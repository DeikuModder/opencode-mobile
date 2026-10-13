import { afterEach, describe, expect, it } from "vitest"
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http"
import { EventHub, parseFrame, type HubSubscriber, type StreamEvent } from "../src/gateway/event-hub.js"
import type { AppConfig } from "../src/config.js"
import type { ProjectEntry } from "../src/projects/registry.js"

/**
 * Tests for the shared event stream.
 *
 * The behaviour worth protecting is not "frames arrive" — that was already true.
 * It is that N subscribers cost exactly one upstream connection, that closing one
 * tab cannot disturb the rest, that a late tab misses nothing, and that an
 * upstream outage is absorbed by the hub rather than by every client at once.
 */

const HOST = "127.0.0.1"

class FakeRegistry {
  readonly started: string[] = []
  readonly touched: string[] = []
  ok = true
  constructor(private readonly entries = new Map<string, ProjectEntry>()) {}
  async ensureStarted(id: string): Promise<{ ok: boolean; detail?: string }> {
    this.started.push(id)
    if (this.entries.size > 0 && !this.entries.has(id)) return { ok: false, detail: "unknown project" }
    return this.ok ? { ok: true } : { ok: false, detail: "refused" }
  }
  touch(id: string): void {
    this.touched.push(id)
  }
}

interface FakeUpstream {
  server: Server
  port: number
  connections: number
  peakConcurrent: number
  live: number
  status: number
  lastHeaders: IncomingHttpHeaders | null
  send(payload: unknown): void
  endAll(): void
  destroyAll(): void
  /**
   * Answer every /event request with 200 and headers, then go permanently quiet.
   *
   * This is the shape of the bug that was reported from a phone: the socket is
   * ESTABLISHED, Node has emitted neither `end` nor `error`, and the hub reports
   * "open" while nothing can ever arrive. A normal `destroyAll()` cannot reproduce
   * it, because that fires the events the hub already listens for.
   */
  goSilent(): void
}

function makeUpstream(): Promise<FakeUpstream> {
  const sockets = new Set<ServerResponse>()
  const state = {
    connections: 0,
    peakConcurrent: 0,
    live: 0,
    status: 200,
    lastHeaders: null as IncomingHttpHeaders | null,
    silent: false,
  }

  const server = createServer((req, res) => {
    state.connections += 1
    state.lastHeaders = req.headers
    if (state.status !== 200) {
      res.writeHead(state.status)
      res.end()
      return
    }
    state.live += 1
    state.peakConcurrent = Math.max(state.peakConcurrent, state.live)
    sockets.add(res)
    res.writeHead(200, { "content-type": "text/event-stream" })
    // Flushed, not merely staged. writeHead only queues the headers, and a real
    // SSE server sends its first frame immediately, so the client's response
    // callback fires at once. Without this the hub would sit in "connecting"
    // until the first event and the fixtures would not resemble opencode.
    res.flushHeaders()
    const drop = (): void => {
      state.live -= 1
      sockets.delete(res)
    }
    // Held open and silent. Deliberately not ended or destroyed: those paths fire
    // the `end`/`error` events the hub handles, and the bug is precisely that
    // neither fires.
    void state.silent
    res.on("close", drop)
    res.on("error", drop)
  })

  return new Promise((resolve) => {
    server.listen(0, HOST, () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({
        server,
        port,
        get connections() {
          return state.connections
        },
        get peakConcurrent() {
          return state.peakConcurrent
        },
        get live() {
          return state.live
        },
        get status() {
          return state.status
        },
        set status(code: number) {
          state.status = code
        },
        get lastHeaders() {
          return state.lastHeaders
        },
        send(payload: unknown) {
          for (const res of sockets) res.write(`data: ${JSON.stringify(payload)}\n\n`)
        },
        endAll() {
          for (const res of sockets) res.end()
        },
        destroyAll() {
          for (const res of sockets) res.destroy()
        },
        goSilent() {
          state.silent = true
        },
      })
    })
  })
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function project(port: number, id = "demo"): ProjectEntry {
  return { id, name: "Demo", path: "C:\\demo", port }
}

/**
 * `overrides` are read by the hub's constructor, so a test that wants a different
 * liveness window has to set them before the hub is built.
 */
