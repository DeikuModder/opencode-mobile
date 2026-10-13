/**
 * Host supervisor: lazily runs one `opencode serve` per project.
 *
 * Runs on the Windows host (not in Docker) because serve needs access to the
 * real project directories and the Windows filesystem. The gateway asks it to
 * start a project the first time that project is used, and it shuts a project
 * down again after a period of inactivity so idle machines are not holding
 * several Node processes and ports open.
 *
 *   pnpm supervisor
 *
 * Security notes that are load-bearing, not decoration:
 *
 *  - Every request requires SUPERVISOR_TOKEN. This process spawns programs, so
 *    an unauthenticated endpoint would be remote code execution for anything
 *    that can reach the port. The port must be bound to 0.0.0.0 for the
 *    container to reach it, which is exactly why the token exists.
 *  - Only ids already present in data/projects.json are ever started. A caller
 *    cannot supply a path, so this cannot be used to run a server in an
 *    arbitrary directory.
 *  - Children are tracked by PID and killed by PID. `taskkill /IM` and
 *    `Stop-Process -Name` are never used: they match by image name and have
 *    previously killed unrelated opencode processes, including the one running
 *    the agent itself.
 */
import { createServer } from "node:http"
import { spawn, execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { timingSafeEqual } from "node:crypto"

const HOST_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HOST_DIR, "..")

if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"))

const PORT = Number.parseInt(process.env.SUPERVISOR_PORT ?? "", 10) || 4100
const BIND = process.env.SUPERVISOR_BIND_HOST ?? "127.0.0.1"
const TOKEN = process.env.SUPERVISOR_TOKEN ?? ""
const SERVE_PASSWORD = process.env.SERVE_PASSWORD ?? ""
const SERVE_BIND_HOST = process.env.SERVE_BIND_HOST ?? "0.0.0.0"
const IDLE_MS = (Number.parseInt(process.env.SERVE_IDLE_SHUTDOWN_MINUTES ?? "", 10) || 30) * 60_000
const READY_TIMEOUT_MS = 45_000
const REGISTRY = join(ROOT, "data", "projects.json")

