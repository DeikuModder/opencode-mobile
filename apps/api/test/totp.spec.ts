import { describe, expect, it } from "vitest"
import { createHmac } from "node:crypto"
import { authenticator } from "otplib"
import { diagnoseTotp, findTotpDriftSteps, generateTotpSecret, verifyTotp } from "../src/auth/totp.js"

/**
 * TOTP verification.
 *
 * The headline regression here is that `WINDOW` was declared and documented as
 * accepting ±30s of clock drift but never passed to otplib, so verification ran
 * with a window of 0. A code was rejected the instant its step rolled over,
 * which surfaced as `invalid_totp` for users whose credentials were correct.
 */

const STEP = 30

function b32decode(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s.toUpperCase().replace(/=+$/, "")) {
    const i = A.indexOf(ch)
    if (i < 0) continue
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** RFC 6238, written out so the test does not validate otplib against itself. */
function codeAt(secret: string, epochSec: number): string {
  const counter = Math.floor(epochSec / STEP)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = createHmac("sha1", b32decode(secret)).update(buf).digest()
  const off = h[h.length - 1] & 0x0f
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 10 ** 6).padStart(6, "0")
}

describe("verifyTotp", () => {
  it("accepts a code for the current step", () => {
    const secret = generateTotpSecret()
    expect(verifyTotp(codeAt(secret, Math.floor(Date.now() / 1000)), secret)).toBe(true)
  })

  it("ignores surrounding whitespace", () => {
    const secret = generateTotpSecret()
    const code = codeAt(secret, Math.floor(Date.now() / 1000))
    expect(verifyTotp(`  ${code} `, secret)).toBe(true)
  })

  it("tolerates one step of clock drift in each direction", () => {
    // The bug: both of these were rejected.
    const secret = generateTotpSecret()
    const now = Math.floor(Date.now() / 1000)
    expect(verifyTotp(codeAt(secret, now - STEP), secret)).toBe(true)
    expect(verifyTotp(codeAt(secret, now + STEP), secret)).toBe(true)
  })

  it("rejects codes two steps away", () => {
    const secret = generateTotpSecret()
    const now = Math.floor(Date.now() / 1000)
    expect(verifyTotp(codeAt(secret, now - 2 * STEP), secret)).toBe(false)
    expect(verifyTotp(codeAt(secret, now + 2 * STEP), secret)).toBe(false)
  })

  it("rejects malformed input instead of throwing", () => {
    const secret = generateTotpSecret()
    for (const bad of ["", "   ", "12345", "1234567", "abcdef", "12 34 56", "🔥🔥🔥"]) {
      expect(verifyTotp(bad, secret)).toBe(false)
    }
  })

  it("rejects when there is no secret", () => {
    expect(verifyTotp("123456", "")).toBe(false)
  })

  it("rejects a code generated for a different secret", () => {
    const a = generateTotpSecret()
    const b = generateTotpSecret()
    const now = Math.floor(Date.now() / 1000)
    expect(verifyTotp(codeAt(b, now), a)).toBe(false)
  })
})

describe("findTotpDriftSteps", () => {
  it("reports zero drift for a live code", () => {
    const secret = generateTotpSecret()
    expect(findTotpDriftSteps(codeAt(secret, Math.floor(Date.now() / 1000)), secret)).toBe(0)
  })

  it("quantifies drift instead of just failing", () => {
    // This is the whole point of the diagnostic: an expired-or-drifted code and
    // a wrong secret both return invalid_totp from login.
    const secret = generateTotpSecret()
    const now = Math.floor(Date.now() / 1000)
    expect(findTotpDriftSteps(codeAt(secret, now - 2 * STEP), secret, 4)).toBe(2)
    expect(findTotpDriftSteps(codeAt(secret, now + 3 * STEP), secret, 4)).toBe(3)
  })

  it("returns null when no plausible drift explains the code", () => {
    const secret = generateTotpSecret()
    const other = generateTotpSecret()
    const now = Math.floor(Date.now() / 1000)
    expect(findTotpDriftSteps(codeAt(other, now), secret, 4)).toBeNull()
  })

  it("returns null for input that is not a code at all", () => {
    const secret = generateTotpSecret()
    expect(findTotpDriftSteps("nope", secret)).toBeNull()
    expect(findTotpDriftSteps("12345", secret)).toBeNull()
  })
})

describe("the window actually reaches the library", () => {
  it("is not silently the library default", () => {
    // Guards the specific regression: someone edits WINDOW, or drops the
    // explicit options, and drift tolerance quietly disappears again.
    const secret = generateTotpSecret()
    const now = Math.floor(Date.now() / 1000)
    const drifting = codeAt(secret, now - STEP)
    // Default otplib: window 0, rejects it. Our verifyTotp: accepts it.
    expect(authenticator.check(drifting, secret)).toBe(false)
    expect(verifyTotp(drifting, secret)).toBe(true)
  })
})

describe("diagnoseTotp", () => {
  it("calls a live code valid", () => {
    const secret = generateTotpSecret()
    expect(diagnoseTotp(codeAt(secret, Math.floor(Date.now() / 1000)), secret)).toEqual({ kind: "valid" })
  })

  it("quantifies clock drift in seconds", () => {
    const secret = generateTotpSecret()
    const now = Math.floor(Date.now() / 1000)
    expect(diagnoseTotp(codeAt(secret, now - 2 * STEP), secret, 6)).toEqual({ kind: "drift", seconds: 60 })
    expect(diagnoseTotp(codeAt(secret, now - 3 * STEP), secret, 6)).toEqual({ kind: "drift", seconds: 90 })
  })

  it("returns unknown, not drift, for the wrong secret", () => {
    // Misreporting this as drift would send the user to fix a clock that is
    // perfectly correct while their real problem is a stale enrolment.
    const secret = generateTotpSecret()
    const other = generateTotpSecret()
    const now = Math.floor(Date.now() / 1000)
    expect(diagnoseTotp(codeAt(other, now), secret, 6)).toEqual({ kind: "unknown" })
  })

  it("returns unknown for malformed input rather than throwing", () => {
    const secret = generateTotpSecret()
    for (const bad of ["", "nope", "12345", "000000x"]) {
      expect(diagnoseTotp(bad, secret)).toEqual({ kind: "unknown" })
    }
  })
})
