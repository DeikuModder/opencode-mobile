import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common"
import type { Request, Response } from "express"
import { AuthService, SETUP_REQUIRED, TOTP_LOCKED_OUT } from "./service.js"
import { SessionGuard } from "./session.guard.js"
import { clearCookie, serializeCookie } from "./cookies.js"
import {
  createBotToken,
  getTotpEnabled,
  listBotTokens,
  listSessions,
  revokeAllSessions,
  revokeBotToken,
  revokeSession,
} from "./db.js"
import { DB, SESSION_COOKIE, SESSION_POLICY } from "../tokens.js"
import type { Db } from "./db.js"
import type { SessionPolicy } from "./service.js"

interface LoginBody {
  username?: string
  password?: string
  totpCode?: string
  recoveryCode?: string
}

@Controller("api/auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DB) private readonly db: Db,
    @Inject(SESSION_COOKIE) private readonly cookieName: string,
    @Inject(SESSION_POLICY) private readonly policy: SessionPolicy,
  ) {}

  /**
   * Unauthenticated, so the SPA can tell "you need to log in" apart from
   * "this install has never been set up". Deliberately leaks nothing beyond
   * those two states.
   */
  @Get("state")
  state(): { setupRequired: boolean; totpEnabled: boolean } {
    const setupRequired = this.auth.isSetupRequired()
    return { setupRequired, totpEnabled: !setupRequired && getTotpEnabled(this.db) }
  }

  /**
   * Whether the caller's cookie is currently a valid session, and who it is for.
   *
   * Separate from /state because that endpoint is deliberately unauthenticated —
   * it must answer the same way for a signed-out visitor so it cannot be used to
   * probe for valid accounts. That left the SPA with no way to tell "needs to log
   * in" from "already signed in", which it needs on every page load to choose
   * between the login screen and the app.
   *
   * Guarded, so a signed-out caller gets 401 rather than a body; the client
   * treats that as "not authenticated" instead of as an error. It goes through
   * SessionGuard rather than resolving the cookie inline so the session is
   * touched and slides its expiry exactly as on every other route.
   */
  @Get("session")
  @UseGuards(SessionGuard)
  sessionState(@Req() req: Request): { authenticated: boolean; username: string | null } {
    const session = req.session
    return {
      authenticated: session !== undefined,
      username: session?.username ?? null,
    }
  }

  /**
   * The only unauthenticated write endpoint. Aggressively throttled per IP on
   * top of AuthService's per-username TOTP limiter — layered because either one
   * alone can be sidestepped (the TOTP limiter is per-username, the IP limiter
   * is per-connection).
   */
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginBody, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const result = await this.auth.login({
      username: body.username ?? "",
      password: body.password ?? "",
      totpCode: body.totpCode,
      recoveryCode: body.recoveryCode,
      userAgent: req.headers["user-agent"] ?? null,
      ip: req.ip ?? null,
    })

    if (!result.ok) {
      if (result.code === SETUP_REQUIRED) {
        // 423: the account does not exist yet and cannot be created over HTTP.
        throw new HttpException(
          {
            code: SETUP_REQUIRED,
            message: "No account configured. Run `pnpm auth:setup` in a terminal on the host.",
          },
          HttpStatus.LOCKED,
        )
      }
      if (result.code === TOTP_LOCKED_OUT) {
        res.setHeader("Retry-After", String(result.retryAfterSeconds ?? 900))
      }
      throw new UnauthorizedException({
        code: result.code,
        // Tells the UI to reveal the TOTP field only once the password is right,
        // so it never asks for a second factor it should not.
        passwordAccepted: result.passwordAccepted ?? false,
        retryAfterSeconds: result.retryAfterSeconds,
      })
    }

    res.setHeader(
      "Set-Cookie",
      serializeCookie(this.cookieName, result.session.token, {
        maxAgeMs: this.policy.ttlMs,
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
      }),
    )
    return { ok: true }
  }

  @Post("logout")
  @UseGuards(SessionGuard)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): { ok: true } {
    if (req.session) this.auth.logout(req.session.id)
    res.setHeader("Set-Cookie", clearCookie(this.cookieName, { path: "/" }))
    return { ok: true }
  }

  /**
   * Password change. Always invalidates every session, including this one, so
   * the client must sign in again with the new password.
   */
  @Post("password")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  async changePassword(
    @Body() body: { currentPassword?: string; newPassword?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true; reauthRequired: true }> {
    try {
      await this.auth.changePassword(body.currentPassword ?? "", body.newPassword ?? "")
    } catch (err) {
      throw new UnauthorizedException({ code: "password_change_rejected", message: (err as Error).message })
    }
    res.setHeader("Set-Cookie", clearCookie(this.cookieName, { path: "/" }))
    return { ok: true, reauthRequired: true }
  }

  @Get("sessions")
  @UseGuards(SessionGuard)
  sessions(@Req() req: Request): { sessions: Array<Record<string, unknown>>; current: number } {    return {
      current: req.session?.id ?? -1,
      sessions: listSessions(this.db).map((s) => ({
        id: s.id,
        kind: s.kind,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at,
        userAgent: s.user_agent,
        ip: s.ip,
      })),
    }
  }

  @Post("sessions/revoke-all")
  @UseGuards(SessionGuard)
  revokeAll(): { ok: true; revoked: number } {
    return { ok: true, revoked: revokeAllSessions(this.db) }
  }

  @Post("sessions/revoke")
  @UseGuards(SessionGuard)
  revokeOne(@Body() body: { id?: number }): { ok: true } {
    if (typeof body.id === "number") revokeSession(this.db, body.id)
    return { ok: true }
  }

  @Get("bot-tokens")
  @UseGuards(SessionGuard)
  botTokens(): { tokens: Array<Record<string, unknown>> } {
    return {
      tokens: listBotTokens(this.db).map((t) => ({
        id: t.id,
        label: t.label,
        createdAt: t.created_at,
        lastUsedAt: t.last_used_at,
        revokedAt: t.revoked_at,
      })),
    }
  }

  /**
   * Mints a Telegram bot credential. Returned exactly once in the response —
   * only its hash is stored, so it cannot be shown again.
   */
  @Post("bot-tokens")
  @UseGuards(SessionGuard)
  createBot(@Body() body: { label?: string }): { token: string; id: number } {
    const { row, token } = createBotToken(this.db, body.label ?? "telegram")
    return { token, id: row.id }
  }

  @Post("bot-tokens/revoke")
  @UseGuards(SessionGuard)
  revokeBot(@Body() body: { id?: number }): { ok: true } {
    if (typeof body.id === "number") revokeBotToken(this.db, body.id)
    return { ok: true }
  }
}
