<script lang="ts">
  /**
   * Read-only file browser.
   *
   * Navigation is breadcrumb-based rather than a full tree: a phone user wants
   * "go up one level and into a sibling", and lazily fetching one directory at a
   * time keeps a large repo from being walked in full just to render a screen.
   *
   * Nothing here can write. A file is viewed or copied, never edited.
   */
  import { serveApi, type ApiError } from "../lib/api.js"

  interface Entry {
    name: string
    path: string
    type: "file" | "directory"
    size?: number
  }

  let cwd = $state("")
  let entries = $state<Entry[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)
  let selected = $state<{ path: string; name: string } | null>(null)
  let content = $state<string | null>(null)
  let binary = $state(false)
  let contentLoading = $state(false)

  /** Byte cap: a minified bundle or a lockfile is megabytes and unreadable on a phone. */
  const MAX_BYTES = 200_000

  const crumbs = $derived.by(() => {
    if (!cwd) return []
    const parts = cwd.split("/").filter(Boolean)
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }))
  })

  const dirs = $derived(entries.filter((e) => e.type === "directory"))
  const files = $derived(
    entries
      .filter((e) => e.type === "file")
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  async function load(path: string) {
    loading = true
    error = null
    selected = null
    content = null
    try {
      const node = await serveApi.fileTree(path === "" ? "." : path)
      const kids = (node.children ?? []) as Entry[]
      entries = [...kids].sort((a, b) => {
        // Directories first, which is what a phone user scans for.
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      cwd = path
    } catch (e) {
      const err = e as ApiError
      // A directory we cannot read is a permissions or .gitignore question, not
      // a gateway failure; saying so is more useful than a generic message.
      error = err.isNetwork ? err.message : `cannot open this directory (${err.code})`
    } finally {
      loading = false
    }
  }

  async function open(entry: Entry) {
    if (entry.type === "directory") {
      await load(entry.path)
      return
    }
    selected = { path: entry.path, name: entry.name }
    contentLoading = true
    content = null
    binary = false
    try {
      const res = await serveApi.fileContent(entry.path)
      const head = res.content.slice(0, 8000)
      // A data: URL means the file is inlined as base64 (images, PDFs). A NUL or
      // a high proportion of control characters means raw binary. Checking the
      // head only, because a large text file's tail tells us nothing extra and
      // scanning all of it is wasted work on a phone.
      const controlChars = (head.match(/[\x00-\x08\x0E-\x1F]/g) ?? []).length
      const looksBinary = head.indexOf(String.fromCharCode(0)) >= 0 || controlChars / Math.max(1, head.length) > 0.05
      if (res.encoding === "base64" || res.content.startsWith("data:") || looksBinary) {
        binary = true
      } else {
        content = res.content.length > MAX_BYTES ? `${res.content.slice(0, MAX_BYTES)}\n\n… truncated …` : res.content
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "cannot read file"
    } finally {
      contentLoading = false
    }
  }

  async function copy() {
    if (content === null) return
    try {
      await navigator.clipboard.writeText(content)
    } catch {
      // Clipboard access needs a secure context and can still be refused by the
      // user. The text is on screen, so this is a convenience, not a path.
      error = "clipboard unavailable — select the text manually"
    }
  }

  function close() {
    selected = null
    content = null
  }

  async function goUp() {
    const parts = cwd.split("/").filter(Boolean)
    parts.pop()
    await load(parts.join("/"))
  }

  $effect(() => {
    const q = new URLSearchParams(location.hash.split("?")[1] ?? "")
    void load(q.get("path") ?? "")
  })
</script>

<div class="wrap">
  <div class="bar">
    <a class="ghost back" href="#/" aria-label="Back">‹</a>
    <nav class="crumbs" aria-label="Path">
      <button class="crumb" onclick={() => load("")}>root</button>
      {#each crumbs as c (c.path)}
        <span class="sep">/</span>
        <button class="crumb" onclick={() => load(c.path)}>{c.name}</button>
      {/each}
    </nav>
    {#if cwd}
      <button class="ghost" onclick={goUp}>up</button>
    {/if}
  </div>

  {#if loading}
    <div class="center"><span class="spinner"></span></div>
  {:else if error && !selected}
    <p class="error" role="alert">{error}</p>
  {:else}
    {#if dirs.length}
      <h2>folders</h2>
      <ul>
        {#each dirs as d (d.path)}
          <li><button class="row spread full" onclick={() => open(d)}><span class="truncate">{d.name}/</span></button></li>
        {/each}
      </ul>
    {/if}

    {#if files.length}
      <h2>files</h2>
      <ul>
        {#each files as f (f.path)}
          <li>
            <button class="row spread full" class:on={selected?.path === f.path} onclick={() => open(f)}>
              <span class="truncate">{f.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else if !dirs.length}
      <p class="faint center">empty directory</p>
    {/if}
  {/if}
</div>

{#if selected}
  <div class="sheet">
    <div class="sheet-bar">
      <span class="truncate grow mono">{selected.name}</span>
      {#if content !== null}
        <button class="ghost" onclick={copy}>copy</button>
      {/if}
      <button class="ghost" onclick={close}>close</button>
    </div>
    <div class="sheet-body">
      {#if contentLoading}
        <span class="spinner"></span>
      {:else if binary}
        <p class="faint">binary file — not shown</p>
      {:else if content !== null}
        <pre>{content}</pre>
      {:else if error}
        <p class="error" role="alert">{error}</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .wrap {
    padding: 0 0 16px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 8px;
    padding-top: calc(env(safe-area-inset-top) + 8px);
    border-bottom: 1px solid var(--border);
    min-height: calc(env(safe-area-inset-top) + var(--header-h));
  }
  .back {
    font-size: 1.5rem;
    line-height: 1;
    text-decoration: none;
    padding: 4px 12px;
    flex: none;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    flex: 1;
  }
  .crumb {
    background: none;
    border: none;
    padding: 4px 2px;
    color: var(--accent);
    font-size: 0.85rem;
    white-space: nowrap;
    min-height: 0;
  }
  .sep {
    color: var(--text-faint);
  }
  h2 {
    margin: 16px 14px 6px;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-dim);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overscroll-behavior: contain;
  }
  li {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .full {
    width: 100%;
    background: none;
    border: none;
    text-align: left;
    min-height: 0;
    padding: 12px 14px;
  }
  .on {
    border-color: var(--accent);
  }
  .center {
    text-align: center;
    padding: 32px 0;
  }
  .sheet {
    position: fixed;
    inset: 0;
    background: var(--bg);
    z-index: 40;
    display: flex;
    flex-direction: column;
  }
  .sheet-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    padding-top: calc(env(safe-area-inset-top) + 8px);
    border-bottom: 1px solid var(--border);
  }
  .sheet-body {
    flex: 1;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 12px 14px calc(env(safe-area-inset-bottom) + 12px);
  }
</style>
