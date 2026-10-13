/**
 * Renders assistant markdown to sanitized HTML.
 *
 * Why a library rather than hand-rolled regexes: agent output is full of fenced
 * code, lists, tables and emphasis, and the naive replacements for those break
 * on exactly the content that matters (a `*` inside a code block, a `#` inside
 * a shell comment). `marked` parses CommonMark/GFM properly.
 *
 * Why sanitizing is not optional: the rendered string comes from a model and,
 * transitively, from files and web content the model read. It is injected with
 * `{@html}`, which bypasses Svelte's escaping, so unsanitized HTML here would be
 * a stored-XSS hole with the gateway cookie as the payload. DOMPurify strips
 * scripts, event handlers and `javascript:` URLs before the HTML reaches the DOM.
 */

import { marked } from "marked"
import DOMPurify from "dompurify"

marked.setOptions({ gfm: true, breaks: true, async: false })

/**
 * Marks links as external and un-trustable.
 *
 * Without this a document could contain a link that navigates the app away to an
 * attacker page, or opens a new tab that keeps a handle on `window.opener`.
 */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank")
    node.setAttribute("rel", "noopener noreferrer")
  }
})

/**
 * Finalized messages are rendered repeatedly as the transcript scrolls and
 * re-renders, and the same text is re-rendered on every parent update. Keying by
 * content keeps that cheap.
 *
 * Bounded because a long session accumulates a lot of distinct assistant text;
 * without a ceiling this grows for the lifetime of the tab. Eviction is
 * oldest-first, which is safe because the value is a pure function of the key.
 */
const CACHE_LIMIT = 200
const cache = new Map<string, string>()

/**
 * Renders `src` to HTML that is safe to inject.
 *
 * Returns a string, never a promise: `async: false` above pins that, so callers
 * in the template do not have to become async.
 */
export function renderMarkdown(src: string): string {
  if (!src) return ""

  const hit = cache.get(src)
  if (hit !== undefined) return hit

  const html = DOMPurify.sanitize(marked.parse(src) as string, {
    // `target`/`rel` are added by the hook above, so they must survive the
    // allowlist or external links come back without them.
    ADD_ATTR: ["target", "rel"],
  })

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(src, html)
  return html
}

/** Test seam: drops memoized output. */
export function clearMarkdownCache(): void {
  cache.clear()
}