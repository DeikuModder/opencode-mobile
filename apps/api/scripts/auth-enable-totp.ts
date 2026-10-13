/**
 * Enrol, or re-enrol, the TOTP second factor. LOCAL ONLY.
 *
 * This existed as a gap: `auth:setup` refuses to run once an account exists,
 * and `auth:disable-totp` was the only other TOTP command, so an account whose
 * authenticator held the wrong secret could not be repaired at all. The only
 * ways out were burning the ten recovery codes or deleting the database.
 *
 * `pnpm auth:check-totp` says which of those you actually need.
 *
 * Re-enrolment is gated on the current password, and on a working second factor
 * if one is already enabled. Otherwise anyone who learned the password could
 * swap in an authenticator they control and log in with it.
 */
import { openDb, getUser, userExists, consumeRecoveryCode, unusedRecoveryCodeCount } from "../src/auth/db.js"
import { resolveDbPath, resolveSessionPolicy } from "../src/config.js"
import { verifyPassword } from "../src/auth/password.js"
import { AuthService } from "../src/auth/service.js"
import { generateTotpSecret, totpUri, verifyTotp } from "../src/auth/totp.js"
import { ask, askHidden, fail, ok } from "./lib/prompt.js"
import { printTotpEnrolment } from "./lib/qr.js"
import { stdout } from "node:process"

async function main(): Promise<void> {
  const db = openDb(resolveDbPath())
  if (!userExists(db)) fail("No account configured. Run `pnpm auth:setup` first.")

  const user = getUser(db)!
  const svc = new AuthService(db, resolveSessionPolicy())

  stdout.write(`\nRe-enrolling the second factor for "${user.username}".\n\n`)

  stdout.write("Confirm the current password:\n")
  const password = await askHidden("Current password: ")
  if (!(await verifyPassword(password, user.password_hash))) {
    db.close()
    fail("Password is not correct. Nothing changed.")
  }

  if (user.totp_enabled === 1) {
    // TOTP is already on, so the password alone is not enough to replace it.
    const remaining = unusedRecoveryCodeCount(db)
    stdout.write(
      "\nA second factor is already enabled, so prove you still have it: enter\n" +
        `either a current code from your authenticator, or one of the ${remaining} unused\n` +
        "recovery codes. (Using a recovery code consumes it.)\n",
    )
    const proof = (await ask("Code or recovery code: ")).trim()
    const totpOk = verifyTotp(proof, user.totp_secret ?? "")
    const recoveryOk = !totpOk && consumeRecoveryCode(db, proof.toUpperCase())
    if (!totpOk && !recoveryOk) {
      db.close()
      fail("That did not verify. Nothing changed.")
    }
    ok(recoveryOk ? "Recovery code accepted (one has been used)." : "Second factor confirmed.")
  }

  stdout.write("\nA new secret will replace the current one.\n")
  const confirm = await ask('Type "enrol" to continue: ')
  if (confirm !== "enrol") {
    db.close()
    fail("Confirmation did not match; nothing changed.")
  }

  const secret = generateTotpSecret()
  stdout.write("\nAdd this account to your authenticator app:\n")
  await printTotpEnrolment(totpUri(secret, user.username), secret)

  const code = await ask("\nEnter a fresh code from the app to confirm: ")
  if (!verifyTotp(code, secret)) {
    db.close()
    fail("That code was not valid, so the old secret is still in place. Nothing changed.")
  }

  const codes = svc.enableTotpFromCli(secret)
  db.close()

  ok("Second factor enrolled. All sessions revoked, recovery codes replaced.")

  stdout.write("\nRecovery codes - store these now, they are shown only once:\n")
  for (const c of codes) stdout.write(`  ${c}\n`)
  stdout.write("\nRestart the gateway if it runs in Docker, so it picks up the new secret.\n\n")
}

main().catch((err) => fail((err as Error).message))
