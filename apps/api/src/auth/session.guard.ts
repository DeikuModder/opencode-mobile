import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common"
import type { Request } from "express"
import { AuthService } from "./service.js"
import { parseCookies } from "./cookies.js"
import { SESSION_COOKIE } from "../tokens.js"
import type { SessionRow } from "./db.js"

declare module "express" {
  interface Request {
    session?: SessionRow
  }
}

/**
 * Resolves the session cookie to a live session row.
 *
 * Only authentication. The CSRF Origin check is deliberately NOT here — it lives
 * in OriginGuard, which runs globally, so that unauthenticated mutating routes
 * such as login are covered too.
 *
 * Bot tokens are deliberately NOT accepted here. A bot token is a narrow
 * credential that lives in a chat platform's configuration, and letting it
 * authenticate the whole API would turn a leaked Telegram token into full
 * control of the agent. Bot-authenticated routes get their own guard.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SESSION_COOKIE) private readonly cookieName: string,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>()

    const cookies = parseCookies(req.headers.cookie)
    const session = this.auth.resolveSession(cookies[this.cookieName])
    if (!session) {
      throw new UnauthorizedException({ code: "unauthenticated", message: "Sign in required" })
    }
    req.session = session
    return true
  }
}
