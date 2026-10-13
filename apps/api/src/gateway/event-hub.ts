import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import { request as httpRequest } from "node:http"
import type { ClientRequest, IncomingMessage } from "node:http"
import { APP_CONFIG } from "../tokens.js"
import type { AppConfig } from "../config.js"
import { ProjectRegistry, type ProjectEntry } from "../projects/registry.js"

/**
 * One event, as parsed off the wire.
 *
 * Index signature because opencode stamps an `id` on every frame and the
 * original payload is forwarded verbatim: re-serialising a subset would quietly
 * drop fields the UI might start relying on.
 */
export interface StreamEvent {
  type: string
  properties: Record<string, unknown>
  [key: string]: unknown
}

export interface HubSubscriber {
  /** Handle one event. Called on the socket's own tick; must not throw. */
  deliver(event: StreamEvent): void
  /**
   * Called when the hub has stopped retrying and is giving up on this stretch of
   * silence.
   *
   * A browser subscriber ends its response, so EventSource reconnects on its own
   * backoff and the page refetches — a client that has silently missed events
   * would otherwise render stale state while reporting itself as connected. An
   * internal subscriber (the notifier) has nothing to refetch and ignores it.
   */
  flush?(): void
}

export type HubState = "open" | "connecting" | "closed"

/** Ceiling on what one slow client may buffer before it is dropped. */
const DEFAULT_MAX_CLIENT_BUFFER_BYTES = 1_000_000

/** How long the upstream is kept open after the last subscriber leaves. */
const DEFAULT_IDLE_GRACE_MS = 30_000

const DEFAULT_RETRY_MIN_MS = 1_000
const DEFAULT_RETRY_MAX_MS = 30_000

/**
 * Consecutive failures tolerated before subscribers are told the stream is gone.
 *
 * At the default backoff this is roughly half a minute of trying. Long enough to
 * ride out a `serve` restart, which the supervisor does on every idle shutdown
 * and every project switch; short enough that a genuine outage is surfaced
 * instead of being papered over with a connection that looks alive and is not.
 */
const DEFAULT_MAX_SILENT_FAILURES = 5

/**
 * How long an open upstream may deliver nothing before it is presumed dead.
 *
 * opencode emits `server.heartbeat` roughly every 10s, so 45s is several missed
 * heartbeats of slack. It has to be generous: a real stall (a long tool run, a
 * paused container) must not cost a reconnect, or every quiet turn would churn
 * the shared socket.
 */
const DEFAULT_SILENCE_TIMEOUT_MS = 45_000

/** How often the liveness check runs. Coarse, because the timeout is coarse. */
const DEFAULT_LIVENESS_CHECK_MS = 15_000

/**
 * A single upstream event stream per project, fanned out in process.
 *
 * Why this exists: every browser tab and the Telegram notifier used to open its
 * own connection to `opencode serve`. That is correct but scales badly in both
 * directions. N tabs meant N upstream connections, and when `serve` restarted,
 * all N failed at once and all N retried at once — a disconnect storm that the
 * upstream cannot distinguish from real load. One connection with N local
 * subscribers collapses that to a single upstream reconnect.
 *
 * The safety argument for sharing is not obvious and is worth stating, because a
 * shared stream normally implies late subscribers miss a snapshot. Here it does
 * not, and the reason is that opencode's stream carries no snapshot: connecting
 * emits exactly one frame, `server.connected`, with empty properties, and the
 * client discards it as a heartbeat. State is fetched over REST and the stream
 * only carries deltas. A tab that subscribes to an already-open hub therefore
 * misses nothing that a tab with its own connection would have received. This
 * was verified against a live `serve` before the hub was written; the test
 * `emits no state snapshot on connect` pins the behaviour so a future opencode
 * that starts sending one fails loudly instead of silently.
 *
 * The upstream credential lives here and nowhere else. Subscribers are handed
 * parsed events, so a browser can never see the serve password, and the hub is
 * not reachable as a route: the only way to attach a subscriber is from behind
 * the session guard.
 */
