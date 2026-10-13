import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common"
import { Bot, InlineKeyboard } from "grammy"
import type { AppConfig } from "../config.js"
import { APP_CONFIG } from "../tokens.js"
import { ProjectRegistry } from "../projects/registry.js"
import {
  TELEGRAM_MAX,
  formatHelp,
  formatProjects,
  formatStatus,
  toNotification,
  truncate,
  type SessionContext,
} from "./messages.js"

/** Longest session title we will look up in a callback payload. */
const MAX_TITLE_MATCH = 40

/** The three answers the upstream permission endpoint accepts. */
export type PermissionResponse = "once" | "always" | "reject"

const PERMISSION_RESPONSES: readonly PermissionResponse[] = ["once", "always", "reject"]

function isPermissionResponse(value: string): value is PermissionResponse {
  return (PERMISSION_RESPONSES as readonly string[]).includes(value)
}

interface PendingPermission {
  sessionId: string
  permissionId: string
  /** Rendered so the message is meaningful if the run is already gone. */
  text: string
  /** Rejected after this many minutes so a stale card cannot act later. */
  expiresAt: number
}

/** How long an inline permission button stays actionable. */
const PERMISSION_TTL_MS = 30 * 60_000

/**
 * Telegram notification bridge.
 *
 * Scope is deliberately narrow: notify, and answer permission prompts. There is
 * no prompt submission and no shell, because those cannot be reviewed at a
 * glance and a bot token is a bearer credential that leaks through screenshots
 * and chat backups.
 *
 * Access control is the load-bearing part. Every inbound update is checked
 * against TELEGRAM_ALLOWED_USER_ID before anything else happens, and the bot
 * never accepts a chat id from the message payload.
 */
