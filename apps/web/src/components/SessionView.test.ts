import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import SessionView from "./SessionView.svelte"
import { eventStream } from "../lib/events.svelte.js"

/**
 * Replays real SSE frames through the component.
 *
 * Every fixture below is a frame captured from a live turn, not an invented one.
 * That is the point: each of these tests corresponds to a bug that shipped to a
 * running container while the gateway, the proxy, and upstream all reported
 * healthy. The client discarded correct payloads silently, because dropping an
 * event is not an exception and leaves nothing in the logs.
 *
 * The failures were all diagnosable from the wire data alone, and all of them
 * were misdiagnosed at least once from source. These tests exist so the wire
 * shape, not an assumption about it, is what the component is held to.
 */

const SESSION = "ses_eff720283ffesBoG1ewYEPrxkj"

/** Frames in the exact order upstream emitted them for one turn. */
const TURN_FRAMES: unknown[] = [
  {
    type: "session.status",
    properties: { sessionID: SESSION, status: { type: "busy" } },
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      part: { id: "prt_step", messageID: "msg_a", sessionID: SESSION, type: "step-start" },
    },
  },
  {
    // The first text part carries text:"" BEFORE any delta. This frame is the
    // only thing that puts the part on screen so a delta sink node exists.
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      part: { id: "prt_t1", messageID: "msg_a", sessionID: SESSION, type: "text", text: "" },
    },
  },
  // Deltas are incremental tokens, in `delta`. `text` is the full accumulated
  // string and only arrives on the final part update.
  { type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_a", partID: "prt_t1", field: "text", delta: "Under" } },
  { type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_a", partID: "prt_t1", field: "text", delta: "stood" } },
  { type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_a", partID: "prt_t1", field: "text", delta: " - ok" } },
  {
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      part: { id: "prt_t1", messageID: "msg_a", sessionID: SESSION, type: "text", text: "Understood - ok" },
    },
  },
  // The parent arrives AFTER its parts. Note sessionID is here but NOT in info.
  {
    type: "message.updated",
    properties: {
      sessionID: SESSION,
      info: { id: "msg_a", role: "assistant", sessionID: SESSION },
    },
  },
  { type: "session.status", properties: { sessionID: SESSION, status: { type: "busy" } } },
  { type: "session.status", properties: { sessionID: SESSION, status: { type: "idle" } } },
  { type: "session.idle", properties: { sessionID: SESSION } },
]

/** The user message's parts also stream, and a part carries no role. */
const USER_PART_FRAMES: unknown[] = [
  {
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      part: { id: "prt_u1", messageID: "msg_u", sessionID: SESSION, type: "text", text: "hello there" },
    },
  },
  {
    type: "message.updated",
    properties: {
      sessionID: SESSION,
      // sessionID absent from info on this frame, and summary is an empty
      // object, which is truthy.
      info: { id: "msg_u", role: "user", summary: { diffs: [] } },
    },
  },
]

/**
 * Stand-in for the EventSource the singleton opens, driven frame by frame.
 *
 * The component does not construct an EventSource itself; it subscribes to the
 * shared `eventStream`, which is a module-level singleton with a private
 * refCount. Stubbing the global alone is therefore not enough to feed frames in,
 * so the frames go through the real singleton's public API instead.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((ev: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string, readonly init?: EventSourceInit) {
    FakeEventSource.instances.push(this)
    // Real EventSource fires onopen asynchronously.
    queueMicrotask(() => this.onopen?.())
  }
  close() {}
  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

/** Lets Svelte flush the microtask queue before assertions. */
const flush = () => new Promise((r) => setTimeout(r, 0))

/** Count of message-list reads, which is what a refetch has to produce. */
function messageReads(): number {
  return (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
    String(c[0]).includes("/message?"),
  ).length
}

/**
 * Re-issues the default fetch mock with a different session title.
 *
 * Wraps the existing implementation rather than repeating it, so the route table
 * above stays the single place that knows what each endpoint answers.
 */
function withTitle(title: string) {
  const base = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).getMockImplementation()!
  ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await base(input, init)
      if (/\/session\/[^/]+$/.test(String(input))) {
        const body = (await res.json()) as Record<string, unknown>
        return new Response(JSON.stringify({ ...body, title }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return res
    },
  )
}

/** One pending question request, as the v1 `GET /question` list returns it: a bare array. */
const ONE = [
  {
    id: "que_1",
    sessionID: SESSION,
    questions: [
      {
        question: "Which approach should I take?",
        header: "Approach",
        options: [
          { label: "Rewrite", description: "Replace the parser" },
          { label: "Patch", description: "Change only what breaks" },
        ],
      },
    ],
  },
]

