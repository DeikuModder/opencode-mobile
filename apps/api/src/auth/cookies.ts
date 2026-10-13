/**
 * Minimal cookie handling.
 *
 * A dedicated cookie-parser dependency is not worth it here: we read exactly
 * one cookie and write one cookie. Values we generate are base64url, so they
 * never need quoting or unescaping.
 */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!name) continue
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

export interface CookieOptions {
  maxAgeMs?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: "Strict" | "Lax" | "None"
  path?: string
  /** Omit to make the cookie host-only. Required to be absent for __Host-. */
  domain?: string
}

/**
 * Serialise a Set-Cookie value.
 *
 * `__Host-` prefixed names are a browser-enforced contract: the cookie is
 * rejected unless it is Secure, Path=/ and carries no Domain attribute. That
 * removes subdomain cookie-injection and http downgrade as possibilities rather
 * than relying on us never making the mistake.
 */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  const path = opts.path ?? "/"
  parts.push(`Path=${path}`)
  if (opts.domain) parts.push(`Domain=${opts.domain}`)

  const isHostPrefixed = name.startsWith("__Host-")
  const secure = opts.secure ?? true
  if (isHostPrefixed && !secure) {
    throw new Error(`Cookie ${name} uses the __Host- prefix and must be Secure`)
  }
  if (isHostPrefixed && path !== "/") {
    throw new Error(`Cookie ${name} uses the __Host- prefix and must have Path=/`)
  }
  if (isHostPrefixed && opts.domain) {
    throw new Error(`Cookie ${name} uses the __Host- prefix and must not set Domain`)
  }
  if (secure) parts.push("Secure")
  if (opts.httpOnly ?? true) parts.push("HttpOnly")
  parts.push(`SameSite=${opts.sameSite ?? "Strict"}`)
  if (opts.maxAgeMs !== undefined) {
    const seconds = Math.floor(opts.maxAgeMs / 1000)
    parts.push(`Max-Age=${seconds}`)
    parts.push(`Expires=${new Date(Date.now() + opts.maxAgeMs).toUTCString()}`)
  }
  return parts.join("; ")
}

export function clearCookie(name: string, opts: CookieOptions = {}): string {
  return serializeCookie(name, "", { ...opts, maxAgeMs: 0 })
}
