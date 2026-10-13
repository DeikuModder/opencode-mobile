/**
 * Inspect and revoke sessions. LOCAL ONLY.
 *
 *   pnpm auth:sessions           list active sessions
 *   pnpm auth:sessions --all     revoke every session (log out everywhere)
 *   pnpm auth:sessions --purge   delete expired rows only
 *   pnpm auth:sessions --tokens  list Telegram bot tokens
 */
import { openDb, listSessions, listBotTokens, purgeExpiredSessions, revokeAllSessions, revokeSession } from "../src/auth/db.js"
import { resolveDbPath } from "../src/config.js"
import { fail } from "./lib/prompt.js"
import { stdout } from "node:process"

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

async function main(): Promise<void> {
  const db = openDb(resolveDbPath())
  const args = process.argv.slice(2)

  if (args.includes("--purge")) {
    const n = purgeExpiredSessions(db)
    stdout.write(`Removed ${n} expired session(s).\n`)
    db.close()
    return
  }

  if (args.includes("--all")) {
    const n = revokeAllSessions(db)
    stdout.write(`Revoked ${n} session(s). Every device must log in again.\n`)
    db.close()
    return
  }

  if (args.includes("--tokens")) {
    const tokens = listBotTokens(db)
    if (tokens.length === 0) stdout.write("No Telegram bot tokens.\n")
    for (const t of tokens) {
      const state = t.revoked_at ? `REVOKED ${ago(t.revoked_at)}` : `active, last used ${t.last_used_at ? ago(t.last_used_at) : "never"}`
      stdout.write(`  #${t.id}  ${t.label || "(unlabelled)"}  ${state}\n`)
    }
    db.close()
    return
  }

  const sessions = listSessions(db)
  if (sessions.length === 0) stdout.write("No active sessions.\n")
  for (const s of sessions) {
    stdout.write(
      `  #${s.id}  ${s.kind}  created ${ago(s.created_at)}  seen ${ago(s.last_seen_at)}  ` +
        `expires in ${Math.max(0, Math.floor((s.expires_at - Date.now()) / 86_400_000))}d\n` +
        `        ip=${s.ip ?? "?"}  ua=${(s.user_agent ?? "?").slice(0, 80)}\n`,
    )
  }
  const idArg = args.find((a) => a.startsWith("--revoke="))
  if (idArg) {
    const id = Number.parseInt(idArg.split("=")[1] ?? "", 10)
    if (Number.isFinite(id)) {
      revokeSession(db, id)
      stdout.write(`\nRevoked session #${id}.\n`)
    }
  }
  db.close()
}

// Without this catch a ConfigError surfaces as a raw stack trace, which is the
// wrong output for a break-glass command: the one thing the operator needs to
// read is the message, and a stack pushes it off the top of the screen.
main().catch((err) => fail((err as Error).message))