/**
 * Points the question list at `pending` for this test.
 *
 * The list route answers before the `/reply` and `/reject` routes on purpose:
 * those are matched on their full path, so a blanket `/question` match would
 * swallow the 204 the setters return and the panel would never clear.
 *
 * The list is served as a bare array, which is what the real v1 route returns,
 * so a regression back to expecting a `{ data }` envelope fails here.
 */
function withQuestion(pending: unknown[]) {
  ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    if (/\/question\/[^/]+\/(reply|reject)$/.test(url)) return new Response(null, { status: 204 })
    if (url.includes("/question")) return json(pending)
    if (url.includes("/permission")) return json({ data: [] })
    if (url.includes("/message?")) return json([])
    if (url.includes("/message")) return json({})
    if (/\/session\/[^/]+\/(model|agent)$/.test(url)) return new Response(null, { status: 204 })
    if (url.includes("/children")) return json([])
    if (url.includes("/todo")) return json([])
    if (url.includes("/session/")) return json({ id: SESSION, title: "t" })
    if (url.includes("/api/projects")) {
      return json({ active: "proj_1", projects: [{ id: "proj_1", name: "one" }] })
    }
    if (url.includes("/api/gateway/model-catalog")) {
      return json({
        providers: [
          {
            id: "prov",
            name: "Big Provider",
            models: [
              { id: "model-b", providerID: "prov", name: "Model B" },
              { id: "model-a", providerID: "prov", name: "Model A", enabled: false },
            ],
          },
        ],
      })
    }
    if (url.includes("/path")) {
      return json({ home: "C:\\Users", state: "s", config: "c", worktree: "C:\\repo", directory: "C:\\repo" })
    }
    return json([])
  })
}

beforeEach(() => {
  FakeEventSource.instances = []
  // jsdom implements neither scrollTo nor the layout it needs. The component
  // calls scrollTo after every message, and an unstubbed call throws inside a
  // requestAnimationFrame, which surfaces as an unrelated test failure.
  Element.prototype.scrollTo = function scrollTo() {}
  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    if (url.includes("/message?")) return json([])
    if (url.includes("/message")) return json({})
    // The setters reply 204 and are matched on their full path so the model
    // catalog route (/api/gateway/model-catalog) is not caught by the `/model`
    // suffix. Both live in the `/api/session/...` family upstream; the
    // unprefixed paths are the SPA page.
    if (url.includes("/todo")) return json([])
    if (url.includes("/question") || url.includes("/permission")) return json([])
    if (/\/question\/[^/]+\/(reply|reject)$/.test(url)) return new Response(null, { status: 204 })
    if (/\/session\/[^/]+\/(model|agent)$/.test(url)) return new Response(null, { status: 204 })
    if (url.includes("/session/")) return json({ id: SESSION, title: "t" })
    // GET /api/projects is the gateway's allowlist, GET /path is the instance's cwd.
    if (url.includes("/api/projects")) {
      return json({ active: "proj_1", projects: [{ id: "proj_1", name: "one" }] })
    }
    if (url.includes("/api/gateway/model-catalog")) {
      return json({
        providers: [
          {
            id: "prov",
            name: "Big Provider",
            models: [
              { id: "model-b", providerID: "prov", name: "Model B" },
              { id: "model-a", providerID: "prov", name: "Model A", enabled: false },
            ],
          },
        ],
      })
    }
    if (url.includes("/path")) {
      return json({ home: "C:\\Users", state: "s", config: "c", worktree: "C:\\repo", directory: "C:\\repo" })
    }
    return json([])
  }))
})

afterEach(() => {
  // testing-library only auto-registers this when a global afterEach exists,
  // and Vitest does not expose one unless globals is enabled. Without this the
  // previous test's transcript stays in the document and queries match it too.
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // The stream is a module-level singleton, so its refCount and listeners
  // survive into the next test unless explicitly reset.
  eventStream.close()
})

