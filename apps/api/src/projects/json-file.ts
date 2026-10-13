import { readFileSync } from "node:fs"

/**
 * Parse a JSON file, tolerating a UTF-8 BOM.
 *
 * Windows PowerShell 5.1's `Set-Content -Encoding utf8`, several Windows
 * editors, and anything that round-trips through a BOM-aware tool will prepend
 * EF BB BF. `JSON.parse` rejects a leading BOM outright, so an otherwise valid
 * config file fails to load — and in this project that failure mode is a
 * silently empty project allowlist.
 */
export function parseJsonFile<T = unknown>(path: string): T {
  const raw = readFileSync(path, "utf8")
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as T
}