function makeHub(
  entries = new Map<string, ProjectEntry>(),
  overrides: Record<string, string> = {},
): { hub: EventHub; registry: FakeRegistry } {
  process.env.EVENT_HUB_RETRY_MIN_MS = "25"
  process.env.EVENT_HUB_RETRY_MAX_MS = "60"
  process.env.EVENT_HUB_IDLE_GRACE_MS = "120"
  process.env.EVENT_HUB_MAX_SILENT_FAILURES = "2"
  process.env.EVENT_HUB_MAX_CLIENT_BUFFER_BYTES = "1000"
  // Long enough that the liveness check never fires during an ordinary test, so
  // the tests that do exercise it opt in explicitly rather than inheriting a
  // shortened window that would make timing-sensitive cases flaky.
  process.env.EVENT_HUB_SILENCE_TIMEOUT_MS = "600000"
  process.env.EVENT_HUB_LIVENESS_CHECK_MS = "600000"
  Object.assign(process.env, overrides)
  const registry = new FakeRegistry(entries)
  const config = { serve: { host: HOST, password: "serve-pw" } } as unknown as AppConfig
  const hub = new EventHub(config, registry as never)
  cleanups.push(() => hub.onModuleDestroy())
  return { hub, registry }
}

function collector(): { events: StreamEvent[]; flushes: number[]; sub: HubSubscriber } {
  const events: StreamEvent[] = []
  const flushes: number[] = []
  return {
    events,
    flushes,
    sub: {
      deliver: (e) => events.push(e),
      flush: () => flushes.push(events.length),
    },
  }
}

