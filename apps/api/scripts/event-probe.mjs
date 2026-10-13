// Throwaway probe: holds /event open against serve directly and prints every
// frame type with a timestamp, so we can see whether session-scoped events
// appear at all while a turn runs.
import { readFileSync } from "node:fs"

const env = readFileSync(new URL("../../../.env", import.meta.url), "utf8")
const pw = /^\s*SERVE_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, "")
if (!pw) throw new Error("SERVE_PASSWORD not found in .env")

const basic = Buffer.from(`opencode:${pw}`).toString("base64")
const started = Date.now()
const res = await fetch("http://127.0.0.1:4101/event", {
  headers: { authorization: `Basic ${basic}`, accept: "text/event-stream" },
  signal: AbortSignal.timeout(Number(process.argv[2] ?? 120) * 1000),
})

console.log(`status ${res.status} ${res.headers.get("content-type")}`)
const reader = res.body.getReader()
const dec = new TextDecoder()
let buf = ""
const counts = new Map()

while (true) {
  let chunk
  try {
    chunk = await reader.read()
  } catch (err) {
    console.log(`\nstream ended: ${err.message}`)
    break
  }
  if (chunk.done) break
  buf += dec.decode(chunk.value, { stream: true })

  let idx
  while ((idx = buf.indexOf("\n\n")) !== -1) {
    const raw = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    if (raw.startsWith(":")) {
      console.log(`[${Date.now() - started}s] comment: ${raw.trim()}`)
      continue
    }
    const data = /^data: (.*)$/m.exec(raw)?.[1]
    if (!data) continue
    let type = "?"
    let sessionId = ""
    try {
      const ev = JSON.parse(data)
      type = ev.type ?? "?"
      sessionId = ev.properties?.sessionID ?? ev.properties?.info?.id ?? ""
    } catch {
      type = "unparseable"
    }
    counts.set(type, (counts.get(type) ?? 0) + 1)
    const marker = sessionId ? ` session=${sessionId.slice(0, 16)}` : ""
    console.log(`[${Date.now() - started}s] ${type}${marker}`)
  }
}

console.log("\n--- frame type counts ---")
for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${t}`)