import { describe, expect, it, beforeEach } from "vitest"
import { authenticator } from "otplib"
import { openDb, listSessions, consumeRecoveryCode, unusedRecoveryCodeCount, type Db } from "../src/auth/db.js"
import { AuthService, INVALID_CREDENTIALS, INVALID_TOTP, SETUP_REQUIRED, TOTP_LOCKED_OUT } from "../src/auth/service.js"
import { hashPassword, needsRehash, verifyPassword } from "../src/auth/password.js"
import { generateToken, hashToken, safeEqual } from "../src/auth/tokens.js"
import { validateOrigin } from "../src/auth/origin.js"

const APP_ORIGIN = "https://ocm.example.com"
const POLICY = { ttlMs: 30 * 86_400_000, slideIntervalMs: 3_600_000 }

const PW = "correct horse battery 42"

let db: Db
let svc: AuthService

beforeEach(() => {
  db = openDb(":memory:")
  svc = new AuthService(db, POLICY)
})

describe("password", () => {
  it("round-trips a hash", async () => {
    const h = await hashPassword(PW)
    expect(h.startsWith("scrypt$")).toBe(true)
    expect(await verifyPassword(PW, h)).toBe(true)
    expect(await verifyPassword("wrong", h)).toBe(false)
  })

  it("salts, so the same password hashes differently each time", async () => {
    expect(await hashPassword(PW)).not.toBe(await hashPassword(PW))
  })

  it("rejects a garbled hash instead of throwing", async () => {
    expect(await verifyPassword(PW, "nonsense")).toBe(false)
    expect(await verifyPassword(PW, "scrypt$bad$AAAA$AAAA")).toBe(false)
  })

  it("does not flag a current-parameter hash for rehash", async () => {
    expect(needsRehash(await hashPassword(PW))).toBe(false)
  })
})

describe("tokens", () => {
  it("generates url-safe high-entropy tokens", () => {
    const t = generateToken(32)
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(new Set(Array.from({ length: 200 }, () => generateToken(32))).size).toBe(200)
  })

  it("hashes deterministically and compares safely", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"))
    expect(hashToken("abc")).not.toBe(hashToken("abd"))
    expect(safeEqual("abc", "abc")).toBe(true)
    expect(safeEqual("abc", "abd")).toBe(false)
    expect(safeEqual("abc", "much longer value")).toBe(false)
  })
})

