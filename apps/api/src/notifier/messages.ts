/**
 * Decides what is worth telling the user about, and how to say it.
 *
 * Split out from the Telegram transport on purpose: this is the part with
 * judgement calls in it (what counts as "finished", how to truncate, what to
 * leave out) and the part worth testing without a network or a bot token.
 */

export interface SessionContext {
  sessionId: string
  title: string
  project: string
}

export interface Notification {
  /** Telegram chat message. */
  text: string
  /** Extra machine-readable context, for future buttons. */
  sessionId?: string
}

/** Telegram's hard limit. Exceeding it makes sendMessage fail outright. */
const TELEGRAM_MAX = 4096

/** Cap on a diff excerpt, so a large change does not produce an unusable wall. */
const DIFF_EXCERPT_LINES = 40

/**
 * Trim to a limit without cutting a multi-byte character in half.
 *
 * Slicing by UTF-16 index can land mid-surrogate, which Telegram accepts but
 * which renders as a replacement glyph. Bounded by a few code points.
 */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  let end = limit
  const code = text.charCodeAt(end - 1)
  // A high surrogate at the boundary means the pair is incomplete.
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Escapes only the characters Telegram's Markdown parser actually treats as
 * markup.
 *
 * A wider set was escaping ".", "-" and "!", which turned ordinary text into
 * unreadable noise: an ellipsis became "\.\.\." and "rm -rf" became "rm \-rf".
 * Those characters are not special unless they open a block, and a single-line
 * notification title cannot open one.
 */
export function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`\\])/g, "\\$1")
}

/** Title-case a session title without mangling words that are already caps. */
function tidyTitle(title: string): string {
  const t = title.trim()
  if (!t) return "untitled"
  return t.length <= 60 ? t : `${t.slice(0, 57)}...`
}

function projectLine(ctx: SessionContext): string {
  return `*${escapeMd(tidyTitle(ctx.title))}*  ·  \`${escapeMd(ctx.project)}\``
}

/** Pull the changed-file count and +/- totals out of a diff payload. */
export function summariseDiff(diff: string): { files: number; added: number; removed: number } {
  let added = 0
  let removed = 0
  // Count the file headers themselves. The earlier "have I seen a header yet"
  // flag never reset between files and so under-counted every diff after the
  // first; a header is a header, wherever it appears.
  const hasGitHeaders = diff.includes("diff --git")
  const headers = diff.split("\n").filter((l) => (hasGitHeaders ? l.startsWith("diff --git") : l.startsWith("+++ ")))
  const files = headers.length

  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff --git")) continue
    if (line.startsWith("+")) added += 1
    else if (line.startsWith("-")) removed += 1
  }
  return { files, added, removed }
}

/**
 * Turn an opencode event into a notification, or null to stay silent.
 *
 * The event vocabulary is large and still changing, so anything unrecognised is
 * ignored rather than guessed at. A wrong notification is worse than none: it
 * trains the user to ignore the channel.
 */
export function toNotification(
  event: { type: string; properties: Record<string, unknown> },
  ctx: SessionContext,
): Notification | null {
  // Field names taken from the openapi schemas, not guessed: PermissionRequest
  // carries `permission` and `patterns`, not a `title`. Reading a field that
  // does not exist yields undefined, which silently renders as a blank message.
  const p = event.properties as {
    sessionID?: string
    info?: { title?: string; time?: { updated?: number } }
    error?: { name?: string; data?: { message?: string } }
    permission?: string
    patterns?: string[]
    id?: string
  }

  switch (event.type) {
    // Terminal states. "Idle" is the signal that an agent run finished, which is
    // the single most useful notification this app can send.
    case "session.idle":
      return { text: `${projectLine(ctx)}\nDone.`, sessionId: ctx.sessionId }

    case "session.error": {
      const message = p.error?.data?.message ?? p.error?.name ?? "unknown error"
      return { text: `${projectLine(ctx)}\n*Error:* ${escapeMd(message)}`, sessionId: ctx.sessionId }
    }

    // Permission requests are the one case that gets inline buttons, because the
    // run is blocked until the user answers and they may not be at the screen.
    case "permission.asked": {
      // Show what is actually being permitted. The patterns are the concrete
      // thing being asked about, so they matter more than the permission name.
      const kind = escapeMd(p.permission ?? "permission")
      const patterns = (p.patterns ?? []).map(escapeMd).slice(0, 4)
      const detail = patterns.length > 0 ? patterns.map((x) => `\`${x}\``).join("\n") : `_${kind}_`
      return {
        text: `${projectLine(ctx)}\n*Permission needed:* ${kind}\n${detail}`,
        sessionId: ctx.sessionId,
      }
    }

    case "session.updated": {
      // Only a real rename is news. opencode assigns a generated title to a new
      // session, and reporting that would be a notification for every session the
      // user ever opens. So the previous title must look like a placeholder for
      // this to count as a rename.
      const title = p.info?.title
      if (!title || title === ctx.title) return null
      if (!/^New session/i.test(ctx.title)) return null
      return {
        text: `${projectLine(ctx)}\nNow titled *${escapeMd(tidyTitle(title))}*`,
        sessionId: ctx.sessionId,
      }
    }

    default:
      return null
  }
}

/** Human-readable one-liner for the /status command. */
export function formatStatus(input: {
  username: string
  project: string | null
  running: number
  stream: "open" | "connecting" | "closed"
}): string {
  const stream = input.stream === "open" ? "live" : input.stream
  return [
    `*${escapeMd(input.username)}*`,
    `project: ${input.project ? `\`${escapeMd(input.project)}\`` : "_none_"}`,
    `serve: ${input.running} running`,
    `events: ${stream}`,
  ].join("\n")
}

/** Build the /projects listing from the registry. */
export function formatProjects(
  projects: Array<{ id: string; name: string; port: number }>,
  activeId: string | null,
): string {
  if (projects.length === 0) {
    return "No projects configured.\nAdd one with `pnpm project:add -- <path>` on the host."
  }
  const lines = projects.map((p) => {
    const marker = p.id === activeId ? "●" : "○"
    return `${marker} \`${escapeMd(p.name)}\`  ·  :${p.port}`
  })
  return ["*projects*", "", ...lines, "", "Switch with `/project <name>`"].join("\n")
}

export function formatHelp(): string {
  return [
    "*opencode remote*",
    "",
    "/status — gateway and agent status",
    "/projects — list configured projects",
    "/project \\<name\\> — switch the active project",
    "/help — this message",
    "",
    "Permission requests arrive here with *Allow once* / *Always* / *Deny* buttons.",
    "Session replies and prompts stay in the web app — they can be long, and this",
    "chat is a poor place to read them.",
  ].join("\n")
}

export { TELEGRAM_MAX, DIFF_EXCERPT_LINES }
