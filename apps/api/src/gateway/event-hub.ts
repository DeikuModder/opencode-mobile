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

/** Minimum interval between directory scans driven by subscriptions. */
const DEFAULT_SCAN_INTERVAL_MS = 5 * 60_000

/** Timeout for one upstream REST read while discovering the dial set. */
const SCAN_REQUEST_TIMEOUT_MS = 10_000

/**
 * One upstream event connection to `opencode serve`, scoped to a directory.
 *
 * opencode filters the `/event` bus by the `directory` query this gateway
 * discovered the hard way: a bare dial answers 200 and then delivers only the
 * frames whose session directory matches the serve's own cwd — verified live
 * against 1.18.35, where a turn in an opencode-mobile session arrived on a
 * `/event?directory=<opencode-mobile>` dial and never on the bare one, while a
 * turn in a chain session arrived on the bare dial and `/event?directory=<chain>`
 * but not on other scopes. There is no wildcard: `directory=*`, an empty value,
 * the global project id and an invented path all delivered heartbeats only.
 *
 * In hub terms: the hub keeps one socket per directory that holds
 * sessions, and fanned-out frames go to every subscriber of the project.
 */
interface UpstreamSocket {
  /**
   * The directory scope of this dial. Empty means the bare `/event` URL, whose
   * scope is the serve's own working directory — the project path the supervisor
   * always spawns serve with.
   */
  directory: string
  req: ClientRequest | null
  res: IncomingMessage | null
  /** True from dialling until the attempt resolves, so ticks cannot double-dial. */
  connecting: boolean
  buffer: string
  retryMs: number
  failures: number
  retryTimer: ReturnType<typeof setTimeout> | null
  /** Fires while this socket is open, to catch a silent-but-open one. */
  livenessTimer: ReturnType<typeof setInterval> | null
  /** When bytes last arrived on this socket, 0 when there is no socket. */
  lastFrameAt: number
}

/**
 * One project's shared event surface: the subscribers that must receive every
 * frame, and the one upstream connection per directory that produces them.
 *
 * Why this exists: every browser tab and the Telegram notifier used to open its
 * own connection to `opencode serve`. That is correct but scales badly in both
 * directions. N tabs meant N upstream connections, and when `serve` restarted,
 * all N failed at once and all N retried at once — a disconnect storm that the
 * upstream cannot distinguish from real load. One set of connections with N
 * local subscribers collapses that to a single upstream reconnect.
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
interface ProjectStream {
  project: ProjectEntry
  subscribers: Set<HubSubscriber>
  waiters: Array<(ok: boolean) => void>
  /** Keyed by directory scope. "" is the bare dial. */
  sockets: Map<string, UpstreamSocket>
  /** 0 until the first scan of this stream cycle; a retired stream resets it. */
  lastScanAt: number
  scanning: boolean
  graceTimer: ReturnType<typeof setTimeout> | null
  stopped: boolean
  /**
   * Set when every socket has exhausted its budget and subscribers were
   * flushed; cleared the next time any socket opens, so one outage flushes
   * once instead of once per retry per socket.
   */
  flushedSinceLastOpen: boolean
}