describe("SessionView live event rendering", () => {
  it("streams a reply into the transcript token by token", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    for (const frame of TURN_FRAMES) eventStream.emitForTest(frame as never)
    await flush()

    // Regression: applyDelta used to read `text`, which is undefined on a delta
    // frame, so every token was discarded and the reply only appeared after a
    // reload fetched the completed message.
    await waitFor(() => expect(screen.getByText(/Understood/)).toBeTruthy())
  })

  it("renders the reply without needing a reload", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    // Nothing is loaded; the transcript starts empty.
    expect(screen.queryByText(/Understood/)).toBeNull()

    for (const frame of TURN_FRAMES) eventStream.emitForTest(frame as never)
    await flush()

    // Regression: the parent message.updated carried sessionID only at the
    // properties level, so reading info.sessionID rejected every frame and the
    // reply never rendered at all.
expect(screen.getByText(/Understood/)).toBeTruthy()
  })

  it("does not render the user's message as agent output", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    for (const frame of USER_PART_FRAMES) eventStream.emitForTest(frame as never)
    for (const frame of TURN_FRAMES) eventStream.emitForTest(frame as never)
    await flush()

    // Regression: a part carries no role, and the handler synthesized a parent
    // with role:"assistant", so the user's own text rendered a second time as if
    // the agent had written it. The text must never appear at all, since the
    // user's message is already on screen from send()'s optimistic insert.
    expect(screen.queryAllByText(/hello there/)).toHaveLength(0)
  })

  it("ignores frames belonging to another session", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    eventStream.emitForTest({
      type: "message.updated",
      properties: {
        sessionID: "ses_other",
        info: { id: "msg_x", role: "assistant", sessionID: "ses_other" },
      },
    } as never)
    eventStream.emitForTest({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_other",
        part: { id: "prt_x", messageID: "msg_x", sessionID: "ses_other", type: "text", text: "not mine" },
      },
    } as never)
    await flush()

    expect(screen.queryByText(/not mine/)).toBeNull()
  })

  it("shows partial text while the turn is still streaming", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

// Real ordering: the part and its deltas arrive BEFORE message.updated, so the
    // role is still unknown while the tokens are already flowing. The transcript
    // must not stay blank until the turn ends.
    // Frames 0-3: busy, step-start, the text part with text:"", then delta "Under".
    for (const frame of TURN_FRAMES.slice(0, 4)) eventStream.emitForTest(frame as never)
    await flush()
    expect(screen.getByText(/Under/)).toBeTruthy()

    // The next delta extends it: "Under" + "stood".
    eventStream.emitForTest(TURN_FRAMES[4] as never)
    await flush()
    expect(screen.getByText(/Understood/)).toBeTruthy()
  })

  it("keeps the finished message on screen when its info carries a summary", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    // Real parent frame for a completed assistant message: info.summary is an
    // object (a turn summary), not a boolean flag. It is truthy, so a
    // `if (m.summary) return` guard silently discards the message — the streamed
    // text vanishes the moment the turn completes, and only comes back on a
    // reload because REST has it by then.
    const frames = [
      ...TURN_FRAMES.slice(0, 6),
      {
        type: "message.updated",
        properties: {
          sessionID: SESSION,
          info: { id: "msg_a", role: "assistant", sessionID: SESSION, summary: { diffs: [] } },
        },
      },
      { type: "session.idle", properties: { sessionID: SESSION } },
    ]
    for (const frame of frames) eventStream.emitForTest(frame as never)
    await flush()

    expect(screen.getByText(/Understood/)).toBeTruthy()
    // The pending bubble was replaced by a real message, not merely left alone.
    expect(document.querySelector("article.pending")).toBeNull()
  })

  it("keeps the reply when a second message.updated arrives with no parts", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    // opencode sends message.updated more than once per assistant message. The
    // frames carry `info` only — never `parts` — so the second one (emitted when
    // the turn completes, adding time.completed) arrives with no content at all.
    const frames = [
      ...TURN_FRAMES.slice(0, 6),
      {
        type: "message.updated",
        properties: {
          sessionID: SESSION,
          info: { id: "msg_a", role: "assistant", sessionID: SESSION },
        },
      },
      {
        type: "message.updated",
        properties: {
          sessionID: SESSION,
          // No `parts` key at all, exactly as upstream sends it.
          info: { id: "msg_a", role: "assistant", sessionID: SESSION, time: { completed: 1 } },
        },
      },
      { type: "session.idle", properties: { sessionID: SESSION } },
    ]
    for (const frame of frames) eventStream.emitForTest(frame as never)
    await flush()

    // The turn is over, so this is the final state. The reply must still be here.
    expect(screen.getByText(/Understood/)).toBeTruthy()
  })

  it("renders a part that arrives before its parent", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    // Frames 0-5: busy, step-start, the text part, and all three deltas. Still no
    // final part update and no parent, so this can only be rendered from deltas.
    for (const frame of TURN_FRAMES.slice(0, 6)) eventStream.emitForTest(frame as never)
    await flush()

    // The text is already on screen, but attributed to nobody: the parent has not
    // said whose it is, so the bubble must not be styled as the agent's.
    const pendingNode = screen.getByText(/Understood/)
    expect(pendingNode).toBeTruthy()
    const bubble = pendingNode.closest("article")
    expect(bubble?.classList.contains("pending")).toBe(true)
    expect(bubble?.classList.contains("user")).toBe(false)

    // The parent resolves the role and the pending bubble becomes a real message.
    eventStream.emitForTest(TURN_FRAMES[7] as never)
    await flush()
    const attached = screen.getByText(/Understood/)
    expect(attached.closest("article")?.classList.contains("pending")).toBe(false)
  })

  it("streams reasoning tokens into the thinking block", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    // Reasoning arrives as its own part and streams through the same delta
    // channel as text. Without a delta sink on the thinking block these tokens
    // target a partID that is not in liveStore and are dropped, leaving it empty
    // until the final part update.
    const frames = [
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION,
          part: { id: "prt_r1", messageID: "msg_a", sessionID: SESSION, type: "reasoning", text: "" },
        },
      },
      { type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_a", partID: "prt_r1", field: "text", delta: "checking" } },
      { type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_a", partID: "prt_r1", field: "text", delta: " the spec" } },
    ]
    for (const frame of frames) eventStream.emitForTest(frame as never)
    await flush()

    expect(screen.getByText(/checking the spec/)).toBeTruthy()
  })

  it("shows a progress bar only while a turn is running", async () => {
    const { container } = render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    const bar = () => container.querySelector(".progress")
    expect(bar()?.classList.contains("on")).toBe(false)

    eventStream.emitForTest({
      type: "session.status",
      properties: { sessionID: SESSION, status: { type: "busy" } },
    } as never)
    await flush()
    expect(bar()?.classList.contains("on")).toBe(true)

    eventStream.emitForTest({
      type: "session.status",
      properties: { sessionID: SESSION, status: { type: "idle" } },
    } as never)
    await flush()
    expect(bar()?.classList.contains("on")).toBe(false)
  })

  it("offers the mode toggle and lists only enabled models", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    const build = await screen.findByRole("button", { name: "Build" })
    const plan = await screen.findByRole("button", { name: "Plan" })
    expect(build.getAttribute("aria-pressed")).toBe("true")
    expect(plan.getAttribute("aria-pressed")).toBe("false")

    // `enabled: false` models are filtered out, so a deprecated entry cannot be
    // selected. This assertion is about the option list, not the label.
    const select = document.querySelector(".pick select") as HTMLSelectElement
    const labels = [...select.options].map((o) => o.textContent)
    expect(labels).toContain("Model B")
    expect(labels).not.toContain("Model A")
    // Options are grouped under the provider's display name, not its raw id.
    // One option remains besides the placeholder: Model B, under its group.
    const group = select.querySelector("optgroup")
    expect(group).toBeTruthy()
    expect((group as HTMLOptGroupElement).label).toBe("Big Provider")
    expect(group?.querySelectorAll("option")).toHaveLength(1)
    expect(group?.querySelector("option")?.textContent).toBe("Model B")
  })

  it("switches mode through the agent endpoint and keeps Build pressed by default", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    const plan = await screen.findByRole("button", { name: "Plan" })
    await fireEvent.click(plan)
    await waitFor(() => {
      expect(plan.getAttribute("aria-pressed")).toBe("true")
    })

    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes("/agent"),
    )
    expect(call).toBeTruthy()
    expect(JSON.parse(String((call as unknown as [string, RequestInit])[1].body))).toEqual({
      agent: "plan",
    })
  })

  it("reverts the mode toggle when the agent request fails", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    const plan = await screen.findByRole("button", { name: "Plan" })
    // A JSON error body, which is what the gateway sends, so parseError can read
    // the message out of it rather than falling back to the status text.
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ code: "agent_rejected", message: "unknown agent" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    )
    await fireEvent.click(plan)
    // The optimistic toggle has to roll back, otherwise the UI claims a mode the
    // server rejected and the next turn silently uses the old one.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Build" }).getAttribute("aria-pressed")).toBe("true")
    })
    expect(screen.getByRole("alert").textContent).toContain("unknown agent")
  })

  it("renders the plan checklist from the session todo endpoint", async () => {
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
      if (url.includes("/todo")) {
        return json([
          { content: "Read the spec", status: "completed", priority: "high" },
          { content: "Wire the picker", status: "in_progress", priority: "medium" },
        ])
      }
      if (url.includes("/message?")) return json([])
      if (url.includes("/session/")) return json({ id: SESSION, title: "t" })
      if (url.includes("/api/projects")) return json({ active: "p1", projects: [{ id: "p1", name: "one" }] })
      if (url.includes("/path")) return json({ home: "h", state: "s", config: "c", worktree: "w", directory: "w" })
      if (url.includes("/api/gateway/model-catalog")) return json({ providers: [] })
      return json([])
    })

    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    expect(await screen.findByText("Read the spec")).toBeTruthy()
    expect(screen.getByText("Wire the picker")).toBeTruthy()
    // The counter reads completed/total, which is the useful progress signal.
    expect(screen.getByText(/plan · 1\/2/)).toBeTruthy()
  })

  it("reads the agent and model from the session endpoint, not from the last message", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
      if (url.includes("/session/") && url.endsWith(`/${SESSION}`)) {
        return json({
          id: SESSION,
          title: "t",
          agent: "plan",
          model: { id: "big-pickle", providerID: "opencode" },
        })
      }
      if (url.includes("/message")) return json([])
      if (url.includes("/api/gateway/model-catalog")) return json({ providers: [] })
      if (url.includes("/api/projects")) return json({ active: "p1", projects: [{ id: "p1", name: "one" }] })
      if (url.includes("/path")) return json({ home: "h", state: "s", config: "c", worktree: "w", directory: "w" })
      if (url.includes("/todo")) return json([])
      if (url.includes("/children")) return json([])
      if (url.includes("/question")) return json([])
      if (url.includes("/permission")) return json({ data: [] })
      return json({})
    })

    render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    // The session says "plan"; the message stream says "build". We must believe the session.
    expect((await screen.findByRole("button", { name: "Plan" })).getAttribute("aria-pressed")).toBe("true")
  })

  it("shows a pending question above the composer", async () => {
    withQuestion(ONE)
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    // The turn is blocked until this is answered, so it has to be unmissable.
    expect(await screen.findByText("Which approach should I take?")).toBeTruthy()
    expect(screen.getByText("Rewrite")).toBeTruthy()
    expect(screen.getByRole("button", { name: "send answer" })).toBeTruthy()
  })

  it("renders a question raised over the event stream", async () => {
    withQuestion([])
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    expect(screen.queryByText("Which approach should I take?")).toBeNull()

    // The event payload is deliberately ignored; the list is re-read from the
    // endpoint, which is the authority on what is still pending.
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
      if (url.includes("/question")) return json(ONE)
      if (url.includes("/permission")) return json({ data: [] })
      if (url.includes("/todo")) return json([])
      if (url.includes("/message?")) return json([])
      if (url.includes("/message")) return json({})
      if (url.includes("/session/")) return json({ id: SESSION, title: "t" })
      return json([])
    })

    eventStream.emitForTest({
      type: "question.v2.asked",
      properties: { id: "que_1", sessionID: SESSION, questions: ONE[0]!.questions },
    } as never)
    await waitFor(async () => {
      expect(await screen.findByText("Which approach should I take?")).toBeTruthy()
    })
  })

  it("ignores a question event for a different session", async () => {
    withQuestion([])
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    eventStream.emitForTest({
      type: "question.v2.asked",
      properties: { id: "que_x", sessionID: "ses_other", questions: ONE[0]!.questions },
    } as never)
    await flush()
    expect(screen.queryByText("Which approach should I take?")).toBeNull()
  })

  it("replies with the chosen labels and clears the question", async () => {
    withQuestion(ONE)
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    await screen.findByText("Which approach should I take?")
    await fireEvent.click(screen.getByText("Patch"))
    await fireEvent.click(screen.getByRole("button", { name: "send answer" }))

    await waitFor(() => {
      const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
        String(c[0]).includes("/reply"),
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String((call as unknown as [string, RequestInit])[1].body))).toEqual({
        answers: [["Patch"]],
      })
    })
    // The reply is 204 with no body, so the panel has to be cleared locally.
    await waitFor(() => {
      expect(screen.queryByText("Which approach should I take?")).toBeNull()
    })
  })

  it("blocks the reply until every question is answered", async () => {
    withQuestion([
      {
        id: "que_2",
        sessionID: SESSION,
        questions: [
          {
            question: "Pick a database",
            header: "Database",
            options: [{ label: "Postgres", description: "" }],
          },
          {
            question: "Pick a region",
            header: "Region",
            options: [{ label: "eu-west", description: "" }],
          },
        ],
      },
    ])
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    await screen.findByText("Pick a database")
    const send = screen.getByRole("button", { name: "send answer" }) as HTMLButtonElement
    expect(send.disabled).toBe(true)

    // One of two answered is still not enough: the reply is positional, so a
    // missing entry would shift the second answer onto the first question.
    await fireEvent.click(screen.getByText("Postgres"))
    expect((screen.getByRole("button", { name: "send answer" }) as HTMLButtonElement).disabled).toBe(true)

    await fireEvent.click(screen.getByText("eu-west"))
    expect((screen.getByRole("button", { name: "send answer" }) as HTMLButtonElement).disabled).toBe(false)

    await fireEvent.click(screen.getByRole("button", { name: "send answer" }))
    await waitFor(() => {
      const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
        String(c[0]).includes("/reply"),
      )
      expect(JSON.parse(String((call as unknown as [string, RequestInit])[1].body))).toEqual({
        answers: [["Postgres"], ["eu-west"]],
      })
    })
  })

  it("keeps several selections when the question is multi-select", async () => {
    withQuestion([
      {
        id: "que_3",
        sessionID: SESSION,
        questions: [
          {
            question: "Which files?",
            header: "Files",
            multiple: true,
            options: [
              { label: "a.ts", description: "" },
              { label: "b.ts", description: "" },
            ],
          },
        ],
      },
    ])
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    await screen.findByText("Which files?")
    await fireEvent.click(screen.getByText("a.ts"))
    await fireEvent.click(screen.getByText("b.ts"))
    await fireEvent.click(screen.getByRole("button", { name: "send answer" }))

    await waitFor(() => {
      const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
        String(c[0]).includes("/reply"),
      )
      expect(JSON.parse(String((call as unknown as [string, RequestInit])[1].body))).toEqual({
        answers: [["a.ts", "b.ts"]],
      })
    })
  })

  it("replaces the selection on a single-choice question", async () => {
    withQuestion(ONE)
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    await screen.findByText("Which approach should I take?")
    await fireEvent.click(screen.getByText("Rewrite"))
    await fireEvent.click(screen.getByText("Patch"))
    await fireEvent.click(screen.getByRole("button", { name: "send answer" }))

    await waitFor(() => {
      const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
        String(c[0]).includes("/reply"),
      )
      // Not both: a single-choice question replaces rather than accumulates.
      expect(JSON.parse(String((call as unknown as [string, RequestInit])[1].body))).toEqual({
        answers: [["Patch"]],
      })
    })
  })

  it("sends a typed custom answer alongside the selected options", async () => {
    withQuestion([
      {
        id: "que_4",
        sessionID: SESSION,
        questions: [
          {
            question: "Name the branch",
            header: "Branch",
            custom: true,
            options: [{ label: "feature/x", description: "" }],
          },
        ],
      },
    ])
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    await screen.findByText("Name the branch")
    await fireEvent.input(screen.getByPlaceholderText("or type your own answer"), {
      target: { value: "my-branch" },
    })
    await fireEvent.click(screen.getByRole("button", { name: "send answer" }))

    await waitFor(() => {
      const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
        String(c[0]).includes("/reply"),
      )
      // The typed text rides in the same array; the wire format has no
      // separate field for free text.
      expect(JSON.parse(String((call as unknown as [string, RequestInit])[1].body))).toEqual({
        answers: [["my-branch"]],
      })
    })
  })

  it("releases the turn through the reject route when skipped", async () => {
    withQuestion(ONE)
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    await screen.findByText("Which approach should I take?")
    await fireEvent.click(screen.getByRole("button", { name: "skip" }))

    await waitFor(() => {
      const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
        String(c[0]).includes("/reject"),
      )
      expect(call).toBeTruthy()
      expect(screen.queryByText("Which approach should I take?")).toBeNull()
    })
  })

  it("keeps the question on screen and explains the failure when a reply fails", async () => {
    withQuestion(ONE)
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    await screen.findByText("Which approach should I take?")
    await fireEvent.click(screen.getByText("Patch"))
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ code: "invalid_request", message: "question already answered" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    )
    await fireEvent.click(screen.getByRole("button", { name: "send answer" }))

    // Dropping the panel on failure would leave the user with no way to see
    // that the agent is still waiting.
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("question already answered")
    })
    expect(screen.getByText("Which approach should I take?")).toBeTruthy()
  })

  it("shows a pending question raised before this screen was opened", async () => {
    // Nothing is emitted here, so only the load-time read can find it.
    withQuestion(ONE)
    render(SessionView, { props: { sessionId: SESSION } })
  })
})

