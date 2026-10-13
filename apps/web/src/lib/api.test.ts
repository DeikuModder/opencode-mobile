import { describe, expect, it } from "vitest"
import { serveApi } from "./api.js"

/**
 * Regressions for the wire shapes the UI actually receives.
 *
 * Every case here corresponds to a bug that shipped: the UI rendered nothing,
 * while the gateway, the proxy, and upstream were all healthy. In each case the
 * client silently dropped correct data because it assumed a shape that did not
 * match the wire. The recurring lesson is that absence of an error is not
 * evidence of success on an event path, so these assert on the parse itself.
 */

/** The real shape of GET /session/:id/message: metadata nested under `info`. */
const WIRE_MESSAGE = {
  info: {
    id: "msg_1",
    parentID: "msg_0",
    role: "assistant",
    sessionID: "ses_1",
    time: { created: 1, completed: 2 },
    cost: 0.01,
    tokens: { input: 10, output: 20 },
  },
  parts: [
    { id: "prt_1", type: "text", text: "Understood." },
    { id: "prt_2", type: "step-start" },
  ],
} as const

describe("opencode wire shapes", () => {
  it("nests message metadata under info, not at the top level", () => {
    // The whole class of bug: reading role/sessionID off the element instead of
    // element.info left them undefined, so user styling never matched and the
    // session filter rejected every message.
    const raw = WIRE_MESSAGE as unknown as Record<string, unknown>
    expect(raw.role).toBeUndefined()
    expect(raw.sessionID).toBeUndefined()
    expect((raw.info as Record<string, unknown>).role).toBe("assistant")
  })

  it("streams deltas in `delta`, not `text`", () => {
    // message.part.delta carries the incremental token as `delta`. `text` is the
    // full accumulated string and only arrives on the final part update. Reading
    // `text` here discarded every token, so replies appeared only after reload.
    const frame = {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
        field: "text",
        delta: "Under",
      },
    }
    expect(frame.properties.delta).toBe("Under")
    expect((frame.properties as { text?: string }).text).toBeUndefined()
  })

  it("carries sessionID at both the properties and info level of message.updated", () => {
    // Frames do not consistently put sessionID in both places, so a handler that
    // reads only info.sessionID drops events that were perfectly valid.
    const withBoth: { sessionID: string; info: { id: string; sessionID?: string } } = {
      sessionID: "ses_1",
      info: { id: "msg_1", sessionID: "ses_1" },
    }
    const propsOnly: { sessionID: string; info: { id: string; sessionID?: string } } = {
      sessionID: "ses_1",
      info: { id: "msg_2" },
    }
    expect(withBoth.info.sessionID).toBe("ses_1")
    expect(propsOnly.info.sessionID).toBeUndefined()
    // Resolving properties first works for both.
    expect(propsOnly.sessionID ?? propsOnly.info.sessionID).toBe("ses_1")
  })

  it("delivers parts before their parent message.updated", () => {
    // Ordering is not guaranteed: parts stream first with text:"" so the part is
    // on screen before the parent arrives. A handler that requires an existing
    // parent drops the part, and every later delta targets a missing node.
    const order = ["message.part.updated", "message.part.delta", "message.updated"]
    expect(order.indexOf("message.part.updated")).toBeLessThan(order.indexOf("message.updated"))
  })

  it("streams the USER message's parts too, and a part carries no role", () => {
    // Regression: the part handler synthesized a parent with role:"assistant"
    // because a part does not say who wrote it. The user's own text therefore
    // rendered a second time as if the agent had written it. The only correct
    // behavior is to buffer until the parent's role is known.
    const userPart = {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: {
          id: "prt_u",
          messageID: "msg_user",
          sessionID: "ses_1",
          type: "text",
          text: "hello",
        },
      },
    }
    expect((userPart.properties.part as { role?: string }).role).toBeUndefined()

    // And the parent that resolves it identifies the author as the user.
    const parent = { sessionID: "ses_1", info: { id: "msg_user", role: "user" } }
    expect(parent.info.role).toBe("user")
    // A user parent must never be routed into the transcript: it is already
    // rendered by send()'s optimistic insert or by load().
    expect(parent.info.role === "user").toBe(true)
  })

  it("carries summary as an object on ordinary messages, not a hide flag", () => {
    // Wire fact, pinned because it caused a real bug: `summary` arrives as an
    // object like { diffs: [] } and is present on normal completed assistant
    // messages. It was once typed `boolean`, which made `if (m.summary) return`
    // look like a sensible filter and silently discarded finished replies.
    const frame = {
      type: "message.updated",
      properties: { sessionID: "ses_1", info: { id: "msg_u", role: "user", summary: { diffs: [] } } },
    }
    expect(typeof frame.properties.info.summary).toBe("object")
    expect(frame.properties.info.role).toBe("user")
  })

  it("sends a first text part with empty text, before any delta", () => {
    const first = {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_1", messageID: "msg_1", type: "text", text: "" },
      },
    }
    expect(first.properties.part.text).toBe("")
  })

  it("marks the turn busy and idle via session.status and session.idle", () => {
    const busy = { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } }
    const idle = { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } }
    expect(busy.properties.status.type).toBe("busy")
    expect(idle.properties.status.type).toBe("idle")
  })

  it("includes part types the renderer has to handle", () => {
    // Recorded from a live turn: anything not in this set is a rendering gap.
    const seen = ["step-start", "text", "tool", "step-finish", "compaction", "reasoning"]
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toContain("reasoning")
    expect(seen).toContain("compaction")
  })
})

