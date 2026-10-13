/**
 * Remove the TOTP second factor. LOCAL ONLY break-glass path.
 *
 * Use when the authenticator device is lost. Revokes every session and destroys
 * all recovery codes, since none of them are trustworthy any more.
 */
import { openDb, getUser, userExists } from "../src/auth/db.js"
import { resolveDbPath, resolveSessionPolicy } from "../src/config.js"
import { AuthService } from "../src/auth/service.js"
import { ask, fail, ok } from "./lib/prompt.js"
import { stdout } from "node:process"

async function main(): Promise<void> {
  const db = openDb(resolveDbPath())
  if (!userExists(db)) fail("No account configured. Run `pnpm auth:setup` first.")

  const svc = new AuthService(db, resolveSessionPolicy())
  const user = getUser(db)!

  if (user.totp_enabled !== 1) {
    stdout.write("TOTP is not currently enabled. Nothing to do.\n")
    db.close()
    return
  }

  stdout.write(`\nThis will disable TOTP for "${user.username}".\n`)
  stdout.write("It weakens security: the password becomes the only factor guarding a\n")
  stdout.write("service that can execute shell commands on this machine.\n\n")
  const answer = await ask('Type "disable-totp" to confirm: ')
  if (answer !== "disable-totp") fail("Confirmation did not match; nothing changed.")

  svc.disableTotpFromCli()
  ok("TOTP disabled, recovery codes destroyed, all sessions revoked.")
  db.close()
}

main().catch((err) => fail((err as Error).message))

