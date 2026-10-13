import { existsSync } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"

export interface AppConfig {
  port: number
  /**
   * Interface the HTTP server binds.
   *
   * Loopback by default, and that default is the point: cloudflared runs on the
   * same host and connects over 127.0.0.1, so nothing legitimate needs the
   * gateway on a routable address. Binding 0.0.0.0 would expose the login
   * endpoint, and through the proxy a full coding agent, to the whole LAN.
   * Set GATEWAY_BIND_HOST=0.0.0.0 only if the tunnel itself runs elsewhere.
   */
  bindHost: string
  logLevel: string
  /**
   * Every origin allowed to make cookie-authenticated mutations. A list rather
   * than a single value because the same API is legitimately reachable at more
   * than one origin in development (Vite dev server, direct API, LAN IP) and a
   * tunnel hostname has to coexist with localhost.
   */
  appOrigins: string[]
  dataDir: string
  logDir: string
  session: {
    ttlMs: number
    slideIntervalMs: number
    cookieName: string
  }
  rateLimit: {
    globalPerMinute: number
    loginPerMinute: number
  }
  serve: {
    /**
     * Host used to reach a project's `opencode serve`.
     *
     * Resolved once here rather than read from the environment at each use site.
     * The event hub, the proxy, and the notifier all have to agree on this or
     * they will not be talking to the same process, and a silent disagreement is
     * far harder to diagnose than a missing variable. The default is
     * host.docker.internal because that is the only value that works inside the
     * gateway container; a native run has to set SERVE_HOST=127.0.0.1.
     */
    host: string
    password: string
    bindHost: string
    portBase: number
    idleShutdownMinutes: number
  }
  supervisor: {
    url: string
    port: number
    /** Shared secret for the supervisor API. Required: it spawns processes. */
    token: string
    opencodeBin: string
    opencodeVersion: string
  }
  telegram: {
    botToken: string
    allowedUserId: string
    appUrl: string
  }
}

export class ConfigError extends Error {}

function req(name: string, raw: string | undefined): string {
  const v = raw?.trim()
  if (!v) throw new ConfigError(`Missing required env var: ${name}`)
  return v
}

function int(name: string, raw: string | undefined, fallback: number): number {
  const v = raw?.trim()
  if (!v) return fallback
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) throw new ConfigError(`Env var ${name} must be an integer, got: ${v}`)
  return n
}

function opt(name: string, raw: string | undefined, fallback = ""): string {
  return raw?.trim() || fallback
}

/** Normalise a public origin to scheme+host+port with no trailing slash. */
function normaliseOrigin(raw: string, name: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ConfigError(`Env var ${name} must be an absolute URL, got: ${raw}`)
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new ConfigError(`Env var ${name} must be http(s), got: ${u.protocol}`)
  }
  if (u.pathname !== "/" && u.pathname !== "") {
    throw new ConfigError(`Env var ${name} must not contain a path, got: ${u.pathname}`)
  }
  return u.origin
}

/**
 * APP_ORIGIN is a comma-separated allowlist.
 *
 * A single value would force the developer to choose between running the Vite
 * dev server and running the API directly, and would make a tunnel hostname
 * mutually exclusive with localhost. Each entry is normalised the same way as
 * a single origin, so "https://x.example.com/" and "https://x.example.com" are
 * not treated as two different origins.
 */
export function normaliseOriginList(raw: string): string[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (parts.length === 0) throw new ConfigError("APP_ORIGIN must list at least one origin")

  const out: string[] = []
  for (const part of parts) {
    const norm = normaliseOrigin(part, "APP_ORIGIN")
    if (!out.includes(norm)) out.push(norm)
  }

  // http:// on a non-loopback host means the session cookie can leave the
  // machine in cleartext. Refuse it rather than let it be discovered in review.
  for (const o of out) {
    // "localhost" is a loopback name, not a routable host, and resolves to
    // 127.0.0.1 / ::1 on the machine that runs the browser. Subdomains of
    // localhost are excluded: "evil.localhost" is resolved by some resolvers
    // and is not covered by the loopback guarantee this check relies on.
    // The port is optional but constrained, so a dev origin on :5173 passes while
    // "localhost.evil.com:80" cannot slip through the host match.
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d{1,5})?$/.test(o)
    if (o.startsWith("http://") && !isLoopback) {
      throw new ConfigError(
        `APP_ORIGIN entry "${o}" uses http on a non-loopback host. Use https, or a loopback address for local development.`,
      )
    }
  }
  return out
}

function abs(p: string): string {
  return isAbsolute(p) ? p : resolve(workspaceRoot(), p)
}

