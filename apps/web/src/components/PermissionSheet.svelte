<script lang="ts">
  /**
   * Pending permission requests, delivered as a modal the user cannot scroll
   * past.
   *
   * These matter more than they look: opencode will block a turn indefinitely
   * until a permission is answered, so if the request is missed the session
   * silently stalls. Hence the modal, and hence the choice to always render from
   * the event stream rather than only on screen entry.
   */
  import { serveApi } from "../lib/api.js"
  import { eventStream } from "../lib/events.svelte.js"

  interface Permission {
    id: string
    sessionID: string
    title: string
    type: string
    metadata?: Record<string, unknown>
    time: number
  }

  let queue = $state<Permission[]>([])
  let answering = $state<string | null>(null)
  let error = $state<string | null>(null)

  const current = $derived(queue[0] ?? null)

  function enqueue(p: Permission) {
    // Permission ids can be re-announced; do not stack duplicates.
    if (queue.some((x) => x.id === p.id)) return
    queue = [...queue, p]
  }

  async function respond(response: "once" | "always" | "reject") {
    const p = current
    if (!p || answering) return
    answering = p.id
    error = null
    try {
      await serveApi.replyPermission(p.sessionID, p.id, response)
      queue = queue.filter((x) => x.id !== p.id)
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not answer"
    } finally {
      answering = null
    }
  }

  function detail(p: Permission): string {
    const m = p.metadata
    if (!m) return ""
    const keys = Object.keys(m)
    return keys
      .slice(0, 4)
      .map((k) => `${k}: ${JSON.stringify(m[k])}`)
      .join("\n")
  }

  $effect(
    () =>
      eventStream.subscribe((e) => {
        // Only permission events here. Questions used to be handled by showing
        // "answer it in the chat or terminal", which was true when the app had no
        // way to answer one at all; SessionView now renders them inline above the
        // composer, and a modal for them would duplicate that panel.
        if (e.type !== "permission.asked" && e.type !== "permission.v2.asked") return
        const p = e.properties as unknown as Permission
        if (p?.id) enqueue(p)
        // The event stream is the only reliable source: permissions can be
        // raised while the user is on a different screen.
      }),
  )
</script>

{#if current}
  <div class="scrim" role="dialog" aria-modal="true" aria-label="Permission request">
    <div class="sheet">
      <p class="kicker">permission needed</p>
      <h2 class="truncate">{current.title || current.type}</h2>
      {#if detail(current)}
        <pre class="detail">{detail(current)}</pre>
      {/if}
      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}
      <div class="actions">
        <button class="danger" onclick={() => respond("reject")} disabled={answering !== null}>
          deny
        </button>
        <button onclick={() => respond("always")} disabled={answering !== null}>
          always allow
        </button>
        <button class="primary" onclick={() => respond("once")} disabled={answering !== null}>
          allow once
        </button>
      </div>
      {#if queue.length > 1}
        <p class="faint">+{queue.length - 1} more waiting</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    z-index: 50;
  }
  .sheet {
    width: 100%;
    max-width: 520px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    /* Rounded only at the top: this is a bottom sheet, the iOS pattern for
       something that must be dealt with before continuing. */
    border-radius: 18px 18px 0 0;
    padding: 18px 16px calc(env(safe-area-inset-bottom) + 18px);
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 85dvh;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .kicker {
    margin: 0;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--warn);
  }
  h2 {
    margin: 0;
    font-size: 1.05rem;
  }
  .detail {
    background: var(--bg-sunken);
    border-radius: 8px;
    padding: 10px;
    max-height: 30dvh;
    overflow: auto;
    color: var(--text-dim);
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions button {
    flex: 1;
  }
</style>