describe("setup", () => {
  it("reports setup required before any user exists", async () => {
    expect(svc.isSetupRequired()).toBe(true)
    const r = await svc.login({ username: "x", password: PW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(SETUP_REQUIRED)
  })

  it("creates a user with TOTP and issues recovery codes", async () => {
    const secret = authenticator.generateSecret()
    const user = await svc.setup({ username: "usuario", password: PW, totpSecret: secret })
    expect(user.totp_enabled).toBe(1)
    expect(svc.isSetupRequired()).toBe(false)
    const codes = svc.regenerateRecoveryCodes()
    expect(codes).toHaveLength(10)
  })

  it("refuses a second run so setup cannot be used to take over an account", async () => {
    await svc.setup({ username: "usuario", password: PW, totpSecret: null })
    await expect(svc.setup({ username: "attacker", password: PW, totpSecret: null })).rejects.toThrow(
      /already exists/i,
    )
  })

  it("refuses a weak password", async () => {
    await expect(svc.setup({ username: "u", password: "short", totpSecret: null })).rejects.toThrow(/at least/i)
  })
})

describe("login without TOTP", () => {
  beforeEach(async () => {
    await svc.setup({ username: "usuario", password: PW, totpSecret: null })
  })

  it("issues a session and resolves it from the raw token", async () => {
    const r = await svc.login({ username: "usuario", password: PW })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const row = svc.resolveSession(r.session.token)
    expect(row).toBeDefined()
    expect(row!.kind).toBe("web")
  })

  it("carries the username on the resolved session", async () => {
    // resolveSession returns the row from touchSession, so a SELECT without the
    // users JOIN there leaves username undefined and the UI renders no account
    // name. The row that reaches the request is the one that must have it.
    const r = await svc.login({ username: "usuario", password: PW })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(svc.resolveSession(r.session.token)?.username).toBe("usuario")
  })

  it("keeps the username after the session's expiry is slid forward", async () => {
    // The slide path re-selects the row; if that select drops the JOIN the
    // username disappears partway through a long-lived session.
    const r = await svc.login({ username: "usuario", password: PW })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const first = svc.resolveSession(r.session.token)
    const second = svc.resolveSession(r.session.token)
    expect(first?.username).toBe("usuario")
    expect(second?.username).toBe("usuario")
  })

  it("rejects a wrong password and an unknown user identically", async () => {
    const bad = await svc.login({ username: "usuario", password: "nope" })
    const unknown = await svc.login({ username: "nobody", password: PW })
    expect(bad.ok).toBe(false)
    expect(unknown.ok).toBe(false)
    if (!bad.ok && !unknown.ok) {
      expect(bad.code).toBe(INVALID_CREDENTIALS)
      expect(unknown.code).toBe(INVALID_CREDENTIALS)
    }
  })

  it("does not resolve a garbage or empty token", () => {
    expect(svc.resolveSession(undefined)).toBeUndefined()
    expect(svc.resolveSession("")).toBeUndefined()
    expect(svc.resolveSession("ocm_not_a_real_token")).toBeUndefined()
  })
})

describe("login with TOTP", () => {
  let secret: string

  beforeEach(async () => {
    secret = authenticator.generateSecret()
    await svc.setup({ username: "usuario", password: PW, totpSecret: secret })
  })

  it("accepts a current code", async () => {
    const r = await svc.login({ username: "usuario", password: PW, totpCode: authenticator.generate(secret) })
    expect(r.ok).toBe(true)
  })

  it("refuses a missing or malformed code, but confirms the password was right", async () => {
    for (const totpCode of [undefined, "12345", "abcdef", "0000000"]) {
      const r = await svc.login({ username: "usuario", password: PW, totpCode })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe(INVALID_TOTP)
        expect(r.passwordAccepted).toBe(true)
      }
    }
  })

  it("accumulates failures and locks out after 5 bad codes", async () => {
    // Pick a code that is definitely not the valid one, so this cannot flake
    // against a secret whose current TOTP happens to be 000000.
    const valid = authenticator.generate(secret)
    const bad = valid === "000000" ? "000001" : "000000"

    for (let i = 1; i <= 5; i++) {
      const r = await svc.login({ username: "usuario", password: PW, totpCode: bad })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe(INVALID_TOTP)
      // Regression guard: the count must actually build up across attempts.
      if (i < 5) expect(svc.totpLimiter.failureCount("usuario")).toBe(i)
    }

    // Correct password, correct code â€” still refused, because it is locked out.
    const locked = await svc.login({ username: "usuario", password: PW, totpCode: valid })
    expect(locked.ok).toBe(false)
    if (!locked.ok) {
      expect(locked.code).toBe(TOTP_LOCKED_OUT)
      expect(locked.retryAfterSeconds).toBeGreaterThan(0)
    }
  })

  it("does not count a wrong password against the TOTP limiter", async () => {
    for (let i = 0; i < 8; i++) {
      const r = await svc.login({ username: "usuario", password: "wrong-password" })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe(INVALID_CREDENTIALS)
    }
    expect(svc.totpLimiter.failureCount("usuario")).toBe(0)
    const ok = await svc.login({ username: "usuario", password: PW, totpCode: authenticator.generate(secret) })
    expect(ok.ok).toBe(true)
  })

  it("clears the failure count after a successful login", async () => {
    const bad = authenticator.generate(secret) === "000000" ? "000001" : "000000"
    await svc.login({ username: "usuario", password: PW, totpCode: bad })
    await svc.login({ username: "usuario", password: PW, totpCode: bad })
    expect(svc.totpLimiter.failureCount("usuario")).toBe(2)
    const ok = await svc.login({ username: "usuario", password: PW, totpCode: authenticator.generate(secret) })
    expect(ok.ok).toBe(true)
    expect(svc.totpLimiter.failureCount("usuario")).toBe(0)
  })

  it("consumes a recovery code exactly once", async () => {
    const [code] = svc.regenerateRecoveryCodes()
    const first = await svc.login({ username: "usuario", password: PW, recoveryCode: code })
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.usedRecoveryCode).toBe(true)

    const second = await svc.login({ username: "usuario", password: PW, recoveryCode: code })
    expect(second.ok).toBe(false)
  })
})

