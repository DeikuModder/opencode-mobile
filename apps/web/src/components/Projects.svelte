<script lang="ts">
  /** Project switcher plus gateway/supervisor status. */
  import { app } from "../lib/state.svelte.js"
  import { eventStream } from "../lib/events.svelte.js"

  let switching = $state<string | null>(null)
  let error = $state<string | null>(null)

  const active = $derived(app.health?.activeProject ?? null)
  const status = $derived.by(() => {
    if (app.gatewayDown) return { text: "gateway unreachable", tone: "err" as const }
    const h = app.health
    if (!h) return { text: "checking…", tone: "idle" as const }
    if (!h.supervisor.ok) return { text: `supervisor: ${h.supervisor.error ?? "unreachable"}`, tone: "err" as const }
    if (!h.ok) return { text: "no active project", tone: "warn" as const }
    const running = h.supervisor.running.length
    return { text: running > 0 ? "serve running" : "serve idle", tone: "ok" as const }
  })

  async function pick(id: string) {
    if (id === active?.id || switching) return
    switching = id
    error = null
    try {
      await app.setActiveProject(id)
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not switch project"
    } finally {
      switching = null
    }
  }

  $effect(() =>
    eventStream.subscribe((e) => {
      if (e.type === "server.connected" || e.type === "project.updated") void app.refreshGateway()
    }),
  )
</script>

<div class="wrap">
  <h2>projects</h2>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <ul>
    {#each app.projects as p (p.id)}
      <li class:active={p.id === active?.id}>
        <button class="pick" onclick={() => pick(p.id)} disabled={switching !== null}>
          <span class="grow truncate">{p.name}</span>
          <span class="faint">:{p.port}</span>
        </button>
      </li>
    {:else}
      <li class="none">
        <p class="faint">no projects configured</p>
        <p class="faint mono">pnpm project:add -- &lt;path&gt;</p>
      </li>
    {/each}
  </ul>

  <div class="card col status" class:err={status.tone === "err"}>
    <div class="row spread">
      <span class="grow">{status.text}</span>
      <span class="dot" class:ok={status.tone === "ok"} class:warn={status.tone === "warn"} class:err={status.tone === "err"}></span>
    </div>
    {#if app.health?.supervisor.opencodeBin}
      <p class="faint mono truncate" title={app.health.supervisor.opencodeBin}>
        {app.health.supervisor.opencodeBin}
      </p>
    {/if}
  </div>
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
  }
  h2 {
    margin: 4px 0 0;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  li {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  li.active {
    border-color: var(--accent);
  }
  .pick {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    border-radius: 0;
    text-align: left;
  }
  li.none {
    padding: 16px;
    text-align: center;
  }
  li.none p {
    margin: 0 0 4px;
  }
  .status.err {
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-faint);
    flex: none;
  }
  .dot.ok {
    background: var(--ok);
  }
  .dot.warn {
    background: var(--warn);
  }
  .dot.err {
    background: var(--danger);
  }
  p.faint {
    margin: 0;
  }
</style>
