/**
 * First-run account setup.
 *
 * LOCAL ONLY. There is deliberately no HTTP route for this — the only way to
 * create the account is from a terminal on the machine, which already implies
 * full control. It refuses to run if a user already exists so it can never be
 * used to replace the credentials of a configured account.
 */
import { openDb, userExists } from "../src/auth/db.js"
import { resolveDbPath } from "../src/config.js"
import { MIN_PASSWORD_LENGTH, validatePasswordStrength } from "../src/auth/password.js"
import { generateTotpSecret, totpUri, verifyTotp, TOTP_ISSUER } from "../src/auth/totp.js"
import { hashPassword } from "../src/auth/password.js"
import { generateRecoveryCode, hashToken } from "../src/auth/tokens.js"
import { ask, askHidden, fail, ok } from "./lib/prompt.js"
import { printTotpEnrolment } from "./lib/qr.js"
import { stdout } from "node:process"

function heading(s: string): void {
  stdout.write(`\n${s}\n${"-".repeat(s.length)}\n`)
}

async function promptPassword(): Promise<string> {
  const first = await askHidden("Password: ")
  const second = await askHidden("Confirm password: ")
  if (first !== second) fail("Passwords do not match.")
  const weak = validatePasswordStrength(first)
  if (weak) fail(weak)
  return first
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath()
  const db = openDb(dbPath)

  heading("opencode-mobile — first-run setup")
  stdout.write(`Database: ${dbPath}\n`)

  if (userExists(db)) {
    fail(
      "An account already exists.\n" +
        "  Use `pnpm auth:reset-password` to change the password.\n" +
        "  Use `pnpm auth:disable-totp`    to remove the second factor.\n" +
        "This command will not overwrite an existing account.",
    )
  }

  const username = (await ask("Username [usuario]: ")) || "usuario"
  const password = await promptPassword()
  ok(`Password accepted (min ${MIN_PASSWORD_LENGTH} chars, letter + digit).`)

  heading("Two-factor authentication")
  const secret = generateTotpSecret()
  stdout.write(`\nAdd this account to your authenticator app (${TOTP_ISSUER}):\n`)
  await printTotpEnrolment(totpUri(secret, username), secret)

  const code = await ask("Enter the 6-digit code from your app to confirm: ")
  if (!verifyTotp(code, secret)) {
    fail("That code was not valid. Nothing was written — run setup again.")
  }
  ok("Second factor confirmed.")

  heading("Creating account")
  const now = Date.now()
  db.prepare(
    `INSERT INTO users (id, username, password_hash, totp_secret, totp_enabled, created_at, updated_at)
     VALUES (1, ?, ?, ?, 1, ?, ?)`,
  ).run(username, await hashPassword(password), secret, now, now)

  const codes = Array.from({ length: 10 }, generateRecoveryCode)
  const ins = db.prepare("INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (1, ?, ?)")
  for (const c of codes) ins.run(hashToken(c.toUpperCase()), now)

  ok(`User "${username}" created with TOTP enabled.`)

  heading("Recovery codes — store these now, they are shown only once")
  for (const c of codes) stdout.write(`  ${c}\n`)
  stdout.write("\nEach code works once. They are the only way back in if you lose\n")
  stdout.write("your phone. They cannot be retrieved later.\n")

  db.close()
  stdout.write("\nSetup complete. Start the gateway with `pnpm dev:api`.\n\n")
}

main().catch((err) => fail((err as Error).message))
