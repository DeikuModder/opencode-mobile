import { describe, expect, it } from "vitest"
import {
  DIFF_EXCERPT_LINES,
  TELEGRAM_MAX,
  escapeMd,
  formatBytes,
  formatHelp,
  formatProjects,
  formatStatus,
  summariseDiff,
  toNotification,
  truncate,
  type SessionContext,
} from "../src/notifier/messages.js"

const ctx: SessionContext = { sessionId: "ses_abc", title: "Fix login", project: "chain" }

describe("telegram message formatting", () => {
  it("truncates below the limit unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  it("does not cut a surrogate pair in half", () => {
    // An emoji is two UTF-16 units. Slicing naively leaves a lone high
    // surrogate, which renders as a replacement glyph.
    const s = "a😀b"
    const cut = truncate(s, 2)
    expect(cut).toBe("a")
    // The last code unit is not a dangling surrogate.
    expect(cut.charCodeAt(cut.length - 1)).toBeLessThan(0xd800)
  })

  it("truncates a long string to at most the limit", () => {
    expect(truncate("x".repeat(5000), TELEGRAM_MAX).length).toBeLessThanOrEqual(TELEGRAM_MAX)
  })

  it("escapes markdown metacharacters so a title cannot inject formatting", () => {
    // A session title is attacker-influenced: it can come from a prompt.
    const evil = "x *bold* [link](http://evil) _under_"
    const out = escapeMd(evil)
    expect(out).not.toMatch(/(?<!\\)\*/)
    expect(out).toContain("\\*")
  })

  it("does not escape punctuation that Telegram treats as ordinary text", () => {
    // Escaping ".", "-" and "!" turned an ellipsis into "\\.\\.\\." and
    // "rm -rf" into "rm \\-rf", which is unreadable noise rather than safety.
    expect(escapeMd("rm -rf build/")).toBe("rm -rf build/")
    expect(escapeMd("done...")).toBe("done...")
    expect(escapeMd("path/to/file.ts")).toBe("path/to/file.ts")
  })

  it("formats byte counts", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 kB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB")
  })

  it("summarises a diff into file and line counts", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old line",
      "+new line",
      "+another",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "-gone",
    ].join("\n")
    const s = summariseDiff(diff)
    expect(s.files).toBe(2)
    expect(s.added).toBe(2)
    expect(s.removed).toBe(2)
  })

  it("reports a single-file diff as one file", () => {
    const diff = "--- a/x\n+++ b/x\n+one\n-two"
    expect(summariseDiff(diff)).toEqual({ files: 1, added: 1, removed: 1 })
  })

  it("counts nothing in an empty diff", () => {
    expect(summariseDiff("")).toEqual({ files: 0, added: 0, removed: 0 })
  })
})

