import { Inject, Injectable, Logger } from "@nestjs/common"
import * as store from "./db.js"
import { DB, SESSION_POLICY } from "../tokens.js"
import { hashPassword, needsRehash, validatePasswordStrength, verifyPassword } from "./password.js"
import { generateRecoveryCode, hashToken, safeEqual } from "./tokens.js"
import { TotpAttemptLimiter, TOTP_LOCKOUT_MS, TOTP_MAX_FAILURES, verifyTotp } from "./totp.js"

/**
 * The only configuration AuthService needs.
 *
 * Deliberately narrower than the full AppConfig: the break-glass CLIs must keep
 * working when the rest of the environment is broken, otherwise a bad .env
 * could lock you out of the machine's own agent.
 */
export interface SessionPolicy {
  ttlMs: number
  slideIntervalMs: number
}

export const SETUP_REQUIRED = "setup_required"
export const INVALID_CREDENTIALS = "invalid_credentials"
export const INVALID_TOTP = "invalid_totp"
export const TOTP_LOCKED_OUT = "totp_locked_out"
export const RECOVERY_CODE_INVALID = "recovery_code_invalid"

export interface LoginOk {
  ok: true
  session: store.IssuedSession
  usedRecoveryCode: boolean
  rehashNeeded: boolean
}

export interface LoginErr {
  ok: false
  code: string
  /** Seconds remaining, only for TOTP_LOCKED_OUT. */
  retryAfterSeconds?: number
  /** True when the password was right but the second factor was not. */
  passwordAccepted?: boolean
}