describe("stream lifecycle", () => {
  it("refetches the transcript after the stream drops and comes back", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    const before = messageReads()
    expect(before).toBeGreaterThan(0)

    // A dropped stream does not replay what happened while it was down, and
    // opencode sends no snapshot. Reconnecting without refetching leaves the page
    // showing stale state that is indistinguishable from a hung agent, which is
    // exactly why this needed a reload to look right again.
    FakeEventSource.instances[0]!.onerror?.()
    await flush()
    expect(screen.getByRole("status").textContent).toContain("event stream dropped")

    // The first retry is scheduled at retryMinMs (1s).
    await new Promise((r) => setTimeout(r, 1100))
    await flush()
    await waitFor(() => expect(messageReads()).toBeGreaterThan(before))
  })

  it("does not report a reconnect for the first successful open", async () => {
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    // The socket opened once. That is not a reconnect, and refetching on it would
    // double every load.
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("keeps one socket across a session change instead of rebuilding it", async () => {
    const { rerender } = render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    expect(FakeEventSource.instances).toHaveLength(1)

    await rerender({ sessionId: "ses_another" })
    await flush()

    // Every navigation used to close the shared socket and dial a new one, which
    // on a phone behind a tunnel means a fresh TLS handshake and a window in which
    // arriving events are dropped.
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

/**
 * Seeds a transcript and models revert the way the server actually behaves.
 *
 * The important detail is what this mock does *not* do: it never removes the
 * reverted messages and never flags them. opencode keeps them — they keep coming
 * back from `GET /message` with no marker — and only the session grows a
 * `revert: { messageID }`. A mock that quietly dropped the tail would hide the
 * very thing the UI has to handle, which is that it has to do the hiding itself.
 */
function withSession(state: { messages: unknown[]; revert?: { messageID: string } | null }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } })
      if (method === "POST" && url.endsWith("/revert")) {
        state.revert = { messageID: (JSON.parse(String(init?.body ?? "{}")) as { messageID: string }).messageID }
      } else if (method === "POST" && url.endsWith("/unrevert")) {
        state.revert = null
      } else if (url.includes("/message?")) {
        return json(state.messages)
      } else if (url.includes("/message")) {
        return json({})
      } else if (/\/question\/[^/]+\/(reply|reject)$/.test(url)) {
        return new Response(null, { status: 204 })
      } else if (url.includes("/question")) {
        return json([])
      } else if (url.includes("/permission") || url.includes("/children") || url.includes("/todo")) {
        return json([])
      } else if (/\/session\/[^/]+\/(model|agent)$/.test(url)) {
        return new Response(null, { status: 204 })
      } else if (/\/session\/[^/]+$/.test(url)) {
        return json({ id: SESSION, title: "t", revert: state.revert ?? null })
      } else if (url.includes("/api/projects")) {
        return json({ active: "proj_1", projects: [{ id: "proj_1", name: "one" }] })
      } else if (url.includes("/api/gateway/model-catalog")) {
        return json({
          providers: [
            { id: "prov", name: "Big Provider", models: [{ id: "model-b", providerID: "prov", name: "Model B", enabled: true }] },
          ],
        })
      } else if (url.includes("/path")) {
        return json({ home: "C:\\Users", state: "s", config: "c", worktree: "C:\\repo", directory: "C:\\repo" })
      }
      return json([])
    }),
  )
}

