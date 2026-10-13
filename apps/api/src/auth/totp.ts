import { authenticator } from "otplib"

export const TOTP_ISSUER = "opencode-mobile"
export const TOTP_SERVICE = "opencode-mobile"

/** Accept one step of clock drift either side of the current window. */
const WINDOW = 1

const TOTP_STEP_SECONDS = 30
const TOTP_DIGITS = 6

/**
 * The one authenticator instance the app verifies with.
 *
 * Every option is set explicitly. Relying on otplib's defaults is how
 * `WINDOW` ended up dead code: it was declared here, documented as accepting
 * ±30s of clock drift, and never actually handed to the library, so
 * `authenticator.check` ran with a window of 0 and rejected a code the instant
 * its 30-second step rolled over. A phone with ordinary clock drift, or a
 * human copying a code that expires mid-keystroke, then failed a login that
 * looked like a wrong credential.
 *
 * digits/step are pinned too, so a library default change cannot silently
 * alter what users have enrolled in their authenticator apps.
 */
const AUTH = authenticator.clone({
  window: WINDOW,
  digits: TOTP_DIGITS,
  step: TOTP_STEP_SECONDS,
})

const digits = (code: string): boolean => /^\d{6}$/.test(code.trim())

export function generateTotpSecret(): string {
  return authenticator.generateSecret()
}

export function totpUri(secret: string, username: string): string {
  return authenticator.keyuri(username, TOTP_SERVICE, secret)
}

/**
 * Verify a 6-digit TOTP.
 *
 * A 6-digit code is only 10^6 possibilities, which is enumerable online in
 * minutes. This function is therefore always paired with an attempt limiter
 * (see TotpAttemptLimiter) — the limiter is what makes the second factor worth
 * anything, not the algorithm. The ±1 window widens the live search space from
 * 10^6 to 3x10^6 per step, which is a rounding error next to 8 tries per
 * 15 minutes.
 */
export function verifyTotp(code: string, secret: string): boolean {
  const c = code.trim()
  if (!digits(c) || !secret) return false
  try {
    return AUTH.check(c, secret)
  } catch {
    return false
  }
}

/**
 * Diagnostic: how far off the clock is a code that did not verify?
 *
 * Returns the number of 30-second steps of drift that would make `code` valid,
 * or null if no plausible drift explains it (which means the wrong secret, the
 * wrong account, or a typo). Used by `pnpm auth:check-totp` to tell "your phone
 * clock is off by 90 seconds" apart from "your authenticator has a different
 * secret", which look identical from the login error.
 *
 * Binary-searches the verification window rather than generating codes for
 * arbitrary timestamps, so it stays on otplib's single implementation of the
 * algorithm instead of adding a second one next to it.
 */
export function findTotpDriftSteps(code: string, secret: string, maxSteps = 20): number | null {
  const c = code.trim()
  if (!digits(c) || !secret) return null
  const accepts = (window: number): boolean => {
    try {
      return authenticator.clone({ window }).check(c, secret)
    } catch {
      return false
    }
  }
  if (!accepts(maxSteps)) return null
  let lo = 0
  let hi = maxSteps
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (accepts(mid)) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * Why a code failed: the three cases login cannot tell apart.
 *
 * `invalid_totp` is returned for a live-but-just-expired code, a device whose
 * clock drifted, and an authenticator holding an entirely different secret. They
 * need different fixes — wait 30s, fix the phone's clock, re-enrol — so the
 * decision belongs in one tested place rather than being re-derived in a CLI.
 */
export type TotpVerdict =
  | { kind: "valid" }
  | { kind: "drift"; seconds: number }
  | { kind: "unknown" }

export function diagnoseTotp(code: string, secret: string, maxSteps = 20): TotpVerdict {
  if (verifyTotp(code, secret)) return { kind: "valid" }
  const steps = findTotpDriftSteps(code, secret, maxSteps)
  if (steps === null || steps === 0) return { kind: "unknown" }
  return { kind: "drift", seconds: steps * TOTP_STEP_SECONDS }
}

interface AttemptState {
  failures: number
  lockedUntil: number
}

export const TOTP_MAX_FAILURES = 5
export const TOTP_LOCKOUT_MS = 15 * 60_000

/**
 * Per-username TOTP attempt limiter. In-memory on purpose: losing it on restart
 * only costs an attacker a few extra tries, and persisting it would add a write
 * on the exact path we are trying to keep cheap.
 */
export class TotpAttemptLimiter {
  private readonly state = new Map<string, AttemptState>()

  /**
   * Clear every accumulated failure and lockout for one user.
   *
   * Exposed because the limiter is in-memory, so a test that deliberately burns
   * TOTP_MAX_FAILURES cannot be reset by clearing database fixtures, and would
   * otherwise lock every later test in the file for TOTP_LOCKOUT_MS.
   */
  resetAll(): void {
    this.state.clear()
  }

  /**
   * Milliseconds of lockout remaining, or 0.
   *
   * This is a read with narrow, deliberate mutation: it must NOT clear the
   * accumulated failure count when no lockout is active, because that count is
   * the whole mechanism. It is only reset once a lockout has actually expired.
   */
  lockedFor(username: string): number {
    const s = this.state.get(username)
    if (!s) return 0
    if (s.lockedUntil > 0) {
      const remaining = s.lockedUntil - Date.now()
      if (remaining > 0) return remaining
      // The lockout has now run its course; start clean.
      s.lockedUntil = 0
      s.failures = 0
    }
    return 0
  }

  recordFailure(username: string): void {
    const s = this.state.get(username) ?? { failures: 0, lockedUntil: 0 }
    s.failures += 1
    if (s.failures >= TOTP_MAX_FAILURES) {
      s.lockedUntil = Date.now() + TOTP_LOCKOUT_MS
      s.failures = 0
    }
    this.state.set(username, s)
    if (this.state.size > PRUNE_THRESHOLD) this.prune()
  }

  reset(username: string): void {
    this.state.delete(username)
  }

  /** Drops entries whose lockout expired long ago, bounding memory. */
  private prune(): void {
    const now = Date.now()
    for (const [k, s] of this.state) {
      if (s.lockedUntil > 0 && s.lockedUntil <= now - TOTP_LOCKOUT_MS) this.state.delete(k)
    }
  }

  /** Test/diagnostic helper. */
  failureCount(username: string): number {
    return this.state.get(username)?.failures ?? 0
  }
}

const PRUNE_THRESHOLD = 1024