/**
 * Walk up looking for pnpm-workspace.yaml.
 *
 * Relative DATA_DIR/LOG_DIR must resolve the same way whether the process was
 * started from the repo root, from apps/api, or from /app inside the container.
 * Anchoring to the workspace root removes that whole class of "works in dev,
 * writes somewhere else in prod" bug. Falls back to cwd if the marker is absent
 * (e.g. running from a published package).
 */
let cachedRoot: string | null = null

function workspaceRoot(): string {
  if (cachedRoot) return cachedRoot
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
      cachedRoot = dir
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Container images do not necessarily ship pnpm-workspace.yaml, so honour an
  // explicit override before falling back to cwd.
  cachedRoot = process.env.WORKSPACE_ROOT?.trim() || process.cwd()
  return cachedRoot
}

/** Absolute path to something inside the workspace, regardless of cwd. */
export function workspacePath(...segments: string[]): string {
  return resolve(workspaceRoot(), ...segments)
}

function loadDotEnv(): void {
  // Tests never see the developer's .env. That file is machine-specific: it
  // carries live credentials (Telegram bot token, supervisor token) and
  // deployment choices (DEPLOYMENT, rate limits, SSE tuning). A test that loads
  // it stops being hermetic — the notifier enables itself with the real bot
  // token and dials Telegram mid-run, which added a subscriber the tests did not
  // make and left a connection that hung app teardown. The guard lives here so
  // none of the suite's many loadConfig/resetConfig call sites can forget it.
  // VITEST=true is the marker (not NODE_ENV=test, which a production process
  // could legitimately carry).
  if (process.env.VITEST === "true") return

  // Node >=20.12 can read .env natively; no dotenv dependency needed.
  // Candidates are anchored to the workspace root, not cwd, so the dev server,
  // the CLIs, and the container all read the same file.
  const root = workspaceRoot()
  for (const candidate of [resolve(root, ".env"), resolve(process.cwd(), ".env"), resolve(root, "apps/api/.env")]) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate)
      } catch (err) {
        throw new ConfigError(`Failed to load ${candidate}: ${(err as Error).message}`)
      }
      return
    }
  }
}

let cached: AppConfig | null = null

export function loadConfig(force = false): AppConfig {
  if (cached && !force) return cached
  loadDotEnv()

  const cookieName = opt("SESSION_COOKIE_NAME", process.env.SESSION_COOKIE_NAME, "__Host-ocm_session")
  if (!cookieName.startsWith("__Host-") && !cookieName.startsWith("ocm_")) {
    // __Host- is enforced by the browser: Secure, Path=/, no Domain.
    // A plain name is allowed for plain-HTTP local dev only.
    if (process.env.NODE_ENV === "production") {
      throw new ConfigError("SESSION_COOKIE_NAME must use the __Host- prefix in production")
    }
  }

  cached = {
    port: int("PORT", process.env.PORT, 3000),
    bindHost: opt("GATEWAY_BIND_HOST", process.env.GATEWAY_BIND_HOST, "127.0.0.1"),
    logLevel: opt("LOG_LEVEL", process.env.LOG_LEVEL, "info"),
    appOrigins: normaliseOriginList(req("APP_ORIGIN", process.env.APP_ORIGIN)),
    dataDir: abs(opt("DATA_DIR", process.env.DATA_DIR, "./data")),
    logDir: abs(opt("LOG_DIR", process.env.LOG_DIR, "./logs")),
    session: {
      ttlMs: int("SESSION_TTL_DAYS", process.env.SESSION_TTL_DAYS, 30) * 86_400_000,
      slideIntervalMs: int("SESSION_SLIDE_INTERVAL_MINUTES", process.env.SESSION_SLIDE_INTERVAL_MINUTES, 60) * 60_000,
      cookieName,
    },
    rateLimit: {
      globalPerMinute: int("RATE_LIMIT_GLOBAL_PER_MINUTE", process.env.RATE_LIMIT_GLOBAL_PER_MINUTE, 300),
      loginPerMinute: int("RATE_LIMIT_LOGIN_PER_MINUTE", process.env.RATE_LIMIT_LOGIN_PER_MINUTE, 8),
    },
    serve: {
      host: opt("SERVE_HOST", process.env.SERVE_HOST, "host.docker.internal"),
      password: opt("SERVE_PASSWORD", process.env.SERVE_PASSWORD),
      bindHost: opt("SERVE_BIND_HOST", process.env.SERVE_BIND_HOST, "0.0.0.0"),
      portBase: int("SERVE_PORT_BASE", process.env.SERVE_PORT_BASE, 4101),
      idleShutdownMinutes: int("SERVE_IDLE_SHUTDOWN_MINUTES", process.env.SERVE_IDLE_SHUTDOWN_MINUTES, 30),
    },
    supervisor: {
      url: opt("SUPERVISOR_URL", process.env.SUPERVISOR_URL, "http://host.docker.internal:4100"),
      port: int("SUPERVISOR_PORT", process.env.SUPERVISOR_PORT, 4100),
      token: req("SUPERVISOR_TOKEN", process.env.SUPERVISOR_TOKEN),
      opencodeBin: opt("OPENCODE_BIN", process.env.OPENCODE_BIN),
      opencodeVersion: opt("OPENCODE_VERSION", process.env.OPENCODE_VERSION, "1.18.33"),
    },
    telegram: {
      botToken: opt("TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN),
      allowedUserId: opt("TELEGRAM_ALLOWED_USER_ID", process.env.TELEGRAM_ALLOWED_USER_ID),
      appUrl: opt("TELEGRAM_APP_URL", process.env.TELEGRAM_APP_URL),
    },
  }
  return cached
}

/** Test seam: drop the memoised config so a new env takes effect. */
export function resetConfig(): void {
  cached = null
}

/**
 * Data directory only, for the local admin CLIs.
 *
 * Deliberately does not require APP_ORIGIN: break-glass commands must keep
 * working even if the rest of the environment is misconfigured, otherwise a bad
 * .env could lock you out of your own machine's agent.
 */
export function resolveDataDir(): string {
  loadDotEnv()
  return abs(opt("DATA_DIR", process.env.DATA_DIR, "./data"))
}

export function resolveDbPath(): string {
  loadDotEnv()
  assertDbIsReachable()
  return resolve(resolveDataDir(), "auth.db")
}

/**
 * True when this process is itself inside a container.
 *
 * /.dockerenv is Docker's marker and is what main.ts already uses to suppress
 * the misleading loopback warning. /run/.containerenv covers podman, which
 * Docker Desktop's engine can front.
 */
function inContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv")
}

