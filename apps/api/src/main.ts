import "reflect-metadata"
import { Logger } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import type { NestExpressApplication } from "@nestjs/platform-express"
import type { Request, Response } from "express"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { AppModule } from "./app.module.js"
import { loadConfig, resolveDbPath, workspacePath } from "./config.js"
import { getUser, openDb } from "./auth/db.js"

/** Log levels Nest accepts, in increasing verbosity. */
const LOG_LEVELS = ["fatal", "error", "warn", "log", "debug", "verbose"] as const
type NestLogLevel = (typeof LOG_LEVELS)[number]

function resolveLogLevel(configured: string): false | NestLogLevel[] {
  if (configured === "silent") return false
  const level = (LOG_LEVELS as readonly string[]).includes(configured) ? (configured as NestLogLevel) : "log"
  return [level]
}

async function bootstrap(): Promise<void> {
  const logger = new Logger("bootstrap")
  const config = loadConfig()

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: resolveLogLevel(config.logLevel),
    // The /api/serve/* proxy must re-send the client's request body upstream.
    // Without this, Nest's body parser consumes the stream before the proxy runs,
    // and `req.pipe(upstream)` then forwards zero bytes — the upstream sees an
    // empty body and answers "Expected object, got undefined". rawBody keeps the
    // original bytes on the request so the proxy can forward them verbatim,
    // which also preserves the exact payload a client signed or encoded.
    rawBody: true,
  })

  // cloudflared terminates TLS and forwards over plain HTTP, so without this
  // Express believes the connection is insecure (which breaks the Secure
  // cookie) and reports every client as 127.0.0.1, which silently disables
  // per-IP rate limiting.
  app.set("trust proxy", 1)

  // The SPA is served from the same origin as the API, so no CORS is needed and
  // no wildcard origins are permitted.
  app.enableCors({ origin: false })

  app.enableShutdownHooks()

  // Serve the built SPA when present, so the whole app is one process on one
  // port. In development Vite serves it on :5173 instead.
  //
  // The path is resolved from the workspace root, not cwd(), because the process
  // is started both ways in practice: `pnpm --filter @ocm/api dev` from the repo
  // root and `node dist/main.js` from inside the container image. A cwd-relative
  // path silently finds nothing in one of those, which looks like "the build
  // broke" rather than "the path is wrong".
  const webDist = workspacePath("apps", "web", "dist")
  if (existsSync(webDist)) {
    logger.log(`Serving static SPA from ${webDist}`)
    app.useStaticAssets(webDist, { index: "index.html" })
    // The SPA uses hash routing, so a deep link never actually needs a
    // server-side fallback. This only covers the case where a request reaches the
    // server with a non-API path and no matching asset (a stale bookmark, a typo
    // in a URL typed by hand): answering with the app shell is more useful than a
    // bare 404, and it keeps a missing API route from being masked as the app.
    // A middleware rather than a route: Nest's typed route helpers reject a
    // RegExp path, and this needs to be a catch-all that also declines /api.
    app.use((req: Request, res: Response, next: () => void) => {
      if (req.method !== "GET") return next()
      if (req.path.startsWith("/api/")) return next()
      res.sendFile(join(webDist, "index.html"))
    })
  } else {
    logger.warn(`No SPA build found at ${webDist} — run \`pnpm dev:web\` for the dev server`)
  }

  try {
    await app.listen(config.port, config.bindHost)
  } catch (err) {
    // A raw EADDRINUSE tells the operator nothing about what to do next, and the
    // usual cause here is not a stray process: it is the *other* half of this
    // app already holding the port, i.e. the Docker gateway while they tried to
    // start a second native one.
    if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
      logger.error(
        `Port ${config.port} on ${config.bindHost} is already in use.\n` +
          `  If the Docker gateway is running, it already serves this app and you do not\n` +
          `  need a second one — check it with:\n` +
          `      docker ps --filter name=opencode-gateway\n` +
          `  Otherwise find the owner with:\n` +
          `      Get-NetTCPConnection -State Listen -LocalPort ${config.port} |\n` +
          `        Select-Object LocalAddress, OwningProcess\n` +
          `  …then set PORT in .env to something else.`,
      )
      process.exit(1)
    }
    throw err
  }
  logger.log(`Gateway listening on ${config.bindHost}:${config.port}`)
  if (config.bindHost === "0.0.0.0" && !inContainer()) {
    // Loud, because this is the one setting that turns a loopback-only service
    // into a LAN-reachable one and it is easy to set for a reason that is no
    // longer true (e.g. left over from debugging on a phone).
    //
    // Suppressed inside a container: 0.0.0.0 is *required* there, because Docker
    // forwards the published port from outside the container's network namespace
    // and a container-loopback listener is unreachable. Warning about it on every
    // container start trains the operator to ignore the one warning that matters.
    logger.warn(
      "GATEWAY_BIND_HOST is 0.0.0.0: the gateway is reachable from the LAN. " +
        "cloudflared on this host only needs 127.0.0.1. See scripts/firewall-check.ps1.",
    )
  }
  logger.log(`Allowed origins: ${config.appOrigins.join(", ")}`)
  reportAccountState(logger)
}

/** True when running inside a container, which changes what 0.0.0.0 means. */
function inContainer(): boolean {
  return existsSync("/.dockerenv")
}

function reportAccountState(logger: Logger): void {
  try {
    // A login wall whose state is invisible is a support ticket. This also makes
    // the container case obvious: the DB lives on a bind mount, so a change made
    // by the host CLI is only picked up when the process restarts, and this line
    // is where you see that it has.
    const db = openDb(resolveDbPath())
    const user = getUser(db)
    db.close()
    if (!user) {
      logger.warn(
        "No account found. This install is unusable until you run `pnpm auth:setup` " +
          "in a terminal (it needs a TTY), then restart this gateway.",
      )
      return
    }
    logger.log(
      `Signed-in account: ${user.username} (TOTP ${user.totp_enabled ? "on" : "off"})`,
    )
  } catch (err) {
    // Never fatal: the DB is opened again per request, and a failure here would
    // otherwise be the only thing the operator sees instead of the real problem.
    logger.warn(`Could not read the account from the database: ${(err as Error).message}`)
  }
}

bootstrap().catch((err) => {
  new Logger("bootstrap").error(err instanceof Error ? err.stack : String(err))
  process.exit(1)
})
