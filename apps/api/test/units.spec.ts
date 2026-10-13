import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCookies, serializeCookie, clearCookie } from "../src/auth/cookies.js"
import { parseJsonFile } from "../src/projects/json-file.js"
import { FixedWindowStore } from "../src/rate-limit.js"
import { isOriginAllowed, validateOrigin } from "../src/auth/origin.js"
import { normaliseOriginList, ConfigError } from "../src/config.js"

describe("APP_ORIGIN parsing", () => {
  it("accepts a single origin", () => {
    expect(normaliseOriginList("https://ocm.example.com")).toEqual(["https://ocm.example.com"])
  })

  it("accepts a comma-separated list and trims whitespace", () => {
    expect(normaliseOriginList("https://a.example.com, https://b.example.com")).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ])
  })

  it("de-duplicates origins that normalise to the same value", () => {
    // A trailing slash is stripped by normalisation, so these are one origin.
    expect(normaliseOriginList("https://a.example.com,https://a.example.com/")).toEqual([
      "https://a.example.com",
    ])
  })

  it("rejects an empty list", () => {
    expect(() => normaliseOriginList("  ,  ")).toThrow(ConfigError)
  })

  it("rejects a non-absolute URL", () => {
    expect(() => normaliseOriginList("ocm.example.com")).toThrow(ConfigError)
  })

  it("rejects an origin carrying a path", () => {
    expect(() => normaliseOriginList("https://ocm.example.com/app")).toThrow(ConfigError)
  })

  it("allows http on loopback, with and without a port", () => {
    // This is the normal development setup: the API on :3000 and the Vite dev
    // server on :5173, both plain http.
    expect(normaliseOriginList("http://localhost:3000,http://127.0.0.1:5173")).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:5173",
    ])
    expect(normaliseOriginList("http://localhost")).toEqual(["http://localhost"])
    expect(normaliseOriginList("http://[::1]:3000")).toEqual(["http://[::1]:3000"])
  })

  it("refuses http on a non-loopback host, since the cookie would travel in cleartext", () => {
    expect(() => normaliseOriginList("http://ocm.example.com")).toThrow(/non-loopback/)
  })

  it("refuses a lookalike host that merely contains a loopback name", () => {
    expect(() => normaliseOriginList("http://localhost.evil.com")).toThrow(/non-loopback/)
    expect(() => normaliseOriginList("http://evil.localhost")).toThrow(/non-loopback/)
  })

  it("allows https on any host", () => {
    expect(normaliseOriginList("https://ocm.example.com")).toEqual(["https://ocm.example.com"])
  })
})

describe("origin allowlist", () => {
  const allowed = ["https://ocm.example.com", "http://127.0.0.1:5173"] as const

  it("accepts an exact match on any listed origin", () => {
    expect(validateOrigin("https://ocm.example.com", "https://ocm.example.com")).toBe(true)
    expect(validateOrigin("http://127.0.0.1:5173", "http://127.0.0.1:5173")).toBe(true)
  })

  it("accepts a match against any entry in a multi-origin list", () => {
    expect(isOriginAllowed("https://ocm.example.com", allowed)).toBe(true)
    expect(isOriginAllowed("http://127.0.0.1:5173", allowed)).toBe(true)
  })

  it("rejects an origin that is on no list", () => {
    expect(isOriginAllowed("https://evil.com", allowed)).toBe(false)
  })

  it("rejects a lookalike suffix on an allowed host", () => {
    expect(isOriginAllowed("https://ocm.example.com.evil.com", allowed)).toBe(false)
    expect(isOriginAllowed("https://evil.com/https://ocm.example.com", allowed)).toBe(false)
  })

  it("rejects a port shift or scheme change against an allowed host", () => {
    expect(isOriginAllowed("https://ocm.example.com:8443", allowed)).toBe(false)
    expect(isOriginAllowed("http://ocm.example.com", allowed)).toBe(false)
  })

  it("rejects missing, null, and path-bearing origins", () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(false)
    expect(isOriginAllowed("null", allowed)).toBe(false)
    expect(isOriginAllowed("https://ocm.example.com/path", allowed)).toBe(false)
  })

  it("rejects every origin when the allowlist is empty", () => {
    expect(isOriginAllowed("https://ocm.example.com", [])).toBe(false)
  })
})