describe("event to notification", () => {
  it("notifies when a session goes idle", () => {
    const n = toNotification({ type: "session.idle", properties: { sessionID: "ses_abc" } }, ctx)
    expect(n?.text).toContain("Fix login")
    expect(n?.text).toContain("chain")
    expect(n?.text).toContain("Done")
    expect(n?.sessionId).toBe("ses_abc")
  })

  it("notifies on an error, with the message when present", () => {
    const n = toNotification(
      { type: "session.error", properties: { sessionID: "ses_abc", error: { data: { message: "rate limited" } } } },
      ctx,
    )
    expect(n?.text).toContain("rate limited")
  })

  it("falls back to the error name when there is no message", () => {
    const n = toNotification(
      { type: "session.error", properties: { sessionID: "ses_abc", error: { name: "Overloaded" } } },
      ctx,
    )
    expect(n?.text).toContain("Overloaded")
  })

  it("flags a permission request, naming the permission and its patterns", () => {
    // Field names come from the openapi PermissionRequest schema: `permission`
    // and `patterns`. An earlier version read a `title` field that does not
    // exist, so the message rendered blank.
    const n = toNotification(
      {
        type: "permission.asked",
        properties: { sessionID: "ses_abc", permission: "bash", patterns: ["rm -rf build"] },
      },
      ctx,
    )
    expect(n?.text).toContain("Permission")
    expect(n?.text).toContain("bash")
    expect(n?.text).toContain("rm -rf build")
  })

  it("still says something useful when a permission carries no patterns", () => {
    const n = toNotification(
      { type: "permission.asked", properties: { sessionID: "ses_abc", permission: "edit" } },
      ctx,
    )
    expect(n?.text).toContain("edit")
  })

  it("stays silent on high-frequency streaming events", () => {
    // A delta per token would be thousands of messages per reply.
    expect(toNotification({ type: "message.part.delta", properties: { sessionID: "ses_abc", text: "x" } }, ctx)).toBeNull()
    expect(toNotification({ type: "message.updated", properties: { sessionID: "ses_abc" } }, ctx)).toBeNull()
  })

  it("stays silent on an event type it does not recognise", () => {
    // Guessing at an unknown event is worse than silence: it trains the user to
    // ignore the channel.
    expect(toNotification({ type: "something.new.in.1.18.33", properties: { sessionID: "ses_abc" } }, ctx)).toBeNull()
  })

  it("reports a real rename from the placeholder title", () => {
    const renamed = toNotification(
      { type: "session.updated", properties: { sessionID: "ses_abc", info: { title: "Refactor auth" } } },
      { ...ctx, title: "New session" },
    )
    expect(renamed?.text).toContain("Refactor auth")
  })

  it("stays silent when the previous title was not a placeholder", () => {
    // Renaming "Fix login" to "Refactor auth" is a user action, not something
    // worth a push notification.
    const n = toNotification(
      { type: "session.updated", properties: { sessionID: "ses_abc", info: { title: "Refactor auth" } } },
      ctx,
    )
    expect(n).toBeNull()
  })

  it("does not report a title that has not actually changed", () => {
    const same = toNotification(
      { type: "session.updated", properties: { sessionID: "ses_abc", info: { title: "New session" } } },
      { ...ctx, title: "New session" },
    )
    expect(same).toBeNull()
  })

  it("truncates a very long title rather than sending an oversized message", () => {
    const long: SessionContext = { ...ctx, title: "y".repeat(300) }
    const n = toNotification({ type: "session.idle", properties: { sessionID: "ses_abc" } }, long)
    expect(n!.text.length).toBeLessThan(TELEGRAM_MAX)
    // The ellipsis must survive escaping. When escapeMd also escaped ".", the
    // marker became "\.\.\." and was invisible as an ellipsis.
    expect(n!.text).toContain("...")
  })
})

describe("command output", () => {
  it("lists projects and marks the active one", () => {
    const out = formatProjects(
      [
        { id: "a", name: "chain", port: 4101 },
        { id: "b", name: "web", port: 4102 },
      ],
      "a",
    )
    expect(out).toContain("chain")
    expect(out).toContain("web")
    // The active project is marked, and only one is.
    expect(out.match(/●/g)).toHaveLength(1)
    expect(out).toContain("/project")
  })

  it("explains how to add a project when the list is empty", () => {
    const out = formatProjects([], null)
    expect(out).toContain("No projects")
    expect(out).toContain("project:add")
  })

  it("summarises status", () => {
    const out = formatStatus({ username: "me", project: "chain", running: 1, stream: "open" })
    expect(out).toContain("chain")
    expect(out).toContain("live")
  })

  it("does not crash when there is no active project", () => {
    const out = formatStatus({ username: "me", project: null, running: 0, stream: "closed" })
    expect(out).toContain("none")
  })

  it("documents the commands that exist", () => {
    const help = formatHelp()
    for (const cmd of ["/status", "/projects", "/project", "/help"]) {
      expect(help).toContain(cmd)
    }
  })

  it("keeps the diff excerpt constant sane", () => {
    // A guard, not a behaviour: this is a bound other code may rely on.
    expect(DIFF_EXCERPT_LINES).toBeGreaterThan(0)
    expect(DIFF_EXCERPT_LINES).toBeLessThan(200)
  })
})
