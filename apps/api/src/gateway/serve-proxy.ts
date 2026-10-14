import { Inject, Injectable, Logger } from "@nestjs/common"
import type { IncomingMessage, ServerResponse } from "node:http"
import { request as httpRequest } from "node:http"
import { APP_CONFIG } from "../tokens.js"
import type { AppConfig } from "../config.js"
import type { ProjectEntry } from "../projects/registry.js"
import { EventHub, type StreamEvent } from "./event-hub.js"

/** How often to emit an SSE comment when the upstream has been quiet. */
const PING_INTERVAL_MS = 15_000

/** How long a reduced provider catalog stays valid before `/provider` is re-read. */
const CATALOG_TTL_MS = 10 * 60_000

/** Raw shape of one model inside a `/provider` entry. */
type ProviderModelRaw = {
  id?: string
  providerID?: string
  name?: string
  status?: string
  enabled?: boolean
}

/** Newest-first sort key for a session record. */
function updatedOf(s: Record<string, unknown>): number {
  const t = s.time as { updated?: number; created?: number } | undefined
  return t?.updated ?? t?.created ?? 0
}

export class UpstreamUnavailableError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message)
  }
}

/**
 * Two-tier authentication to `opencode serve`.
 *
 * The browser holds a session cookie for the gateway and never sees the serve
 * password. This class is the only place that credential exists at runtime: it
 * is attached to the upstream hop and stripped from anything forwarded onward.
 *
 * Our own cookie and the browser's Authorization header are deliberately
 * dropped before forwarding, so a compromised upstream cannot harvest live
 * gateway sessions.
 */
@Injectable()
export class ServeProxy {
  private readonly logger = new Logger(ServeProxy.name)