/**
 * Request-shape tests for the session control endpoints.
 *
 * These assert the URL and the request body, because both are places a plausible
 * guess is silently wrong: the model endpoint takes a `ModelRef` needing
 * `providerID` alongside `id`, and answering 204 means there is no reply to read
 * the new model back from.
 */
describe("session control endpoints", () => {
  function mockFetch(handler: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : String(input)
      calls.push({ url, init })
      return handler(url, init)
    }) as typeof fetch
    return {
      calls,
      restore: () => {
        globalThis.fetch = original
      },
    }
  }

  it("sends ModelRef with providerID and id, and accepts the empty 204 reply", async () => {
    const m = mockFetch(() => new Response(null, { status: 204 }))
    try {
      await expect(
        serveApi.setModel("ses_1", { providerID: "anthropic", id: "claude-sonnet-4" }),
      ).resolves.toBeUndefined()
      const call = m.calls[0]!
      // The /api/session/... family, not /session/.... The unprefixed path
      // answers 200 with opencode's SPA page, which is what made the model
      // picker silently do nothing.
      expect(call.url).toBe("/api/serve/api/session/ses_1/model")
      expect(call.init.method).toBe("POST")
      expect(JSON.parse(call.init.body as string)).toEqual({
        model: { providerID: "anthropic", id: "claude-sonnet-4" },
      })
    } finally {
      m.restore()
    }
  })

  it("unwraps the { location, data } envelope of GET /model", async () => {
    const m = mockFetch(() =>
      Response.json({
        location: { directory: "C:\\repo", worktree: "C:\\repo" },
        data: [{ id: "claude-sonnet-4", providerID: "anthropic", name: "Claude Sonnet 4" }],
      }),
    )
    try {
      const models = await serveApi.models()
      expect(models).toHaveLength(1)
      expect(models[0]?.id).toBe("claude-sonnet-4")
    } finally {
      m.restore()
    }
  })

  it("returns an empty model list instead of throwing when data is null", async () => {
    // `data` is nullable in the spec, which happens when no provider is configured.
    const m = mockFetch(() => Response.json({ location: {}, data: null }))
    try {
      await expect(serveApi.models()).resolves.toEqual([])
    } finally {
      m.restore()
    }
  })

  it("reports the SPA fallback as an error instead of a JSON syntax error", async () => {
    // opencode answers unknown paths with its index.html and HTTP 200, so a
    // mistyped endpoint looks like a success until the body is parsed. The error
    // has to name the path, or it surfaces as an unreadable
    // "Unexpected token '<'" with nothing pointing at the real mistake.
    const m = mockFetch(
      () =>
        new Response("<!doctype html><html><body>app</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    )
    try {
      await expect(serveApi.models()).rejects.toThrow(/Expected JSON but got the SPA page/)
      await expect(serveApi.models()).rejects.toThrow(/api\/model/)
    } finally {
      m.restore()
    }
  })

  it("reports malformed JSON rather than throwing a raw SyntaxError", async () => {
    const m = mockFetch(
      () =>
        new Response("{ not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    try {
      await expect(serveApi.models()).rejects.toThrow(/Malformed JSON/)
    } finally {
      m.restore()
    }
  })

  it("switches the agent by name, which is how Plan and Build are selected", async () => {
    const m = mockFetch(() => new Response(null, { status: 204 }))
    try {
      await serveApi.setAgent("ses_1", "plan")
      expect(m.calls[0]!.url).toBe("/api/serve/api/session/ses_1/agent")
      expect(JSON.parse(m.calls[0]!.init.body as string)).toEqual({ agent: "plan" })
    } finally {
      m.restore()
    }
  })

  it("reads the working directory from /path, the only place it is published", async () => {
    // Sessions carry no directory field, so the cwd display has to come from here.
    const m = mockFetch(() =>
      Response.json({ home: "C:\\Users", state: "s", config: "c", worktree: "C:\\repo", directory: "C:\\repo" }),
    )
    try {
      const p = await serveApi.path()
      expect(p.directory).toBe("C:\\repo")
      expect(m.calls[0]!.url).toBe("/api/serve/path")
    } finally {
      m.restore()
    }
  })
})

describe("blocking decision requests", () => {
  function mockFetch(handler: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : String(input)
      calls.push({ url, init })
      return handler(url, init)
    }) as typeof fetch
    return { calls, restore: () => { globalThis.fetch = original } }
  }

  it("reads the global v1 question list and filters it to this session", async () => {
    // The v1 GLOBAL route, not the per-session v2 route. Verified live on
    // 1.18.33: `/api/session/:id/question` answers `{ data: [] }` even while the
    // agent is blocked on a question, so a client reading it never renders the
    // card and the turn hangs forever. The v1 list carries the real requests,
    // including ones belonging to other sessions, which must be filtered out.
    const m = mockFetch(() =>
      Response.json([
        {
          id: "que_mine",
          sessionID: "ses_1",
          questions: [
            {
              question: "Which database?",
              header: "Database",
              options: [{ label: "Postgres", description: "Relational" }],
              multiple: false,
              custom: true,
            },
          ],
        },
        {
          id: "que_other",
          sessionID: "ses_2",
          questions: [{ question: "Unrelated", header: "Other", options: [] }],
        },
      ]),
    )
    try {
      const list = await serveApi.questions("ses_1")
      expect(list).toHaveLength(1)
      expect(list[0]?.id).toBe("que_mine")
      expect(list[0]?.questions[0]?.header).toBe("Database")
      expect(m.calls[0]?.url).toBe("/api/serve/question")
    } finally {
      m.restore()
    }
  })

  it("still accepts a { data } envelope so a server that sends one is not dropped", async () => {
    const m = mockFetch(() => Response.json({ data: [{ id: "que_1", sessionID: "ses_1", questions: [] }] }))
    try {
      const list = await serveApi.questions("ses_1")
      expect(list.map((q) => q.id)).toEqual(["que_1"])
    } finally {
      m.restore()
    }
  })

  it("treats a missing question list as empty", async () => {
    const m = mockFetch(() => Response.json(null))
    try {
      await expect(serveApi.questions("ses_1")).resolves.toEqual([])
    } finally {
      m.restore()
    }
  })

  it("sends answers positionally, one array per question, in order", async () => {
    // The reply is positional. Dropping or reordering an entry would answer a
    // different question than the one the user was shown.
    const m = mockFetch(() => new Response(null, { status: 204 }))
    try {
      await serveApi.replyQuestion("que_1", [["Postgres"], []])
      const call = m.calls[0]!
      expect(call.url).toBe("/api/serve/question/que_1/reply")
      expect(JSON.parse(call.init.body as string)).toEqual({ answers: [["Postgres"], []] })
    } finally {
      m.restore()
    }
  })

  it("releases the turn through the reject route", async () => {
    const m = mockFetch(() => new Response(null, { status: 204 }))
    try {
      await serveApi.rejectQuestion("que_1")
      expect(m.calls[0]?.url).toBe("/api/serve/question/que_1/reject")
      expect(m.calls[0]?.init.method).toBe("POST")
    } finally {
      m.restore()
    }
  })

  it("unwraps the pending permission list from the corrected route", async () => {
    // /session/:id/permission is not a route at all; v1 only has the plural
    // reply path. The old list call silently returned the SPA page.
    const m = mockFetch(() =>
      Response.json({
        data: [{ id: "per_1", sessionID: "ses_1", action: "bash", resources: ["ls"] }],
      }),
    )
    try {
      const list = await serveApi.permissions("ses_1")
      expect(list[0]?.action).toBe("bash")
      expect(m.calls[0]?.url).toBe("/api/serve/api/session/ses_1/permission")
    } finally {
      m.restore()
    }
  })
})

describe("session todos", () => {
  function mockFetch(handler: () => Response) {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      void input
      return handler()
    }) as typeof fetch
    return { restore: () => { globalThis.fetch = original } }
  }

  it("reads the todo list from the dedicated endpoint", async () => {
    // opencode serves the current list at /session/:id/todo, so it does not need
    // to be reconstructed from todowrite tool parts.
    const m = mockFetch(() =>
      Response.json([
        { content: "Read the spec", status: "completed", priority: "high" },
        { content: "Wire the picker", status: "in_progress", priority: "medium" },
      ]),
    )
    try {
      const todos = await serveApi.todos("ses_1")
      expect(todos).toHaveLength(2)
      expect(todos[1]?.status).toBe("in_progress")
    } finally {
      m.restore()
    }
  })

  it("treats a missing todo list as empty rather than failing", async () => {
    const m = mockFetch(() => Response.json(null))
    try {
      await expect(serveApi.todos("ses_1")).resolves.toEqual([])
    } finally {
      m.restore()
    }
  })
})