@Injectable()
export class TelegramNotifier implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramNotifier.name)
  private bot: Bot | null = null
  private readonly pending = new Map<string, PendingPermission>()
  private sessionTitles = new Map<string, string>()
  /**
   * Supplies live stream/serve state for /status.
   *
   * Injected as a callback by EventPump rather than as a constructor dependency
   * because the pump already depends on this class; requiring it here too would
   * be a cycle Nest would have to break with forwardRef.
   */
  private statusSource: (() => { running: number; stream: "open" | "connecting" | "closed" }) | null = null

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ProjectRegistry) private readonly registry: ProjectRegistry,
  ) {}

  /** Called by EventPump once it exists; see the note on statusSource. */
  setStatusSource(source: () => { running: number; stream: "open" | "connecting" | "closed" }): void {
    this.statusSource = source
  }

  get enabled(): boolean {
    return Boolean(this.config.telegram.botToken && this.config.telegram.allowedUserId)
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log("Telegram notifier disabled: set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID")
      return
    }

    const { botToken, allowedUserId } = this.config.telegram

    try {
      this.bot = new Bot(botToken)
    } catch (err) {
      // A malformed token should disable the notifier, not take the gateway down
      // with it. The web app is the primary surface; Telegram is an accessory.
      this.logger.error(`Telegram bot token rejected by grammy: ${(err as Error).message}`)
      this.bot = null
      return
    }

    const bot = this.bot

    // Long polling needs no inbound port, which is why no webhook is configured.
    bot.catch((err: unknown) => {
      const e = err as { error?: { message?: string }; message?: string }
      this.logger.error(`Telegram update handler failed: ${e.error?.message ?? e.message ?? "unknown"}`)
    })

    // Membership is enforced by middleware so it cannot be forgotten by a future
    // command added to this class.
    //
    // This must be registered BEFORE any command or handler. grammy runs the
    // chain in registration order and a handler ends the chain, so a `.use`
    // added afterwards would never execute for a command that was already
    // registered — the guard would silently do nothing.
    bot.use(async (ctx, next) => {
      const id = String(ctx.from?.id ?? "")
      if (id !== String(allowedUserId)) {
        this.logger.warn(`rejected Telegram update from unauthorised user id ${id || "<none>"}`)
        // A silent drop: replying tells an unauthorised caller that the bot is
        // alive and that only the id was wrong.
        return
      }
      await next()
    })

    bot.command("start", (ctx) => ctx.reply(formatHelp(), { parse_mode: "Markdown" }))
    bot.command("help", (ctx) => ctx.reply(formatHelp(), { parse_mode: "Markdown" }))
    bot.command("status", async (ctx) => {
      // Reported from the real pump, not hardcoded: a /status that always says
      // "events: live" is worse than no /status, because it looks healthy while
      // the notifier is silently deaf.
      const live = this.statusSource?.()
      ctx.reply(
        formatStatus({
          username: "linked",
          project: this.registry.active()?.name ?? null,
          running: live?.running ?? 0,
          stream: live?.stream ?? "closed",
        }),
        { parse_mode: "Markdown" },
      )
    })
    bot.command("projects", (ctx) => {
      ctx.reply(
        formatProjects(
          this.registry.list().map((p) => ({ id: p.id, name: p.name, port: p.port })),
          this.registry.activeId(),
        ),
        { parse_mode: "Markdown" },
      )
    })
    bot.command("project", async (ctx) => {
      const match = ctx.match?.trim()
      if (!match) {
        await ctx.reply("Usage: /project <name>")
        return
      }
      const project = this.registry.list().find((p) => p.name === match || p.id === match)
      if (!project) {
        await ctx.reply(`No project named "${match}".`)
        return
      }
      this.registry.setActive(project.id)
      await ctx.reply(`Active project: ${project.name}`)
    })

    bot.callbackQuery(/^perm:(.+)$/, async (ctx) => {
      await this.handlePermissionCallback(ctx)
    })

    void bot
      .start({
        // Never block gateway startup on Telegram. If the API is unreachable at
        // boot, the web app must still come up.
        onStart: (info) => this.logger.log(`Telegram notifier online as @${info.username}`),
        drop_pending_updates: true,
      })
      .catch((err) => {
        this.logger.error(`Telegram notifier stopped: ${err.message}`)
        this.bot = null
      })

    this.logger.warn("Telegram notifier is enabled: treat TELEGRAM_BOT_TOKEN as a secret")
  }

  async onModuleDestroy(): Promise<void> {
    this.bot?.stop().catch(() => undefined)
    this.bot = null
  }

  /**
   * Deliver a notification derived from an opencode event.
   *
   * Errors are swallowed with a log line: a Telegram outage must not become an
   * unhandled rejection inside the event pump.
   */
  async notify(event: { type: string; properties: Record<string, unknown> }, projectName: string): Promise<void> {
    const bot = this.bot
    if (!bot) return

    const sessionId = (event.properties as { sessionID?: string }).sessionID
    if (!sessionId) return

    const title = this.sessionTitles.get(sessionId) ?? "New session"
    if (event.type === "session.updated") {
      const info = (event.properties as { info?: { title?: string } }).info
      if (info?.title) this.sessionTitles.set(sessionId, info.title)
    }

    const ctx: SessionContext = { sessionId, title, project: projectName }
    const note = toNotification(event, ctx)
    if (!note) return

    try {
      if (event.type === "permission.asked") {
        await this.sendPermission(bot, note, sessionId, event.properties as { id?: string })
        return
      }
      await bot.api.sendMessage(
        this.config.telegram.allowedUserId,
        truncate(note.text, TELEGRAM_MAX),
        { parse_mode: "Markdown" },
      )
    } catch (err) {
      this.logger.warn(`Telegram send failed: ${(err as Error).message}`)
    }
  }

  private async sendPermission(
    bot: Bot,
    note: { text: string; sessionId?: string },
    sessionId: string,
    props: { id?: string },
  ): Promise<void> {
    const permissionId = props.id
    if (!permissionId || !note.sessionId) {
      await bot.api.sendMessage(this.config.telegram.allowedUserId, truncate(note.text, TELEGRAM_MAX), {
        parse_mode: "Markdown",
      })
      return
    }

    // A short key: callback_data is capped at 64 bytes by Telegram, so the
    // permission id cannot be carried verbatim. A short unique prefix is stored
    // server-side instead and the entry is dropped when it expires.
    const key = `${sessionId.slice(0, 8)}-${permissionId.slice(0, 12)}-${Date.now().toString(36)}`
    this.pending.set(key, {
      sessionId,
      permissionId,
      text: note.text,
      expiresAt: Date.now() + PERMISSION_TTL_MS,
    })

    const keyboard = new InlineKeyboard()
      .text("Allow once", `perm:${key}:once`)
      .text("Always", `perm:${key}:always`)
      .text("Deny", `perm:${key}:reject`)
    keyboard.row()

    try {
      await bot.api.sendMessage(this.config.telegram.allowedUserId, truncate(note.text, TELEGRAM_MAX), {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      })
    } catch (err) {
      this.pending.delete(key)
      throw err
    }
  }

  private async handlePermissionCallback(ctx: {
    callbackQuery?: { data?: string; id: string; message?: unknown }
    answerCallbackQuery: (o: Record<string, unknown>) => Promise<unknown>
    reply: (t: string) => Promise<unknown>
  }): Promise<void> {
    const data = ctx.callbackQuery?.data
    if (!data) return

    const parts = data.split(":")
    if (parts.length !== 3 || parts[0] !== "perm") {
      await ctx.answerCallbackQuery({ text: "Unknown action" })
      return
    }
    const key = parts[1]
    const response = parts[2]
    if (!key || !response) {
      await ctx.answerCallbackQuery({ text: "Unknown action" })
      return
    }
    // The enum is exactly what the upstream endpoint accepts; anything else is
    // rejected by it with a validation error, so catch it here.
    if (!isPermissionResponse(response)) {
      await ctx.answerCallbackQuery({ text: "Unknown action" })
      return
    }

    const entry = this.pending.get(key)
    if (!entry) {
      // Expired or already used. The run has almost certainly moved on, so the
      // buttons are simply retired.
      await ctx.answerCallbackQuery({ text: "This request is no longer valid" })
      return
    }
    this.pending.delete(key)

    try {
      await this.replyPermission(entry.sessionId, entry.permissionId, response)
      await ctx.answerCallbackQuery({ text: response === "reject" ? "Denied" : "Allowed" })
      await ctx.reply(response === "reject" ? "Denied." : "Allowed.")
    } catch (err) {
      this.logger.warn(`could not answer permission: ${(err as Error).message}`)
      await ctx.answerCallbackQuery({ text: "Could not reach opencode" })
    }
  }

  /**
   * Answer a permission by calling serve directly.
   *
   * This does not loop back through the gateway's own /api/serve proxy. That
   * path is protected by SessionGuard, which requires a browser session cookie
   * and deliberately rejects Basic credentials, so a self-call with the serve
   * password would be answered 401 and every button would fail. Reusing the
   * same host resolution as the proxy and the pump keeps one code path to
   * serve, without the pointless internal hop through a guard we cannot pass.
   */
  private async replyPermission(
    sessionId: string,
    permissionId: string,
    response: PermissionResponse,
  ): Promise<void> {
    const active = this.registry.active()
    if (!active) throw new Error("no active project")

    const started = await this.registry.ensureStarted(active.id)
    if (!started.ok) throw new Error(`serve unavailable: ${started.detail ?? "unknown reason"}`)

    const host = process.env.SERVE_HOST ?? "host.docker.internal"
    const url = `http://${host}:${active.port}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`

    const headers: Record<string, string> = { "content-type": "application/json" }
    if (this.config.serve.password) {
      headers["authorization"] = `Basic ${Buffer.from(`opencode:${this.config.serve.password}`).toString("base64")}`
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ response }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      // Include the upstream's own error: "upstream returned 400" alone gives no
      // clue that the value was wrong, which is the failure we actually hit.
      const detail = (await res.text().catch(() => "")).slice(0, 300)
      throw new Error(`upstream returned ${res.status}: ${detail}`)
    }
  }

  /**
   * Drop expired permission cards.
   *
   * Called on a timer as well as on access: nothing else removes entries, so
   * without this a long-running gateway accumulates one dead card per prompt
   * for as long as it stays up.
   */
  prunePending(now = Date.now()): number {
    let removed = 0
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        this.pending.delete(key)
        removed += 1
      }
    }
    return removed
  }

  get pendingCount(): number {
    return this.pending.size
  }
}

export { MAX_TITLE_MATCH }