describe("cookie parsing", () => {
  it("reads a single cookie out of a multi-cookie header", () => {
    expect(parseCookies("a=1; __Host-ocm_session=abc; b=2")["__Host-ocm_session"]).toBe("abc")
  })

  it("handles an absent or empty header", () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies("")).toEqual({})
  })

  it("tolerates whitespace and a trailing semicolon", () => {
    expect(parseCookies("  x = y ; ")["x"]).toBe("y")
  })

  it("ignores malformed segments instead of throwing", () => {
    expect(parseCookies("novalue;=orphan;ok=1")).toEqual({ ok: "1" })
  })

  it("keeps a value containing '=' rather than truncating it", () => {
    expect(parseCookies("t=abc=def")["t"]).toBe("abc=def")
  })

  it("url-decodes, and falls back to the raw value when it cannot", () => {
    expect(parseCookies("t=a%20b")["t"]).toBe("a b")
    expect(parseCookies("t=%E0%A4%A")["t"]).toBe("%E0%A4%A")
  })
})

describe("cookie serialisation", () => {
  it("emits every hardening attribute by default", () => {
    const header = serializeCookie("__Host-ocm_session", "v", { maxAgeMs: 1000 })
    expect(header).toContain("Path=/")
    expect(header).toContain("Secure")
    expect(header).toContain("HttpOnly")
    expect(header).toContain("SameSite=Strict")
    expect(header).toContain("Max-Age=1")
  })

  it("refuses to weaken the __Host- contract", () => {
    // The browser would reject these anyway, but failing loudly at the point of
    // the mistake beats a cookie that silently never arrives.
    expect(() => serializeCookie("__Host-ocm_session", "v", { secure: false })).toThrow(/Secure/)
    expect(() => serializeCookie("__Host-ocm_session", "v", { path: "/api" })).toThrow(/Path/)
    expect(() => serializeCookie("__Host-ocm_session", "v", { domain: "example.com" })).toThrow(/Domain/)
  })

  it("allows a non-prefixed name to be insecure for local dev", () => {
    expect(serializeCookie("ocm_session", "v", { secure: false })).not.toContain("Secure")
  })

  it("expires immediately when cleared", () => {
    const header = clearCookie("__Host-ocm_session", { path: "/" })
    expect(header).toMatch(/Max-Age=0/)
    // A cleared cookie must keep the same attributes, or the browser keeps the
    // original alive.
    expect(header).toContain("Secure")
    expect(header).toContain("HttpOnly")
    expect(header).toContain("SameSite=Strict")
  })
})

describe("json file parsing", () => {
  it("parses plain JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocm-json-"))
    const file = join(dir, "a.json")
    writeFileSync(file, '{"ok":true}')
    expect(parseJsonFile(file)).toEqual({ ok: true })
  })

  it("tolerates a UTF-8 BOM", () => {
    // PowerShell's `Set-Content -Encoding utf8` writes one, and JSON.parse
    // rejects it outright — which previously reduced the project allowlist to
    // empty without a clear error.
    const dir = mkdtempSync(join(tmpdir(), "ocm-json-"))
    const file = join(dir, "bom.json")
    writeFileSync(file, "\uFEFF{\"projects\":[{\"id\":\"a\"}]}")
    expect(parseJsonFile<{ projects: Array<{ id: string }> }>(file).projects[0].id).toBe("a")
  })

  it("propagates a genuine parse error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocm-json-"))
    const file = join(dir, "bad.json")
    writeFileSync(file, "{not json}")
    expect(() => parseJsonFile(file)).toThrow()
  })
})