export type LoginResult = LoginOk | LoginErr

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)
  readonly totpLimiter = new TotpAttemptLimiter()

  /**
   * A real hash of a random value, used to burn a comparable KDF when the
   * username does not exist so a wrong username is not distinguishable from a
   * wrong password by response time. Built once, lazily.
   */
  private dummyHash: string | null = null

  constructor(
    // Explicit tokens throughout. Constructor params referenced only in type
    // position get their imports elided by esbuild (which cannot emit decorator
    // metadata), so design:paramtypes would resolve to undefined at runtime.
    @Inject(DB) private readonly db: store.Db,
    @Inject(SESSION_POLICY) private readonly policy: SessionPolicy,
  ) {}

  private async getDummyHash(): Promise<string> {
    this.dummyHash ??= await hashPassword("dummy-password-for-timing-equalisation")
    return this.dummyHash
  }

  isSetupRequired(): boolean {
    return !store.userExists(this.db)
  }

  /**
   * First-run account creation.
   *
   * Reached only from the local CLI â€” there is deliberately no HTTP route for
   * it. Refuses once a user exists, so setup cannot be re-run to take over an
   * already-configured account.
   */
  async setup(input: { username: string; password: string; totpSecret: string | null }): Promise<store.UserRow> {
    if (!this.isSetupRequired()) {
      throw new Error("A user already exists. Use auth:reset-password or auth:disable-totp instead.")
    }
    const weak = validatePasswordStrength(input.password)
    if (weak) throw new Error(weak)

    const user = store.createUser(this.db, input.username, await hashPassword(input.password), input.totpSecret)
    if (input.totpSecret) this.regenerateRecoveryCodes()
    this.logger.log(`Initial user "${user.username}" created (totp=${user.totp_enabled === 1})`)
    return user
  }

  async login(input: {
    username: string
    password: string
    totpCode?: string
    recoveryCode?: string
    userAgent?: string | null
    ip?: string | null
  }): Promise<LoginResult> {
    if (this.isSetupRequired()) return { ok: false, code: SETUP_REQUIRED }

    const locked = this.totpLimiter.lockedFor(input.username)
    if (locked > 0) {
      return { ok: false, code: TOTP_LOCKED_OUT, retryAfterSeconds: Math.ceil(locked / 1000) }
    }

    const user = store.getUser(this.db)
    if (!user) return { ok: false, code: SETUP_REQUIRED }

    if (!safeEqual(user.username, input.username)) {
      await verifyPassword(input.password, await this.getDummyHash())
      return { ok: false, code: INVALID_CREDENTIALS }
    }

    if (!(await verifyPassword(input.password, user.password_hash))) {
      return { ok: false, code: INVALID_CREDENTIALS }
    }

    // Password verified from here on.
    let rehashNeeded = false
    if (needsRehash(user.password_hash)) {
      store.setPasswordHash(this.db, await hashPassword(input.password))
      rehashNeeded = true
    }

    const issue = (usedRecoveryCode: boolean): LoginOk => ({
      ok: true,
      usedRecoveryCode,
      rehashNeeded,
      session: store.createSession(this.db, this.policy.ttlMs, {
        userAgent: input.userAgent ?? null,
        ip: input.ip ?? null,
        kind: "web",
      }),
    })

    if (!user.totp_enabled || !user.totp_secret) {
      this.totpLimiter.reset(input.username)
      return issue(false)
    }

    if (input.recoveryCode) {
      if (store.consumeRecoveryCode(this.db, input.recoveryCode)) {
        this.totpLimiter.reset(input.username)
        return issue(true)
      }
      this.totpLimiter.recordFailure(input.username)
      return { ok: false, code: RECOVERY_CODE_INVALID, passwordAccepted: true }
    }

    if (!input.totpCode || !verifyTotp(input.totpCode, user.totp_secret)) {
      this.totpLimiter.recordFailure(input.username)
      return { ok: false, code: INVALID_TOTP, passwordAccepted: true }
    }

    this.totpLimiter.reset(input.username)
    return issue(false)
  }

  /**
   * Resolve a plaintext cookie value to a live session, sliding its expiry.
   * Unknown, revoked and expired tokens are all indistinguishable to the caller,
   * which is intentional.
   */
  resolveSession(token: string | undefined): store.SessionRow | undefined {
    if (!token) return undefined
    const row = store.findSessionByToken(this.db, token)
    if (!row) return undefined
    if (row.expires_at <= Date.now()) {
      store.revokeSession(this.db, row.id)
      return undefined
    }
    return store.touchSession(this.db, row.id, this.policy.ttlMs, this.policy.slideIntervalMs)
  }

  resolveBearerToken(token: string | undefined): store.BotTokenRow | undefined {
    if (!token) return undefined
    const row = store.findBotToken(this.db, token)
    if (!row) return undefined
    store.touchBotToken(this.db, row.id)
    return row
  }

  logout(sessionId: number): void {
    store.revokeSession(this.db, sessionId)
  }

  /**
   * Password change and TOTP removal always drop every session: keeping old
   * sessions alive would defeat the point of the change.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const user = store.getUser(this.db)
    if (!user) throw new Error("No user configured")
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw new Error("Current password is incorrect")
    }
    const weak = validatePasswordStrength(newPassword)
    if (weak) throw new Error(weak)
    store.setPasswordHash(this.db, await hashPassword(newPassword))
    this.logger.warn(`Password changed for "${user.username}"; all sessions revoked`)
    store.revokeAllSessions(this.db)
  }

  async resetPasswordFromCli(newPassword: string): Promise<void> {
    const weak = validatePasswordStrength(newPassword)
    if (weak) throw new Error(weak)
    store.setPasswordHash(this.db, await hashPassword(newPassword))
    store.revokeAllSessions(this.db)
  }

  disableTotpFromCli(): void {
    store.setTotp(this.db, null)
    this.db.exec("DELETE FROM recovery_codes")
    store.revokeAllSessions(this.db)
  }

  /**
   * Turns on (or re-enrols) TOTP. Returns the new recovery codes in plaintext:
   * they are hashed on the way in and cannot be read back, so the caller must
   * print them or they are gone for good.
   */
  enableTotpFromCli(secret: string): string[] {
    store.setTotp(this.db, secret)
    const codes = this.regenerateRecoveryCodes()
    // Changing the second factor invalidates every existing session, otherwise a
    // stolen cookie outlives the enrolment that was supposed to contain it.
    store.revokeAllSessions(this.db)
    return codes
  }

  /** Returns plaintext codes. Shown once by the CLI, never recoverable later. */
  regenerateRecoveryCodes(): string[] {
    const codes = Array.from({ length: 10 }, generateRecoveryCode)
    store.replaceRecoveryCodes(
      this.db,
      codes.map((c) => hashToken(c.toUpperCase())),
    )
    return codes
  }

  lockoutSecondsRemaining(username: string): number {
    const ms = this.totpLimiter.lockedFor(username)
    return ms > 0 ? Math.ceil(ms / 1000) : 0
  }

  get totpMaxFailures(): number {
    return TOTP_MAX_FAILURES
  }

  get totpLockoutMs(): number {
    return TOTP_LOCKOUT_MS
  }
}