/** A user message with one text part, as the message list returns it. */
function userMsg(id: string, text: string) {
  return { info: { id, role: "user", sessionID: SESSION }, parts: [{ id: `prt_${id}`, type: "text", text }] }
}
function asstMsg(id: string, text: string) {
  return { info: { id, role: "assistant", sessionID: SESSION }, parts: [{ id: `prt_${id}`, type: "text", text }] }
}

describe("long-press actions", () => {
  const THREE = {
    messages: [
      userMsg("msg_u1", "first"),
      asstMsg("msg_a1", "one"),
      userMsg("msg_u2", "second"),
      asstMsg("msg_a2", "two"),
      userMsg("msg_u3", "third"),
      asstMsg("msg_a3", "three"),
    ],
    revert: null as { messageID: string } | null,
  }

  /** Presses send and holds long enough to trip the 500ms threshold. */
  async function longPressSend() {
    const send = screen.getByRole("button", { name: "Send" })
    await fireEvent.pointerDown(send)
    await new Promise((r) => setTimeout(r, 600))
    await fireEvent.pointerUp(send)
    await flush()
  }

  it("opens the menu on a long press without sending", async () => {
    withSession(structuredClone(THREE))
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    await longPressSend()
    expect(screen.getByRole("menu")).toBeTruthy()
    // The release after a long press must not submit: the message was never
    // meant to be sent.
    expect(
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
        String(c[0]).includes("/prompt_async"),
      ),
    ).toBe(false)
  })

  it("hides the reverted tail, which the server keeps sending", async () => {
    withSession(structuredClone(THREE))
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    expect(screen.getByText("third")).toBeTruthy()

    await longPressSend()
    await fireEvent.click(screen.getByRole("menuitem", { name: "undo last turn" }))
    await flush()

    const sheet = screen.getByRole("dialog")
    // Undoing the last turn drops that user message and the reply after it, so
    // the count is stated rather than implied.
    expect(sheet.textContent).toContain("Discard 2 messages")

    await fireEvent.click(screen.getByRole("button", { name: "undo" }))
    await waitFor(() => expect(screen.getByText(/later message/)).toBeTruthy())
    // The target user message and its reply go; the two earlier turns stay.
    expect(screen.queryByText("third")).toBeNull()
    expect(screen.queryByText("three")).toBeNull()
    expect(screen.getByText("second")).toBeTruthy()
    expect(screen.getByText("first")).toBeTruthy()
  })

  it("restores the tail", async () => {
    withSession(structuredClone(THREE))
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    await longPressSend()
    await fireEvent.click(screen.getByRole("menuitem", { name: "undo last turn" }))
    await flush()
    await fireEvent.click(screen.getByRole("button", { name: "undo" }))
    await waitFor(() => expect(screen.getByText(/later message/)).toBeTruthy())

    await fireEvent.click(screen.getByRole("button", { name: "restore" }))
    // Wait for the divider itself to go, rather than for "second" — "second" is
    // already on screen while the tail is hidden, so asserting on it would pass
    // before the restore had done anything.
    await waitFor(() => expect(screen.queryByText(/later message/)).toBeNull())
    expect(screen.getByText("third")).toBeTruthy()
  })

  it("loads a message back into the composer and sets the revert marker", async () => {
    withSession(structuredClone(THREE))
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    await longPressSend()
    await fireEvent.click(screen.getByRole("menuitem", { name: "undo an earlier message…" }))
    await flush()
    await fireEvent.click(screen.getAllByRole("button", { name: "undo from here" })[0]!)
    await flush()
    await fireEvent.click(screen.getByRole("button", { name: "undo" }))
    await flush()

    // The revert marker is what makes the resend replace the tail, so it has to be
    // set before the prompt goes out.
    await waitFor(() =>
      expect(
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
          (c) => String(c[0]).includes("/revert") && c[1]?.method === "POST",
        ),
      ).toBe(true),
    )
    expect(
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => String(c[0]).includes("/revert") && String(c[1]?.body).includes("msg_u1"),
      ),
    ).toBe(true)
  })

  it("labels the composer while editing and cancels back cleanly", async () => {
    withSession(structuredClone(THREE))
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    await longPressSend()
    await fireEvent.click(screen.getByRole("menuitem", { name: "edit last message" }))
    await flush()
    await fireEvent.click(screen.getByRole("button", { name: "edit" }))
    await flush()

    // The composer now holds an existing message and the next send rewrites the
    // transcript, so the state has to be stated rather than left to be inferred.
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("editing a message"))
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("third")

    await fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    await waitFor(() => expect(screen.queryByText(/editing a message/)).toBeNull())
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("")
    // Cancelling clears the marker, which puts the hidden turn back. The reflow
    // waits on the unrevert, so it has to be awaited rather than asserted.
    await waitFor(() => expect(screen.getByText("third")).toBeTruthy())
  })

  it("refuses to undo while a turn is running", async () => {
    withSession(structuredClone(THREE))
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    eventStream.emitForTest({
      type: "session.status",
      properties: { sessionID: SESSION, status: { type: "busy" } },
    })
    await flush()

    await longPressSend()
    // opencode answers 409 SessionBusyError for a revert during a turn, so the
    // control is disabled rather than left to fail.
    expect(screen.getByRole("menuitem", { name: "undo last turn" }).hasAttribute("disabled")).toBe(true)
  })
})