async function until(fn: () => boolean, label = "condition", timeoutMs = 4_000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 8))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe("event hub fan-out", () => {
  it("serves many subscribers from exactly one upstream connection", async () => {
    const upstream = await makeUpstream()
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    const { hub } = makeHub()

    const tabs = [collector(), collector(), collector()]
    for (const t of tabs) hub.subscribe(project(upstream.port), t.sub)
    await until(() => hub.state("demo") === "open", "hub open")

    upstream.send({ type: "message.updated", properties: { id: "m1" } })
    await until(() => tabs.every((t) => t.events.length === 1), "all tabs served")

    expect(upstream.connections).toBe(1)
    expect(upstream.peakConcurrent).toBe(1)
    for (const t of tabs) {
      expect(t.events[0]).toMatchObject({ type: "message.updated", properties: { id: "m1" } })
    }
  })

  it("keeps the other tabs alive when one tab closes", async () => {
    const upstream = await makeUpstream()
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    const { hub } = makeHub()

    const tabs = [collector(), collector(), collector()]
    const detachers = tabs.map((t) => hub.subscribe(project(upstream.port), t.sub))
    await until(() => hub.state("demo") === "open", "hub open")

    // A closed tab used to destroy the upstream request, taking the stream with it.
    detachers[1]()

    upstream.send({ type: "session.idle", properties: {} })
    await until(() => tabs[0].events.length === 1 && tabs[2].events.length === 1, "surviving tabs served")

    expect(tabs[1].events).toHaveLength(0)
    expect(upstream.live).toBe(1)
    expect(upstream.connections).toBe(1)
    expect(hub.subscriberCount("demo")).toBe(2)
  })

  it("gives a late tab the live stream and nothing it could not have had alone", async () => {
    const upstream = await makeUpstream()
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    const { hub } = makeHub()

    const early = collector()
    hub.subscribe(project(upstream.port), early.sub)
    await until(() => hub.state("demo") === "open", "hub open")
    upstream.send({ type: "message.updated", properties: { id: "before" } })
    await until(() => early.events.length === 1, "early tab served")

    // The safety argument for sharing rests on there being no snapshot to miss:
    // a tab with its own upstream connection would not have seen "before"
    // either, because it had not connected yet.
    const late = collector()
    hub.subscribe(project(upstream.port), late.sub)
    upstream.send({ type: "message.updated", properties: { id: "after" } })
    await until(() => late.events.length === 1, "late tab served")

    expect(late.events.map((e) => (e.properties as { id: string }).id)).toEqual(["after"])
    expect(upstream.connections).toBe(1)
  })

  it("holds the upstream open briefly after the last tab closes, then retires it", async () => {
    const upstream = await makeUpstream()
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    const { hub } = makeHub()

    const tab = collector()
    const detach = hub.subscribe(project(upstream.port), tab.sub)
    await until(() => hub.state("demo") === "open", "hub open")

    detach()
    // A reload or a project switch passes through zero subscribers; dialling
    // upstream again for each one is the cost the hub exists to remove.
    expect(upstream.live).toBe(1)
    await until(() => upstream.live === 0, "upstream retired")
  })

  it("reconnects after the upstream drops, without the tabs noticing", async () => {
    const upstream = await makeUpstream()
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    const { hub } = makeHub()

    const tab = collector()
    hub.subscribe(project(upstream.port), tab.sub)
    await until(() => hub.state("demo") === "open", "hub open")

    // What a `serve` restart looks like from here.
    upstream.destroyAll()
    await until(() => upstream.connections >= 2, "hub reconnected")

    upstream.send({ type: "message.updated", properties: { id: "post-restart" } })
    await until(() => tab.events.length === 1, "tab served after reconnect")
    expect(tab.flushes).toHaveLength(0)
  })

  it("redials an upstream that stays open but has gone silent", async () => {
    // The reported failure: `serve` is replaced by the supervisor, its socket is
    // left ESTABLISHED with no FIN and no RST, so Node emits neither `end` nor
    // `error`. The hub kept reporting "open" and delivered nothing, forever, while
    // REST kept working — a UI that updates only on reload, with no error shown.
    //
    // Reproduced by having the upstream accept the connection and then say
    // nothing at all. Every other reconnect test here uses destroyAll(), which
    // fires the events the hub already handles, so it cannot reach this path.
    const upstream = await makeUpstream()
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    upstream.goSilent()
    const { hub } = makeHub(new Map(), { EVENT_HUB_SILENCE_TIMEOUT_MS: "80", EVENT_HUB_LIVENESS_CHECK_MS: "20" })

    const tab = collector()
    hub.subscribe(project(upstream.port), tab.sub)
    // The hub counts as open only once it has the upstream response, which is
    // after the server accepted the request.
    await until(() => hub.state("demo") === "open", "hub reported the stream open")

    // This is the whole bug in one line: a live-looking socket, one connection,
    // and no possible path to any event.
    expect(upstream.connections).toBe(1)

    await until(() => upstream.connections >= 2, "hub redialled the silent upstream")

    // And the new socket must actually deliver, which is the whole point.
    upstream.send({ type: "message.updated", properties: { id: "after-redial" } })
    await until(() => tab.events.length === 1, "events flow again after the redial")
    expect(tab.events[0]).toMatchObject({ type: "message.updated" })
  })

  it("does not redial an upstream that is merely quiet between turns", async () => {
    const upstream = await makeUpstream()
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    const { hub } = makeHub(new Map(), { EVENT_HUB_SILENCE_TIMEOUT_MS: "400", EVENT_HUB_LIVENESS_CHECK_MS: "20" })

    const tab = collector()
    hub.subscribe(project(upstream.port), tab.sub)
    await until(() => upstream.connections >= 1, "upstream dialled")

    // Heartbeats well inside the window: this is an idle-but-healthy stream, and
    // treating it as dead would churn the shared socket on every quiet turn.
    for (let i = 0; i < 6; i++) {
      await sleep(50)
      upstream.send({ type: "server.heartbeat", properties: {} })
    }

    expect(upstream.connections).toBe(1)
    expect(hub.state("demo")).toBe("open")
  })

  it("keeps serving subscribers while a turn streams for longer than the silence window", async () => {
    // The flip side of the liveness check, and the reason the timeout is 45s
    // rather than something tighter: a real agent turn can go a long time between
    // frames (a slow tool call, a queued subagent). Treating that as a dead socket
    // would tear down a healthy stream in the middle of the user's turn, which is
    // worse than the bug being fixed.
    const upstream = await makeUpstream()
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    // A window shorter than the gap between the frames below, so only a steady
    // drip of events keeps this stream considered alive.
    const { hub } = makeHub(new Map(), { EVENT_HUB_SILENCE_TIMEOUT_MS: "200", EVENT_HUB_LIVENESS_CHECK_MS: "15" })

    const tab = collector()
    hub.subscribe(project(upstream.port), tab.sub)
    await until(() => hub.state("demo") === "open", "hub reported the stream open")

    // Ten frames over ~600ms: each gap is inside the window, while the turn as a
    // whole lasts several times the window.
    for (let i = 0; i < 10; i++) {
      await sleep(60)
      upstream.send({ type: "message.part.delta", properties: { text: `t${i}` } })
    }
    await until(() => tab.events.length === 10, "all frames delivered")

    expect(tab.events).toHaveLength(10)
    // Never recycled: a mid-turn teardown would show as a second connection.
    expect(upstream.connections).toBe(1)
    expect(hub.state("demo")).toBe("open")
  })

  it("flushes browser subscribers once an outage is sustained, but not internal ones", async () => {
    const upstream = await makeUpstream()
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    const { hub } = makeHub()

    const browser = collector()
    // The notifier's shape: an internal consumer with no client state to refetch.
    const internalEvents: StreamEvent[] = []
    const internal: HubSubscriber = { deliver: (e) => internalEvents.push(e) }

    hub.subscribe(project(upstream.port), browser.sub)
    hub.subscribe(project(upstream.port), internal)
    await until(() => upstream.live === 1, "hub open")

    upstream.destroyAll()
    upstream.endAll()
    upstream.status = 503

    await until(() => browser.flushes.length > 0, "browser flushed")
    // The notifier must not be detached during a restart, or Telegram goes
    // silent for the rest of the outage.
    expect(hub.subscriberCount("demo")).toBe(2)

    // The flush lands while the hub is still inside its backoff, so the upstream
    // has to be restored and reopened before anything can be delivered.
    upstream.status = 200
    await until(() => hub.state("demo") === "open", "hub recovered")
    upstream.send({ type: "message.updated", properties: { id: "recovered" } })
    await until(() => internalEvents.length === 1, "internal consumer still served")
  })

  it("reports an unreachable upstream so a cold start can answer 503", async () => {
    const upstream = await makeUpstream()
    upstream.status = 503
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    const { hub, registry } = makeHub()

    const tab = collector()
    hub.subscribe(project(upstream.port), tab.sub)

    // Without this the proxy would answer 200 with a silent stream and the UI
    // would sit there updating nothing.
    expect(await hub.waitForOpen(project(upstream.port), 500)).toBe(false)
    expect(registry.started.length).toBeGreaterThan(0)

    upstream.status = 200
    expect(await hub.waitForOpen(project(upstream.port), 2_000)).toBe(true)
  })

  it("dials anyway when the supervisor refuses, because the stream is the truth", async () => {
    const upstream = await makeUpstream()
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    const { hub, registry } = makeHub()
    registry.ok = false

    const tab = collector()
    hub.subscribe(project(upstream.port), tab.sub)
    await until(() => hub.state("demo") === "open", "hub open despite a refusing supervisor")

    // The supervisor is a control plane that can be restarting or briefly
    // unreachable while `serve` is perfectly alive. Gating the dial on its answer
    // would silence a working stream until the supervisor came back.
    upstream.send({ type: "message.updated", properties: { id: "x" } })
    await until(() => tab.events.length === 1, "tab served")
  })

  it("authenticates to the upstream itself and forwards no browser credential", async () => {
    const upstream = await makeUpstream()
    cleanups.push(() => new Promise<void>((r) => upstream.server.close(() => r())))
    const { hub } = makeHub()

    hub.subscribe(project(upstream.port), collector().sub)
    await until(() => upstream.lastHeaders !== null, "upstream dialled")

    const expected = `Basic ${Buffer.from("opencode:serve-pw").toString("base64")}`
    expect(upstream.lastHeaders?.["authorization"]).toBe(expected)
    expect(upstream.lastHeaders?.["cookie"]).toBeUndefined()
  })

  it("never lets one slow client hold the shared stream hostage", () => {
    const { hub } = makeHub()
    const written: string[] = []
    const res = {
      writableEnded: false,
      writableLength: 5_000,
      write: (chunk: string) => written.push(chunk),
      end: () => {
        res.writableEnded = true
      },
    }

    // A stalled tab is dropped rather than buffered without bound; the browser
    // reconnects and refetches, which is recoverable. Growing a heap is not.
    expect(hub.writeToClient(res as never, { type: "x", properties: {} })).toBe(false)
    expect(res.writableEnded).toBe(true)
    expect(written).toHaveLength(0)
  })

  it("reports closed for a project it has never been asked about", () => {
    const { hub } = makeHub()
    expect(hub.state("never-seen")).toBe("closed")
  })
})

describe("frame parsing", () => {
  it("keeps the fields opencode stamps on every frame", () => {
    const event = parseFrame('data: {"id":"evt_1","type":"server.connected","properties":{}}')
    expect(event).toEqual({ id: "evt_1", type: "server.connected", properties: {} })
  })

  it("joins a multi-line data field", () => {
    expect(parseFrame('data: {"type":"x",\ndata: "properties":{}}')).toEqual({ type: "x", properties: {} })
  })

  it("drops frames that carry nothing a consumer can use", () => {
    // Comment keepalives, which the proxy injects and opencode emits.
    expect(parseFrame(": ping")).toBeNull()
    expect(parseFrame("")).toBeNull()
    expect(parseFrame("data: not json")).toBeNull()
    expect(parseFrame('data: {"properties":{}}')).toBeNull()
    expect(parseFrame('data: {"type":"x"}')).toBeNull()
    expect(parseFrame('data: {"type":"x","properties":null}')).toBeNull()
    expect(parseFrame('data: "a string"')).toBeNull()
  })
})
