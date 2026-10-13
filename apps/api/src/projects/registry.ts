import { existsSync, renameSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { Inject, Injectable, Logger } from "@nestjs/common"
import { APP_CONFIG } from "../tokens.js"
import { parseJsonFile } from "./json-file.js"
import type { AppConfig } from "../config.js"

export interface ProjectEntry {
  /** Stable slug; the supervisor only ever accepts this, never a raw path. */
  id: string
  name: string
  /** Absolute path on the Windows host. */
  path: string
  /** Port the supervisor runs this project's `opencode serve` on. */
  port: number
}

interface RegistryFile {
  version: 1
  active: string | null
  projects: ProjectEntry[]
}

/**
 * The project allowlist, shared with the host supervisor via a read-only mount.
 *
 * Projects are only ever added by the local `project:add` CLI. The gateway can
 * switch between allowlisted entries but cannot introduce new ones, so an
 * authenticated session cannot point the agent at an arbitrary directory.
 */
@Injectable()
export class ProjectRegistry {
  private readonly logger = new Logger(ProjectRegistry.name)
  private readonly file: string

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.file = join(config.dataDir, "projects.json")
  }

  private read(): RegistryFile {
    if (!existsSync(this.file)) return { version: 1, active: null, projects: [] }
    try {
      const parsed = parseJsonFile(this.file) as RegistryFile
      if (!Array.isArray(parsed.projects)) throw new Error("projects must be an array")
      return { version: 1, active: parsed.active ?? null, projects: parsed.projects }
    } catch (err) {
      // Fail closed. An unreadable allowlist must mean "no projects", never
      // "all projects" — this file is the boundary that stops a session from
      // pointing the agent at an arbitrary directory.
      this.logger.error(`Could not read ${this.file}: ${(err as Error).message}`)
      return { version: 1, active: null, projects: [] }
    }
  }

  /** Write via a temp file + rename so a crash cannot truncate the registry. */
  private write(data: RegistryFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8")
    renameSync(tmp, this.file)
  }

  list(): ProjectEntry[] {
    return this.read().projects
  }

  get(id: string): ProjectEntry | undefined {
    return this.read().projects.find((p) => p.id === id)
  }

  activeId(): string | null {
    const data = this.read()
    if (data.active && data.projects.some((p) => p.id === data.active)) return data.active
    return data.projects[0]?.id ?? null
  }

  active(): ProjectEntry | undefined {
    const id = this.activeId()
    return id ? this.get(id) : undefined
  }

  setActive(id: string): ProjectEntry {
    const data = this.read()
    const project = data.projects.find((p) => p.id === id)
    if (!project) throw new Error(`Unknown project: ${id}`)
    data.active = id
    this.write(data)
    return project
  }

  /**
   * Ask the host supervisor to make sure this project's `serve` is up.
   *
   * The supervisor only accepts an id from this allowlist, so this call cannot
   * be used to start a process in an arbitrary directory.
   */
  async ensureStarted(id: string): Promise<{ ok: boolean; detail?: string }> {
    const project = this.get(id)
    if (!project) return { ok: false, detail: `Unknown project: ${id}` }
    try {
      const res = await fetch(`${this.config.supervisor.url}/start`, {
        method: "POST",
        headers: this.supervisorHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ projectId: id }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) return { ok: false, detail: `Supervisor returned ${res.status}` }
      return (await res.json()) as { ok: boolean; detail?: string }
    } catch (err) {
      return { ok: false, detail: `Supervisor unreachable at ${this.config.supervisor.url}: ${(err as Error).message}` }
    }
  }

  /**
   * Tell the supervisor the project is in active use, deferring its idle
   * shutdown. Best-effort: a failure here must not break the request.
   */
  touch(id: string): void {
    void fetch(`${this.config.supervisor.url}/touch`, {
      method: "POST",
      headers: this.supervisorHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ projectId: id }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)
  }

  async supervisorHealth(): Promise<unknown> {
    try {
      const res = await fetch(`${this.config.supervisor.url}/health`, {
        headers: this.supervisorHeaders(),
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return { reachable: false, status: res.status }
      return await res.json()
    } catch (err) {
      return { reachable: false, error: (err as Error).message }
    }
  }

  /**
   * The supervisor spawns processes on the host, so it is token-authenticated.
   * It must be reachable from the container, which means binding to 0.0.0.0 â€”
   * the token is what stops that from being a LAN-wide RCE endpoint.
   */
  private supervisorHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.supervisor.token}`,
      ...(extra ?? {}),
    }
  }
}