function makeSocket(directory: string): UpstreamSocket {
  return {
    directory,
    req: null,
    res: null,
    connecting: false,
    buffer: "",
    retryMs: 1_000,
    failures: 0,
    retryTimer: null,
    livenessTimer: null,
    lastFrameAt: 0,
  }
}

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
  private readonly scanIntervalMs: number

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
    this.scanIntervalMs = num("EVENT_HUB_SCAN_INTERVAL_MS", DEFAULT_SCAN_INTERVAL_MS)
  }

  /**
   * Attach to a project's stream, opening the upstream if this is the first
   * subscriber. Returns an idempotent detach function.
   */
  subscribe(project: ProjectEntry, subscriber: HubSubscriber): () => void {
    const stream = this.streamFor(project)

    if (stream.stopped) return () => undefined
    stream.subscribers.add(subscriber)

    if (stream.graceTimer) {
      clearTimeout(stream.graceTimer)
      stream.graceTimer = null
    }

    // Discover which directories hold sessions, one socket each, at most once
    // per interval or per stream cycle. The bare socket always exists, so
    // something is dialled even while the scan runs.
    if (!stream.scanning && stream.lastScanAt === 0) {
      void this.refreshDialSet(stream)
    } else if (!stream.scanning && Date.now() - stream.lastScanAt > this.scanIntervalMs) {
      void this.refreshDialSet(stream)
    }

    // A tab opening is a good moment to retry: someone is actually waiting, and
    // the alternative is up to retryMaxMs of a connection that looks open and
    // carries nothing. Bounded because each new subscriber causes at most one
    // dial per socket, and the retry counter still climbs if it keeps failing.
    for (const socket of stream.sockets.values()) {
      if (socket.res !== null) continue
      if (socket.retryTimer !== null) {
        this.clearRetry(socket)
        socket.retryMs = this.retryMinMs
        this.connect(stream, socket)
      } else if (!socket.connecting) {
        this.connect(stream, socket)
      }
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
   *
   * With several directory sockets the answer is optimistic: any open socket
   * means serve is up and frames can arrive. Sockets that dial a directory with
   * no traffic sit healthy and silent, so waiting for all of them would read a
   * perfectly good stream as a hung one.
   */
  async waitForOpen(project: ProjectEntry, timeoutMs = 5_000): Promise<boolean> {
    const stream = this.streams.get(project.id)
    if (!stream || stream.stopped) return false

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (stream.stopped) return false
      let open = false
      let allFailed = stream.sockets.size > 0
      let pending = false
      for (const socket of stream.sockets.values()) {
        if (socket.res !== null) {
          open = true
          break
        }
        if (socket.failures === 0) allFailed = false
        if (socket.retryTimer !== null || socket.connecting) pending = true
      }
      if (open) return true
      // Everything has failed at least once and nothing is in flight: a genuine
      // cold-start failure, answerable with a 503. A retry timer still pending
      // means the next attempt may yet succeed, so only report failure when
      // there is nothing left to wait for.
      if (allFailed && !pending) return false
      await new Promise((r) => setTimeout(r, 20))
    }
    return false
  }

  state(projectId: string): HubState {
    const stream = this.streams.get(projectId)
    if (!stream || stream.stopped) return "closed"
    for (const socket of stream.sockets.values()) {
      if (socket.res !== null) return "open"
    }
    return "connecting"
  }

  /** Live subscriber count, for tests and diagnostics. */
  subscriberCount(projectId: string): number {
    return this.streams.get(projectId)?.subscribers.size ?? 0
  }

  onModuleDestroy(): void {
    for (const stream of this.streams.values()) {
      stream.stopped = true
      if (stream.graceTimer) clearTimeout(stream.graceTimer)
      stream.graceTimer = null
      for (const socket of stream.sockets.values()) {
        this.clearRetry(socket)
        this.stopLivenessCheck(socket)
        socket.res?.destroy()
        socket.req?.destroy()
      }
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
      sockets: new Map(),
      lastScanAt: 0,
      scanning: false,
      graceTimer: null,
      stopped: false,
      flushedSinceLastOpen: false,
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
      for (const socket of stream.sockets.values()) {
        this.clearRetry(socket)
        this.stopLivenessCheck(socket)
        socket.res?.destroy()
        socket.req?.destroy()
      }
      stream.sockets.clear()
      // A forced rescan at next attach picks up directories that appeared while
      // nobody was listening.
      stream.lastScanAt = 0
    }, this.idleGraceMs)
    stream.graceTimer.unref?.()
  }

  /**
   * The set of directories this project's sessions live in, plus the bare dial.
   *
   * Reads the same shape the REST aggregated list uses: the bare session list
   * carries the global-project sessions (whose directories are exactly the
   * non-worktree ones), and each worktree in `/project` contributes its scoped
   * list. The serve's own directory is not dialled separately — the bare dial
   * already covers it, verified live, and a second socket for the same scope
   * would deliver every frame twice.
   */
  private listSessionDirectories(project: ProjectEntry): Promise<Set<string>> {
    const dirs = new Set<string>()
    const base = `http://${this.config.serve.host}:${project.port}`
    const headers: Record<string, string> = {}
    if (this.config.serve.password) {
      headers["authorization"] = `Basic ${Buffer.from(`opencode:${this.config.serve.password}`).toString("base64")}`
    }
    const getJson = async (path: string): Promise<unknown> => {
      const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(SCAN_REQUEST_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`upstream ${path} answered ${res.status}`)
      return res.json()
    }
    const absorb = (payload: unknown): void => {
      for (const s of Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : []) {
        const d = s?.directory
        if (typeof d === "string" && d) dirs.add(d)
      }
    }
    const safe = async (path: string, label: string): Promise<void> => {
      try {
        absorb(await getJson(path))
      } catch (err) {
        // One unreadable scope degrades to less coverage; it must not take the
        // whole dial set down. The bare dial still streams the project path.
        this.logger.debug(`directory scan skipped ${label}: ${(err as Error).message}`)
      }
    }

    return (async () => {
      await safe("/session", "the bare session list")
      let worktrees: string[] = []
      try {
        const payload = await getJson("/project")
        worktrees = (Array.isArray(payload) ? payload : [])
          .map((p) => (p as { worktree?: unknown })?.worktree)
          .filter((w): w is string => typeof w === "string" && w !== "/" && w.length > 0)
      } catch (err) {
        this.logger.debug(`worktree scan failed, dial scope stays bare: ${(err as Error).message}`)
      }
      if (worktrees.length > 0) {
        // The same path can be registered under several ids; one scoped read
        // per unique path is enough.
        for (const w of [...new Set(worktrees)]) await safe(`/session?directory=${encodeURIComponent(w)}`, w)
      }
      // The bare dial streams the serve's own directory; never duplicate it.
      dirs.delete(project.path)
      return dirs
    })()
  }

  /**
   * Rebuild the socket set from a fresh scan. The bare socket always exists,
   * even while the scan fails or runs, so frames keep flowing for the project
   * path while discovery adds or drops the rest.
   */
  private async refreshDialSet(stream: ProjectStream): Promise<void> {
    if (stream.scanning || stream.stopped) return
    stream.scanning = true
    try {
      // The bare socket exists regardless of what the scan finds: it is the
      // dial for the serve's own directory, and the only one guaranteed to
      // cover the sessions of this project path.
      if (!stream.sockets.has("")) {
        const bare = makeSocket("")
        stream.sockets.set("", bare)
        this.connect(stream, bare)
      }
      await this.ensureStartedThrottled(stream)
      const dirs = await this.listSessionDirectories(stream.project)
      if (stream.stopped) return
      for (const [dir, socket] of [...stream.sockets]) {
        if (dir !== "" && !dirs.has(dir)) {
          // A directory emptied out: stop paying for its dial.
          this.clearRetry(socket)
          this.stopLivenessCheck(socket)
          socket.res?.destroy()
          socket.req?.destroy()
          stream.sockets.delete(dir)
        }
      }
      for (const dir of dirs) {
        if (stream.sockets.has(dir)) continue
        const socket = makeSocket(dir)
        stream.sockets.set(dir, socket)
        this.connect(stream, socket)
      }
      stream.lastScanAt = Date.now()
    } finally {
      stream.scanning = false
    }
  }

  /**
   * ensureStarted advisory, throttled per stream: with one socket per directory
   * a retry storm must not translate into one supervisor call per socket.
   */
  private ensureStartedMemo = new Map<string, number>()
  private async ensureStartedThrottled(stream: ProjectStream): Promise<void> {
    const last = this.ensureStartedMemo.get(stream.project.id) ?? 0
    if (Date.now() - last < 15_000) return
    this.ensureStartedMemo.set(stream.project.id, Date.now())
    try {
      const result = await this.registry.ensureStarted(stream.project.id)
      if (stream.stopped) return
      if (!result.ok) {
        this.logger.warn(`serve did not start for "${stream.project.id}": ${result.detail ?? "unknown"}`)
      } else {
        this.registry.touch(stream.project.id)
      }
    } catch (err) {
      this.logger.warn(`ensureStarted threw for "${stream.project.id}": ${(err as Error).message}`)
    }
  }

  private connect(stream: ProjectStream, socket: UpstreamSocket): void {
    // The `connecting` guard matters: openStream is two hops away from
    // synchronous (`ensureStartedThrottled` runs first for the bare socket),
    // so `res` is null for that whole window. Without this, several tabs
    // attaching at once would each dial upstream — the exact fan-out this
    // class exists to prevent.
    if (stream.stopped || socket.res !== null || socket.connecting) return
    socket.connecting = true

    // The bare dial carries the supervisor round-trip because it is the first
    // socket to exist on a fresh cycle; the rest dial straight away. A refusal
    // is advisory rather than final: the supervisor is a control plane that can
    // be restarting while `serve` itself is perfectly alive, and the dial is the
    // ground truth for whether events are available.
    if (socket.directory === "") {
      void this.ensureStartedThrottled(stream).then(() => {
        if (stream.stopped) return
        this.openStream(stream, socket)
      })
    } else {
      this.openStream(stream, socket)
    }
  }

  private openStream(stream: ProjectStream, socket: UpstreamSocket): void {
    if (stream.stopped) return
    socket.connecting = false

    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (this.config.serve.password) {
      headers["authorization"] = `Basic ${Buffer.from(`opencode:${this.config.serve.password}`).toString("base64")}`
    }

    const scope = socket.directory ? `?directory=${encodeURIComponent(socket.directory)}` : ""
    const target = `http://${this.config.serve.host}:${stream.project.port}/event${scope}`
    const req = httpRequest(target, { headers }, (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        res.resume()
        this.scheduleRetry(stream, socket, `status ${res.statusCode}`)
        return
      }
      if (stream.stopped) {
        res.destroy()
        return
      }
      socket.req = req
      socket.res = res
      socket.buffer = ""
      socket.retryMs = this.retryMinMs
      socket.failures = 0
      stream.flushedSinceLastOpen = false
      // Armed as soon as the socket is live, not on the first frame: a socket that
      // connects and then says nothing is exactly the failure this watches for.
      socket.lastFrameAt = Date.now()
      this.startLivenessCheck(stream, socket)
      const scopeLabel = socket.directory === "" ? "bare" : socket.directory
      this.logger.log(`event stream open for project "${stream.project.id}" (${scopeLabel}, ${stream.subscribers.size} subscriber(s))`)
      // First open wins: a waiter only ever exists on a cold start, and one
      // reachable socket is enough to answer the browser with a real stream.
      const opened = stream.waiters
      stream.waiters = []
      for (const waiter of opened) waiter(true)

      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        // Any bytes at all count as liveness, including a comment keepalive. The
        // question is whether the peer is still there, not whether it had news.
        socket.lastFrameAt = Date.now()
        this.ingest(stream, socket, chunk)
      })
      res.on("end", () => this.scheduleRetry(stream, socket, "stream ended"))
      res.on("error", (err) => {
        this.logger.warn(`event stream for "${stream.project.id}" errored: ${err.message}`)
        this.scheduleRetry(stream, socket, "stream error")
      })
    })

    req.on("error", (err) => {
      this.logger.warn(`event stream connect failed for "${stream.project.id}": ${err.message}`)
      this.scheduleRetry(stream, socket, "connect error")
    })
    req.end()
    socket.req = req
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
  private startLivenessCheck(stream: ProjectStream, socket: UpstreamSocket): void {
    this.stopLivenessCheck(socket)
    const timer = setInterval(() => {
      if (stream.stopped || socket.res === null) return
      if (Date.now() - socket.lastFrameAt < this.silenceTimeoutMs) return
      this.logger.warn(
        `event stream for "${stream.project.id}" (${socket.directory || "bare"}) has been silent for over ` +
          `${this.silenceTimeoutMs}ms with the socket still open; redialling`,
      )
      // Counted as a failure so a serve that is genuinely gone still escalates to
      // flushing subscribers rather than being retried quietly forever.
      this.scheduleRetry(stream, socket, "silent upstream")
    }, this.livenessCheckMs)
    timer.unref?.()
    socket.livenessTimer = timer
  }

  private stopLivenessCheck(socket: UpstreamSocket): void {
    if (socket.livenessTimer) {
      clearInterval(socket.livenessTimer)
      socket.livenessTimer = null
    }
  }

  private ingest(stream: ProjectStream, socket: UpstreamSocket, chunk: string): void {
    socket.buffer += chunk

    // Frames are separated by a blank line. A partial frame stays buffered
    // because a chunk boundary can land anywhere in the stream.
    let idx = socket.buffer.indexOf("\n\n")
    while (idx >= 0) {
      const frame = socket.buffer.slice(0, idx)
      socket.buffer = socket.buffer.slice(idx + 2)
      const event = parseFrame(frame)
      if (event) this.broadcast(stream, event)
      idx = socket.buffer.indexOf("\n\n")
    }

    // Guard against a broken upstream that never sends a separator.
    if (socket.buffer.length > 1_000_000) socket.buffer = ""
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

  private scheduleRetry(stream: ProjectStream, socket: UpstreamSocket, reason: string): void {
    if (stream.stopped) return
    socket.connecting = false
    // Stopped before the socket is torn down, or the interval would fire against
    // the fresh socket the retry is about to open.
    this.stopLivenessCheck(socket)
    this.closeUpstream(socket)
    if (socket.retryTimer !== null) return

    socket.failures += 1

    // Tell the waiters a cold start failed so the caller can answer 503 rather
    // than an empty 200 — but only while nothing whatsoever has opened: some
    // directories sit legitimately unreachable for stretches.
    if (!this.anySocketOpen(stream) && socket.failures === 1) {
      const waiting = stream.waiters
      stream.waiters = []
      for (const waiter of waiting) waiter(false)
    }

    // All sockets exhausted together is an outage, not one slow directory.
    // Browser subscribers are flushed so their EventSource reconnects and the
    // page refetches; internal subscribers (the notifier) simply pause. The
    // transition is edge-triggered: an open socket resets the marker, so a long
    // outage flushes once, not once per retry per socket.
    if (this.allSocketsExhausted(stream, socket.failures) && !stream.flushedSinceLastOpen) {
      this.logger.warn(`giving up on "${stream.project.id}" after ${socket.failures} attempts (${reason})`)
      stream.flushedSinceLastOpen = true
      for (const subscriber of [...stream.subscribers]) {
        try {
          subscriber.flush?.()
        } catch (err) {
          this.logger.warn(`subscriber threw on flush: ${(err as Error).message}`)
        }
      }
    }

    const delay = socket.retryMs
    this.logger.debug(`reconnecting to "${stream.project.id}" in ${delay}ms (${reason})`)
    socket.retryTimer = setTimeout(() => {
      socket.retryTimer = null
      socket.retryMs = Math.min(socket.retryMs * 2, this.retryMaxMs)
      this.connect(stream, socket)
    }, delay)
    socket.retryTimer.unref?.()
  }

  private anySocketOpen(stream: ProjectStream): boolean {
    for (const socket of stream.sockets.values()) {
      if (socket.res !== null) return true
    }
    return false
  }

  /** True when every currently known socket has exhausted its retry budget. */
  private allSocketsExhausted(stream: ProjectStream, failures: number): boolean {
    if (stream.sockets.size === 0) return true
    for (const socket of stream.sockets.values()) {
      if (socket.failures < this.maxSilentFailures) return false
    }
    return failures >= this.maxSilentFailures
  }

  private clearRetry(socket: UpstreamSocket): void {
    if (socket.retryTimer !== null) {
      clearTimeout(socket.retryTimer)
      socket.retryTimer = null
    }
  }

  private closeUpstream(socket: UpstreamSocket): void {
    socket.res?.destroy()
    socket.res = null
    socket.req?.destroy()
    socket.req = null
    socket.buffer = ""
    socket.lastFrameAt = 0
  }
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
