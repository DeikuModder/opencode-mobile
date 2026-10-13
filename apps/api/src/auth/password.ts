import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/**
 * scrypt from node:crypto, deliberately.
 *
 * A native KDF (argon2) would be marginally stronger against GPU attack, but it
 * would also mean a compiled dependency on both Windows and a Debian-slim
 * container, for a single-user service holding one password. scrypt with
 * N=2^16 is memory-hard and is a well-regarded choice; the cost of the extra
 * dependency is not worth it here.
 *
 * The encoded form is self-describing so parameters can be raised later without
 * invalidating existing credentials:
 *   scrypt$N=65536,r=8,p=1$<salt-b64url>$<hash-b64url>
 */
export interface ScryptParams {
  N: number
  r: number
  p: number
}

// N=2^16, r=8 needs ~64 MiB (128 * r * N). Node's default maxmem is 32 MiB and
// would throw, so it must be raised explicitly.
export const SCRYPT_DEFAULTS: ScryptParams = { N: 65536, r: 8, p: 1 }
const SCRYPT_KEYLEN = 64
const SCRYPT_MAXMEM = 192 * 1024 * 1024

function encodeParams(p: ScryptParams): string {
  return `N=${p.N},r=${p.r},p=${p.p}`
}

function decodeParams(s: string): ScryptParams {
  const out: Record<string, number> = {}
  for (const pair of s.split(",")) {
    const [k, v] = pair.split("=")
    if (k && v) out[k] = Number.parseInt(v, 10)
  }
  return { N: out.N ?? SCRYPT_DEFAULTS.N, r: out.r ?? SCRYPT_DEFAULTS.r, p: out.p ?? SCRYPT_DEFAULTS.p }
}

export async function hashPassword(password: string, params: ScryptParams = SCRYPT_DEFAULTS): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  })
  return `scrypt$${encodeParams(params)}$${salt.toString("base64url")}$${hash.toString("base64url")}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$")
  if (parts.length !== 4 || parts[0] !== "scrypt") return false
  const [, paramStr, saltB64, hashB64] = parts
  if (!paramStr || !saltB64 || !hashB64) return false

  let salt: Buffer
  let expected: Buffer
  let params: ScryptParams
  try {
    salt = Buffer.from(saltB64, "base64url")
    expected = Buffer.from(hashB64, "base64url")
    params = decodeParams(paramStr)
  } catch {
    return false
  }
  if (expected.length === 0) return false

  try {
    const actual = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT_MAXMEM,
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** True when a stored hash uses weaker parameters than the current default. */
export function needsRehash(encoded: string): boolean {
  const [alg, paramStr] = encoded.split("$")
  if (alg !== "scrypt" || !paramStr) return true
  const p = decodeParams(paramStr)
  return p.N !== SCRYPT_DEFAULTS.N || p.r !== SCRYPT_DEFAULTS.r || p.p !== SCRYPT_DEFAULTS.p
}

export const MIN_PASSWORD_LENGTH = 12

export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  if (password.length > 512) return "Password must be at most 512 characters"
  if (!/[a-z]/i.test(password)) return "Password must contain a letter"
  if (!/[0-9]/.test(password)) return "Password must contain a digit"
  return null
}
