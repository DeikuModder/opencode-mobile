import { All, Controller, Get, Inject, Logger, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common"
import type { Request, Response } from "express"
import { SessionGuard } from "../auth/session.guard.js"
import { ServeProxy } from "./serve-proxy.js"
import { ProjectRegistry } from "../projects/registry.js"
import { DB } from "../tokens.js"
import { openDb } from "../auth/db.js"
import type { Db } from "../auth/db.js"
import { purgeExpiredSessions } from "../auth/db.js"

/** Everything under this prefix is proxied verbatim to `opencode serve`. */
const SERVE_PREFIX = "/api/serve"

@Controller("api")
export class GatewayController {
  private readonly logger = new Logger(GatewayController.name)

  constructor(
    @Inject(ServeProxy) private readonly proxy: ServeProxy,
    @Inject(ProjectRegistry) private readonly registry: ProjectRegistry,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * Transparent reverse proxy to the active project's `serve`.
   *
   * The upstream API is large and still moving, so it is proxied rather than
   * reimplemented: every current and future endpoint works without a code
   * change, and this class stays small enough to audit.
   */
  @All("serve/*path")
  @UseGuards(SessionGuard)
  async proxyToServe(@Req() req: Request, @Res() res: Response): Promise<void> {
    // Derive the upstream path from the URL rather than route params, so this
    // does not depend on the router's wildcard syntax.
    const raw = req.url.split("?")[0] ?? ""
    const upstreamPath = raw.startsWith(SERVE_PREFIX) ? raw.slice(SERVE_PREFIX.length) : raw
    const query = req.url.includes("?") ? (req.url.split("?").slice(1).join("?") ?? "") : ""

    const active = this.registry.active()
    if (!active) {
      throw new UnauthorizedException({
        code: "no_projects",
        message: "No projects configured. Run `pnpm project:add -- <path>` on the host.",
      })
    }

    // Idempotent and fast when serve is already up. Awaited on purpose: on a
    // cold start this blocks until serve answers /global/health, which is a far
    // better first request than a 503 the client has to retry. The timeout lives
    // in the registry (60s) and is only reached if opencode is genuinely broken.
    const started = await this.registry.ensureStarted(active.id)
    if (!started.ok) {
      this.logger.warn(`Could not start serve for "${active.id}": ${started.detail ?? "unknown reason"}`)
    }
    this.registry.touch(active.id)

    await this.proxy.forward(req, res, active, upstreamPath || "/", query)
  }

  @Get("gateway/health")
  @UseGuards(SessionGuard)
  async health(): Promise<Record<string, unknown>> {
    purgeExpiredSessions(this.db)
    const active = this.registry.active()
    return {
      ok: true,
      activeProject: active ? { id: active.id, name: active.name, port: active.port } : null,
      projects: this.registry.list().map((p) => ({ id: p.id, name: p.name, port: p.port })),
      supervisor: await this.registry.supervisorHealth(),
    }
  }

  @Get("projects")
  @UseGuards(SessionGuard)
  projects(): { active: string | null; projects: Array<Record<string, unknown>> } {
    return {
      active: this.registry.activeId(),
      projects: this.registry.list().map((p) => ({ id: p.id, name: p.name, port: p.port })),
    }
  }

  @Post("projects/active")
  @UseGuards(SessionGuard)
  async setActive(@Req() req: Request): Promise<Record<string, unknown>> {
    const id = (req.body as { id?: string })?.id
    if (!id) throw new UnauthorizedException({ code: "missing_id", message: "Project id required" })
    const project = this.registry.setActive(id)
    const started = await this.registry.ensureStarted(id)
    return { ok: true, active: project.id, serve: started }
  }
}
