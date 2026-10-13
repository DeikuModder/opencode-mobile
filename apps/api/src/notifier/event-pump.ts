import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common"
import { ProjectRegistry } from "../projects/registry.js"
import { EventHub, type StreamEvent } from "../gateway/event-hub.js"
import { TelegramNotifier } from "./telegram.js"

/** How often expired permission cards are swept. */
const PRUNE_INTERVAL_MS = 5 * 60_000

/** How often the active project is re-checked and serve's run count refreshed. */
const SYNC_INTERVAL_MS = 30_000

/**
 * Keeps Telegram notifications working with no browser attached.
 *
 * This used to hold its own connection to `opencode serve`, deliberately separate
 * from the browser's, on the reasoning that sharing would make notifications
 * depend on a phone screen being open. That reasoning was right about the goal
 * and wrong about the mechanism: sharing a *connection* does tie the two
 * together, but sharing a *hub* does not. The hub owns the upstream connection
 * and outlives every browser attached to it, so this subscriber stays deaf to
 * nothing and silent to no one — and one upstream connection now serves every
 * tab and the notifier together instead of one each.
 *
 * The subscription is therefore permanent while the notifier is enabled, which
 * also keeps the upstream warm for the next request.
 *
 * opencode restarts are normal — a project switch, an idle shutdown — so the
 * active project is re-checked periodically and the hub reconnects with backoff
 * on its own. A bounded, patient retry matters more than a fast one: a fast
 * retry that gives up would leave the notifier permanently silent.
 */
@Injectable()
export class EventPump implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventPump.name)
  private unsubscribe: (() => void) | null = null
  private projectId: string | null = null
  private started = false
  private cachedRunning = 0
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    @Inject(ProjectRegistry) private readonly registry: ProjectRegistry,
    @Inject(EventHub) private readonly hub: EventHub,
    @Inject(TelegramNotifier) private readonly notifier: TelegramNotifier,
  ) {}

  onModuleInit(): void {
    // Registered even when disabled so /status still tells the truth.
    this.notifier.setStatusSource(() => ({ running: this.cachedRunning, stream: this.streamState }))

    if (!this.notifier.enabled) {
      this.logger.log("Event pump idle: the Telegram notifier is disabled")
      return
    }
    this.started = true
    this.attachActive()
    void this.refreshRunning()

    this.pruneTimer = setInterval(() => this.notifier.prunePending(), PRUNE_INTERVAL_MS)
    this.pruneTimer.unref?.()
    this.syncTimer = setInterval(() => {
      this.attachActive()
      void this.refreshRunning()
    }, SYNC_INTERVAL_MS)
    this.syncTimer.unref?.()
  }

  onModuleDestroy(): void {
    this.started = false
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.pruneTimer = null
    this.syncTimer = null
    this.detach()
  }

  get streamState(): "open" | "connecting" | "closed" {
    if (!this.projectId) return "closed"
    return this.hub.state(this.projectId)
  }

  /** How many serve processes the supervisor currently reports running. */
  async runningCount(): Promise<number> {
    this.cachedRunning = await this.fetchRunning()
    return this.cachedRunning
  }

  /**
   * Point the subscription at whichever project is active.
   *
   * The registry is a file with no change notification, so this is polled rather
   * than evented. Re-attaching is guarded by id: without that check the timer
   * would churn a subscription every 30 seconds, which would defeat the idle
   * grace period in the hub and dial upstream on a loop.
   */
  private attachActive(): void {
    if (!this.started) return
    const project = this.registry.active()
    if (!project) {
      // Nothing allowlisted. Stay detached and keep polling, so notifications
      // resume on their own once a project is configured.
      if (this.projectId !== null) this.logger.warn("no active project; notifications paused")
      this.detach()
      return
    }
    if (this.projectId === project.id) return

    this.detach()
    this.projectId = project.id
    this.unsubscribe = this.hub.subscribe(project, {
      deliver: (event) => this.handle(event),
      // Deliberately no flush. The hub tells browser subscribers to drop their
      // connection after a sustained outage so they refetch stale state; an
      // internal consumer has no client state, and detaching here would just
      // silence Telegram for the rest of the outage.
    })
    this.logger.log(`watching project "${project.id}" for notification events`)
  }

  private detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.projectId = null
  }

  private handle(event: StreamEvent): void {
    const project = this.registry.active()?.name ?? "unknown"
    void this.notifier.notify({ type: event.type, properties: event.properties }, project)
  }

  private async refreshRunning(): Promise<void> {
    this.cachedRunning = await this.fetchRunning()
  }

  private async fetchRunning(): Promise<number> {
    try {
      const health = await this.registry.supervisorHealth()
      const running = (health as { running?: unknown }).running
      return Array.isArray(running) ? running.length : 0
    } catch {
      return 0
    }
  }
}