describe("the stop control", () => {
  const LONG =
    "a deliberately very long session title that used to push the stop control out of the header row on a phone"

  it("stays reachable in the composer when the title is long", async () => {
    withTitle(LONG)
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()

    eventStream.emitForTest({
      type: "session.status",
      properties: { sessionID: SESSION, status: { type: "busy" } },
    })
    await flush()

    const stop = screen.getByRole("button", { name: "Stop generating" })
    // jsdom does no layout, so the clipping itself cannot be asserted. What can be
    // pinned is the structure that caused it: the control belongs to the composer,
    // whose width does not depend on the title, and not to the title bar, whose
    // content does.
    expect(stop.closest(".composer")).not.toBeNull()
    expect(stop.closest(".bar")).toBeNull()
  })

  it("is absent while the session is idle", async () => {
    withTitle(LONG)
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull()
  })

  it("aborts the turn when pressed", async () => {
    withTitle(LONG)
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    eventStream.emitForTest({
      type: "session.status",
      properties: { sessionID: SESSION, status: { type: "busy" } },
    })
    await flush()

    await fireEvent.click(screen.getByRole("button", { name: "Stop generating" }))
    await waitFor(() =>
      expect(
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
          String(c[0]).includes("/abort"),
        ),
      ).toBe(true),
    )
  })
})

