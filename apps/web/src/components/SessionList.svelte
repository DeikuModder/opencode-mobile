<script lang="ts">
  /**
   * Session list: the app's home screen.
   *
   * Sorted newest-first by opencode's own `time.updated`, so a session you just
   * used in the terminal is at the top.
   */
  import { serveApi, type SessionInfo } from "../lib/api.js"
  import { eventStream } from "../lib/events.svelte.js"

  let sessions = $state<SessionInfo[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)
  let search = $state("")
  let newTitle = $state("")
  let creating = $state(false)
  let showNew = $state(false)

  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase()
    const list = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions
    return [...list].sort((a, b) => b.time.updated - a.time.updated)
  })

  async function load() {
    loading = true
    error = null
    try {
      sessions = await serveApi.sessions()
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load sessions"
    } finally {
      loading = false
    }
  }

  async function create() {
    if (creating) return
    creating = true
    try {
      const s = await serveApi.createSession(newTitle.trim() || undefined)
      newTitle = ""
      showNew = false
      sessions = await serveApi.sessions()
      location.hash = `#/session/${s.id}`
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not create session"
    } finally {
      creating = false
    }
  }

  async function remove(id: string, title: string) {
    // Confirm inline rather than with window.confirm: a native dialog blocks the
    // event stream and looks wrong on iOS.
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return
    try {
      await serveApi.deleteSession(id)
      sessions = sessions.filter((s) => s.id !== id)
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not delete session"
    }
  }

  function relTime(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000)
    if (s < 60) return "just now"
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`
    return new Date(ts).toLocaleDateString()
  }

  $effect(() => {
    void load()
    // A session title can change server-side; patching the local list keeps the
    // screen correct without polling.
    return eventStream.subscribe((e) => {
      if (e.type === "session.updated" || e.type === "session.deleted") {
        const info = e.properties as { info?: SessionInfo; id?: string }
        if (e.type === "session.deleted" && info.id) {
          sessions = sessions.filter((s) => s.id !== info.id)
        } else if (info.info) {
          const next = info.info
          sessions = sessions.some((s) => s.id === next.id)
            ? sessions.map((s) => (s.id === next.id ? next : s))
            : [...sessions, next]
        }
      }
    })
  })
</script>

<div class="head">
  <label class="search">
    <span class="faint">search</span>
    <input type="search" bind:value={search} placeholder="filter sessions" />
  </label>
  <button class="primary" onclick={() => (showNew = !showNew)} aria-expanded={showNew}>
    {showNew ? "cancel" : "new"}
  </button>
</div>

{#if showNew}
  <div class="card col">
    <label>
      <span class="faint">title (optional)</span>
      <input bind:value={newTitle} placeholder="what is this about?" maxlength="80" />
    </label>
    <button class="primary" onclick={create} disabled={creating}>
      {#if creating}<span class="spinner"></span>{:else}create session{/if}
    </button>
  </div>
{/if}

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

{#if loading}
  <div class="center"><span class="spinner"></span></div>
{:else if filtered.length === 0}
  <p class="faint center">
    {search ? "no sessions match" : "no sessions yet — create one to get started"}
  </p>
{:else}
  <ul>
    {#each filtered as s (s.id)}
      <li>
        <a class="grow truncate" href={`#/session/${s.id}`}>{s.title || "untitled"}</a>
        <span class="faint">{relTime(s.time.updated)}</span>
        <button
          class="ghost del"
          onclick={() => remove(s.id, s.title)}
          aria-label={`Delete ${s.title || "untitled"}`}
        >
          ✕
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .head {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    padding: 12px 0;
  }
  .search {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    /* Stops the pull-to-refresh gesture hijacking list scrolling. */
    overscroll-behavior: contain;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 8px 12px 14px;
  }
  a {
    text-decoration: none;
    color: var(--text);
    font-weight: 500;
  }
  .del {
    min-height: 36px;
    padding: 6px 10px;
    color: var(--text-faint);
  }
  .center {
    text-align: center;
    padding: 32px 0;
  }
</style>