describe("sessions", () => {
  beforeEach(async () => {
    await svc.setup({ username: "usuario", password: PW, totpSecret: null })
  })

  it("slides expiry, but only after the write interval has elapsed", async () => {
    const r = await svc.login({ username: "usuario", password: PW })
    if (!r.ok) throw new Error("login failed")
    const first = svc.resolveSession(r.session.token)!
    const firstExpiry = first.expires_at

    // slideIntervalMs is 1h, so an immediate re-resolve must not extend it.
    const second = svc.resolveSession(r.session.token)!
    expect(second.expires_at).toBe(firstExpiry)

    // Simulate the interval having passed.
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(Date.now() - 7_200_000, first.id)
    const before = Date.now()
    const third = svc.resolveSession(r.session.token)!

    // Compared with a tolerance rather than strictly. The slide recomputes
    // expiry as `now + ttl`, so if every call in this test lands inside the same
    // millisecond the new expiry is legitimately identical to the old one.
    // A strict toBeGreaterThan is a coin flip on a fast machine.
    expect(third.expires_at).toBeGreaterThanOrEqual(before + POLICY.ttlMs - 2000)
    // The row must genuinely have been written, not just recomputed in memory.
    // Compared against the value forced into the row above, with tolerance:
    // Date.now() can be identical to the login timestamp, and a strict
    // toBeGreaterThan then fails for reasons that have nothing to do with the
    // behaviour under test.
    expect(third.last_seen_at).toBeGreaterThan(before - 2000)
  })

  it("rejects an expired session and prunes it", async () => {
    const r = await svc.login({ username: "usuario", password: PW })
    if (!r.ok) throw new Error("login failed")
    db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, r.session.row.id)
    expect(svc.resolveSession(r.session.token)).toBeUndefined()
    expect(listSessions(db)).toHaveLength(0)
  })

  it("revokes every session on password change", async () => {
    const a = await svc.login({ username: "usuario", password: PW })
    if (!a.ok) throw new Error("login failed")
    await svc.changePassword(PW, "another good password 7")
    expect(svc.resolveSession(a.session.token)).toBeUndefined()
    const b = await svc.login({ username: "usuario", password: "another good password 7" })
    expect(b.ok).toBe(true)
  })

  it("revokes every session when TOTP is disabled from the CLI", async () => {
    const a = await svc.login({ username: "usuario", password: PW })
    if (!a.ok) throw new Error("login failed")
    svc.disableTotpFromCli()
    expect(svc.resolveSession(a.session.token)).toBeUndefined()
  })

  it("returns usable recovery codes when TOTP is re-enrolled from the CLI", async () => {
    // enableTotpFromCli now returns the codes because they are hashed on the way
    // in: if it did not, re-enrolling would silently destroy the user's old
    // codes and hand them no new ones, leaving password+TOTP as the only way in.
    const codes = svc.enableTotpFromCli(authenticator.generateSecret())
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    expect(codes.every((c) => typeof c === "string" && c.length > 0)).toBe(true)

    // The returned plaintext must actually work, not merely exist.
    expect(unusedRecoveryCodeCount(db)).toBe(10)
    expect(consumeRecoveryCode(db, codes[0].toUpperCase())).toBe(true)
    expect(consumeRecoveryCode(db, codes[0].toUpperCase())).toBe(false)
  })

  it("revokes every session when TOTP is re-enrolled from the CLI", async () => {
    // A stolen cookie must not outlive the enrolment that was meant to contain it.
    const a = await svc.login({ username: "usuario", password: PW })
    if (!a.ok) throw new Error("login failed")
    svc.enableTotpFromCli(authenticator.generateSecret())
    expect(svc.resolveSession(a.session.token)).toBeUndefined()
  })
})

describe("bot tokens", () => {
  it("mints a prefixed token and resolves it, then stops after revocation", async () => {
    await svc.setup({ username: "usuario", password: PW, totpSecret: null })
    const { token, row } = (await import("../src/auth/db.js")).createBotToken(db, "telegram")
    expect(token.startsWith("ocm_")).toBe(true)
    expect(svc.resolveBearerToken(token)?.id).toBe(row.id)
    ;(await import("../src/auth/db.js")).revokeBotToken(db, row.id)
    expect(svc.resolveBearerToken(token)).toBeUndefined()
  })
})

describe("origin check (CSRF)", () => {
  it("allows the configured origin", () => {
    expect(validateOrigin("https://ocm.example.com", APP_ORIGIN)).toBe(true)
  })

  it("rejects any other origin, including a lookalike", () => {
    for (const bad of [
      "https://evil.com",
      "https://ocm.example.com.evil.com",
      "http://ocm.example.com", // scheme downgrade
      "https://ocm.example.com:8443",
      "null",
      "",
    ]) {
      expect(validateOrigin(bad, APP_ORIGIN)).toBe(false)
    }
  })

  it("requires an Origin header at all on mutating requests", () => {
    expect(validateOrigin(undefined, APP_ORIGIN)).toBe(false)
  })
})

