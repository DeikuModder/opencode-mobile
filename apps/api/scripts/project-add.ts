/**
 * Add a project to the allowlist. LOCAL ONLY.
 *
 *   pnpm project:add -- C:\Users\me\code\myapp
 *   pnpm project:add -- C:\Users\me\code\myapp "My App"   # custom display name
 *
 * Projects can only be registered here, never over HTTP. The gateway and the
 * host supervisor both read this file, and the supervisor will refuse to start
 * anything whose id is not already present — so a valid session cannot point
 * the agent at an arbitrary directory on the host.
 */
import { existsSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { stdout } from "node:process"
import { resolveDataDir } from "../src/config.js"
import { parseJsonFile } from "../src/projects/json-file.js"
import { ask, fail, ok } from "./lib/prompt.js"

interface ProjectEntry {
  id: string
  name: string
  path: string
  port: number
}

interface RegistryFile {
  version: 1
  active: string | null
  projects: ProjectEntry[]
}

function load(file: string): RegistryFile {
  if (!existsSync(file)) return { version: 1, active: null, projects: [] }
  try {
    const parsed = parseJsonFile(file) as RegistryFile
    if (!Array.isArray(parsed.projects)) throw new Error("projects is not an array")
    return { version: 1, active: parsed.active ?? null, projects: parsed.projects }
  } catch (err) {
    fail(`${file} is not readable: ${(err as Error).message}`)
  }
}

function save(file: string, data: RegistryFile): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8")
  renameSync(tmp, file)
}

/** Lowercase, hyphenated, restricted to characters that are safe in a URL. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug || "project"
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const pathArg = args[0]
  if (!pathArg || pathArg.startsWith("--")) {
    stdout.write("Usage: pnpm project:add -- <path> [display name]\n")
    process.exit(1)
  }

  const projectPath = resolve(pathArg)
  if (!existsSync(projectPath)) fail(`No such directory: ${projectPath}`)
  if (!statSync(projectPath).isDirectory()) fail(`Not a directory: ${projectPath}`)

  const defaultName = basename(projectPath)
  const name = args[1] ?? (await ask(`Display name [${defaultName}]: `)) ?? defaultName

  const file = join(resolveDataDir(), "projects.json")
  const data = load(file)

  const dupe = data.projects.find((p) => p.path.toLowerCase() === projectPath.toLowerCase())
  if (dupe) fail(`Already registered as "${dupe.name}" (id: ${dupe.id}, port: ${dupe.port})`)

  const baseId = slugify(basename(projectPath))
  let id = baseId
  for (let n = 2; data.projects.some((p) => p.id === id); n++) id = `${baseId}-${n}`

  // Ports are handed out from SERVE_PORT_BASE and never reused within a
  // registry, so a stale supervisor entry cannot collide with a new project.
  const used = new Set(data.projects.map((p) => p.port))
  const portBase = Number.parseInt(process.env.SERVE_PORT_BASE ?? "", 10) || 4101
  let port = portBase
  while (used.has(port)) port++

  data.projects.push({ id, name, path: projectPath, port })
  if (!data.active) data.active = id
  save(file, data)

  ok(`Added "${name}"`)
  ok(`  id    ${id}`)
  ok(`  path  ${projectPath}`)
  ok(`  port  ${port}`)
  if (data.active === id) ok("  active (first project)")
  stdout.write("\nThe gateway starts this on first use. No need to launch anything now.\n")
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)))
