import { stdin as realStdin, stdout as realStdout } from "node:process"

/**
 * Interactive prompts.
 *
 * These are used by the account CLI scripts, which are the only way to create or
 * change credentials, so they are deliberately paranoid: no TTY means no prompt,
 * and a password is never echoed.
 *
 * Both prompts are driven by `data` events on a single shared stdin rather than
 * by `readline` or by iterating stdin with `for await`. That is not a style
 * choice:
 *
 * - A Node stream's async iterator is consumed. Asking for it a second time
 *   yields nothing, or rejects with `AbortError: The operation was aborted` once
 *   the stream has been destroyed, so `for await` silently breaks any script
 *   that needs two prompts in a row. `auth:setup` asks for a password twice.
 * - `readline` takes over stdin and closes it, which fights with raw-mode input
 *   handling for the *next* prompt.
 *
 * Attaching and removing listeners per prompt is re-entrant by construction, and
 * it leaves stdin paused and out of raw mode in between.
 */

/** The slice of a TTY stdin/stdout pair the reader needs. */
export interface PromptStreams {
  // pause/resume/read/setEncoding come from NodeJS.ReadableStream itself; only
  // the TTY extras are added, and optionally because a piped stdin has none.
  input: NodeJS.ReadableStream & {
    isTTY?: boolean
    isRaw?: boolean
    setRawMode?: (mode: boolean) => unknown
  }
  output: { write: (s: string) => unknown }
}

type Mode = "visible" | "hidden"

// Escapes rather than literal bytes: a raw 0x03 in a source file is invisible in
// review and easy for an editor or a diff to mangle.
const CTRL_C = "\u0003"
const CTRL_D = "\u0004"
const BACKSPACE = "\u007f"
const CTRL_H = "\b"
const CR = "\r"
const LF = "\n"

/**
 * Reads one line from `io`, echoing it or masking it according to `mode`.
 *
 * Exported for tests: being correct across several sequential calls is the whole
 * point, and that cannot be exercised through a non-TTY stdin.
 */
export function readPromptLine(io: PromptStreams, question: string, mode: Mode): Promise<string> {
  const { input, output } = io

  // Visible mode stays in cooked mode so the terminal does its own echo and line
  // editing. Raw mode is only used to suppress the echo for passwords; doing that
  // for visible prompts would mean re-implementing echo by hand.
  const wantRaw = mode === "hidden"
  const wasRaw = input.isRaw ?? false
  const setRaw = (on: boolean): void => {
    if (input.setRawMode) input.setRawMode(on)
  }

  output.write(question)

  return new Promise<string>((resolve) => {
    let value = ""
    let settled = false

    const cleanup = (): void => {
      if (settled) return
      settled = true
      input.removeListener("data", onData as never)
      input.removeListener("end", onEnd)
      input.removeListener("close", onEnd)
      input.removeListener("error", onEnd)
      if (wantRaw) setRaw(wasRaw)
      input.pause()
      // Drop anything already buffered. Without this, a password pasted with a
      // trailing newline leaves that newline in the buffer and the *next* prompt
      // returns an empty answer.
      try {
        while (input.read() !== null) {
          /* discard */
        }
      } catch {
        /* not readable while paused; nothing buffered to drain */
      }
    }

    function settleWith(line: string): void {
      if (wantRaw) output.write(LF)
      cleanup()
      resolve(line)
    }

    function onData(chunk: string | Buffer): void {
      for (const ch of chunk.toString()) {
        if (ch === CR || ch === LF) {
          // A pasted CRLF emits two terminators, so `settled` in cleanup is what
          // stops the second from silently starting a new prompt.
          settleWith(value)
          return
        }
        if (ch === CTRL_C) {
          output.write(LF)
          cleanup()
          process.exit(130)
        }
        if (ch === CTRL_D) {
          // Ctrl-D ends input. Treat it as an empty line rather than hanging.
          settleWith(value)
          return
        }
        if (ch === BACKSPACE || ch === CTRL_H) {
          if (value.length > 0) {
            value = value.slice(0, -1)
            if (wantRaw) output.write("\b \b")
          }
          continue
        }
        if (ch >= " ") {
          value += ch
          if (wantRaw) output.write("*")
        }
      }
    }

    // End of input with no terminating newline still has to resolve, or the
    // process hangs with the terminal in raw mode.
    function onEnd(): void {
      settleWith(value)
    }

    if (wantRaw) setRaw(true)
    input.setEncoding("utf8")
    input.resume()
    input.on("data", onData as never)
    input.on("end", onEnd)
    input.on("close", onEnd)
    input.on("error", onEnd)
  })
}

const stdio: PromptStreams = { input: realStdin, output: realStdout }

/** Visible single-line prompt. */
export async function ask(question: string): Promise<string> {
  if (!realStdin.isTTY) {
    throw new Error("Refusing to prompt without a TTY. Run this from an interactive terminal.")
  }
  return (await readPromptLine(stdio, question, "visible")).trim()
}

/**
 * Password prompt with echo suppressed.
 *
 * Restores the terminal in cleanup — an un-restored stdin leaves the shell
 * unusable after the process exits, and a raw stdin left attached keeps the
 * process alive.
 */
export async function askHidden(question: string): Promise<string> {
  if (!realStdin.isTTY) {
    throw new Error("Refusing to read a password without a TTY. Run this from an interactive terminal.")
  }
  return readPromptLine(stdio, question, "hidden")
}

export function ok(msg: string): void {
  realStdout.write(`  ${msg}\n`)
}

export function fail(msg: string): never {
  realStdin.pause()
  process.stderr.write(`\nERROR: ${msg}\n`)
  process.exit(1)
}