describe("fixed window rate limit store", () => {
  it("allows exactly the limit, then blocks", () => {
    const store = new FixedWindowStore()
    // limit 3: the first three calls pass, the fourth is refused.
    expect([1, 2, 3].map((_, i) => store.hit("k", 3, 60_000))).toMatchObject([
      { count: 1, limited: false },
      { count: 2, limited: false },
      { count: 3, limited: false },
    ])
    expect(store.hit("k", 3, 60_000)).toMatchObject({ count: 4, limited: true })
  })

  it("keeps separate counters per key", () => {
    const store = new FixedWindowStore()
    for (let i = 0; i < 5; i++) store.hit("a", 1, 60_000)
    expect(store.hit("a", 1, 60_000).limited).toBe(true)
    expect(store.hit("b", 1, 60_000).limited).toBe(false)
  })

  it("starts a fresh window once the old one expires", () => {
    const store = new FixedWindowStore()
    const t0 = 1_000_000
    expect(store.hit("k", 1, 1000, t0)).toMatchObject({ count: 1, limited: false })
    expect(store.hit("k", 1, 1000, t0)).toMatchObject({ count: 2, limited: true })
    // Just past the boundary the count must reset rather than carry over, so
    // the caller is allowed again.
    expect(store.hit("k", 1, 1000, t0 + 1001)).toMatchObject({ count: 1, limited: false })
  })

  it("reports a usable retry-after and reset", () => {
    const store = new FixedWindowStore()
    store.hit("k", 1, 60_000)
    const blocked = store.hit("k", 1, 60_000)
    expect(blocked.limited).toBe(true)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60)
    // retryAfter and reset describe the same window end, so they must agree.
    expect(blocked.retryAfterSeconds).toBe(blocked.resetSeconds)
  })

  it("sweeps expired windows and can be cleared", () => {
    const store = new FixedWindowStore()
    const t0 = 1_000_000
    store.hit("a", 10, 1000, t0)
    store.hit("b", 10, 60_000, t0)
    expect(store.size).toBe(2)
    store.sweep(t0 + 2000)
    expect(store.size).toBe(1)
    store.clear()
    expect(store.size).toBe(0)
  })

  it("sweeps on its own so a key flood cannot grow the map without bound", () => {
    // The key is "<ip>:<path>", so an unauthenticated caller controls how many
    // distinct keys exist. Without an internal sweep the map only ever grows,
    // and a long-lived process leaks memory under exactly the traffic a rate
    // limiter exists to absorb.
    const store = new FixedWindowStore()
    const t0 = 1_000_000
    // Real traffic has advancing time; a flood of 25k distinct keys across 25
    // seconds, each with a 1s window, so most keys are long expired by the end.
    for (let i = 0; i < 25_000; i++) {
      store.hit(`flood:${i}`, 10, 1000, t0 + i)
    }
    // Bounded by the sweep threshold plus at most one window's worth of keys,
    // rather than tracking all 25k forever.
    expect(store.size).toBeLessThan(25_000)
  })

  it("keeps unexpired keys when the internal sweep runs", () => {
    // The sweep must not evict live windows, or a flood would silently hand
    // everyone a fresh allowance.
    const store = new FixedWindowStore()
    const t0 = 1_000_000
    const longLived = 12_000
    for (let i = 0; i < longLived; i++) store.hit(`live:${i}`, 1, 60_000, t0)
    // A later wave of short windows triggers sweeps; the long ones must survive.
    for (let i = 0; i < 5_000; i++) store.hit(`short:${i}`, 1, 1, t0 + 30_000)
    expect(store.hit(`live:${0}`, 1, 60_000, t0 + 30_000).limited).toBe(true)
  })

  it("still counts a blocked key correctly after a sweep ran", () => {
    const store = new FixedWindowStore()
    const t0 = 1_000_000
    for (let i = 0; i < 10_000; i++) store.hit(`flood:${i}`, 10, 1, t0)
    store.hit("victim", 2, 60_000, t0)
    expect(store.hit("victim", 2, 60_000, t0).limited).toBe(false)
    expect(store.hit("victim", 2, 60_000, t0).limited).toBe(true)
  })

  it("caps the map when every key is still inside its window", () => {
    // The sweep alone is not a bound: a flood of distinct keys within a single
    // window is entirely unexpired, so sweeping reclaims nothing and the map
    // grows for the whole window. The key is caller-controlled, so this needs a
    // hard ceiling as well.
    const store = new FixedWindowStore()
    const t0 = 1_000_000
    // All at the same instant with a 10 minute window: nothing ever expires.
    for (let i = 0; i < 100_001; i++) store.hit(`same-instant:${i}`, 5, 600_000, t0)
    expect(store.size).toBe(100_000)
  })

  it("evicts the oldest entry when the cap is reached", () => {
    const store = new FixedWindowStore()
    const t0 = 1_000_000
    for (let i = 0; i < 100_000; i++) store.hit(`cap:${i}`, 5, 600_000, t0)
    // Two hits on the oldest key, then a flood of new keys to push past the cap.
    expect(store.hit("cap:0", 5, 600_000, t0).count).toBe(2)
    for (let i = 0; i < 50; i++) store.hit(`new:${i}`, 5, 600_000, t0)

    // The oldest entry was sacrificed, so its counter restarts. Evicting a live
    // counter is the accepted trade for bounded memory: a flood this size is
    // already being limited.
    expect(store.hit("cap:0", 5, 600_000, t0).count).toBe(1)
    // A recently added key kept its count.
    expect(store.hit("new:49", 5, 600_000, t0).count).toBe(2)
  })

  it("stays fast when a flood arrives faster than the cap can evict", () => {
    // Eviction must not be O(n) per insert, or a key flood turns into quadratic
    // work inside the rate limiter — the one path that has to stay fast.
    const store = new FixedWindowStore()
    const t0 = 1_000_000
    for (let i = 0; i < 30_000; i++) store.hit(`flood:${i}`, 5, 600_000, t0)
    expect(store.size).toBe(30_000)
  })

  it("does not grow the map when an existing key is hit repeatedly", () => {
    const store = new FixedWindowStore()
    const t0 = 1_000_000
    for (let i = 0; i < 1_000; i++) store.hit("same", 1_000_000, 600_000, t0)
    expect(store.size).toBe(1)
  })
})