if (!TOKEN) {
  console.error("SUPERVISOR_TOKEN is required. Generate one with:")
  console.error("  node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"")
  process.exit(1)
}
if (!SERVE_PASSWORD) {
  console.error("SERVE_PASSWORD is required — serve would otherwise be unauthenticated on all interfaces.")
  process.exit(1)
}

/** Resolve the real opencode executable.
 *
 * `opencode` on PATH resolves to opencode.cmd, and Node refuses to spawn a .cmd
 * with shell:false (EINVAL). The .exe inside the npm package is the real binary,
 * so that is what gets spawned. `where.exe opencode.exe` alone is not enough
 * because only the shim is on PATH — hence the npm-root lookup as a fallback.
 *
 * Resolution is strict: if nothing resolves, fail at startup rather than
 * discovering it on first use, when the failure looks like opencode is broken.
 */
function resolveOpencodeBin() {
  const candidates = []
  if (process.env.OPENCODE_BIN) candidates.push(process.env.OPENCODE_BIN)

  try {
    const found = execFileSync("where.exe", ["opencode.exe"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    candidates.push(...found)
  } catch {
    /* not on PATH as a bare .exe, which is the normal case on Windows */
  }

  try {
    const root = execFileSync("npm.cmd", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    if (root) candidates.push(join(root, "opencode-ai", "bin", "opencode.exe"))
  } catch {
    /* npm not available */
  }

  const appdata = process.env.APPDATA
  if (appdata) candidates.push(join(appdata, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  console.error("Could not find the opencode executable. Looked in:")
  for (const candidate of candidates) console.error(`  - ${candidate}`)
  console.error("\nSet OPENCODE_BIN in .env to the full path of opencode.exe.")
  process.exit(1)
}

const OPENCODE_BIN = resolveOpencodeBin()

/** projectId -> live process */
const running = new Map()
/** projectId -> in-flight start, so concurrent requests share one spawn */
const starting = new Map()

function readRegistry() {
  if (!existsSync(REGISTRY)) return { projects: [] }
  try {
    const raw = readFileSync(REGISTRY, "utf8")
    // Tolerate a UTF-8 BOM: Windows PowerShell's `Set-Content -Encoding utf8`
    // writes one, and JSON.parse rejects it, which would silently reduce the
    // allowlist to empty.
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    if (!Array.isArray(parsed.projects)) throw new Error("projects is not an array")
    return parsed
  } catch (err) {
    // Fail closed: an unreadable allowlist must not start anything.
    console.error(`projects.json unreadable: ${err.message}`)
    return { projects: [] }
  }
}

function findProject(id) {
  return readRegistry().projects.find((p) => p.id === id)
}

function authOk(req) {
  const header = req.headers.authorization ?? ""
  if (!header.startsWith("Bearer ")) return false
  const a = Buffer.from(header.slice(7))
  const b = Buffer.from(TOKEN)
  // timingSafeEqual throws on length mismatch, so guard first.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return {}
  }
}

/** Poll opencode's own health endpoint until it answers, or give up. */
async function waitForReady(port, deadline) {
  const url = `http://127.0.0.1:${port}/global/health`
  const basic = Buffer.from(`opencode:${SERVE_PASSWORD}`).toString("base64")
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

async function startProject(id) {
  const existing = running.get(id)
  if (existing) {
    existing.lastUsed = Date.now()
    return { ok: true, port: existing.port, alreadyRunning: true }
  }
  // Collapse concurrent starts onto one spawn.
  const inflight = starting.get(id)
  if (inflight) return inflight

  const promise = (async () => {
    const project = findProject(id)
    if (!project) return { ok: false, detail: `Project "${id}" is not in the allowlist` }
    if (!existsSync(project.path)) return { ok: false, detail: `Project path is gone: ${project.path}` }

    const deadline = Date.now() + READY_TIMEOUT_MS
    const args = ["serve", "--hostname", SERVE_BIND_HOST, "--port", String(project.port)]
    console.log(`[start] ${id} -> ${OPENCODE_BIN} ${args.join(" ")} (cwd ${project.path})`)

    const child = spawn(OPENCODE_BIN, args, {
      cwd: project.path,
      env: {
        ...process.env,
        // serve refuses to bind a non-loopback address without this.
        OPENCODE_SERVER_PASSWORD: SERVE_PASSWORD,
        // Keep each project's data in its own worktree.
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const entry = { child, pid: child.pid, port: project.port, lastUsed: Date.now() }
    running.set(id, entry)
    child.stdout.on("data", (d) => console.log(`[${id}] ${d.toString().trimEnd()}`))
    child.stderr.on("data", (d) => console.error(`[${id}] ${d.toString().trimEnd()}`))
    child.on("exit", (code, signal) => {
      if (running.get(id) === entry) running.delete(id)
      console.log(`[${id}] serve exited (code=${code} signal=${signal})`)
    })
    child.on("error", (err) => {
      console.error(`[${id}] failed to spawn: ${err.message}`)
      if (running.get(id) === entry) running.delete(id)
    })

    if (!(await waitForReady(project.port, deadline))) {
      stopProject(id)
      return { ok: false, detail: `serve did not become ready on port ${project.port}` }
    }
    console.log(`[${id}] ready on :${project.port}`)
    return { ok: true, port: project.port, alreadyRunning: false }
  })().finally(() => starting.delete(id))

  starting.set(id, promise)
  return promise
}

/** Kill by PID only. Never by image name. */
function stopProject(id) {
  const entry = running.get(id)
  if (!entry) return { ok: true, detail: "not running" }
  running.delete(id)
  const { pid } = entry
  try {
    if (process.platform === "win32") {
      // /PID with /T also reaps the process tree opencode may have spawned.
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
    } else {
      process.kill(-pid, "SIGTERM")
    }
  } catch (err) {
    // ESRCH just means it already exited, which is a success for our purposes.
    if (err.code !== "ESRCH") console.error(`[${id}] kill failed: ${err.message}`)
  }
  console.log(`[stop] ${id} (pid ${pid})`)
  return { ok: true, detail: `stopped pid ${pid}` }
}

setInterval(() => {
  const cutoff = Date.now() - IDLE_MS
  for (const [id, entry] of running) {
    if (entry.lastUsed < cutoff) {
      console.log(`[idle] ${id} unused for ${Math.round(IDLE_MS / 60000)}m, shutting down`)
      stopProject(id)
    }
  }
}, 60_000).unref?.()

const server = createServer(async (req, res) => {
  if (!authOk(req)) {
    // Deliberately vague: a wrong token and a missing token are indistinguishable.
    return json(res, 401, { ok: false, error: "unauthorized" })
  }
  try {
    const url = new URL(req.url ?? "/", `http://localhost`)

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        opencodeBin: OPENCODE_BIN,
        running: [...running.entries()].map(([id, e]) => ({ id, pid: e.pid, port: e.port, idleMs: Date.now() - e.lastUsed })),
      })
    }

    if (req.method === "POST" && url.pathname === "/start") {
      const { projectId } = await readBody(req)
      if (typeof projectId !== "string" || !projectId) return json(res, 400, { ok: false, error: "projectId required" })
      const result = await startProject(projectId)
      return json(res, result.ok ? 200 : 409, result)
    }

    if (req.method === "POST" && url.pathname === "/stop") {
      const { projectId } = await readBody(req)
      if (typeof projectId !== "string" || !projectId) return json(res, 400, { ok: false, error: "projectId required" })
      return json(res, 200, stopProject(projectId))
    }

    if (req.method === "POST" && url.pathname === "/touch") {
      const { projectId } = await readBody(req)
      const entry = running.get(projectId)
      if (entry) entry.lastUsed = Date.now()
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { ok: false, error: "not found" })
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message })
  }
})

server.listen(PORT, BIND, () => {
  console.log(`supervisor listening on ${BIND}:${PORT}`)
  console.log(`  opencode: ${OPENCODE_BIN}`)
  console.log(`  registry: ${REGISTRY}`)
  console.log(`  idle shutdown: ${Math.round(IDLE_MS / 60000)}m`)
  if (BIND === "0.0.0.0") {
    console.log("  NOTE: bound to all interfaces so the container can reach it. The firewall must block 4100 from the LAN.")
  }
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log("\nstopping children before exit")
  for (const id of [...running.keys()]) stopProject(id)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
// If the supervisor itself dies unexpectedly, do not leave orphans behind.
process.on("exit", () => {
  for (const id of [...running.keys()]) stopProject(id)
})
