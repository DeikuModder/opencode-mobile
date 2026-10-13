import { describe, expect, it } from "vitest"
import { PassThrough } from "node:stream"
import { readPromptLine, type PromptStreams } from "../scripts/lib/prompt.js"

/**
 * Regression tests for the interactive prompt reader.
 *
 * These exist because `auth:setup` was unusable: it asked for a password twice,
 * and the second prompt died with `AbortError: The operation was aborted` because
 * the reader consumed stdin's async iterator. The failure was only observable
 * with a real TTY, so the reader is tested directly against a fake stream.
 */

const BS = "\u007f"
const CR = "\r"
const LF = "\n"

interface FakeTty extends PromptStreams {
  type: (s: string) => void
  written: () => string
  isRaw: () => boolean
}

function fakeTty(): FakeTty {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean
    isRaw: boolean
    setRawMode: (m: boolean) => void
  }
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = (m: boolean) => {
    input.isRaw = m
  }

  let out = ""
  return {
    input,
    output: {
      write(s: string) {
        out += s
        return true
      },
    },
    type(s: string) {
      input.write(s)
    },
    written: () => out,
    isRaw: () => input.isRaw,
  }
}

/** Let the reader attach its listeners before anything is typed. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5))
}

describe("readPromptLine", () => {
  it("reads a visible line and lets the terminal echo it", async () => {
    const tty = fakeTty()
    const p = readPromptLine(tty, "Username: ", "visible")
    await settle()
    tty.type("alice" + LF)
    await expect(p).resolves.toBe("alice")
    // No per-character echo from us: cooked mode owns that.
    expect(tty.written()).toBe("Username: ")
  })

  it("reads two hidden prompts in a row from the same stream", async () => {
    // The original bug: the second call aborted instead of reading.
    const tty = fakeTty()
    const first = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    tty.type("hunter22" + LF)
    await expect(first).resolves.toBe("hunter22")

    const second = readPromptLine(tty, "Confirm password: ", "hidden")
    await settle()
    tty.type("hunter22" + LF)
    await expect(second).resolves.toBe("hunter22")
  })

  it("reads the whole setup sequence: name, password, confirm, code", async () => {
    const tty = fakeTty()
    const turn = (q: string, mode: "visible" | "hidden", typed: string): Promise<string> => {
      const p = readPromptLine(tty, q, mode)
      void settle().then(() => tty.type(typed))
      return p
    }
    await expect(turn("Username [usuario]: ", "visible", "bob" + LF)).resolves.toBe("bob")
    await expect(turn("Password: ", "hidden", "hunter22" + LF)).resolves.toBe("hunter22")
    await expect(turn("Confirm password: ", "hidden", "hunter22" + LF)).resolves.toBe("hunter22")
    await expect(turn("Code: ", "visible", "123456" + LF)).resolves.toBe("123456")
  })

  it("masks hidden input and restores the terminal afterwards", async () => {
    const tty = fakeTty()
    const p = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    tty.type("abc" + LF)
    await expect(p).resolves.toBe("abc")
    expect(tty.written()).toBe("Password: ***" + LF)
    // Raw mode must be off again or the user's shell is left unusable.
    expect(tty.isRaw()).toBe(false)
  })

  it("turns raw mode on while a password is being typed", async () => {
    const tty = fakeTty()
    const p = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    expect(tty.isRaw()).toBe(true)
    tty.type("a" + LF)
    await p
    expect(tty.isRaw()).toBe(false)
  })

  it("never leaves raw mode on when input ends with no newline", async () => {
    // Regression guard: without an end handler this promise never settles and
    // the process exits with the terminal still in raw mode.
    const tty = fakeTty()
    const p = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    tty.input.end()
    await expect(p).resolves.toBe("")
    expect(tty.isRaw()).toBe(false)
  })

  it("resolves with what was typed when the stream ends mid-password", async () => {
    const tty = fakeTty()
    const p = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    tty.type("half")
    tty.input.end()
    await expect(p).resolves.toBe("half")
  })

  it("does not leak listeners between prompts", async () => {
    // Keystrokes typed between prompts legitimately feed the *next* prompt,
    // exactly as in any terminal. What must not happen is a finished prompt
    // leaving its listener attached and appending to its own already-returned
    // value.
    const tty = fakeTty()
    const dataListeners = (): number => tty.input.listenerCount("data")

    expect(dataListeners()).toBe(0)
    const p = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    expect(dataListeners()).toBe(1)
    tty.type("one" + LF)
    await expect(p).resolves.toBe("one")
    expect(dataListeners()).toBe(0)

    const q = readPromptLine(tty, "Code: ", "visible")
    await settle()
    expect(dataListeners()).toBe(1)
    tty.type("42" + LF)
    await expect(q).resolves.toBe("42")
    expect(dataListeners()).toBe(0)

    // And the finished prompts are not still holding stdin open.
    expect(tty.input.isPaused()).toBe(true)
  })

  it("deletes characters on backspace", async () => {
    const tty = fakeTty()
    const p = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    // "abc" + two backspaces + "xy" leaves "a" + "xy".
    tty.type("abc" + BS + BS + "xy" + LF)
    await expect(p).resolves.toBe("axy")
  })

  it("accepts Ctrl-H as backspace too", async () => {
    const tty = fakeTty()
    const p = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    tty.type("ab\b\b" + LF)
    await expect(p).resolves.toBe("")
  })

  it("ignores a backspace that arrives before any input", async () => {
    const tty = fakeTty()
    const p = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    tty.type(BS + "a" + LF)
    await expect(p).resolves.toBe("a")
  })

  it("treats a pasted CRLF as one line, not two prompts", async () => {
    const tty = fakeTty()
    const p = readPromptLine(tty, "Code: ", "visible")
    await settle()
    tty.type("654321" + CR + LF)
    await expect(p).resolves.toBe("654321")
  })

  it("discards a trailing newline left over from a paste", async () => {
    // If that newline survived, the confirm prompt would return empty and setup
    // would fail with a confusing password-mismatch error.
    const tty = fakeTty()
    const first = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    tty.type("secret1" + LF + LF)
    await expect(first).resolves.toBe("secret1")

    const second = readPromptLine(tty, "Confirm: ", "hidden")
    await settle()
    tty.type("secret1" + LF)
    await expect(second).resolves.toBe("secret1")
  })

  it("handles a password arriving as one pasted blob", async () => {
    const tty = fakeTty()
    const p = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    tty.type("c0rrectHorse1" + LF)
    await expect(p).resolves.toBe("c0rrectHorse1")
  })

  it("accepts unicode passwords", async () => {
    const tty = fakeTty()
    const p = readPromptLine(tty, "Password: ", "hidden")
    await settle()
    tty.type("contraseñaSegura1" + LF)
    await expect(p).resolves.toBe("contraseñaSegura1")
  })

  it("ignores other control characters", async () => {
    const tty = fakeTty()
    const p = readPromptLine(tty, "Code: ", "visible")
    await settle()
    tty.type("\u0001\u001b12" + LF)
    await expect(p).resolves.toBe("12")
  })
})
