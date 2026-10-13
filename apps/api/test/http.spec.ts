import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { Test } from "@nestjs/testing"
import type { NestExpressApplication } from "@nestjs/platform-express"
import request from "supertest"
import { authenticator } from "otplib"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer as httpCreateServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppModule } from "../src/app.module.js"
import { EventHub } from "../src/gateway/event-hub.js"
import type { ProjectEntry } from "../src/projects/registry.js"
import { resetConfig } from "../src/config.js"
import { DB, APP_ORIGIN, RATE_LIMIT_STORE } from "../src/tokens.js"
import { FixedWindowStore } from "../src/rate-limit.js"
import { openDb, type Db } from "../src/auth/db.js"
import { AuthService } from "../src/auth/service.js"

const ORIGIN = "https://ocm.test"
const USER = "usuario"
const PW = "correct horse battery 42"
const COOKIE = "__Host-ocm_session"

let app: NestExpressApplication
let db: Db
let dataDir: string
let store: FixedWindowStore

/** The only cookie-pair value from a Set-Cookie header. */
function cookiePair(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined
  expect(raw, "expected a Set-Cookie header").toBeDefined()
  return (raw as string[]).find((c) => c.startsWith(COOKIE))!.split(";")[0]
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ocm-http-"))
  // A registry with one project pointing at a port nothing is listening on, so
  // the proxy can be tested for its failure path without spawning opencode.
  mkdirSync(join(dataDir, ".."), { recursive: true })
    writeFileSync(
      join(dataDir, "projects.json"),
      JSON.stringify({ version: 1, active: "demo", projects: [{ id: "demo", name: "Demo", path: dataDir, port: 4199 }] }),
    )
    // The proxy resolves the upstream through SERVE_HOST; point it at loopback
    // so these tests never depend on a host.docker.internal entry existing.
    process.env.SERVE_HOST = "127.0.0.1"

  process.env.DATA_DIR = dataDir
  process.env.APP_ORIGIN = ORIGIN
  process.env.SUPERVISOR_TOKEN = "test-token-not-used-offline"
  process.env.SERVE_PASSWORD = "serve-test-password"
  process.env.SESSION_COOKIE_NAME = COOKIE
  process.env.LOG_LEVEL = "silent"
  resetConfig()

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(openDb(":memory:"))
    .overrideProvider(APP_ORIGIN)
    .useValue([ORIGIN])
    .compile()

  app = moduleRef.createNestApplication<NestExpressApplication>({
    // Mirrors main.ts. The /api/serve proxy cannot re-send a request body unless
    // Nest keeps the raw bytes, because its body parser consumes the stream
    // before the controller runs.
    rawBody: true,
  })
  // Mirrors main.ts. Without this req.ip is the raw socket address, which is
  // what the rate limiter keys on.
  app.set("trust proxy", 1)
  await app.init()

  db = app.get<Db>(DB)
  store = moduleRef.get<FixedWindowStore>(RATE_LIMIT_STORE)
})

afterAll(async () => {
  await app.close()
})

beforeEach(async () => {
  // Rate-limit state is per-process and keyed by client IP, so it has to be
  // reset between tests or unrelated tests trip each other's limits.
  store.clear()
  db.exec("DELETE FROM sessions; DELETE FROM recovery_codes; DELETE FROM bot_tokens; DELETE FROM users;")
  // The TOTP limiter is in-memory on the app's AuthService singleton and is NOT
  // part of the database, so clearing rows above does not reset it. A test that
  // deliberately burns 5 failures would otherwise lock every later test in the
  // file for 15 minutes.
  app.get(AuthService).totpLimiter.resetAll()
})

/** Creates the single user, since setup is CLI-only and has no HTTP route. */
async function seedUser(totp = false): Promise<void> {
  const svc = new AuthService(db, { ttlMs: 86_400_000, slideIntervalMs: 3_600_000 })
  await svc.setup({ username: USER, password: PW, totpSecret: totp ? "JBSWY3DPEHPK3PXP" : null })
}