/**
 * Refuse to touch the database from the wrong side of the Docker boundary.
 *
 * With the database in a named volume, the host's ./data/auth.db is not the
 * live database — it is whatever was last left there. A host-side
 * `pnpm auth:reset-password` would then edit a file the gateway never reads,
 * print "password changed", and change nothing. The user believes they have
 * revoked an attacker and have not, which is the worst possible failure mode
 * for a break-glass command.
 *
 * DEPLOYMENT=docker is set in .env, which compose also passes through, so this
 * is explicit rather than guessed from a platform check: a native Windows
 * install is a legitimate deployment and must keep working.
 *
 * Deliberately in resolveDbPath rather than in each script. Every CLI and the
 * gateway itself go through here, so a new script cannot forget the guard. The
 * gateway is unaffected because it runs inside the container.
 */
function assertDbIsReachable(): void {
  const deployment = opt("DEPLOYMENT", process.env.DEPLOYMENT, "native")
  if (deployment !== "docker" || inContainer()) return

  // Derive the command to actually run, so the error tells the operator what to
  // type rather than only what went wrong. The file name is auth-sessions.ts
  // but the package script is auth:sessions, so translate rather than guess.
  const file = basename(process.argv[1] ?? "").replace(/\.(ts|mts|js)$/, "")
  const script = file.replace(/^(auth|project)-/, "$1:")
  const command = script
    ? `docker compose exec gateway npm --prefix apps/api run ${script}`
    : "docker compose exec gateway npm --prefix apps/api run <script>"

  throw new ConfigError(
    [
      "DEPLOYMENT=docker, so the live database is in a Docker named volume and",
      "this host is not it. Running this here would edit a file the gateway",
      "never reads, and would report success while changing nothing.",
      "",
      "Run it in the container instead:",
      "",
      `  ${command}`,
      "",
      "or use the wrapper, which does the same thing:",
      "",
      `  .\\scripts\\auth.ps1 ${file}`,
      "",
      "To go back to a host database, unset DEPLOYMENT and mount ./data again.",
    ].join("\n"),
  )
}

/**
 * Session policy from env alone — no APP_ORIGIN required, so the break-glass
 * CLIs keep working even if the rest of the environment is misconfigured.
 */
export function resolveSessionPolicy(): { ttlMs: number; slideIntervalMs: number } {
  loadDotEnv()
  return {
    ttlMs: int("SESSION_TTL_DAYS", process.env.SESSION_TTL_DAYS, 30) * 86_400_000,
    slideIntervalMs:
      int("SESSION_SLIDE_INTERVAL_MINUTES", process.env.SESSION_SLIDE_INTERVAL_MINUTES, 60) * 60_000,
  }
}
