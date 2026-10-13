<script lang="ts">
  import { app } from "./lib/state.svelte.js"
  import Login from "./components/Login.svelte"
  import SessionList from "./components/SessionList.svelte"
  import SessionView from "./components/SessionView.svelte"
  import DiffView from "./components/DiffView.svelte"
  import Projects from "./components/Projects.svelte"
  import Files from "./components/Files.svelte"
  import PermissionSheet from "./components/PermissionSheet.svelte"
  import { eventStream } from "./lib/events.svelte.js"

  type Tab = "sessions" | "files" | "projects"

  let tab = $state<Tab>("sessions")
  let path = $state("")
  let params = $state("")

  /** Hash routes keep the SPA working from a single static index.html. */
  function readHash() {
    const raw = location.hash.replace(/^#/, "") || "/"
    const qIndex = raw.indexOf("?")
    if (qIndex >= 0) {
      path = raw.slice(0, qIndex)
      params = raw.slice(qIndex + 1)
    } else {
      path = raw
      params = ""
    }
  }

  readHash()
  window.addEventListener("hashchange", readHash)

  /** #/session/<id> -> <id>, or null for any other route. */
  const sessionId = $derived.by(() => {
    const m = /^\/session\/(.+)$/.exec(path)
    return m?.[1] ? decodeURIComponent(m[1]!) : null
  })
  const isDiff = $derived(path === "/diff")
  const isFiles = $derived(path === "/files")
  /** The diff, chat, and file screens own the full viewport, so no tab bar. */
  const immersive = $derived(sessionId !== null || isDiff || isFiles)

  $effect(() => {
    void app.boot()
  })

  // A 401 anywhere means the session expired underneath us; bounce to login
  // rather than leaving a dead shell on screen.
  $effect(() => {
    if (!app.booted) return
    return eventStream.onStatus((s) => {
      if (s === "closed" && app.isAuthenticated) void app.boot()
    })
  })

  async function signOut() {
    await app.logout()
    tab = "sessions"
    location.hash = "#/"
  }
</script>

{#if !app.booted}
  <div class="splash"><span class="spinner"></span></div>
{:else if app.gatewayDown}
  <div class="splash col">
    <p class="error">cannot reach the gateway</p>
    <button onclick={() => void app.boot()}>retry</button>
  </div>
{:else if app.needsSetup}
  <div class="splash">
    <p>no account is set up yet.</p>
    <p class="faint mono">run: pnpm auth:setup</p>
  </div>
{:else if !app.isAuthenticated}
  <Login />
{:else}
  <main class:immersive>
    {#if sessionId}
      {#key sessionId}
        <SessionView {sessionId} />
      {/key}
    {:else if isDiff}
      {#key params}
        <DiffView />
      {/key}
    {:else if isFiles}
      {#key params}
        <Files />
      {/key}
    {:else}
      {#if tab === "sessions"}
        <SessionList />
      {:else if tab === "files"}
        <Files />
      {:else}
        <Projects />
      {/if}
    {/if}
  </main>

  {#if !immersive}
    <nav>
      <button class:on={tab === "sessions"} onclick={() => (tab = "sessions")}>
        <span aria-hidden="true">▤</span> sessions
      </button>
      <button class:on={tab === "files"} onclick={() => (tab = "files")}>
        <span aria-hidden="true">▦</span> files
      </button>
      <button class:on={tab === "projects"} onclick={() => (tab = "projects")}>
        <span aria-hidden="true">◈</span> projects
      </button>
      <button onclick={signOut}>
        <span aria-hidden="true">⤴</span> sign out
      </button>
    </nav>
  {/if}

  <PermissionSheet />
{/if}

<style>
  .splash {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    text-align: center;
    padding: 20px;
  }
  main {
    /* Reserve room for the fixed tab bar so the last list item is reachable. */
    height: calc(100dvh - var(--tabbar-h) - env(safe-area-inset-bottom));
    overflow: hidden;
  }
  main.immersive {
    height: 100dvh;
  }
  nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    height: calc(var(--tabbar-h) + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--bg-raised);
    border-top: 1px solid var(--border);
  }
  nav button {
    flex: 1;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--text-faint);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    font-size: 0.7rem;
    min-height: 0;
  }
  nav button.on {
    color: var(--accent);
  }
  nav span {
    font-size: 1.1rem;
  }
</style>