@Injectable()
export class EventHub implements OnModuleDestroy {
  private readonly logger = new Logger(EventHub.name)
  private readonly streams = new Map<string, ProjectStream>()

  // Test seams. Read per instance rather than at import so a test can shrink
  // them; the defaults are the values that matter in production.
  private readonly maxClientBufferBytes: number
  private readonly idleGraceMs: number
  private readonly retryMinMs: number
  private readonly retryMaxMs: number
  private readonly maxSilentFailures: number
  private readonly silenceTimeoutMs: number
  private readonly livenessCheckMs: number

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ProjectRegistry) private readonly registry: ProjectRegistry,
  ) {
    this.maxClientBufferBytes = num("EVENT_HUB_MAX_CLIENT_BUFFER_BYTES", DEFAULT_MAX_CLIENT_BUFFER_BYTES)
    this.idleGraceMs = num("EVENT_HUB_IDLE_GRACE_MS", DEFAULT_IDLE_GRACE_MS)
    this.retryMinMs = num("EVENT_HUB_RETRY_MIN_MS", DEFAULT_RETRY_MIN_MS)
    this.retryMaxMs = num("EVENT_HUB_RETRY_MAX_MS", DEFAULT_RETRY_MAX_MS)
    this.maxSilentFailures = num("EVENT_HUB_MAX_SILENT_FAILURES", DEFAULT_MAX_SILENT_FAILURES)
    this.silenceTimeoutMs = num("EVENT_HUB_SILENCE_TIMEOUT_MS", DEFAULT_SILENCE_TIMEOUT_MS)
    this.livenessCheckMs = num("EVENT_HUB_LIVENESS_CHECK_MS", DEFAULT_LIVENESS_CHECK_MS)
  }

  /**
   * Attach to a project's stream, opening the upstream if this is the first
   * subscriber. Returns an idempotent detach function.
   */
  subscribe(project: ProjectEntry, subscriber: HubSubscriber): () => void {
    const stream = this.streamFor(project)

    if (stream.stopped) return () => undefined
    stream.subscribers.add(subscriber)

    // A tab opening is a good moment to retry: someone is actually waiting, and
    // the alternative is up to retryMaxMs of a connection that looks open and
    // carries nothing. Bounded because each new subscriber causes at most one
    // dial, and the retry counter still climbs if it keeps failing.
    if (stream.res === null && stream.retryTimer !== null) {
      this.clearRetry(stream)
      stream.retryMs = this.retryMinMs
      this.connect(stream)
    } else if (stream.res === null && stream.retryTimer === null && stream.graceTimer === null) {
      this.connect(stream)
    }

    if (stream.graceTimer) {
      clearTimeout(stream.graceTimer)
      stream.graceTimer = null
    }

    let attached = true
    return () => {
      if (!attached) return
      attached = false
      this.detach(stream, subscriber)
    }
  }

  /**
   * Resolve once the upstream is open, or false if it could not be reached.
   *
   * This exists to preserve the 503 a browser used to get when `serve` was down.
   * The hub reconnects on its own, so a proxy that answered 200 unconditionally
   * would hand the client a live-looking empty stream and hide the outage.
   */
  waitForOpen(project: ProjectEntry, timeoutMs = 5_000): Promise<boolean> {
    const stream = this.streamFor(project)
    if (stream.stopped) return Promise.resolve(false)
    if (stream.res !== null) return Promise.resolve(true)

    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        stream.waiters = stream.waiters.filter((w) => w !== finish)
        resolve(ok)
      }
      stream.waiters.push(finish)
      const timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref?.()
    })
  }

  state(projectId: string): HubState {
    const stream = this.streams.get(projectId)
    if (!stream || stream.stopped) return "closed"
    if (stream.res !== null) return "open"
    return "connecting"
  }

  /** Live subscriber count, for tests and diagnostics. */
  subscriberCount(projectId: string): number {
    return this.streams.get(projectId)?.subscribers.size ?? 0
  }

  onModuleDestroy(): void {
    for (const stream of this.streams.values()) {
      stream.stopped = true
      this.clearRetry(stream)
      this.stopLivenessCheck(stream)
      if (stream.graceTimer) clearTimeout(stream.graceTimer)
      stream.graceTimer = null
      stream.res?.destroy()
      stream.res = null
      stream.req?.destroy()
      stream.req = null
    }
    this.streams.clear()
  }

  // ---------------------------------------------------------------- internals

  private streamFor(project: ProjectEntry): ProjectStream {
    const existing = this.streams.get(project.id)
    if (existing) {
      // The port and name come from projects.json, which the operator can edit
      // while the gateway runs. Picking up a changed port matters: the old one
      // would keep failing and back off forever.
      existing.project = project
      return existing
    }
    const created: ProjectStream = {
      project,
      subscribers: new Set(),
      waiters: [],
      req: null,
      res: null,
      connecting: false,
      buffer: "",
      retryMs: this.retryMinMs,
      failures: 0,
      retryTimer: null,
      graceTimer: null,
      livenessTimer: null,
      lastFrameAt: 0,
      stopped: false,
    }
    this.streams.set(project.id, created)
    return created
  }

  private detach(stream: ProjectStream, subscriber: HubSubscriber): void {
    stream.subscribers.delete(subscriber)
    if (stream.subscribers.size > 0 || stream.stopped) return

    // A reload, a project switch, and a reconnecting phone all cycle through zero
    // subscribers briefly. Closing immediately would mean a fresh upstream dial
    // for each one, which is the cost the hub exists to remove, so the stream is
    // held briefly and only then retired.
    stream.graceTimer = setTimeout(() => {
      stream.graceTimer = null
      if (stream.subscribers.size > 0 || stream.stopped) return
      this.closeUpstream(stream)
    }, this.idleGraceMs)
    stream.graceTimer.unref?.()
  }

  private connect(stream: ProjectStream): void {
    // The `connecting` guard matters: ensureStarted is awaited, so `res` is still
    // null for the whole of it. Without this, several tabs attaching in the same
    // tick would each dial upstream — the exact fan-out this class exists to
    // prevent, reintroduced through the back door.
    if (stream.stopped || stream.res !== null || stream.connecting) return
    stream.connecting = true

    // Ensures `serve` is up before dialling, but a refusal is advisory rather
    // than final: the supervisor is a control plane that can be restarting or
    // briefly unreachable while `serve` itself is perfectly alive. Treating its
    // answer as authoritative would silence a working stream until the
    // supervisor recovered. The dial is the ground truth for whether events are
    // available, and a failed dial is already handled by the retry below.
    //
    // A rejection here means the supervisor is unreachable or refused to spawn;
    // without a catch it would become an unhandled rejection that can take the
    // gateway down.
    void this.registry
      .ensureStarted(stream.project.id)
      .then((result) => {
        if (stream.stopped) return
        if (!result.ok) {
          this.logger.warn(`serve did not start for "${stream.project.id}": ${result.detail ?? "unknown"}`)
        } else {
          this.registry.touch(stream.project.id)
        }
        this.openStream(stream)
      })
      .catch((err: Error) => {
        this.logger.warn(`ensureStarted threw for "${stream.project.id}": ${err.message}`)
        this.openStream(stream)
      })
  }

  private openStream(stream: ProjectStream): void {
    if (stream.stopped) return
    stream.connecting = false

    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (this.config.serve.password) {
      headers["authorization"] = `Basic ${Buffer.from(`opencode:${this.config.serve.password}`).toString("base64")}`
    }

    const target = `http://${this.config.serve.host}:${stream.project.port}/event`
    const req = httpRequest(target, { headers }, (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        res.resume()
        this.scheduleRetry(stream, `status ${res.statusCode}`)
        return
      }
      if (stream.stopped) {
        res.destroy()
        return
      }
      stream.req = req
      stream.res = res
      stream.buffer = ""
      stream.retryMs = this.retryMinMs
      stream.failures = 0
      // Armed as soon as the socket is live, not on the first frame: a socket that
      // connects and then says nothing is exactly the failure this watches for.
      stream.lastFrameAt = Date.now()
      this.startLivenessCheck(stream)
      this.logger.log(`event stream open for project "${stream.project.id}" (${stream.subscribers.size} subscriber(s))`)

      const opened = stream.waiters
      stream.waiters = []
      for (const waiter of opened) waiter(true)

      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        // Any bytes at all count as liveness, including a comment keepalive. The
        // question is whether the peer is still there, not whether it had news.
        stream.lastFrameAt = Date.now()
        this.ingest(stream, chunk)
      })
      res.on("end", () => this.scheduleRetry(stream, "stream ended"))
      res.on("error", (err) => {
        this.logger.warn(`event stream for "${stream.project.id}" errored: ${err.message}`)
        this.scheduleRetry(stream, "stream error")
      })
    })

    req.on("error", (err) => {
      this.logger.warn(`event stream connect failed for "${stream.project.id}": ${err.message}`)
      this.scheduleRetry(stream, "connect error")
    })
    req.end()
    stream.req = req
  }

  /**
   * Redial an upstream that has gone silent without closing.
   *
   * This is the failure every other path misses. When the supervisor replaces
   * `serve`, the old process dies and its socket is left ESTABLISHED with no FIN
   * and no RST, so Node never emits `end` or `error` and no amount of listening
   * will report it. The hub keeps `state() === "open"`, keeps the browser's 200
   * response alive, and delivers nothing at all — permanently, while REST calls
   * (which are fresh requests) keep working. From the user's side that is a UI
   * that updates nothing and needs a reload, with no error anywhere.
   *
   * The only available evidence is time: opencode heartbeats about every 10s, so
   * an open socket that has said nothing for far longer than that is not slow, it
   * is orphaned. This is deliberately the aggressive option, because the failure it
   * prevents is silent and total while the cost of being wrong is one extra dial.
   */
  private startLivenessCheck(stream: ProjectStream): void {
    this.stopLivenessCheck(stream)
    const timer = setInterval(() => {
      if (stream.stopped || stream.res === null) return
      if (Date.now() - stream.lastFrameAt < this.silenceTimeoutMs) return
      this.logger.warn(
        `event stream for "${stream.project.id}" has been silent for over ` +
          `${this.silenceTimeoutMs}ms with the socket still open; redialling`,
      )
      // Counted as a failure so a serve that is genuinely gone still escalates to
      // flushing subscribers rather than being retried quietly forever.
      this.scheduleRetry(stream, "silent upstream")
    }, this.livenessCheckMs)
    timer.unref?.()
    stream.livenessTimer = timer
  }

  private stopLivenessCheck(stream: ProjectStream): void {
    if (stream.livenessTimer) {
      clearInterval(stream.livenessTimer)
      stream.livenessTimer = null
    }
  }

  private ingest(stream: ProjectStream, chunk: string): void {
    stream.buffer += chunk

    // Frames are separated by a blank line. A partial frame stays buffered
    // because a chunk boundary can land anywhere in the stream.
    let idx = stream.buffer.indexOf("\n\n")
    while (idx >= 0) {
      const frame = stream.buffer.slice(0, idx)
      stream.buffer = stream.buffer.slice(idx + 2)
      const event = parseFrame(frame)
      if (event) this.broadcast(stream, event)
      idx = stream.buffer.indexOf("\n\n")
    }

    // Guard against a broken upstream that never sends a separator.
    if (stream.buffer.length > 1_000_000) stream.buffer = ""
  }

  private broadcast(stream: ProjectStream, event: StreamEvent): void {
    // Copied because a subscriber may detach itself while handling an event.
    for (const subscriber of [...stream.subscribers]) {
      try {
        subscriber.deliver(event)
      } catch (err) {
        this.logger.warn(`subscriber threw handling ${event.type}: ${(err as Error).message}`)
      }
    }
  }

  /**
   * Offer a frame to one client, dropping it if it has fallen too far behind.
   *
   * The shared upstream is the scarce resource, so it must not be held hostage by
   * one stalled tab. Ending that tab's response is recoverable — the browser
   * reconnects and refetches — whereas buffering without bound is not.
   */
  writeToClient(res: import("node:http").ServerResponse, event: StreamEvent): boolean {
    if (res.writableEnded) return false
    if (res.writableLength > this.maxClientBufferBytes) {
      this.logger.warn("dropping a client that fell too far behind the event stream")
      res.end()
      return false
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    return true
  }

  private scheduleRetry(stream: ProjectStream, reason: string): void {
    if (stream.stopped) return
    stream.connecting = false
    // Stopped before the socket is torn down, or the interval would fire against
    // the fresh stream the retry is about to open.
    this.stopLivenessCheck(stream)
    this.closeUpstream(stream)
    if (stream.retryTimer !== null) return

    stream.failures += 1

    // Tell the waiters a cold start failed so the caller can answer 503 rather
    // than an empty 200.
    if (stream.failures === 1) {
      const waiting = stream.waiters
      stream.waiters = []
      for (const waiter of waiting) waiter(false)
    }

    if (stream.failures >= this.maxSilentFailures) {
      this.logger.warn(`giving up on "${stream.project.id}" after ${stream.failures} attempts (${reason})`)
      for (const subscriber of [...stream.subscribers]) {
        try {
          subscriber.flush?.()
        } catch (err) {
          this.logger.warn(`subscriber threw on flush: ${(err as Error).message}`)
        }
      }
    }

    const delay = stream.retryMs
    this.logger.debug(`reconnecting to "${stream.project.id}" in ${delay}ms (${reason})`)
    stream.retryTimer = setTimeout(() => {
      stream.retryTimer = null
      stream.retryMs = Math.min(stream.retryMs * 2, this.retryMaxMs)
      this.connect(stream)
    }, delay)
    stream.retryTimer.unref?.()
  }

  private clearRetry(stream: ProjectStream): void {
    if (stream.retryTimer !== null) {
      clearTimeout(stream.retryTimer)
      stream.retryTimer = null
    }
  }

  private closeUpstream(stream: ProjectStream): void {
    this.stopLivenessCheck(stream)
    stream.res?.destroy()
    stream.res = null
    stream.req?.destroy()
    stream.req = null
    stream.buffer = ""
    stream.lastFrameAt = 0
  }
}

