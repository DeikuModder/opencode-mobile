import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * 256 bits of CSPRNG entropy, base64url encoded.
 * base64url avoids +, / and = so the value is cookie-safe with no escaping.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

/**
 * Sessions and bearer tokens are stored as SHA-256 digests, never in plaintext.
 * Safe without a pepper: the input is 256 bits of uniform random, so there is no
 * dictionary to attack and no work factor to tune.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/** Length-independent constant-time string compare for digests and secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (ba.length !== bb.length) {
    // Still burn a comparison so the fast path is not obviously shorter.
    timingSafeEqual(ba, ba)
    return false
  }
  return timingSafeEqual(ba, bb)
}

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no I, O, 0, 1

/** Human-transcribable recovery codes, e.g. "K7QP-2M4X". */
export function generateRecoveryCode(): string {
  const pick = () => RECOVERY_ALPHABET[randomBytes(1)[0]! % RECOVERY_ALPHABET.length]!
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`
}
