import { stdout } from "node:process"
import qrcode from "qrcode-terminal"

/**
 * Terminal QR rendering for TOTP enrolment.
 *
 * Scanning a QR out of a terminal is genuinely unreliable: half-block glyphs
 * depend on the terminal's font metrics lining up, PowerShell adds cell padding
 * that distorts the module grid, and any mismatch corrupts the payload into a
 * *different but still valid-looking* secret. That failure is nasty because the
 * user cannot tell it happened, and their authenticator then computes codes
 * that never match.
 *
 * So the manual secret is presented as the reliable path and the QR is offered
 * as the convenience one, with the otpauth URI as a third option for apps that
 * accept a pasted URI.
 */
export async function printTotpEnrolment(uri: string, secret: string): Promise<void> {
  stdout.write("\n")

  // Half-block rendering: compact, and the only form that fits a terminal
  // without wrapping, which a 21-module QR at full size would do.
  const qr = await new Promise<string>((resolve) => {
    qrcode.generate(uri, { small: true }, resolve)
  })
  stdout.write(
    "\n  Option 1 - scan this with your authenticator app:\n\n" +
      qr
        .replace(/\n$/, "")
        .split("\n")
        .map((l) => "    " + l)
        .join("\n") +
      "\n",
  )

  stdout.write(
    "\n  Option 2 (more reliable) - add the secret by hand, exactly as printed:\n\n" +
      `      ${secret}\n\n` +
      "    Settings -> Add account -> Enter setup key. The issuer is\n" +
      "    opencode-mobile, the type is time based, the digits are 6, and the\n" +
      "    period is 30 seconds.\n",
  )

  stdout.write(
    "\n  Option 3 - if your app accepts a pasted link:\n\n" +
      `      ${uri}\n\n`,
  )
}