  /** Reduced provider catalog, cached per project so /provider is parsed once per window. */
  private readonly catalogCache = new Map<string, { at: number; promise: Promise<unknown> }>()

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EventHub) private readonly hub: EventHub,
  ) {}

  /**
   * Base URL for a project's serve instance.
   *
   * The host comes from config so this, the event hub, and the notifier all
   * resolve it the same way. In Docker the gateway reaches the host through
   * host.docker.internal; running natively SERVE_HOST is 127.0.0.1.
   */
  baseUrlFor(project: ProjectEntry): string {
    return `http://${this.config.serve.host}:${project.port}`
  }

  private upstreamHeaders(incoming: IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(incoming.headers)) {
      if (v === undefined) continue
      const key = k.toLowerCase()
      // Never forward our session cookie, the browser's Authorization, or
      // browser-only headers that would confuse the upstream.
      if (key === "cookie" || key === "authorization" || key === "host" || key === "origin") continue
      if (key === "content-length" || key === "connection") continue
      headers[key] = Array.isArray(v) ? v.join(", ") : v
    }
    if (this.config.serve.password) {
      const basic = Buffer.from(`opencode:${this.config.serve.password}`).toString("base64")
      headers["authorization"] = `Basic ${basic}`
    }
    return headers
  }

  async forward(
    incoming: IncomingMessage,
    res: ServerResponse,
    project: ProjectEntry,
    /** Path relative to the serve root, e.g. "/session" or "/event". */
    upstreamPath: string,
    query: string,
  ): Promise<void> {
    const base = this.baseUrlFor(project)

    // The event stream is served from the hub rather than proxied, so N tabs
    // share one upstream connection. Everything else is proxied verbatim.
    if (upstreamPath === "/event" || upstreamPath.endsWith("/event")) {
      await this.streamEventStream(res, project)
      return
    }

    // The browser's query is forwarded verbatim. Notably the session list is
    // directory-filtered by opencode, so stamping the project path here would
    // hide every session created outside it (verified live: 27 sessions bare,
    // 3 with the project directory). Only /event is scoped, and the hub's
    // dial already carries the project path for that stream.
    const target = `${base}${upstreamPath}${query ? `?${query}` : ""}`
    const headers = this.upstreamHeaders(incoming)

    const upstream = httpRequest(target, { method: incoming.method, headers }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })

    upstream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ETIMEDOUT") {
        this.logger.warn(`serve unreachable for project "${project.id}" at ${base}`)
        if (!res.headersSent) {
          res.writeHead(503, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              code: "serve_unavailable",
              message: `opencode is not running for project "${project.name}".`,
              detail: `Could not reach ${base}. The host supervisor may be stopped.`,
            }),
          )
        } else {
          res.end()
        }
        return
      }
      this.logger.error(`proxy error: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" })
        res.end(JSON.stringify({ code: "proxy_error", message: err.message }))
      }
    })

    // Ordinary requests are bodiless GETs; piping an empty stream would hang
    // the request open. The event stream no longer comes through here at all.
    if (incoming.method === "GET" || incoming.method === "HEAD") {
      upstream.end()
    } else {
      // Nest's body parser has already consumed `incoming`, so it cannot be piped
      // to the upstream: doing so forwards nothing and the upstream rejects the
      // empty body. rawBody (enabled in main.ts) holds the original bytes, so
      // write those instead. Falls back to piping for content types Nest does not
      // buffer, where the stream is still intact.
      const raw = (incoming as IncomingMessage & { rawBody?: Buffer }).rawBody
      if (raw && raw.length > 0) {
        // content-length was stripped from the forwarded headers, so restore it:
        // the upstream needs a length for its own framing, and a chunked request
        // can be rejected where a fixed-length one is accepted.
        headers["content-length"] = String(raw.byteLength)
        upstream.end(raw)
      } else {
        incoming.pipe(upstream)
        incoming.on("error", () => upstream.destroy())
      }
    }

    // If the client disconnects, tear down the upstream request too, otherwise
    // a closed browser tab leaks a connection for the life of the request.
    res.on("close", () => upstream.destroy())
  }

  /**
   * The complete session list of this instance.
   *
   * The bare `GET /session` answers with every *global* session but omits ones
   * belonging to a git worktree — verified live against 1.18.35: 27 sessions
   * bare while `/session?directory=<worktree>` answered exactly that worktree's,
   * and `/project` names every known worktree. The complete picture is the bare
   * list plus one scoped call per worktree, deduplicated by id. It is loopback
   * traffic, so the phone still pays for exactly one request. A failing
   * `/project` scan degrades to the bare list rather than failing the request.
   */
  async listAllSessions(project: ProjectEntry): Promise<unknown> {
    const base = this.baseUrlFor(project)
    const headers: Record<string, string> = {}
    if (this.config.serve.password) {
      headers["authorization"] = `Basic ${Buffer.from(`opencode:${this.config.serve.password}`).toString("base64")}`
    }
    const getJson = async (path: string): Promise<unknown> => {
      const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`upstream ${path} answered ${res.status}`)
      return res.json()
    }

    const byId = new Map<string, Record<string, unknown>>()
    const global = await getJson("/session")
    for (const s of Array.isArray(global) ? (global as Array<Record<string, unknown>>) : []) {
      const id = String(s.id ?? "")
      if (id) byId.set(id, s)
    }

    try {
      const projects = (await getJson("/project")) as Array<{ worktree?: unknown }>
      const worktrees = new Set<string>()
      for (const p of Array.isArray(projects) ? projects : []) {
        const w = p?.worktree
        // "/" is the global project, already covered by the bare list; the same
        // path can be registered under several ids, so the set deduplicates.
        if (typeof w === "string" && w !== "/" && w.length > 0) worktrees.add(w)
      }
      await Promise.all(
        [...worktrees].map(async (worktree) => {
          try {
            const scoped = (await getJson(`/session?directory=${encodeURIComponent(worktree)}`)) as unknown
            for (const s of Array.isArray(scoped) ? (scoped as Array<Record<string, unknown>>) : []) {
              const id = String(s.id ?? "")
              if (id && !byId.has(id)) byId.set(id, s)
            }
          } catch (err) {
            this.logger.warn(`scoped session list failed for "${worktree}": ${(err as Error).message}`)
          }
        }),
      )
    } catch (err) {
      this.logger.warn(`/project scan failed, serving the bare session list: ${(err as Error).message}`)
    }

    return [...byId.values()].sort((a, b) => updatedOf(b) - updatedOf(a))
  }

  /** Reduces the upstream `/provider` answer to id/name/status fields. */
  private buildCatalog(all: Array<{ id?: string; name?: string; models?: Record<string, ProviderModelRaw> }>): unknown {
    const providers = all
      .filter((p) => p.id && p.models && Object.keys(p.models).length > 0)
      .map((p) => ({
        id: String(p.id),
        name: p.name || String(p.id),
        models: Object.values(p.models as Record<string, ProviderModelRaw>)
          .map((m) => ({
            id: String(m.id ?? ""),
            providerID: String(m.providerID ?? p.id ?? ""),
            name: m.name || m.id || "",
            ...(m.status ? { status: m.status } : {}),
            ...(m.enabled === undefined ? {} : { enabled: m.enabled }),
          }))
          .filter((m) => m.id && m.name),
      }))
      .filter((p) => p.models.length > 0)
    // The two opencode-owned providers first, in usage order; everything else
    // follows alphabetically so the groups stay findable in a long list.
    const rank = (id: string): number => (id === "opencode" ? 0 : id === "opencode-go" ? 1 : 2)
    providers.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
    for (const p of providers) p.models.sort((a, b) => a.name.localeCompare(b.name))
    return { providers }
  }

  /**
   * Every configured model, grouped by its provider.
   *
   * `/api/model` answers only with the personal catalog — 39 entries, every one
   * providerID "opencode" — while `/provider` names all of them ("Personal /
   * OpenCode", "OpenCode Go", Anthropic, ...) and carries thousands of models
   * scaled to megabytes. The reduction runs here behind a TTL cache so the
   * phone pays kilobytes, once per window.
   */
  modelCatalog(project: ProjectEntry): Promise<unknown> {
    const cached = this.catalogCache.get(project.id)
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.promise

    const base = this.baseUrlFor(project)
    const headers: Record<string, string> = {}
    if (this.config.serve.password) {
      headers["authorization"] = `Basic ${Buffer.from(`opencode:${this.config.serve.password}`).toString("base64")}`
    }
    const promise = (async () => {
      const res = await fetch(`${base}/provider`, { headers, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new UpstreamUnavailableError(`provider catalog answered ${res.status}`)
      const body = (await res.json()) as {
        all?: Array<{ id?: string; name?: string; models?: Record<string, ProviderModelRaw> }>
      }
      return this.buildCatalog(body.all ?? [])
    })().then(
      (data) => {
        this.catalogCache.set(project.id, { at: Date.now(), promise: Promise.resolve(data) })
        return data
      },
      (err: Error) => {
        this.catalogCache.delete(project.id)
        throw err
      },
    )
    // The in-flight promise is cached too, so simultaneous pickers share one
    // upstream fetch instead of racing megabyte payloads against each other.
    this.catalogCache.set(project.id, { at: Date.now(), promise })
    return promise
  }

  /**
   * Serve one browser's event stream from the shared hub.
   *
   * The hub owns the single upstream connection; this only writes to one client.
   * Two details are deliberate. Compression is disabled because a buffering proxy
   * defeats streaming. And a comment heartbeat is injected because Cloudflare's
   * edge will drop an idle connection — a long tool run can easily produce no
   * output for longer than the edge timeout.
   *
   * A cold start still answers 503 rather than an empty 200. The hub retries on
   * its own, so without this a stopped `serve` would look like a healthy but
   * silent stream, and the UI would sit there updating nothing with no error to
   * explain it.
   */
  private async streamEventStream(res: ServerResponse, project: ProjectEntry): Promise<void> {
    const base = this.baseUrlFor(project)
    let headersSent = false
    // Frames can arrive before the response headers are written. Writing then
    // would implicitly send a 200 and make the explicit writeHead below throw,
    // so they are held until the response is ready.
    const pending: StreamEvent[] = []

    const unsubscribe = this.hub.subscribe(project, {
      deliver: (event) => {
        if (!headersSent) {
          pending.push(event)
          return
        }
        this.hub.writeToClient(res, event)
      },
      flush: () => {
        if (!res.writableEnded) res.end()
      },
    })

    const open = await this.hub.waitForOpen(project)
    if (!open) {
      unsubscribe()
      if (res.writableEnded || res.headersSent) return
      res.writeHead(503, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          code: "serve_unavailable",
          message: `opencode is not running for project "${project.name}".`,
          detail: `Could not reach ${base}. The host supervisor may be stopped.`,
        }),
      )
      return
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Belt and braces alongside the per-client ping.
      "x-accel-buffering": "no",
    })
    headersSent = true

    for (const event of pending) this.hub.writeToClient(res, event)
    pending.length = 0

    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n")
    }, PING_INTERVAL_MS)
    ping.unref?.()

    const stop = (): void => {
      clearInterval(ping)
      unsubscribe()
    }
    res.on("close", stop)
    res.on("error", stop)
  }
}
