/**
 * Diagnose a TOTP code that will not verify.
 *
 * LOCAL ONLY, and read-only. The login error for a bad second factor is
 * `invalid_totp` whether the cause is an expired code, a phone whose clock
 * drifted, or an authenticator holding a completely different secret. Those
 * need three different fixes and the error distinguishes none of them, so this
 * asks for the code you are actually seeing and reports which one it is.
 *
 * Never prints the secret, and never prints a code the app would accept: that
 * would put a working second factor into scrollback.
 */
import { openDb, getUser } from "../src/auth/db.js"
import { resolveDbPath } from "../src/config.js"
import { diagnoseTotp } from "../src/auth/totp.js"
import { ask, fail, ok } from "./lib/prompt.js"
import { stdout } from "node:process"

async function main(): Promise<void> {
  const db = openDb(resolveDbPath())
  const user = getUser(db)
  if (!user) fail("No account exists yet. Run `pnpm auth:setup` first.")
  if (!user.totp_enabled || !user.totp_secret) {
    db.close()
    fail("This account has no second factor enabled, so there is no code to check.")
  }

  stdout.write(`\nChecking the second factor for "${user.username}".\n`)
  stdout.write("Codes rotate every 30 seconds, so run this while the code is fresh.\n\n")

  const code = await ask("6-digit code from your authenticator app: ")
  const verdict = diagnoseTotp(code, user.totp_secret)
  db.close()

  if (verdict.kind === "valid") {
    ok("That code is valid right now. If login still failed, the code had expired by the time it was sent.")
    return
  }

  if (verdict.kind === "drift") {
    stdout.write(`\n  This code is valid for a device whose clock is ${verdict.seconds}s behind.\n`)
    stdout.write("\n  The server's clock is correct, so fix the device:\n")
    stdout.write("    - Android/iOS: Settings -> Date & time -> set it to automatic\n")
    stdout.write("    - then re-run this check to confirm\n\n")
    return
  }

  stdout.write("\n  No clock drift explains this code.\n")
  stdout.write("\n  Most likely: your authenticator is holding a *different* secret than\n")
  stdout.write("  this install. Re-enrol with:\n\n")
  stdout.write("      pnpm auth:enable-totp\n\n")
}

main().catch((err) => fail((err as Error).message))
