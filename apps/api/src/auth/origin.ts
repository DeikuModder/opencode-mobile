/**
 * CSRF defence for cookie-authenticated mutations.
 *
 * Our session cookie is sent automatically by the browser, so any site the user
 * visits can attempt cross-site requests against us. SameSite=Strict blocks the
 * common cases, but this check is the layer that does not depend on browser
 * behaviour: a mutating request must present an Origin we recognise.
 *
 * Comparison is on the full origin (scheme + host + port), so a scheme
 * downgrade, a port shift, or a lookalike suffix such as
 * "ocm.example.com.evil.com" are all rejected.
 */
export function validateOrigin(origin: string | undefined, expected: string): boolean {
  if (!origin) return false
  // "null" is what browsers send from sandboxed/file:// contexts.
  if (origin === "null") return false

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.origin !== expected) return false

  // A browser-sent Origin is always scheme://host[:port] with no trailing slash,
  // path, query or fragment. Anything else is not a real browser origin.
  if (origin !== parsed.origin) return false

  return true
}

/**
 * Check a request Origin against the configured allowlist.
 *
 * Membership is tested against a parsed set rather than with a substring or
 * suffix match, so "https://ocm.example.com.evil.com" and
 * "https://evil.com/?x=https://ocm.example.com" are both rejected.
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false
  for (const expected of allowed) {
    if (validateOrigin(origin, expected)) return true
  }
  return false
}

/** Methods that can change state and therefore need the Origin check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

export function isMutatingMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase())
}
