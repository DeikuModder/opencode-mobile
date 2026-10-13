/**
 * Change the password from a terminal. LOCAL ONLY break-glass path.
 *
 * Revokes every existing session, so a stolen cookie cannot outlive the change.
 */
import { openDb, userExists } from "../src/auth/db.js"
import { resolveDbPath, resolveSessionPolicy } from "../src/config.js"
import { AuthService } from "../src/auth/service.js"
import { validatePasswordStrength } from "../src/auth/password.js"
import { askHidden, fail, ok } from "./lib/prompt.js"
import { stdout } from "node:process"

async function main(): Promise<void> {
  const db = openDb(resolveDbPath())
  if (!userExists(db)) fail("No account configured. Run `pnpm auth:setup` first.")

  const svc = new AuthService(db, resolveSessionPolicy())
  const user = (await import("../src/auth/db.js")).getUser(db)!

  stdout.write(`Changing password for "${user.username}". All sessions will be revoked.\n\n`)
  const first = await askHidden("New password: ")
  const second = await askHidden("Confirm new password: ")
  if (first !== second) fail("Passwords do not match.")
  const weak = validatePasswordStrength(first)
  if (weak) fail(weak)

  await svc.resetPasswordFromCli(first)
  ok("Password changed. All sessions revoked â€” log in again on every device.")
  db.close()
}

main().catch((err) => fail((err as Error).message))

