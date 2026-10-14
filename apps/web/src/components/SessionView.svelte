<script lang="ts">
  /**
   * A single session's chat transcript, kept live by the event stream.
   *
   * The rendering strategy is the interesting part. opencode sends
   * `message.part.delta` for every streaming token. Appending each delta to a
   * Svelte array would mean thousands of array copies for a single reply and a
   * visibly janky transcript, so deltas are written straight into a DOM text
   * node through an action and the reactive state is left alone. Re-renders then
   * happen once per completed message rather than once per token.
   */
  import {
    serveApi,
    type Message,
    type ModelInfo,
    type Part,
type ProjectInfo,
  type QuestionRequest,
    type ServePath,
    type SessionInfo,
    type TodoItem,
  } from "../lib/api.js"
  import { eventStream } from "../lib/events.svelte.js"
  import { renderMarkdown } from "../lib/markdown.js"

  let { sessionId }: { sessionId: string } = $props()

  let messages = $state<Message[]>([])
  let title = $state("")
  let sessionInfo = $state<SessionInfo | null>(null)
  let loading = $state(true)
  let error = $state<string | null>(null)
  let draft = $state("")
  let sending = $state(false)
  let busy = $state(false)
  let transcript = $state<HTMLElement | null>(null)

  /**
   * True where Enter means "newline" rather than "send".
   *
   * `(hover: none)` is the signal that matters rather than `maxTouchPoints`,
   * because a touchscreen laptop has touch points but also a real keyboard and a
   * pointer, and should keep Enter-to-send. Guarded for SSR, where `matchMedia`
   * does not exist.
   */
  const isTouch =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none)").matches

  /* ------------------------------------------------ model, mode and directory */
  let models = $state<ModelInfo[]>([])
  let providerNames = $state(new Map<string, string>())
  let modelKey = $state("")
  let agent = $state("build")
  let cwd = $state<ServePath | null>(null)
  let projects = $state<ProjectInfo[]>([])
  let activeProject = $state<string | null>(null)
  let switching = $state(false)
  let controlsError = $state<string | null>(null)
  let todos = $state<TodoItem[]>([])
  let showTodos = $state(true)

  /**
   * Decisions the agent is blocked on, rendered inline above the composer the
   * way the CLI shows them.
   *
   * opencode holds the turn open until these are answered, so this is not a
   * nicety: if a request is missed the session simply stops, with the progress
   * bar still spinning and nothing on screen explaining why. The list is
   * re-read from the endpoint rather than accumulated from events, because the
   * endpoint is the authority and event payloads have changed shape between
   * versions (`question.asked` versus `question.v2.asked`).
   */
  let questions = $state<QuestionRequest[]>([])
  /** Answer choices per question index within the request being shown. */
  let qSelections = $state<Record<number, string[]>>({})
  let qCustom = $state<Record<number, string>>({})
  let qBusy = $state(false)
  let qError = $state<string | null>(null)
  let controlsLoading = $state(true)

  /* --------------------------------------------------- edit, undo and restore */
  /**
   * The long-press menu, and the message it is aimed at.
   *
   * A revert is destructive: everything after the target is discarded on the next
   * prompt, not merely hidden. So the flow is always confirm-then-act, and the
   * number of messages at risk is shown before anything is thrown away.
   */
  let menuOpen = $state(false)
  /** Set while the user is choosing which of their messages to act on. */
  let picking = $state(false)
  /** The message awaiting confirmation, once a target has been chosen. */
  let pendingTarget = $state<string | null>(null)
  /** Whether the confirmation is about editing or about undoing. */
  let pendingKind = $state<"edit" | "undo">("undo")
  let reverting = $state(false)
  let revertError = $state<string | null>(null)
  /** The message currently loaded into the composer for editing. */
  let editingFrom = $state<string | null>(null)

  /** Long-press bookkeeping, so a held button does not also fire a submit. */
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let longPressed = false

  const userMessages = $derived(messages.filter((m) => m.role === "user" && !m.id.startsWith("pending-")))
  const lastUserMessage = $derived(userMessages[userMessages.length - 1] ?? null)
  const revertAt = $derived(sessionInfo?.revert?.messageID ?? null)

  /**
   * The transcript with the reverted tail removed.
   *
   * opencode does not delete or flag those messages — they keep coming back from
   * `GET /message` with no marker on them — so the hiding has to happen here or a
   * revert looks like it did nothing at all.
   */
  const visibleMessages = $derived.by(() => {
    const at = revertAt
    if (!at) return messages
    const i = messages.findIndex((m) => m.id === at)
    // Exclusive: a revert replaces the target message itself along with everything
    // after it. Verified against the running server — reverting the first of six
    // messages and sending left only the two new ones, so the target does not
    // survive. Including it here would show a message the next prompt discards.
    return i < 0 ? messages : messages.slice(0, i)
  })
  const discardedCount = $derived(messages.length - visibleMessages.length)

  /** Messages that a revert to `id` would throw away, for the confirmation. */
  function wouldDiscard(id: string): number {
    const i = messages.findIndex((m) => m.id === id)
    return i < 0 ? 0 : messages.length - i
  }

  function textOf(m: Message): string {
    return (m.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("")
  }

  function closeMenu() {
    menuOpen = false
    picking = false
    pendingTarget = null
    longPressed = false
  }

  /**
   * Rewind to `messageId` and refetch, so the marker and the visible tail agree.
   *
   * Only the marker changes server-side; the messages are dropped by the next
   * prompt, which is why this leaves the composer untouched.
   */
  async function doRevert(messageId: string): Promise<void> {
    reverting = true
    revertError = null
    try {
      sessionInfo = await serveApi.revert(sessionId, messageId)
      await load()
    } catch (e) {
      revertError = e instanceof Error ? e.message : "Could not undo"
    } finally {
      reverting = false
    }
  }

  async function doUnrevert(): Promise<void> {
    reverting = true
    revertError = null
    try {
      await serveApi.unrevert(sessionId)
      editingFrom = null
      draft = ""
      await load()
    } catch (e) {
      revertError = e instanceof Error ? e.message : "Could not restore"
    } finally {
      reverting = false
    }
  }

  /**
   * Load a message back into the composer.
   *
   * The revert marker is what makes the resend replace the tail, so it has to be
   * set before the prompt goes out — otherwise the edited message is appended and
   * the old exchange is still there.
   */
  function beginEdit(messageId: string): void {
    const target = messages.find((m) => m.id === messageId)
    if (!target) return
    draft = textOf(target)
    editingFrom = messageId
    closeMenu()
    void doRevert(messageId)
    requestAnimationFrame(() => composer?.focus())
  }

  /** Reverting is refused while a turn runs, so surface that rather than failing. */
  function guardIdle(): boolean {
    if (busy) {
      revertError = "Stop the turn before undoing"
      return false
    }
    return true
  }

  function chooseTarget(id: string, kind: "edit" | "undo" = "undo") {
    if (!guardIdle()) return
    pendingKind = kind
    pendingTarget = id
  }

  function confirmTarget() {
    const id = pendingTarget
    if (!id) return
    pendingTarget = null
    if (pendingKind === "edit") beginEdit(id)
    else {
      closeMenu()
      void doRevert(id)
    }
  }

  function onPressStart() {
    longPressed = false
    if (pressTimer) clearTimeout(pressTimer)
    // 500ms is past the threshold where a tap stops registering as a tap, and
    // short enough that it does not feel broken when you are deliberately holding.
    pressTimer = setTimeout(() => {
      longPressed = true
      menuOpen = true
      pressTimer = null
    }, 500)
  }

  function onPressEnd() {
    if (pressTimer) clearTimeout(pressTimer)
    pressTimer = null
  }

  const currentQuestion = $derived(questions[0] ?? null)

  /**
   * Build and Plan, in the CLI's order.
   *
   * Hardcoded because these are the two modes opencode offers a user, and
   * because `/agent` describes agents (build, plan, general, explore, …) rather
   * than modes — inferring the toggle from that list would surface subagents as
   * if they were user-selectable modes.
   */
  const MODES = [
    { id: "build", label: "Build" },
    { id: "plan", label: "Plan" },
  ] as const

  /** A subagent this session spawned, as shown in the transcript. */
  interface Subagent {
    id: string
    title: string
    agent: string
    model: string
    /** True while the child session is mid-turn. */
    busy: boolean
    updated?: number
  }

  let subagents = $state<Subagent[]>([])

  const activeSubagents = $derived(subagents.filter((s) => s.busy))
  const pastSubagents = $derived(
    subagents
      .filter((s) => !s.busy)
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      .slice(0, 6),
  )
  /**
   * messageID -> partID -> the text node currently being appended to.
   *
   * Intentionally NOT $state. This map exists precisely so streaming deltas can
   * bypass Svelte's reactivity and write to DOM text nodes directly; making it
   * reactive would reintroduce the per-token invalidation it avoids. It is
   * swapped wholesale on reload via `liveStore.current`, which is a plain
   * non-reactive box precisely so this does not need to be.
   */
  const liveStore: { current: Map<string, Map<string, Text>> } = {
    current: new Map(),
  }

  /**
   * Parts seen before their parent message.updated, keyed by message id.
   *
   * A part carries no `role`, so its text cannot be attributed to the agent or
   * the user on its own: guessing "assistant" turned the user's own message into
   * a second copy that looked like agent output. Buffering it *hiddenly* until
   * the parent arrives is also wrong, because opencode emits the part and every
   * one of its deltas BEFORE message.updated, so a hidden buffer leaves the
   * transcript blank for the entire turn and the reply appears only at the end.
   *
   * So the parts are rendered as role-neutral "pending" bubbles instead: visible
   * and streaming, but styled as neither agent nor user, and replaced by the
   * properly attributed message as soon as the parent resolves the role.
   */
  const orphans = $state<Array<{ id: string; parts: Part[] }>>([])

  function orphanFor(messageId: string): { id: string; parts: Part[] } | undefined {
    return orphans.find((o) => o.id === messageId)
  }

  function setOrphanParts(messageId: string, parts: Part[]) {
    const at = orphans.findIndex((o) => o.id === messageId)
    if (at >= 0) orphans[at] = { id: messageId, parts }
    else orphans.push({ id: messageId, parts })
  }

  function dropOrphan(messageId: string) {
    const at = orphans.findIndex((o) => o.id === messageId)
    if (at >= 0) orphans.splice(at, 1)
  }

  /**
   * Svelte action that registers a part's text node as the delta sink.
   *
   * Writing deltas into the node directly is what keeps streaming smooth: a
   * token per array mutation would make Svelte re-evaluate the transcript
   * hundreds of times per reply. The node is unregistered on destroy so that
   * navigating away cannot leave a stale handle receiving deltas.
   */
  function liveTextNode(
    node: HTMLElement,
    params: { messageId: string; partId: string; store: Map<string, Map<string, Text>> },
  ) {
    const { store } = params
    // The text is rendered by Svelte inside this span, so its first child is the
    // node already holding the committed text.
    let textNode: Text
    const first = node.firstChild
    if (first instanceof Text) {
      textNode = first
    } else {
      textNode = document.createTextNode(node.textContent ?? "")
      node.textContent = ""
      node.appendChild(textNode)
    }

    /** Track which (message, part) pair this node is currently registered under. */
    let currentKey: { messageId: string; partId: string } = params

    function register(key: { messageId: string; partId: string }) {
      let parts = store.get(key.messageId)
      if (!parts) {
        parts = new Map()
        store.set(key.messageId, parts)
      }
      parts.set(key.partId, textNode)
    }

    function unregister(key: { messageId: string; partId: string }) {
      const parts = store.get(key.messageId)
      if (!parts) return
      // Only remove the entry if it is still ours. When a pending bubble is
      // replaced by the real message, Svelte may mount the replacement before it
      // destroys this node, and an unguarded delete would drop the live handle
      // the new node just registered.
      if (parts.get(key.partId) !== textNode) return
      parts.delete(key.partId)
      if (parts.size === 0) store.delete(key.messageId)
    }

    register(currentKey)

    return {
      update(next: { messageId: string; partId: string }) {
        // Re-key rather than mutating in place, so the old entry cannot be left
        // behind pointing at a node that has moved to a different part.
        unregister(currentKey)
        currentKey = next
        register(currentKey)
      },
      destroy() {
        unregister(currentKey)
      },
    }
  }

  const isEmpty = $derived(messages.length === 0 && orphans.length === 0)
  let composer = $state<HTMLTextAreaElement | null>(null)

  /**
   * Whether assistant prose should be rendered as markdown rather than plain text.
   *
   * Gated on `!busy` because the last text part of a running turn is the live
   * delta sink (`use:liveTextNode`): that node is written token by token by
   * `applyDelta`, and re-rendering it as markup mid-turn would throw the
   * partially-streamed text away on every token. Once the turn reports idle the
   * part is complete and static, so the formatted rendering is safe to swap in.
   */
  const markdownOn = $derived(!busy && !loading)

  /** The sanitized HTML for a text part, or null to render that part as plain text. */
  function markdownFor(m: Message, p: Part): string | null {
    // User text is shown verbatim: it is not model output, and rendering it as
    // markup only adds a way for pasted content to look like something else.
    if (!markdownOn || m.role === "user") return null
    // Synthetic text is our own placeholder rather than model output.
    if ((p as { synthetic?: boolean }).synthetic === true) return null
    const text = partText(p)
    return text ? renderMarkdown(text) : null
  }

  function scrollToBottom(smooth = false) {
    if (!transcript) return
    transcript.scrollTo({ top: transcript.scrollHeight, behavior: smooth ? "smooth" : "auto" })
  }

  /**
   * Appends one streamed token to its text node.
   *
   * The payload field is `delta`, NOT `text`. `text` is the full accumulated
   * string and only arrives on message.part.updated at the end of the part.
   * Reading `text` here made every token fail the string check and silently
   * discard it, so replies only ever appeared after a reload fetched the
   * completed message.
   */
  function applyDelta(m: { messageID?: string; partID?: string; delta?: string; text?: string; field?: string }) {
    const { messageID, partID } = m
    if (!messageID || !partID) return
    // `delta` is the incremental token. Falling back to `text` would duplicate
    // the whole message on any frame that carries both, so delta is required.
    const chunk = m.delta
    if (typeof chunk !== "string" || chunk.length === 0) return
    const node = liveStore.current.get(messageID)?.get(partID)
    if (node) {
      node.appendData(chunk)
      return
    }
    // No sink node yet: deltas can outrun the DOM (the part and its first deltas
    // arrive in one burst, and Svelte has not flushed yet). Appending to the
    // model instead means the tokens are in the text the first render emits,
    // rather than being dropped until the final part update.
    appendToModel(messageID, partID, chunk)
  }

  /**
   * Appends a token to a part's text in the model, in either the pending map or a
   * known message.
   *
   * This is the fallback for deltas that arrive before their text node exists.
   * Returns whether the part was found; an unknown part means the message is from
   * neither this session nor a pending one, so there is nothing to update.
   */
  function appendToModel(messageID: string, partID: string, chunk: string): boolean {
    const held = orphanFor(messageID)
    if (held) {
      const at = held.parts.findIndex((x) => (x as { id?: string }).id === partID)
      if (at >= 0) {
        const p = held.parts[at] as { id?: string; text?: string }
        p.text = (p.text ?? "") + chunk
        // Reassign the array so the keyed each re-renders with the grown text.
        setOrphanParts(messageID, [...held.parts])
        return true
      }
    }
    const mi = messages.findIndex((x) => x.id === messageID)
    if (mi < 0) return false
    const existing = messages[mi]!
    const parts = existing.parts ?? []
    const at = parts.findIndex((x) => (x as { id?: string }).id === partID)
    if (at < 0) return false
    const p = parts[at] as { id?: string; text?: string }
    p.text = (p.text ?? "") + chunk
    messages[mi] = { ...existing, parts: [...parts] }
    messages = [...messages]
    return true
  }
  async function load() {
    loading = true
    error = null
    try {
      const [list, info] = await Promise.all([serveApi.messages(sessionId), serveApi.session(sessionId)])
      messages = list
      title = info.title
      sessionInfo = info
      // The DOM nodes do not exist until after this tick, so the delta map has
      // to be cleared or it would point at nodes from the previous session.
      liveStore.current = new Map()
      // Same reason: buffered parts belong to the session they arrived in.
      orphans.length = 0
      requestAnimationFrame(() => scrollToBottom())
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load messages"
    } finally {
      loading = false
    }
    // Controls load separately: a failure here (no models configured, a project
    // with no supervisor) must not blank the transcript, which is the thing the
    // user actually needs.
    void loadControls()
    // On entry too, not just on events: a request raised while this screen was
    // closed still blocks the turn, and the progress bar would otherwise spin
    // forever with nothing explaining why.
    void loadQuestions()
    void loadSubagents()
  }

  /**
   * Loads the subagents this session has spawned.
   *
   * opencode runs delegated work as child sessions, so their output never appears
   * in this transcript. Without this the parent looks idle while `explore` or
   * `general` is still reading files, which reads as a hang.
   */
  async function loadSubagents() {
    try {
      const kids = await serveApi.children(sessionId)
      const previous = new Map(subagents.map((s) => [s.id, s]))
      subagents = kids.map((k) => ({
        id: k.id,
        title: k.title,
        agent: k.agent || "subagent",
        model: k.model ? `${k.model.providerID}/${k.model.id}` : "",
        // Carry the live flag forward. The endpoint carries no status, and a
        // child mid-turn would otherwise flicker to "finished" on every refresh.
        busy: previous.get(k.id)?.busy ?? false,
        updated: k.time?.updated,
      }))
    } catch {
      // No children is the normal case and must stay silent.
    }
  }

  /**
   * Loads the header controls.
   *
   * Each source is fetched independently and failures are swallowed individually.
   * A missing model list or an unreachable project registry degrades one control
   * rather than blocking the whole header, and none of it can fail the transcript
   * load above.
   */
  async function loadControls() {
    controlsError = null
    controlsLoading = true
    try {
      const [modelResult, pathResult, projectResult, todoResult, sessionResult] =
        await Promise.allSettled([
          serveApi.catalog(),
          serveApi.path(),
          serveApi.projects(),
          serveApi.todos(sessionId),
          serveApi.session(sessionId),
        ])

    if (modelResult.status === "fulfilled") {
      providerNames = new Map(modelResult.value.providers.map((p) => [p.id, p.name]))
      models = modelResult.value.providers.flatMap((p) => p.models).filter((m) => m.enabled !== false)
    }

    // The session record is the authority on the current mode and model.
    //
    // This was previously inferred from the last assistant message, on the
    // assumption that no endpoint carried them. That assumption was wrong:
    // GET /session/:id returns both `agent` and `model`, verified live. Reading
    // history instead of configuration is what made Plan appear not to stick:
    // the reply was recorded against the agent that ran it, so after the next
    // turn the toggle reverted to whatever the previous turn had used.
    if (sessionResult.status === "fulfilled") {
      const s = sessionResult.value
      if (s.agent) agent = s.agent
      if (s.model?.id && s.model?.providerID) modelKey = `${s.model.providerID}/${s.model.id}`
    }
    if (pathResult.status === "fulfilled") cwd = pathResult.value
    if (projectResult.status === "fulfilled") {
      projects = projectResult.value.projects
      activeProject = projectResult.value.active
    }
    if (todoResult.status === "fulfilled") todos = todoResult.value

    // Prefer the live session record above all else; only fall back to history
    // if it's missing.
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
    if (lastAssistant) {
      if (!modelKey && lastAssistant.modelID && lastAssistant.providerID) {
        modelKey = `${lastAssistant.providerID}/${lastAssistant.modelID}`
      }
      if (!agent && lastAssistant.agent) agent = lastAssistant.agent
    }
  } catch (e) {
    // ignore individual failures
  } finally {
    controlsLoading = false
  }
  }

  /** Formats "provider/id" for the <select> value of a model. */
  function keyOf(m: ModelInfo): string {
    return `${m.providerID}/${m.id}`
  }

  function modelLabel(m: ModelInfo): string {
    return m.name || m.id
  }

  /**
   * The picker's option groups, one per provider.
   *
   * A model is only uniquely identified by provider AND id — several providers
   * carry models with the same id — so the key stays "provider/id" and the
   * groups let the user see which catalogue each entry comes from ("Personal /
   * OpenCode", "OpenCode Go", ...). Providers the instance has no models for
   * are simply absent.
   */
  const modelGroups = $derived.by(() => {
    const groups = new Map<string, ModelInfo[]>()
    for (const m of models) {
      const list = groups.get(m.providerID)
      if (list) list.push(m)
      else groups.set(m.providerID, [m])
    }
    return [...groups.entries()].map(([id, list]) => ({
      id,
      label: providerNames.get(id) ?? id,
      models: [...list].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    }))
  })

  async function chooseModel(key: string) {
    const m = models.find((x) => keyOf(x) === key)
    if (!m) return
    const previous = modelKey
    // Optimistic: the select cannot be "chosen" without a value, and the reply
    // confirms it either way by coming back on message.updated.
    modelKey = key
    controlsError = null
    try {
      await serveApi.setModel(sessionId, { providerID: m.providerID, id: m.id })
    } catch (e) {
      modelKey = previous
      controlsError = e instanceof Error ? e.message : "Could not change model"
    }
  }

  async function chooseMode(id: string) {
    const previous = agent
    agent = id
    controlsError = null
    try {
      await serveApi.setAgent(sessionId, id)
    } catch (e) {
      agent = previous
      controlsError = e instanceof Error ? e.message : "Could not change mode"
    }
  }

  /**
   * Points the gateway at another allowlisted project.
   *
   * This is a whole-instance switch, not a per-session setting: the transcript,
   * the model list and the cwd all belong to the other opencode process. So the
   * session being viewed no longer exists afterwards, and the view returns to the
   * session list rather than trying to patch state that is now from another
   * instance entirely.
   */
  async function chooseProject(id: string) {
    if (id === activeProject || switching) return
    switching = true
    controlsError = null
    try {
      const res = await serveApi.switchProject(id)
      if (!res.serve?.ok) {
        controlsError = res.serve?.detail ?? "Project selected but could not be started"
      }
      location.hash = "#/"
    } catch (e) {
      controlsError = e instanceof Error ? e.message : "Could not switch project"
    } finally {
      switching = false
    }
  }

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    sending = true
    error = null
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text }],
    }
    messages = [...messages, optimistic]
    draft = ""
    // The prompt has gone out, so the marker has served its purpose: the server
    // drops the tail as it processes this, and a stale `editingFrom` would keep
    // the composer labelled as an edit of a message that no longer exists.
    editingFrom = null
    requestAnimationFrame(() => scrollToBottom(true))
    try {
      // `agent` must be sent on every prompt. opencode treats it as a per-request
      // field with a hard default of `build` and does NOT fall back to the value
      // persisted by POST /session/:id/agent, so omitting it silently runs the
      // turn as `build` while the session still reports `plan` and the toggle
      // still renders as switched. Verified live: same session, same setAgent,
      // no `agent` -> mode=build; `agent: "plan"` -> mode=plan.
      //
      // prompt_async returns as soon as the prompt is accepted, so the UI does
      // not block for the length of a whole agent turn. The reply arrives over
      // the event stream.
      await fetch(`/api/serve/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, parts: [{ type: "text", text }] }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(await r.text())
      })
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not send"
      messages = messages.filter((m) => m.id !== optimistic.id)
    } finally {
      sending = false
    }
  }

  async function abort() {
    try {
      await serveApi.abort(sessionId)
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not abort"
    }
  }

  /** True for the part types that carry streamable text tokens. */
  function isTextLike(p: Part): boolean {
    return p.type === "text" || p.type === "reasoning" || p.type === "thought" || p.type === "thinking"
  }

  function partText(p: Part): string {
    if (isTextLike(p)) return (p as { text?: string }).text ?? ""
    return ""
  }

  /**
   * The trailing "Build · model · 1.2s" line under a finished turn.
   *
   * Mode and model are read from the message that produced the turn rather than
   * from the current session settings, because a session's settings can change
   * afterwards and labelling an old reply with the new model is worse than
   * omitting it. Duration comes from the message's own created/completed pair for
   * the same reason.
   */
  function turnFooter(m: Message): string | null {
    if (m.role !== "assistant") return null
    const mode = m.agent || m.mode
    const model = m.modelID ?? null
    const parts: string[] = []
    if (mode) parts.push(mode === "plan" ? "Plan" : mode === "build" ? "Build" : mode)
    if (model) parts.push(model)
    const created = m.time?.created
    const completed = m.time?.completed
    if (typeof created === "number" && typeof completed === "number" && completed >= created) {
      parts.push(formatDuration(completed - created))
    }
    return parts.length ? parts.join(" · ") : null
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    const s = ms / 1000
    if (s < 60) return `${s.toFixed(1)}s`
    const m = Math.floor(s / 60)
    return `${m}m ${Math.round(s - m * 60)}s`
  }

  /** Basename of the working directory, for a header short enough for a phone. */
  const cwdName = $derived.by(() => {
    const dir = cwd?.directory
    if (!dir) return ""
    const parts = dir.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] || dir
  })

  function doneCount(list: TodoItem[]): number {
    return list.filter((t) => t.status === "completed").length
  }

  /* ------------------------------------------------------- question handling */

  async function loadQuestions() {
    try {
      questions = await serveApi.questions(sessionId)
      // A fresh request must not inherit the previous one's answers, or a
      // question that opens with a different set of options could be submitted
      // with a label that is no longer on offer.
      qSelections = {}
      qCustom = {}
      qError = null
    } catch (e) {
      // A session with no pending questions answers with `{ data: [] }`, so an
      // error here is worth surfacing rather than silently showing nothing.
      qError = e instanceof Error ? e.message : "Could not load questions"
    }
  }

  function toggleOption(qIndex: number, label: string, multiple: boolean) {
    const current = qSelections[qIndex] ?? []
    if (!multiple) {
      qSelections[qIndex] = [label]
      return
    }
    qSelections[qIndex] = current.includes(label)
      ? current.filter((l) => l !== label)
      : [...current, label]
  }

  /**
   * The answer for one question index: the chosen labels, plus any typed answer.
   *
   * A custom answer is sent as another entry in the same array, because the
   * wire format has no separate slot for free text.
   */
  function answerFor(index: number): string[] {
    const chosen = qSelections[index] ?? []
    const typed = (qCustom[index] ?? "").trim()
    return typed ? [...chosen, typed] : [...chosen]
  }

  /**
   * Whether every question has an answer.
   *
   * The reply is positional, so a missing entry would silently shift every
   * later answer onto the wrong question. Blocking here is safer than letting
   * the agent act on answers meant for different prompts.
   */
  const questionReady = $derived.by(() => {
    const req = currentQuestion
    if (!req) return false
    return req.questions.every((_, i) => answerFor(i).length > 0)
  })

  async function answerQuestion() {
    const req = currentQuestion
    if (!req || qBusy || !questionReady) return
    qBusy = true
    qError = null
    const answers = req.questions.map((_, i) => answerFor(i))
    try {
      await serveApi.replyQuestion(req.id, answers)
      // Drop it locally rather than waiting for the event: the reply returns 204
      // with no body, so there is nothing to read the resolved state back from.
      questions = questions.filter((x) => x.id !== req.id)
      qSelections = {}
      qCustom = {}
    } catch (e) {
      qError = e instanceof Error ? e.message : "Could not send answer"
    } finally {
      qBusy = false
    }
  }

  async function rejectQuestion() {
    const req = currentQuestion
    if (!req || qBusy) return
    qBusy = true
    qError = null
    try {
      await serveApi.rejectQuestion(req.id)
      questions = questions.filter((x) => x.id !== req.id)
      qSelections = {}
      qCustom = {}
    } catch (e) {
      qError = e instanceof Error ? e.message : "Could not decline"
    } finally {
      qBusy = false
    }
  }

  function partKey(m: Message, i: number, p: Part, j: number): string {
    return `${m.id}:${i}:${(p as { id?: string }).id ?? j}`
  }

  /**
   * Whether this is the last reasoning part of its message.
   *
   * Only the current thought is expanded: earlier ones stay collapsed so a long
   * chain of them does not bury the actual reply, and the one still being
   * streamed is open so the user can watch it.
   */
  function isLastOfKind(m: Message, kind: string): boolean {
    const parts = m.parts ?? []
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!
      if (p.type === kind) return i === parts.length - 1 || !isTextLike(p)
      if (isTextLike(p)) return false
    }
    return false
  }

  function handleEvent(e: { type: string; properties: Record<string, unknown> }) {
    switch (e.type) {
      case "message.part.delta": {
        const p = e.properties as { messageID?: string; partID?: string; text?: string; field?: string }
        if (p.field && p.field !== "text") return
        applyDelta(p)
        break
      }
      case "message.updated": {
        // sessionID is read from properties first and only then from info: not
        // every frame puts it in both places, and dropping the event because
        // info.sessionID happened to be absent is what silently killed replies.
        const info = e.properties as { info?: Message; sessionID?: string }
        const m = info.info
        if (!m) return
        const sid = info.sessionID ?? m.sessionID
        if (sid !== sessionId) return
        if (m.agent) agent = m.agent
        if (m.modelID && m.providerID) modelKey = `${m.providerID}/${m.modelID}`
        // The parent is what attributes the parts that streamed in ahead of it, so
        // this frame resolves them. This has to happen before the summary and role
        // checks below: both return early, and leaving the entry in place would
        // strand its pending bubble on screen forever, showing text that belongs
        // to no rendered message.
        const held = orphanFor(m.id)
        if (held) dropOrphan(m.id)
        // A user message is already on screen from send()'s optimistic insert, or
        // from load(). Re-adding it here would duplicate it, and routing it
        // through the part-merge path would render it as if the agent had written
        // it. Its pending bubble has to go too, or the user's own text lingers.
        if (m.role === "user") return
        // NOTE: there is deliberately no `if (m.summary) return` here.
        //
        // info.summary is turn metadata (an object such as { diffs: [] }), not a
        // flag meaning "this message should be hidden", and it is present on
        // ordinary completed assistant messages. Treating it as a reason to skip
        // the frame discarded the message at the exact moment the turn finished:
        // the pending bubble was dropped, the message was never added, so the
        // reply the user had just watched stream token by token disappeared and
        // only reappeared after a reload.
        // Merge the parts that streamed in before this frame, now that the role
        // is known and they can be rendered as a real message.
        const at = messages.findIndex((x) => x.id === m.id)
        const prev = at >= 0 ? messages[at] : undefined
        const rendered = prev?.parts ?? []
        // Copy: `rendered` may be the live array of the message being replaced.
        const parts = [...(held ? held.parts : rendered)]
        for (const part of m.parts ?? []) {
          const i = parts.findIndex((x) => (x as { id?: string }).id === (part as { id?: string }).id)
          if (i >= 0) parts[i] = part
          else parts.push(part)
        }
        // Carry the known parts onto the incoming info. `message.updated` carries
        // `info` only and never `parts`, so without this a repeat frame — which
        // opencode sends when the turn completes, to add time.completed — replaced
        // the rendered message with a part-less one and the reply the user had just
        // watched stream vanished at the last moment.
        m.parts = parts
        if (at >= 0) messages[at] = m
        else messages = [...messages, m]
        busy = true
        requestAnimationFrame(() => scrollToBottom())
        break
      }
      case "message.part.updated": {
        // This is what makes a streamed part render at all. The first frame for a
        // text part arrives with text:"" BEFORE any delta, and it is the only
        // event that puts the part on screen so a delta sink node exists.
        // Discarding it (as this handler used to) meant every delta then targeted
        // a partID that was not in liveStore and was dropped.
        const p = e.properties as { part?: Part & { messageID?: string; sessionID?: string } }
        const part = p.part
        if (!part || !part.id) return
        const messageId = (part as { messageID?: string }).messageID
        if (!messageId) return
        if ((part as { sessionID?: string }).sessionID !== sessionId) return
        const idx = messages.findIndex((x) => x.id === messageId)
        if (idx < 0) {
          // Parts can precede their parent message.updated. A part carries no
          // role, so synthesizing a parent here would have to guess one, and
          // guessing "assistant" rendered the user's own message as agent text.
          // Hold it as a role-neutral pending bubble instead: visible and
          // streaming, but not attributed, until the parent resolves the role.
          const existing = orphanFor(messageId)
          const held = existing ? [...existing.parts] : []
          const at = held.findIndex((x) => (x as { id?: string }).id === part.id)
          if (at >= 0) held[at] = part
          else held.push(part)
          setOrphanParts(messageId, held)
          return
        }
        const existing = messages[idx]!
        const parts = existing.parts ?? []
        const at = parts.findIndex((x) => (x as { id?: string }).id === part.id)
        if (at >= 0) parts[at] = part
        else parts.push(part)
        // Reassign so Svelte sees a new array and re-runs the keyed each.
        messages[idx] = { ...existing, parts: [...parts] }
        messages = [...messages]
        break
      }
      case "message.part.updated": {
        // The agent changes the plan by running todowrite, which arrives as an
        // ordinary tool part. Re-read the list when that happens so the checklist
        // tracks the turn, and use the endpoint rather than the tool's own input:
        // it is the authority on the current list.
        const part = (e.properties as { part?: Part & { tool?: string } }).part
        const isTodoWrite =
          part?.type === "tool" && /^todo_?write$/i.test((part as { tool?: string }).tool ?? "")
        if (isTodoWrite && (part as { sessionID?: string }).sessionID === sessionId) {
          void serveApi
            .todos(sessionId)
            .then((t) => {
              todos = t
            })
            .catch(() => undefined)
        }
        break
      }
      case "message.removed":
      case "session.deleted": {
        const id = e.properties.id as string | undefined
        if (id) messages = messages.filter((m) => m.id !== id)
        break
      }
      case "session.updated": {
        const info = e.properties as {
          info?: Partial<SessionInfo> & { id: string; title: string; parentID?: string }
        }
        // A newly spawned subagent announces itself this way. Adding it here is
        // what makes it visible from the moment it starts, rather than only after
        // the next refresh.
        if (info.info?.parentID === sessionId && info.info.id !== sessionId) {
          if (!subagents.some((s) => s.id === info.info!.id)) {
            subagents = [
              ...subagents,
              {
                id: info.info.id,
                title: info.info.title,
                agent: info.info.agent || "subagent",
                model: info.info.model
                  ? `${info.info.model.providerID}/${info.info.model.id}`
                  : "",
                busy: true,
              },
            ]
          }
        }
        if (info.info?.id === sessionId) {
          title = info.info.title
          // Keep any existing fields we don't receive.
          sessionInfo = { ...(sessionInfo ?? ({ id: sessionId, title: info.info.title } as SessionInfo)), ...info.info } as SessionInfo
          if (info.info.agent) agent = info.info.agent
          else if (sessionInfo.agent) agent = sessionInfo.agent
          if (info.info.model?.id && info.info.model?.providerID) {
            modelKey = `${info.info.model.providerID}/${info.info.model.id}`
          } else if (sessionInfo.model?.id && sessionInfo.model?.providerID) {
            modelKey = `${sessionInfo.model.providerID}/${sessionInfo.model.id}`
          }
        }
        break
      }
      case "question.v2.asked":
      case "question.asked":
      case "question.v2.replied":
      case "question.replied":
      case "question.v2.rejected":
      case "question.rejected": {
        // Both the v1 and v2 event names are handled, and the payload is
        // ignored: the two have different shapes, so reading either one risks
        // building state from a field that moved. Re-reading the endpoint costs
        // one request and cannot drift from what the server considers pending.
        const sid = (e.properties as { sessionID?: string }).sessionID
        if (sid === sessionId) void loadQuestions()
        break
      }
      case "session.status": {
        // The authoritative busy flag. It was previously ignored, so `busy` was
        // only ever set by message.updated and cleared by session.idle: the
        // progress bar and the stop button therefore depended on an assistant
        // message arriving, and a turn that failed or produced no message never
        // showed any activity at all. opencode sends this at both ends of a turn.
        const sid = (e.properties as { sessionID?: string }).sessionID
        if (sid === sessionId) {
          const status = (e.properties as { status?: { type?: string } }).status?.type
          if (status === "busy") busy = true
          else if (status === "idle") busy = false
        } else {
          // The same events arrive for child sessions. A delegated subagent keeps
          // the parent looking idle, because the parent's own status goes idle
          // while the child is still working.
          const child = subagents.find((s) => s.id === sid)
          if (child) {
            const status = (e.properties as { status?: { type?: string } }).status?.type
            if (status === "busy") child.busy = true
            else if (status === "idle") {
              child.busy = false
              // The title is only filled in as the child works, so re-read it
              // once the child finishes or the entry shows a placeholder.
              void loadSubagents()
            }
          }
        }
        break
      }
      case "session.idle":
      case "session.error": {
        if (e.properties.sessionID === sessionId) {
          busy = false
          if (e.type === "session.error") {
            error = (e.properties as { error?: { data?: { message?: string } } }).error?.data?.message ?? "Session error"
          }
          // The turn is over, so this is the moment the final list and the turn's
          // own model/agent are final. A mid-turn read can otherwise show a
          // checklist and a mode that the completed turn never used.
          void loadControls()
        }
        break
      }
    }
  }

  $effect(() => {
    // Reads sessionId, so the effect re-runs on navigation and the transcript is
    // refetched for the new session.
    void sessionId
    loading = true
    void load()
  })

  $effect(() => {
    // Subscribed once per mount, not once per session, and that is the point.
    // Returning the detach from the `sessionId` effect above tore the shared socket
    // down and rebuilt it on every navigation, so switching sessions paid a fresh
    // TLS handshake through the tunnel and could miss events that arrived before
    // the new EventSource finished opening. `handleEvent` reads `sessionId` when it
    // runs, so one subscription tracks whichever session is on screen.
    const offEvents = eventStream.subscribe(handleEvent)
    // A reconnect restores the stream but not the events missed while it was down,
    // and opencode replays nothing. Refetching is the only way back to a truthful
    // transcript: without it a dropped stream leaves the page showing stale state
    // that looks exactly like a hung agent.
    const offReconnect = eventStream.onReconnect(() => void load())
    return () => {
      offEvents()
      offReconnect()
    }
  })
</script>

<section class="wrap">
  <div class="bar">
    <a class="ghost back" href="#/" aria-label="Back to sessions">‹</a>
    <span class="truncate">{title || "session"}</span>
    <span class="conn" title="live connection" class:on={busy}></span>
  </div>

  <!--
    Mode, model and directory.

    Model and mode are per-session settings opencode applies to the next turn, so
    they sit above the transcript next to the other turn controls. The directory
    is not: it is the gateway's active project, shared by every session, which is
    why selecting one navigates away instead of editing in place.
  -->
  <div class="controls">
    <div class="modes" role="group" aria-label="Mode">
      {#each MODES as mode (mode.id)}
        <button
          class="mode"
          class:on={agent === mode.id}
          class:loading={controlsLoading}
          disabled={busy || switching || controlsLoading}
          aria-pressed={agent === mode.id}
          onclick={() => void chooseMode(mode.id)}
        >
          {mode.label}
        </button>
      {/each}
    </div>

    <label class="pick">
      <span class="sr">Model</span>
      <select
        value={modelKey}
        class:loading={controlsLoading}
        disabled={!models.length || switching || controlsLoading}
        onchange={(e) => void chooseModel(e.currentTarget.value)}
      >
        {#if !models.length}
          <option value="">no models</option>
        {:else if !modelKey}
          <option value="">select model</option>
        {/if}
        {#if controlsLoading && !models.length}
          <option value="">loading…</option>
        {/if}
        {#each modelGroups as g (g.id)}
          <optgroup label={g.label}>
            {#each g.models as m (keyOf(m))}
              <option value={keyOf(m)}>{modelLabel(m)}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </label>

    {#if projects.length > 1}
      <label class="pick">
        <span class="sr">Directory</span>
        <select
          value={activeProject ?? ""}
          disabled={switching}
          onchange={(e) => void chooseProject(e.currentTarget.value)}
        >
          {#each projects as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </label>
    {:else if cwdName}
      <span class="cwd faint" title={cwd?.directory}>{cwdName}</span>
    {/if}
  </div>

  {#if controlsError}
    <p class="error small" role="alert">{controlsError}</p>
  {/if}

  <!--
    Indeterminate progress. opencode publishes no percentage, so a determinate
    bar would be a fabricated number; this only communicates "a turn is running".
  -->
  <div class="progress" class:on={busy} aria-hidden={!busy}>
    <div class="progress-fill"></div>
  </div>

  {#if todos.length}
    <section class="todos" aria-label="Plan">
      <button class="todos-head" onclick={() => (showTodos = !showTodos)} aria-expanded={showTodos}>
        <span class="truncate">plan · {doneCount(todos)}/{todos.length}</span>
        <span class="faint">{showTodos ? "▾" : "▸"}</span>
      </button>
      {#if showTodos}
        <ul>
          {#each todos as t, i (i)}
            <li class:done={t.status === "completed"} class:active={t.status === "in_progress"}>
              <span class="mark" aria-hidden="true">
                {t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"}
              </span>
              <span class="truncate">{t.content}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <div class="transcript" bind:this={transcript}>
    {#if loading}
      <div class="center"><span class="spinner"></span></div>
    {:else if isEmpty}
      <p class="faint center">no messages yet</p>
    {/if}

    {#each visibleMessages as m, i (m.id)}
      <article class="msg" class:user={m.role === "user"} class:picking={picking && m.role === "user"}>
        <!--
          Rendered only while the menu is asking for a target, so the transcript
          carries no listeners the rest of the time and the choice is a real button
          rather than a click handler on a non-interactive element.
        -->
        {#if picking && m.role === "user"}
          <button class="pick" type="button" disabled={busy} onclick={() => chooseTarget(m.id, "undo")}>
            undo from here
          </button>
        {/if}
        {#each m.parts ?? [] as p, j (partKey(m, i, p, j))}
          {#if p.type === "text"}
            {@const html = markdownFor(m, p)}
            {#if html}
              <!--
                Rendered with {@html}, so the string comes from renderMarkdown and
                has been DOMPurify-sanitized. Never interpolate raw model text here;
                see src/lib/markdown.ts for why that is a security requirement.
              -->
              <div class="text md">{@html html}</div>
            {:else}
              <p class="text" class:synthetic={(p as { synthetic?: boolean }).synthetic === true}>
                {#if (p as { synthetic?: boolean }).synthetic}
                  {partText(p)}
                {:else}
                  <!--
                    The default text node is reused as the delta sink when this part
                    is being streamed. See liveTextNode/applyDelta.
                  -->
                  <span
                    class="text-span"
                    use:liveTextNode={{
                      messageId: m.id,
                      partId: (p as { id?: string }).id ?? String(j),
                      store: liveStore.current,
                    }}
                  >{partText(p)}</span>
                {/if}
              </p>
            {/if}
          {:else if p.type === "tool"}
            {@const t = (p as { state: { status: string; title?: string; output?: string; error?: string } }).state}
            <details class="tool" open={t.status === "running" || !!t.error}>
              <summary>
                <span class="badge" class:err={t.status === "error"}>{t.status}</span>
                <span class="truncate">{t.title || (p as { tool: string }).tool}</span>
              </summary>
              {#if t.error}
                <pre class="err">{t.error}</pre>
              {:else if t.output}
                <pre>{t.output}</pre>
              {:else}
                <pre class="faint">running…</pre>
              {/if}
            </details>
          {:else if p.type === "reasoning" || p.type === "thought" || p.type === "thinking"}
            <!--
              Reasoning streams through the same delta path as text, so this needs
              a live sink too. Without one, deltas target a partID that is not in
              liveStore and are dropped, and the thinking block would stay empty
              for the whole turn and only fill in at the end.
            -->
            <details class="reasoning" open={isLastOfKind(m, "reasoning")}>
              <summary class="faint">thinking</summary>
              <p class="text faint">
                <span
                  use:liveTextNode={{
                    messageId: m.id,
                    partId: (p as { id?: string }).id ?? String(j),
                    store: liveStore.current,
                  }}
                >{partText(p)}</span>
              </p>
            </details>
          {:else if p.type === "file"}
            <a
            class="file"
            href={`#/files?path=${encodeURIComponent((p as { filename: string }).filename)}`}
          >
            {(p as { filename: string }).filename}
          </a>
          {/if}
        {/each}
        {#if turnFooter(m)}
          <p class="footer faint">{turnFooter(m)}</p>
        {/if}
      </article>
    {/each}

    <!--
      Parts whose parent message.updated has not arrived yet. opencode sends the
      part and its deltas first, so this is the state the transcript is actually
      in for most of a turn. Deliberately carries no `user` class: the role is
      unknown, and styling it as agent output is what made the user's own
      message appear to be duplicated.
    -->
    {#each orphans as orphan (orphan.id)}
      <article class="msg pending">
        {#each orphan.parts as p, j (partKey({ id: orphan.id } as Message, 0, p, j))}
          {#if p.type === "text"}
            <p class="text">
              <span
                class="text-span"
                use:liveTextNode={{
                  messageId: orphan.id,
                  partId: (p as { id?: string }).id ?? String(j),
                  store: liveStore.current,
                }}
              >{partText(p)}</span>
            </p>
          {:else if p.type === "reasoning" || p.type === "thought" || p.type === "thinking"}
            <!--
              Reasoning is streamed exactly like text, so the pending bubble needs
              the same sink. Matching only `text` here dropped every thinking
              token: the part landed in `orphans`, its deltas found no registered
              node, and the block stayed empty until the turn ended.
            -->
            <details class="reasoning" open>
              <summary class="faint">thinking</summary>
              <p class="text faint">
                <span
                  class="text-span"
                  use:liveTextNode={{
                    messageId: orphan.id,
                    partId: (p as { id?: string }).id ?? String(j),
                    store: liveStore.current,
                  }}
                >{partText(p)}</span>
              </p>
            </details>
          {/if}
        {/each}
      </article>
    {/each}

    <!--
      The reverted tail.

      opencode keeps those messages: they still come back from GET /message and
      carry no marker, so without this the transcript would show them as though
      nothing had been undone.
    -->
    {#if discardedCount > 0}
      <div class="reverted">
        <span>{discardedCount} later message{discardedCount === 1 ? "" : "s"} undone</span>
        <button class="ghost small" onclick={() => void doUnrevert()} disabled={reverting}>
          restore
        </button>
      </div>
    {/if}
  </div>

  <!--
    Subagents.

    A delegated subagent runs as its own child session, so nothing it does appears
    in this transcript and the parent's own status reports idle while it works.
    Without this the session looks finished when it is still busy. Working agents
    come first and are marked; finished ones stay below as a record.
  -->
  {#if subagents.length}
    <section class="subs" aria-label="Subagents">
      {#each activeSubagents as s (s.id)}
        <div class="sub on" aria-live="polite">
          <span class="spin" aria-hidden="true"></span>
          <strong>{s.agent}</strong>
          <span class="sub-t">{s.title}</span>
          {#if s.model}<span class="sub-m">{s.model}</span>{/if}
        </div>
      {/each}
      {#each pastSubagents as s (s.id)}
        <div class="sub">
          <span class="tick" aria-hidden="true">✓</span>
          <strong>{s.agent}</strong>
          <span class="sub-t">{s.title}</span>
        </div>
      {/each}
    </section>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <!--
    The blocking question, shown inline above the composer as the CLI does.

    Inline rather than a modal because it is a normal part of the conversation:
    the user can still read the transcript and type while it is open. The agent,
    however, is stopped until it is answered, which is why it sits directly
    against the input rather than at the top of the screen.
  -->
  {#if currentQuestion}
    {@const req = currentQuestion}
    <section class="ask" aria-label="Question from the agent">
      {#if questions.length > 1}
        <p class="ask-queue faint">{questions.length - 1} more waiting</p>
      {/if}

      {#each req.questions as q, qi (qi)}
        <div class="q">
          {#if q.header}
            <p class="q-head truncate">{q.header}</p>
          {/if}
          <p class="q-text">{q.question}</p>
          <div class="q-options" role={q.multiple ? "group" : "radiogroup"}>
            {#each q.options as opt (opt.label)}
              <button
                class="opt"
                class:on={(qSelections[qi] ?? []).includes(opt.label)}
                disabled={qBusy}
                aria-pressed={(qSelections[qi] ?? []).includes(opt.label)}
                onclick={() => toggleOption(qi, opt.label, q.multiple === true)}
              >
                <span class="tick" aria-hidden="true">
                  {(qSelections[qi] ?? []).includes(opt.label) ? "✓" : ""}
                </span>
                <span class="opt-body">
                  <span class="opt-label">{opt.label}</span>
                  {#if opt.description}
                    <span class="opt-desc faint">{opt.description}</span>
                  {/if}
                </span>
              </button>
            {/each}
          </div>

          {#if q.custom}
            <input
              class="q-custom"
              type="text"
              placeholder="or type your own answer"
              value={qCustom[qi] ?? ""}
              disabled={qBusy}
              oninput={(e) => {
                qCustom[qi] = e.currentTarget.value
              }}
            />
          {/if}
        </div>
      {/each}

      {#if qError}
        <p class="error small" role="alert">{qError}</p>
      {/if}

      <div class="ask-actions">
        <button class="ghost" onclick={() => void rejectQuestion()} disabled={qBusy}>skip</button>
        <button
          class="primary"
          onclick={() => void answerQuestion()}
          disabled={qBusy || !questionReady}
          title={questionReady ? "" : "Answer every question first"}
        >
          {qBusy ? "sending…" : "send answer"}
        </button>
      </div>
    </section>
  {/if}

  {#if eventStream.status !== "open"}
    <p class="stream-warn" role="status">
      {eventStream.status === "connecting" ? "reconnecting to the agent…" : "event stream dropped, retrying"}
    </p>
  {/if}

  <!--
    Edit mode.

    The composer now holds a message that already exists further up, and sending
    it rewrites the transcript from that point. Nothing about the composer looks
    different otherwise, so the state is stated here rather than left to be
    inferred from a missing message.
  -->
  {#if editingFrom}
    <p class="editing" role="status">
      editing a message — sending replaces {wouldDiscard(editingFrom)}
      message{wouldDiscard(editingFrom) === 1 ? "" : "s"}
      <button
        class="ghost small"
        onclick={() => {
          editingFrom = null
          draft = ""
          void doUnrevert()
        }}>cancel</button
      >
    </p>
  {/if}

  <form
    class="composer"
    onsubmit={(e) => {
      e.preventDefault()
      // A long press on send opens the menu; the release that follows it would
      // otherwise submit the message the user never meant to send.
      if (longPressed) {
        longPressed = false
        return
      }
      void send()
    }}
  >
    <textarea
      bind:this={composer}
      bind:value={draft}
      placeholder="send a message"
      rows="1"
      oninput={(e) => {
        // Grow with content, capped, so the composer does not eat the
        // transcript on a phone keyboard.
        const el = e.currentTarget
        el.style.height = "auto"
        el.style.height = `${Math.min(el.scrollHeight, 140)}px`
      }}
      enterkeyhint="enter"
      onkeydown={(e) => {
        // Enter sends on a physical keyboard; Shift+Enter inserts a newline.
        // On touch the keyboard's return key always inserts a newline, and the
        // send button is the only way to submit.
        //
        // This has to be decided on the pointer, not on the key alone. A phone
        // keyboard reports the same `Enter` keycode as a USB keyboard, so matching
        // on the key sent on every tap instead of inserting the line break the
        // user asked for, and there was no way to write a multi-line prompt on a
        // phone at all.
        //
        // `isComposing` is checked as well: it covers IME and autocorrect, where
        // Enter confirms the candidate text and must not submit the message.
        if (e.key !== "Enter" || e.shiftKey || isTouch || e.isComposing) return
        e.preventDefault()
        void send()
      }}
    ></textarea>
    <!--
      Stop lives beside send, not in the title bar.

      It used to sit in the header, where a long session title pushed it out of
      the row and it stopped rendering altogether: the one control you reach for
      when a turn has gone wrong was the one control that disappeared. The composer
      is fixed to the bottom of the viewport and its width does not depend on the
      title, so the button is reachable whatever the session is called.
    -->
    {#if busy}
      <button class="stop" type="button" onclick={abort} aria-label="Stop generating">stop</button>
    {/if}
    <button
      class="primary send"
      type="submit"
      disabled={!draft.trim() || sending}
      aria-label="Send"
      onpointerdown={onPressStart}
      onpointerup={onPressEnd}
      onpointerleave={onPressEnd}
      onpointercancel={onPressEnd}
      oncontextmenu={(e) => e.preventDefault()}
    >
      ↑
    </button>
  </form>

  {#if menuOpen}
    <!--
      Long-press menu.

      Kept outside the form so a choice here cannot submit the composer, and so the
      long-press that opened it does not also fire a send on release.
    -->
    <div class="menu" role="menu" aria-label="Message actions">
      <p class="menu-title">
        {picking ? "tap one of your messages" : editingFrom ? "editing a message" : "message actions"}
      </p>
      {#if picking}
        <p class="faint small-note">{userMessages.length} message{userMessages.length === 1 ? "" : "s"} you sent</p>
        <button class="ghost" role="menuitem" onclick={() => (picking = false)}>cancel</button>
      {:else}
        <button
          class="ghost"
          role="menuitem"
          disabled={!lastUserMessage || busy}
          onclick={() => lastUserMessage && chooseTarget(lastUserMessage.id, "edit")}
        >
          edit last message
        </button>
        <button
          class="ghost"
          role="menuitem"
          disabled={!lastUserMessage || busy}
          onclick={() => lastUserMessage && chooseTarget(lastUserMessage.id, "undo")}
        >
          undo last turn
        </button>
        {#if userMessages.length > 1}
          <button class="ghost" role="menuitem" disabled={busy} onclick={() => (picking = true)}>
            undo an earlier message…
          </button>
        {/if}
        {#if revertAt}
          <button class="ghost" role="menuitem" disabled={reverting} onclick={() => { closeMenu(); void doUnrevert() }}>
            restore undone messages
          </button>
        {/if}
      {/if}
      <button class="ghost" role="menuitem" onclick={closeMenu}>close</button>
      {#if revertError}
        <!-- `guardIdle` reports here; without a place to show it, tapping a
             message mid-turn would do nothing at all. -->
        <p class="err small-note" role="alert">{revertError}</p>
      {/if}
    </div>
  {/if}

  {#if pendingTarget}
    <!--
      Confirmation.

      A revert is irreversible from here: the messages are dropped by the next
      prompt, and restoring only brings back what has not been overwritten yet.
      The count is stated rather than implied, because an edit three turns back
      silently loses three turns of work.
    -->
    <div class="scrim" role="dialog" aria-modal="true" aria-label="Confirm">
      <div class="sheet">
        <h2>Discard {wouldDiscard(pendingTarget)} message{wouldDiscard(pendingTarget) === 1 ? "" : "s"}?</h2>
        <p class="faint">
          {#if pendingKind === "edit"}
            The message goes back into the composer. Sending it replaces everything after it.
          {:else}
            The turn is rewound and any files it changed are restored. The agent's reply and everything
            after it are discarded.
          {/if}
        </p>
        {#if revertError}
          <p class="err" role="alert">{revertError}</p>
        {/if}
        <div class="sheet-actions">
          <button class="ghost" onclick={() => (pendingTarget = null)}>cancel</button>
          <button class="primary" onclick={confirmTarget}>
            {pendingKind === "edit" ? "edit" : "undo"}
          </button>
        </div>
      </div>
    </div>
  {/if}
</section>

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
    background: var(--bg);
    min-height: calc(env(safe-area-inset-top) + var(--header-h));
  }
  .back {
    font-size: 1.5rem;
    line-height: 1;
    text-decoration: none;
    padding: 4px 12px;
  }
  .conn {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-faint);
    flex: none;
  }
  .conn.on {
    background: var(--ok);
  }

  /* Subagent strip. */
  .subs {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 12px;
    border-top: 1px solid var(--line);
    background: var(--bg-2);
    font-size: 0.8rem;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
    min-width: 0;
  }
  .sub.on {
    color: var(--text);
  }
  .sub strong {
    flex: none;
    font-weight: 600;
  }
  .sub-t {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub-m {
    flex: none;
    color: var(--text-faint);
    font-size: 0.75rem;
  }
  .spin {
    flex: none;
    width: 10px;
    height: 10px;
    border: 2px solid var(--text-faint);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: ocm-spin 0.7s linear infinite;
  }
  .tick {
    flex: none;
    color: var(--ok);
    font-size: 0.75rem;
  }
  @keyframes ocm-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .controls::-webkit-scrollbar {
    display: none;
  }
  .modes {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    flex: none;
  }
  .mode {
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.82rem;
    padding: 5px 10px;
  }
  .mode + .mode {
    border-left: 1px solid var(--border);
  }
  .mode.on {
    background: var(--accent-dim);
    color: var(--text);
    font-weight: 600;
  }
  .mode.loading,
  .pick select.loading {
    opacity: 0.5;
    pointer-events: none;
    position: relative;
  }
  .mode.loading::after,
  .pick select.loading::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--accent) 15%, transparent) 50%,
      transparent 100%
    );
    animation: ocm-shimmer 1.2s linear infinite;
  }
  @keyframes ocm-shimmer {
    to {
      transform: translateX(100%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .mode.loading::after,
    .pick select.loading::after {
      animation: none;
    }
  }
  .pick select {
    /* Native control sizing on iOS ignores width, so cap the intrinsic size
       instead; without this a long model name pushes the mode toggle offscreen. */
    max-width: 46vw;
    padding: 5px 8px;
    font-size: 0.82rem;
    border-radius: 8px;
  }
  .cwd {
    font-size: 0.78rem;
    flex: none;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  /*
   * Indeterminate bar. Animating transform rather than width keeps this off the
   * main thread's layout path, which matters because it sits above a transcript
   * that is already writing to the DOM on every token.
   */
  .progress {
    height: 2px;
    overflow: hidden;
    background: transparent;
  }
  .progress.on {
    background: var(--bg-sunken);
  }
  .progress-fill {
    height: 100%;
    width: 40%;
    background: var(--accent);
    transform: translateX(-100%);
  }
  .progress.on .progress-fill {
    animation: slide 1.1s ease-in-out infinite;
  }
  @keyframes slide {
    to {
      transform: translateX(250%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .progress.on .progress-fill {
      animation: none;
      transform: none;
      width: 100%;
      opacity: 0.5;
    }
  }
  .todos {
    border-bottom: 1px solid var(--border);
    background: var(--bg-raised);
    padding: 6px 10px;
  }
  .todos-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    border: 0;
    background: transparent;
    padding: 2px 0;
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .todos ul {
    list-style: none;
    margin: 6px 0 2px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .todos li {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
    min-width: 0;
  }
  .todos li.done {
    color: var(--text-faint);
    text-decoration: line-through;
  }
  .todos li.active {
    color: var(--text);
    font-weight: 600;
  }
  .mark {
    flex: none;
    width: 1em;
    color: var(--text-faint);
  }
  .footer {
    margin: 6px 0 0;
    font-size: 0.75rem;
    opacity: 0.8;
  }
  .error.small {
    margin: 0;
    padding: 6px 10px;
    font-size: 0.8rem;
  }
  .transcript {
    flex: 1;
    overflow-y: auto;
    /* Needed or pull-to-refresh fights the transcript scroll. */
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .msg {
    max-width: 92%;
    align-self: flex-start;
  }
  /*
   * A part whose parent has not arrived yet. opencode sends the part and all of
   * its deltas before message.updated, so this is what the transcript looks like
   * for most of a turn. It sits on the agent side (there is nothing else to put
   * it on) but is dimmed to signal that the role is not settled yet, so a user's
   * own text in flight is never mistaken for a reply.
   */
  .msg.pending {
    opacity: 0.75;
  }
  .msg.user {
    align-self: flex-end;
    background: var(--accent-dim);
    border-radius: 12px;
    padding: 8px 12px;
  }
  .text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: break-word;
  }
  .text.synthetic {
    color: var(--text-dim);
    font-style: italic;
  }

  /*
   * Markdown-rendered assistant prose.
   *
   * `white-space` is deliberately NOT pre-wrap here, unlike the plain-text path:
   * marked has already turned the source newlines into block elements, and
   * pre-wrap would add a second line break after each of them. Code is the
   * exception and keeps it, since a code block's internal spacing is content.
   *
   * Every descendant selector is `:global()`. These nodes are created by `{@html}`,
   * so the Svelte compiler has no template markup to match them against and would
   * otherwise report every rule below as an unused selector.
   */
  .md {
    word-break: break-word;
    overflow-wrap: break-word;
  }
  .md :global(> :first-child) {
    margin-top: 0;
  }
  .md :global(> :last-child) {
    margin-bottom: 0;
  }
  .md :global(p) {
    margin: 0 0 0.7em;
  }
  .md :global(h1) {
    margin: 1.1em 0 0.5em;
    font-size: 1.15em;
    line-height: 1.3;
    font-weight: 600;
  }
  .md :global(h2) {
    margin: 1.1em 0 0.5em;
    font-size: 1.1em;
    line-height: 1.3;
    font-weight: 600;
  }
  .md :global(h3),
  .md :global(h4) {
    margin: 1.1em 0 0.5em;
    font-size: 1em;
    line-height: 1.3;
    font-weight: 600;
  }
  .md :global(ul),
  .md :global(ol) {
    margin: 0 0 0.7em;
    padding-left: 1.4em;
  }
  .md :global(li) {
    margin: 0.25em 0;
  }
  .md :global(li > ul),
  .md :global(li > ol) {
    margin: 0.25em 0;
  }
  .md :global(blockquote) {
    margin: 0 0 0.7em;
    padding: 2px 0 2px 10px;
    border-left: 3px solid var(--border);
    color: var(--text-dim);
  }
  .md :global(a) {
    color: var(--accent);
    text-decoration: underline;
  }
  .md :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.92em;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 4px;
  }
  /* Fenced blocks own their padding, so the inline padding is dropped. */
  .md :global(pre) {
    margin: 0 0 0.7em;
    padding: 10px 12px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow-x: auto;
    white-space: pre;
  }
  .md :global(pre code) {
    background: none;
    border: none;
    padding: 0;
    font-size: 0.9em;
  }
  .md :global(table) {
    display: block;
    width: 100%;
    margin: 0 0 0.7em;
    border-collapse: collapse;
    font-size: 0.95em;
    overflow-x: auto;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--border);
    padding: 5px 8px;
    text-align: left;
  }
  .md :global(th) {
    background: var(--bg-raised);
    font-weight: 600;
  }
  .md :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1em 0;
  }
  .md :global(img) {
    max-width: 100%;
    border-radius: 8px;
  }
  .tool,
  .reasoning {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 10px;
    background: var(--bg-raised);
  }
  .tool summary,
  .reasoning summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.88rem;
  }
  .badge {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border-radius: 5px;
    background: var(--bg-sunken);
    color: var(--text-dim);
    flex: none;
  }
  .badge.err {
    color: var(--danger);
  }
  pre.err {
    color: var(--danger);
  }
  .file {
    display: inline-block;
    font-family: var(--mono);
    font-size: 0.82rem;
    text-decoration: none;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
  }
  /*
   * The inline question. Sits directly above the composer and shares its
   * background so the two read as one control area.
   */
  .ask {
    border-top: 1px solid var(--border);
    background: var(--bg-raised);
    padding: 10px 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 55dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .ask-queue {
    margin: 0;
    font-size: 0.75rem;
  }
  .q {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .q + .q {
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .q-head {
    margin: 0;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
    font-weight: 600;
  }
  .q-text {
    margin: 0;
    font-size: 0.92rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .q-options {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .opt {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    text-align: left;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
  }
  .opt.on {
    border-color: var(--accent);
    background: var(--accent-dim);
  }
  .tick {
    flex: none;
    width: 1.1em;
    text-align: center;
    color: var(--accent);
    font-weight: 700;
  }
  .opt-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .opt-label {
    font-size: 0.88rem;
    font-weight: 600;
  }
  .opt-desc {
    font-size: 0.78rem;
  }
  .q-custom {
    width: 100%;
    font-size: 0.88rem;
  }
  .ask-actions {
    display: flex;
    gap: 8px;
  }
  .ask-actions button {
    flex: 1;
  }
  .stream-warn {
    margin: 0;
    padding: 6px 12px;
    font-size: 12px;
    text-align: center;
    color: #f0c36d;
    background: #2a2317;
    border-top: 1px solid var(--border);
  }
  .composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    padding: 8px 10px;
    padding-bottom: calc(env(safe-area-inset-bottom) + 8px);
    border-top: 1px solid var(--border);
    background: var(--bg);
  }
  textarea {
    resize: none;
    max-height: 140px;
  }
  .send {
    flex: none;
    width: 44px;
    height: 44px;
    padding: 0;
    font-size: 1.2rem;
    font-weight: 700;
  }
  /* Matches the send button's 44px so the two read as one control group. */
  .stop {
    flex: none;
    height: 44px;
    padding: 0 14px;
    font-size: 0.85rem;
    font-weight: 600;
    color: #f0c36d;
    background: #2a2317;
    border: 1px solid #4a3d22;
    border-radius: 10px;
  }
  .stop:active {
    background: #3a3020;
  }
  .center {
    text-align: center;
    padding: 24px 0;
  }
  .editing {
    display: flex;
    gap: 10px;
    align-items: center;
    margin: 0 12px 6px;
    padding: 6px 10px;
    font-size: 12px;
    color: #f0c36d;
    background: #2a2317;
    border: 1px dashed #4a3d22;
    border-radius: 8px;
  }
  .reverted {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: center;
    margin: 10px 12px;
    padding: 7px 10px;
    font-size: 12px;
    color: #f0c36d;
    background: #2a2317;
    border: 1px dashed #4a3d22;
    border-radius: 8px;
  }
  .small,
  .small-note {
    font-size: 12px;
  }
  .menu {
    position: fixed;
    right: 10px;
    bottom: calc(env(safe-area-inset-bottom) + 74px);
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 210px;
    padding: 6px;
    background: #1b1b1f;
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 10px 30px rgb(0 0 0 / 55%);
  }
  .menu-title {
    margin: 4px 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--faint);
  }
  .menu button {
    width: 100%;
    padding: 10px 8px;
    text-align: left;
    background: none;
    border: 0;
    border-radius: 8px;
    font-size: 14px;
  }
  .menu button:disabled {
    opacity: 0.4;
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: end center;
    background: rgb(0 0 0 / 55%);
  }
  .sheet {
    width: min(520px, 100%);
    margin: 0 0 calc(env(safe-area-inset-bottom) + 12px);
    padding: 16px;
    background: #1b1b1f;
    border: 1px solid var(--border);
    border-radius: 14px;
  }
  .sheet h2 {
    margin: 0 0 8px;
    font-size: 16px;
  }
  .sheet p {
    margin: 0 0 12px;
    font-size: 13px;
  }
  .sheet-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .err {
    color: #f0c36d;
  }
  .msg.picking {
    outline: 2px dashed var(--border);
    outline-offset: 2px;
  }
  .pick {
    display: block;
    width: 100%;
    margin-bottom: 6px;
    padding: 7px 10px;
    font-size: 12px;
    color: #f0c36d;
    background: #2a2317;
    border: 1px dashed #4a3d22;
    border-radius: 8px;
  }
</style>