interface ProjectStream {
  project: ProjectEntry
  subscribers: Set<HubSubscriber>
  waiters: Array<(ok: boolean) => void>
  req: ClientRequest | null
  res: IncomingMessage | null
  /** True from dialling until the attempt resolves, so ticks cannot double-dial. */
  connecting: boolean
  buffer: string
  retryMs: number
  failures: number
  retryTimer: ReturnType<typeof setTimeout> | null
  graceTimer: ReturnType<typeof setTimeout> | null
  /** Fires while an upstream socket is open, to catch a silent-but-open one. */
  livenessTimer: ReturnType<typeof setInterval> | null
  /**
   * When bytes last arrived on the upstream socket, 0 when there is no socket.
   *
   * The staleness signal for a connection Node still believes in.
   */
  lastFrameAt: number
  stopped: boolean
}

/**
 * Parse one SSE frame into an event, or null if it carries nothing usable.
 *
 * Only `data:` lines matter: `:` lines are keepalives, and opencode's stream uses
 * neither `event:` nor `id:`. A frame is kept only if it has a string `type` and
 * a `properties` object, which is the contract the notifier and the web client
 * both rely on.
 */
export function parseFrame(frame: string): StreamEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
  if (!data) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null

  const candidate = parsed as { type?: unknown; properties?: unknown }
  if (typeof candidate.type !== "string" || typeof candidate.properties !== "object" || candidate.properties === null) {
    return null
  }
  return candidate as StreamEvent
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
