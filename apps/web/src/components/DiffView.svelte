<script lang="ts">
  /**
   * Read-only diff viewer.
   *
   * This deliberately cannot write or revert. The gateway exposes the diff
   * endpoint, and a mobile UI for applying changes is exactly the kind of
   * destructive surface that should live in a proper review tool.
   */
  import { serveApi } from "../lib/api.js"

  interface DiffFile {
    path: string
    additions: number
    deletions: number
    diff: string
  }

  let loading = $state(true)
  let error = $state<string | null>(null)
  let files = $state<DiffFile[]>([])
  let selected = $state<string | null>(null)
  let sessionId = $state("")

  /** Split a unified diff into per-file sections with a header each. */
  function splitDiff(raw: string): DiffFile[] {
    const out: DiffFile[] = []
    const lines = raw.split("\n")
    let current: DiffFile | null = null
    let buf: string[] = []

    const flush = () => {
      if (!current) return
      current.diff = buf.join("\n")
      out.push(current)
      buf = []
      current = null
    }

    for (const line of lines) {
      const m = /^\+\+\+ b\/(.+)$/.exec(line)
      if (m) {
        flush()
        current = { path: m[1] ?? "?", additions: 0, deletions: 0, diff: "" }
        continue
      }
      if (!current) continue
      if (line.startsWith("+") && !line.startsWith("+++")) current.additions++
      else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++
      buf.push(line)
    }
    flush()
    return out
  }

  async function load() {
    const q = new URLSearchParams(location.hash.split("?")[1] ?? "")
    sessionId = q.get("session") ?? ""
    if (!sessionId) {
      error = "no session specified"
      loading = false
      return
    }
    loading = true
    error = null
    try {
      const raw = await serveApi.diff(sessionId)
      if (raw.length === 0) {
        files = []
        return
      }
      // The endpoint shape has varied across opencode builds, so normalise
      // rather than guess: either an array of file entries, or an array whose
      // entries each hold one combined diff string.
      const entries = raw as unknown as Record<string, unknown>[]
      const perFile = entries.length > 0 && typeof entries[0]?.path === "string"
      if (perFile) {
        files = entries.map((e) => ({
          path: String(e.path),
          additions: Number(e.additions ?? 0),
          deletions: Number(e.deletions ?? 0),
          diff: typeof e.diff === "string" ? e.diff : "",
        }))
      } else {
        const combined = entries.map((e) => String(e.diff ?? "")).join("\n")
        files = splitDiff(combined)
      }
      selected = files[0]?.path ?? null
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load diff"
    } finally {
      loading = false
    }
  }

  const current = $derived(files.find((f) => f.path === selected) ?? null)

  $effect(() => {
    void load()
  })
</script>

<div class="wrap">
  <div class="bar">
    <a class="ghost back" href="#/" aria-label="Back">‹</a>
    <span class="grow">diff</span>
    {#if sessionId}
      <a class="ghost" href={`#/session/${sessionId}`}>chat</a>
    {/if}
  </div>

  {#if loading}
    <div class="center"><span class="spinner"></span></div>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if files.length === 0}
    <p class="faint center">no changes in this session</p>
  {:else}
    <nav class="files">
      {#each files as f (f.path)}
        <button class="file" class:on={f.path === selected} onclick={() => (selected = f.path)}>
          <span class="truncate">{f.path}</span>
          <span class="counts">
            <span class="add">+{f.additions}</span>
            <span class="del">-{f.deletions}</span>
          </span>
        </button>
      {/each}
    </nav>

    {#if current}
      <div class="diff" role="region" aria-label={`Diff for ${current.path}`}>
        {#each current.diff.split("\n") as line, i (i)}
          <div
            class="line"
            class:add={line.startsWith("+") && !line.startsWith("+++")}
            class:del={line.startsWith("-") && !line.startsWith("---")}
            class:hunk={line.startsWith("@@")}
            class:meta={line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++")}
          ><span class="txt">{line || " "}</span></div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    padding-top: calc(env(safe-area-inset-top) + 8px);
    border-bottom: 1px solid var(--border);
    min-height: calc(env(safe-area-inset-top) + var(--header-h));
  }
  .back {
    font-size: 1.5rem;
    line-height: 1;
    text-decoration: none;
    padding: 4px 12px;
  }
  .files {
    display: flex;
    gap: 6px;
    padding: 8px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .file {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    white-space: nowrap;
    font-size: 0.8rem;
    padding: 8px 10px;
    min-height: 0;
    max-width: 60vw;
  }
  .file.on {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 15%, var(--bg-raised));
  }
  .counts {
    display: flex;
    gap: 6px;
    font-family: var(--mono);
    font-size: 0.7rem;
  }
  .add {
    color: var(--ok);
  }
  .del {
    color: var(--danger);
  }
  .diff {
    flex: 1;
    overflow: auto;
    overscroll-behavior: contain;
    font-family: var(--mono);
    font-size: 0.75rem;
    /* Wrapping beats horizontal scrolling for narrow screens: a diff line that
       needs 120 columns is unreadable either way, but wrapped code needs no
       horizontal panning mid-review. */
    white-space: pre-wrap;
    word-break: break-word;
  }
  .line {
    padding: 0 10px;
  }
  .line.add {
    background: color-mix(in srgb, var(--ok) 14%, transparent);
  }
  .line.del {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
  }
  .line.hunk {
    color: var(--accent);
  }
  .line.meta {
    color: var(--text-faint);
  }
  .txt {
    display: block;
  }
  .center {
    text-align: center;
    padding: 32px 0;
  }
</style>