async function login(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app.getHttpServer())
    .post("/api/auth/login")
    .set("Origin", ORIGIN)
    .send({ username: USER, password: PW, ...overrides })
  expect(res.status).toBe(200)
  return cookiePair(res)
}

describe("setup state", () => {
  it("reports setup required and refuses login before any user exists", async () => {
    const state = await request(app.getHttpServer()).get("/api/auth/state")
    expect(state.status).toBe(200)
    expect(state.body).toMatchObject({ setupRequired: true, totpEnabled: false })

    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: USER, password: PW })
    // 423, not 401: this is a "no account configured" state, not a bad attempt.
    expect(res.status).toBe(423)
    expect(res.body.code).toBe("setup_required")
  })

  it("never exposes an account-creation route over HTTP", async () => {
    for (const method of ["post", "get"] as const) {
      const res = await request(app.getHttpServer())[method]("/api/auth/setup")
      expect(res.status).toBe(404)
    }
  })
})

describe("login body contract", () => {
  // Regression: the web client sent `code`/`recovery` while the controller read
  // `totpCode`/`recoveryCode`. Every code typed in the browser arrived as
  // undefined and came back as invalid_totp regardless of its value. The service
  // tests could not catch this because they call svc.login() directly and never
  // build the JSON body, so this is pinned at the HTTP boundary on purpose.
  const SECRET = "JBSWY3DPEHPK3PXP"

  beforeEach(async () => {
    await seedUser(true)
  })

  it("accepts a valid TOTP sent as totpCode, over the wire", async () => {
    const code = authenticator.clone({ window: 0 }).generate(SECRET)
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: USER, password: PW, totpCode: code })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.headers["set-cookie"]).toBeDefined()
  })

  it("accepts a recovery code sent as recoveryCode", async () => {
    const svc = new AuthService(db, { ttlMs: 86_400_000, slideIntervalMs: 3_600_000 })
    const [code] = svc.regenerateRecoveryCodes()
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: USER, password: PW, recoveryCode: code })
    expect(res.status).toBe(200)
    // Success is {ok:true} plus the session cookie; the controller does not echo
    // which factor was used.
    expect(res.body.ok).toBe(true)
    expect(res.headers["set-cookie"]).toBeDefined()
  })

  it("still rejects a wrong code sent as totpCode", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: USER, password: PW, totpCode: "000000" })
    // 401 with passwordAccepted: the password was right, the second factor was not.
    expect(res.status).toBe(401)
    expect(res.body.code).toBe("invalid_totp")
    expect(res.body.passwordAccepted).toBe(true)
  })

  it("signals passwordAccepted when a TOTP user submits no code at all", async () => {
    // The first step of the browser flow sends username+password only. The API has
    // no `totp_required` code, so this is the signal the client uses to reveal the
    // code field. Without it the form loops on invalid_totp forever.
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: USER, password: PW })
    expect(res.status).toBe(401)
    expect(res.body.code).toBe("invalid_totp")
    expect(res.body.passwordAccepted).toBe(true)
  })

  it("completes the real two-step flow: password, then code", async () => {
    const step1 = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: USER, password: PW })
    expect(step1.body.passwordAccepted).toBe(true)

    const step2 = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({
        username: USER,
        password: PW,
        totpCode: authenticator.clone({ window: 0 }).generate(SECRET),
      })
    expect(step2.status).toBe(200)
    expect(step2.body.ok).toBe(true)
    expect(step2.headers["set-cookie"]).toBeDefined()
  })

  it("reports the lockout code the client actually matches on", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post("/api/auth/login")
        .set("Origin", ORIGIN)
        .send({ username: USER, password: PW, totpCode: "000000" })
    }
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: USER, password: PW, totpCode: "000000" })
    expect(res.body.code).toBe("totp_locked_out")
    expect(res.headers["retry-after"]).toBeDefined()
  })
})

