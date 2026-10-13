import { describe, expect, it, beforeEach } from "vitest"
import { renderMarkdown, clearMarkdownCache } from "./markdown.js"

describe("renderMarkdown", () => {
  beforeEach(() => clearMarkdownCache())

  it("renders the formatting agents actually emit", () => {
    const html = renderMarkdown("**bold** and `inline`")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<code>inline</code>")
  })

  it("keeps a fenced code block's contents verbatim", () => {
    const html = renderMarkdown("```sh\nls -la *\n```")
    expect(html).toContain("<pre>")
    // The `*` must not become emphasis inside the block, and the newline must
    // survive: this is exactly the content naive regex replacements break on.
    expect(html).toContain("ls -la *")
  })

  it("renders lists and headings", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two")
    expect(html).toContain("<h1>Title</h1>")
    expect(html).toContain("<li>one</li>")
    expect(html).toContain("<li>two</li>")
  })

  // The output is injected with {@html}, so these are the tests that matter most.
  it("strips script tags", () => {
    const html = renderMarkdown("before <script>alert(1)</script> after")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("alert(1)")
    expect(html).toContain("before")
  })

  it("strips inline event handlers", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    expect(html).not.toContain("onerror")
  })

  it("drops javascript: URLs", () => {
    const html = renderMarkdown("[click](javascript:alert(1))")
    expect(html.toLowerCase()).not.toContain("javascript:")
  })

  it("escapes text that is not markup, so it cannot inject structure", () => {
    const html = renderMarkdown("5 < 6 && 7 > 6")
    expect(html).toContain("&lt;")
    expect(html).toContain("&amp;")
  })

  it("marks links noopener so they cannot reach back into the app", () => {
    const html = renderMarkdown("[docs](https://example.com)")
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it("returns the same output for the same input, from cache or not", () => {
    const first = renderMarkdown("**same**")
    const second = renderMarkdown("**same**")
    expect(second).toBe(first)
  })

  it("returns an empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("")
  })
})