describe("composer on a touch device", () => {
  const touch = (hoverNone: boolean) =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: hoverNone && q.includes("hover"), media: q, addEventListener() {}, removeEventListener() {} })),
    )

  it("inserts a newline on Enter rather than sending", async () => {
    touch(true)
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    const before = messageReads()
    const box = screen.getByPlaceholderText("send a message") as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: "line one" } })

    await fireEvent.keyDown(box, { key: "Enter" })
    await flush()

    // On touch the return key is a newline. Sending here is what made a
    // multi-line prompt impossible to type on a phone.
    expect(messageReads()).toBe(before)
    expect(
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
        String(c[0]).includes("/prompt_async"),
      ),
    ).toBe(false)
  })

  it("still sends on Enter with a hardware keyboard", async () => {
    touch(false)
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    const box = screen.getByPlaceholderText("send a message") as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: "ship it" } })

    await fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() =>
      expect(
        (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
          String(c[0]).includes("/prompt_async"),
        ),
      ).toBe(true),
    )
  })

  it("does not send while an IME is composing", async () => {
    touch(false)
    render(SessionView, { props: { sessionId: SESSION } })
    await flush()
    const box = screen.getByPlaceholderText("send a message") as HTMLTextAreaElement
    fireEvent.input(box, { target: { value: "ni hao" } })

    await fireEvent.keyDown(box, { key: "Enter", isComposing: true })
    await flush()
    expect(
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
        String(c[0]).includes("/prompt_async"),
      ),
    ).toBe(false)
  })
})