describe("CSRF origin enforcement", () => {
  beforeEach(async () => {
    await seedUser()
  })

  it("rejects a mutating request from a foreign origin", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", "https://evil.example")
      .send({ username: USER, password: PW })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe("bad_origin")
  })

  it("rejects a mutating request with no Origin at all", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ username: USER, password: PW })
    expect(res.status).toBe(403)
  })

  it("rejects a lookalike origin, not just a different host", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", "https://ocm.test.evil.example")
      .send({ username: USER, password: PW })
    expect(res.status).toBe(403)
  })

  it("does not apply the origin rule to safe methods", async () => {
    const res = await request(app.getHttpServer()).get("/api/auth/state")
    expect(res.status).toBe(200)
  })

  it("does not treat a bogus bearer token as a CSRF exemption", async () => {
    // The exemption must be gated on a *valid* token, otherwise any attacker
    // page can bypass CSRF just by setting an Authorization header.
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", "https://evil.example")
      .set("Authorization", "Bearer ocm_totally_made_up")
      .send({ username: USER, password: PW })
    expect(res.status).toBe(403)
  })

  it("exempts a request carrying a valid bot token", async () => {
    const cookie = await login()
    const minted = await request(app.getHttpServer())
      .post("/api/auth/bot-tokens")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .send({ label: "telegram" })
    expect(minted.status).toBe(201)
    const token = minted.body.token as string
    expect(token.startsWith("ocm_")).toBe(true)

    // No Origin header at all, authorised by bearer instead. Reaching a 200
    // proves the Origin guard let it through rather than rejecting it.
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Authorization", `Bearer ${token}`)
      .send({ username: USER, password: PW })
    expect(res.status).toBe(200)
  })

  it("does not let a bot token stand in for a session on guarded routes", async () => {
    const cookie = await login()
    const minted = await request(app.getHttpServer())
      .post("/api/auth/bot-tokens")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .send({ label: "telegram" })
    const token = minted.body.token as string

    // A leaked Telegram token must not become a full API credential. Bot tokens
    // bypass CSRF only; they do not authenticate the session-guarded surface.
    const res = await request(app.getHttpServer())
      .post("/api/auth/sessions/revoke-all")
      .set("Authorization", `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(401)
  })
})

describe("login", () => {
  beforeEach(async () => {
    await seedUser()
  })

  it("issues a hardened session cookie", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: USER, password: PW })

    expect(res.status).toBe(200)
    const setCookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith(COOKIE))!
    // Every attribute the __Host- prefix implies, asserted explicitly.
    expect(setCookie).toContain("Path=/")
    expect(setCookie).toContain("Secure")
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Strict")
    expect(setCookie).toMatch(/Max-Age=2592000/)
    // __Host- forbids Domain, and forbids a value that could be path-confused.
    expect(setCookie).not.toMatch(/Domain=/i)
    expect(cookiePair(res).split("=")[1]).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("rejects a wrong password without revealing which factor failed", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: USER, password: "wrong password entirely" })
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ code: "invalid_credentials", passwordAccepted: false })
  })

  it("treats an unknown username exactly like a wrong password", async () => {
    const unknown = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: "nobody", password: PW })
    const wrong = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: USER, password: "wrong password entirely" })
    expect(unknown.status).toBe(wrong.status)
    expect(unknown.body.code).toBe(wrong.body.code)
  })

  it("rate limits repeated attempts from one IP", async () => {
    // The limit is 8 per minute; the 9th must be refused regardless of whether
    // the credentials were correct.
    let sawThrottle = false
    for (let i = 0; i < 12; i++) {
      const res = await request(app.getHttpServer())
        .post("/api/auth/login")
        .set("Origin", ORIGIN)
        .send({ username: USER, password: "wrong password entirely" })
      if (res.status === 429) {
        sawThrottle = true
        break
      }
    }
    expect(sawThrottle).toBe(true)
  })
})

describe("session guard", () => {
  beforeEach(async () => {
    await seedUser()
  })

  it("rejects protected routes without a cookie", async () => {
    for (const path of ["/api/gateway/health", "/api/projects", "/api/auth/sessions"]) {
      const res = await request(app.getHttpServer()).get(path)
      expect(res.status, path).toBe(401)
    }
  })

  it("rejects a forged or garbage cookie", async () => {
    for (const value of ["ocm_nope", "x", "a".repeat(43)]) {
      const res = await request(app.getHttpServer()).get("/api/projects").set("Cookie", `${COOKIE}=${value}`)
      expect(res.status, value).toBe(401)
    }
  })

  it("reports the signed-in user, and only then", async () => {
    const anon = await request(app.getHttpServer()).get("/api/auth/session")
    expect(anon.status).toBe(401)
    expect(anon.body.code).toBe("unauthenticated")

    const cookie = await login()
    const me = await request(app.getHttpServer()).get("/api/auth/session").set("Cookie", cookie)
    expect(me.status).toBe(200)
    // Not merely "true": a blank name is the failure this guards against, since
    // the session row has no username column of its own.
    expect(me.body).toEqual({ authenticated: true, username: USER })
  })

  it("does not leak session state through the unauthenticated state endpoint", async () => {
    // /api/auth/state must stay answerable by a signed-out visitor, or it becomes
    // a way to probe for valid accounts. It therefore says nothing about the
    // session, and the client uses /api/auth/session for that instead.
    const res = await request(app.getHttpServer()).get("/api/auth/state")
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(["setupRequired", "totpEnabled"])
  })

  it("allows a real session and reports the active project", async () => {
    const cookie = await login()
    const res = await request(app.getHttpServer()).get("/api/projects").set("Cookie", cookie)
    expect(res.status).toBe(200)
    expect(res.body.active).toBe("demo")
    expect(res.body.projects).toHaveLength(1)
  })

  it("lists sessions and identifies the current one", async () => {
    const cookie = await login()
    const res = await request(app.getHttpServer()).get("/api/auth/sessions").set("Cookie", cookie)
    expect(res.status).toBe(200)
    expect(res.body.sessions).toHaveLength(1)
    expect(res.body.sessions[0].kind).toBe("web")
    expect(typeof res.body.current).toBe("number")
  })

  it("revokes every session, and the caller with it", async () => {
    const a = await login()
    const b = await login()
    expect((await request(app.getHttpServer()).get("/api/projects").set("Cookie", a)).status).toBe(200)
    expect((await request(app.getHttpServer()).get("/api/projects").set("Cookie", b)).status).toBe(200)

    const revoked = await request(app.getHttpServer())
      .post("/api/auth/sessions/revoke-all")
      .set("Origin", ORIGIN)
      .set("Cookie", a)
    expect(revoked.status).toBe(201)
    expect(revoked.body.revoked).toBeGreaterThan(0)

    expect((await request(app.getHttpServer()).get("/api/projects").set("Cookie", a)).status).toBe(401)
    expect((await request(app.getHttpServer()).get("/api/projects").set("Cookie", b)).status).toBe(401)
  })

  it("logs out and clears the cookie", async () => {
    const cookie = await login()
    const res = await request(app.getHttpServer())
      .post("/api/auth/logout")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)

    expect(res.status).toBe(201)
    const cleared = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith(COOKIE))!
    expect(cleared).toMatch(/Max-Age=0/)
    expect((await request(app.getHttpServer()).get("/api/projects").set("Cookie", cookie)).status).toBe(401)
  })
})

describe("password change", () => {
  beforeEach(async () => {
    await seedUser()
  })

  it("requires the current password and invalidates all sessions", async () => {
    const cookie = await login()
    const wrong = await request(app.getHttpServer())
      .post("/api/auth/password")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .send({ currentPassword: "not it", newPassword: "a brand new good password 9" })
    expect(wrong.status).toBe(401)
    expect((await request(app.getHttpServer()).get("/api/projects").set("Cookie", cookie)).status).toBe(200)

    const changed = await request(app.getHttpServer())
      .post("/api/auth/password")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .send({ currentPassword: PW, newPassword: "a brand new good password 9" })
    expect(changed.status).toBe(200)
    expect(changed.body.reauthRequired).toBe(true)
    expect((await request(app.getHttpServer()).get("/api/projects").set("Cookie", cookie)).status).toBe(401)

    const fresh = await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({ username: USER, password: "a brand new good password 9" })
    expect(fresh.status).toBe(200)
  })

  it("refuses a weak replacement password", async () => {
    const cookie = await login()
    const res = await request(app.getHttpServer())
      .post("/api/auth/password")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .send({ currentPassword: PW, newPassword: "short" })
    expect(res.status).toBe(401)
  })
})

describe("bot tokens over HTTP", () => {
  beforeEach(async () => {
    await seedUser()
  })

  it("returns the secret exactly once, then only metadata", async () => {
    const cookie = await login()
    const created = await request(app.getHttpServer())
      .post("/api/auth/bot-tokens")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .send({ label: "telegram" })
    expect(created.status).toBe(201)
    expect(typeof created.body.token).toBe("string")

    const listed = await request(app.getHttpServer()).get("/api/auth/bot-tokens").set("Cookie", cookie)
    expect(listed.status).toBe(200)
    expect(listed.body.tokens[0].label).toBe("telegram")
    // The plaintext must not be recoverable from the list.
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token)
  })
})

describe("serve proxy", () => {
  beforeEach(async () => {
    await seedUser()
  })

  it("requires a session before reaching opencode", async () => {
    const res = await request(app.getHttpServer()).get("/api/serve/session")
    expect(res.status).toBe(401)
  })

  it("returns an actionable 503 when the host serve is down", async () => {
    const cookie = await login()
    const res = await request(app.getHttpServer())
      .get("/api/serve/global/health")
      .set("Cookie", cookie)
      .set("Origin", ORIGIN)

    expect(res.status).toBe(503)
    expect(res.body.code).toBe("serve_unavailable")
    // The message must say which project and why, not just "something failed".
    expect(JSON.stringify(res.body)).toContain("Demo")
  })
})

/**
 * The proxy against a real HTTP upstream.
 *
 * The 503 test above only proves the connection-refused path. It cannot catch a
 * dropped request body, because nothing ever gets far enough to parse one â€” and
 * that is exactly the failure this found: Nest's body parser had already consumed
 * the request, so `req.pipe(upstream)` sent zero bytes and the upstream answered
 * "Expected object, got undefined". A real server is the only thing that can
 * assert the body arrives.
 */
describe("serve proxy request forwarding", () => {
  let upstream: import("node:http").Server
  let upstreamPort = 0
  const http = { createServer: httpCreateServer }
  const received: Array<{ method: string; url: string; body: string; auth: string | undefined }> = []

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8")
        received.push({ method: req.method ?? "", url: req.url ?? "", body, auth: req.headers.authorization })

        if (req.url?.startsWith("/session/") && req.url.includes("/permissions/")) {
          // Mirror the upstream's real behaviour: a missing `response` field is
          // rejected, which is how the dropped body was detected live.
          let parsed: { response?: string } = {}
          try {
            parsed = JSON.parse(body) as { response?: string }
          } catch {
            parsed = {}
          }
          const ok = typeof parsed.response === "string" && ["once", "always", "reject"].includes(parsed.response)
          res.writeHead(ok ? 200 : 400, { "content-type": "application/json" })
          res.end(JSON.stringify(ok ? { ok: true } : { message: "Expected object, got undefined" }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, echo: body }))
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const addr = upstream.address()
    upstreamPort = typeof addr === "object" && addr ? addr.port : 0

    // Point the registry's demo project at this server for the duration.
    writeFileSync(
      join(dataDir, "projects.json"),
      JSON.stringify({ version: 1, active: "demo", projects: [{ id: "demo", name: "Demo", path: dataDir, port: upstreamPort }] }),
    )
    resetConfig()
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    delete process.env.SERVE_HOST
    resetConfig()
  })

  beforeEach(() => {
    received.length = 0
  })

  it("forwards a POST body to the upstream", async () => {
    // Regression test. With rawBody unset, Nest's parser had already consumed the
    // request and `req.pipe(upstream)` sent nothing, so the upstream answered
    // 400 "Expected object, got undefined" for every permission button press.
    await seedUser()
    const cookie = await login()
    const res = await request(app.getHttpServer())
      .post("/api/serve/session/ses_x/permissions/per_x")
      .set("Cookie", cookie)
      .set("Origin", ORIGIN)
      .send({ response: "once" })

    // The decisive assertion: the upstream saw the body, so it accepted it.
    expect(res.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0].body)).toEqual({ response: "once" })
  })

  it("preserves the upstream's rejection when the body is wrong", async () => {
    await seedUser()
    const cookie = await login()
    const res = await request(app.getHttpServer())
      .post("/api/serve/session/ses_x/permissions/per_x")
      .set("Cookie", cookie)
      .set("Origin", ORIGIN)
      .send({ response: "allow" })

    // "allow" is not in the upstream's enum. A proxy that swallowed the body
    // would also return 400 here, which is why the positive case above matters.
    expect(res.status).toBe(400)
    expect(received[0].body).toContain("allow")
  })

  it("forwards the query string and method", async () => {
    await seedUser()
    const cookie = await login()
    await request(app.getHttpServer())
      .get("/api/serve/session?directory=C%3A%5Ctmp")
      .set("Cookie", cookie)
      .set("Origin", ORIGIN)
      .expect(200)

    expect(received[0].method).toBe("GET")
    expect(received[0].url).toContain("directory=C%3A%5Ctmp")
  })

  it("replaces the client's credentials with the serve password", async () => {
    await seedUser()
    const cookie = await login()
    await request(app.getHttpServer())
      .get("/api/serve/session")
      .set("Cookie", cookie)
      .set("Origin", ORIGIN)
      .expect(200)

    // The browser's session cookie must never reach opencode, and the upstream
    // must see exactly one Basic credential: the serve password.
    const expected = `Basic ${Buffer.from(`opencode:${process.env.SERVE_PASSWORD}`).toString("base64")}`
    expect(received[0].auth).toBe(expected)
  })

  it("does not forward a request body on GET", async () => {
    await seedUser()
    const cookie = await login()
    await request(app.getHttpServer())
      .get("/api/serve/session")
      .set("Cookie", cookie)
      .set("Origin", ORIGIN)
      .expect(200)

    expect(received[0].body).toBe("")
  })
})

/**
 * The event stream through the real HTTP stack.
 *
 * The hub's own tests prove the fan-out in isolation. This proves the wiring:
 * that `/api/serve/event` is actually served from the hub, that several
 * simultaneous browser requests cost one upstream connection, and that closing
 * one does not take the rest down. A hub that is correct but not reached is
 * indistinguishable from no hub at all, and this is the only test that would
 * notice.
 */
describe("event stream fan-out over HTTP", () => {
  let upstream: import("node:http").Server
  let upstreamPort = 0
  // supertest binds its own ephemeral port per request, so there is no address to
  // read for a stream that is meant to stay open. The app is put on a real
  // listener for this block instead; supertest copes with a listening server and
  // the outer afterAll still closes the app.
  let listenPort = 0
  const sockets = new Set<import("node:http").ServerResponse>()
  const seen: Array<{ url: string; auth: string | undefined }> = []

  beforeAll(async () => {
    upstream = httpCreateServer((req, res) => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization })
      if (req.url?.startsWith("/event")) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        // Flushed, like the real thing, so the client's response callback fires
        // at once rather than waiting for the first frame.
        res.flushHeaders()
        sockets.add(res)
        res.on("close", () => sockets.delete(res))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const addr = upstream.address()
    upstreamPort = typeof addr === "object" && addr ? addr.port : 0

    writeFileSync(
      join(dataDir, "projects.json"),
      JSON.stringify({ version: 1, active: "demo", projects: [{ id: "demo", name: "Demo", path: dataDir, port: upstreamPort }] }),
    )
    resetConfig()

    await app.listen(0, "127.0.0.1")
    const bound = app.getHttpServer().address()
    listenPort = typeof bound === "object" && bound ? bound.port : 0
  })

  afterAll(async () => {
    for (const res of sockets) res.destroy()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  beforeEach(() => {
    seen.length = 0
  })

  async function waitFor(fn: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
    const start = Date.now()
    while (!fn()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it(
    "routes /event through the hub, so the browser and the notifier share one upstream connection",
    async () => {
      await seedUser()
      const cookie = await login()
      const hub = app.get(EventHub)
      const entry: ProjectEntry = { id: "demo", name: "Demo", path: dataDir, port: upstreamPort }

      // A live EventSource, so the request is a real streaming one. It is not
      // awaited to completion: the response headers only go out once the hub is
      // open, and a socket left open for the life of the stream makes this test
      // hostage to whatever the host firewall does with long-lived loopback
      // connections. What is asserted is the wiring and the connection
      // arithmetic, both of which are observable without holding the socket.
      const abort = new AbortController()
      const req = httpRequest(
        { host: "127.0.0.1", port: listenPort, path: "/api/serve/event", headers: { Cookie: cookie, Accept: "text/event-stream" } },
        () => undefined,
      )
      req.on("error", () => undefined)
      req.end()

      // The wiring claim: a browser hitting /api/serve/event attaches to the hub,
      // and the hub is what dials opencode — once, with its own credential.
      await waitFor(() => seen.filter((s) => s.url.startsWith("/event")).length >= 1, "upstream dial")
      await waitFor(() => hub.subscriberCount("demo") >= 1, "hub subscriber")
      expect(seen.filter((s) => s.url.startsWith("/event"))).toHaveLength(1)
      expect(hub.state("demo")).toBe("open")

      // The browser's session cookie must not reach opencode; the hub supplies
      // the serve credential itself.
      expect(seen[0].auth).toBe(`Basic ${Buffer.from(`opencode:${process.env.SERVE_PASSWORD}`).toString("base64")}`)

      // Frames written upstream reach a browser subscriber, and the frames the
      // hub emits are the ones opencode sent.
      const extra: string[][] = [[], []]
      const detach = extra.map((sink) =>
        hub.subscribe(entry, {
          deliver: (event) => sink.push(JSON.stringify(event)),
        }),
      )
      expect(hub.subscriberCount("demo")).toBe(3)

      for (const res of sockets) res.write('data: {"id":"evt_1","type":"message.updated","properties":{"id":"m2"}}\n\n')
      await waitFor(() => extra.every((sink) => sink.join("").includes("m2")), "subscribers served")
      expect(extra[0].join("")).toContain('"type":"message.updated"')

      // Two more subscribers, no further upstream connection. This is the
      // property the whole change exists for: a disconnect storm upstream now
      // costs one reconnect instead of one per tab.
      await new Promise((r) => setTimeout(r, 250))
      expect(seen.filter((s) => s.url.startsWith("/event"))).toHaveLength(1)

      // Dropping one subscriber mid-stream leaves the rest running. The proxy
      // used to tear down the upstream request whenever any client disconnected.
      detach[0]()
      expect(hub.subscriberCount("demo")).toBe(2)
      for (const res of sockets) res.write('data: {"id":"evt_2","type":"message.updated","properties":{"id":"m3"}}\n\n')
      await waitFor(() => extra[1].join("").includes("m3"), "survivor served")
      expect(seen.filter((s) => s.url.startsWith("/event"))).toHaveLength(1)

      for (const off of detach) off()
      abort.abort()
      req.destroy()
    },
    30_000,
  )
})
