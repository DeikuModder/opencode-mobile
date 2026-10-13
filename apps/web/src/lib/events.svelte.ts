/**
 * opencode's global event stream, exposed to the client as a shared EventSource
 * subscription.
 *
 * Two decisions worth stating:
 *
 *  - The browser connects to /api/serve/event, which the gateway proxies. So the
 *    client never talks to opencode directly and inherits the gateway's auth and
 *    allowlist.
 *  - EventSource cannot set headers, so it relies on the session cookie. That is
 *    fine because the stream is a GET and GET is CSRF-exempt; a cross-site page
 *    cannot read the response body even if it opened one.
 */

export interface OpencodeEvent {
  type: string
  properties: Record<string, unknown>
}

/** opencode emits these to keep idle proxies from closing the connection. */
const HEARTBEATS = new Set(["server.heartbeat", "server.connected"])

type Listener = (e: OpencodeEvent) => void
type StatusListener = (status: StreamStatus) => void

export type StreamStatus = "connecting" | "open" | "closed"

class EventStream {
  #es: EventSource | null = null
  #listeners = new Set<Listener>()
  #statusListeners = new Set<StatusListener>()
  #reconnectListeners = new Set<() => void>()
  #refCount = 0
  #retryMs = 1000
  #timer: ReturnType<typeof setTimeout> | null = null
  #everOpened = false

  status = $state<StreamStatus>("closed")

  /**
   * Subscribe to the stream, starting it if this is the first subscriber.
   *
   * Reference counted because several components want events at once (a chat
   * view, a global permission prompt, a project switcher). Opening one
   * EventSource per component would mean N upstream connections to a single
   * opencode process.
   */
  subscribe(fn: Listener): () => void {
    // `#listeners` is a Set, so re-subscribing an identical function is already a
    // no-op there. Counting it again anyway is what desynchronised the two: the
    // count could outrun the set, the final detach left the count above zero with
    // an empty set, and the socket stayed open delivering to nobody. The UI then
    // reported itself connected while rendering state frozen at the last event it
    // happened to receive, which is indistinguishable from a hung agent until you
    // reload the page.
    const added = !this.#listeners.has(fn)
    if (added) {
      this.#listeners.add(fn)
      this.#refCount += 1
      if (this.#refCount === 1) this.#connect()
    }

    let attached = added
    return () => {
      if (!attached) return
      attached = false
      this.#listeners.delete(fn)
      this.#refCount -= 1
      if (this.#refCount <= 0) this.#disconnect()
    }
  }

  onStatus(fn: StatusListener): () => void {
    this.#statusListeners.add(fn)
    fn(this.status)
    return () => this.#statusListeners.delete(fn)
  }

  /**
   * Called after a connection that had failed comes back, and never on the first
   * successful open.
   *
   * Reconnecting restores the stream but not the events missed while it was down,
   * and opencode sends no snapshot to replay: state lives behind REST and the
   * stream carries deltas only. A consumer that wants to stay correct across a
   * drop therefore has to refetch, and this is the signal telling it to. Without
   * it the page silently shows whatever it last received.
   */
  onReconnect(fn: () => void): () => void {
    this.#reconnectListeners.add(fn)
    return () => this.#reconnectListeners.delete(fn)
  }

  #setStatus(s: StreamStatus) {
    this.status = s
    for (const fn of this.#statusListeners) fn(s)
  }

  #connect() {
    if (this.#es) return
    this.#setStatus("connecting")

    const es = new EventSource("/api/serve/event", { withCredentials: true })
    this.#es = es

    es.onopen = () => {
      this.#retryMs = 1000
      this.#setStatus("open")
      if (this.#everOpened) {
        for (const fn of [...this.#reconnectListeners]) {
          try {
            fn()
          } catch (err) {
            console.error("reconnect listener threw", err)
          }
        }
      }
      this.#everOpened = true
    }

    es.onmessage = (ev) => {
      let parsed: OpencodeEvent
      try {
        parsed = JSON.parse(ev.data) as OpencodeEvent
      } catch {
        // A malformed frame is not worth tearing the connection down for.
        return
      }
      if (typeof parsed.type !== "string") return
      // Heartbeats keep the socket warm but carry no payload; drop them so
      // consumers are not woken for nothing.
      if (HEARTBEATS.has(parsed.type)) return
      for (const fn of this.#listeners) fn(parsed)
    }

    es.onerror = () => {
      // EventSource retries on its own, but it does not always reset quickly
      // after a gateway restart. Closing and re-scheduling gives us bounded,
      // backed-off reconnects and a status the UI can show.
      es.close()
      this.#es = null
      this.#setStatus("closed")
      if (this.#refCount <= 0) return
      const delay = this.#retryMs
      this.#retryMs = Math.min(this.#retryMs * 2, 15_000)
      this.#timer = setTimeout(() => this.#connect(), delay)
    }
  }

  #disconnect() {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#es?.close()
    this.#es = null
    this.#setStatus("closed")
  }

  /**
   * Drop the connection but stay usable, e.g. on logout or project switch.
   *
   * Deliberately not a permanent dispose: logging back in has to be able to
   * reopen the stream, and keeping the object reusable avoids a global
   * "disposed" flag that every future caller has to know about.
   */
  close() {
    this.#refCount = 0
    this.#listeners.clear()
    this.#statusListeners.clear()
    this.#reconnectListeners.clear()
    // Reset so the next login's first open is a first open again and does not
    // report a reconnect that never happened.
    this.#everOpened = false
    this.#disconnect()
  }

  /**
   * Push an event to every current subscriber as if the stream had produced it.
   *
   * Exported for component tests: the only way to exercise an event handler
   * without a live EventSource, and deliberately routed through the same
   * heartbeat filter the real socket applies so tests cannot pass on frames the
   * production path would have dropped.
   */
  emitForTest(e: OpencodeEvent) {
    if (HEARTBEATS.has(e.type)) return
    for (const fn of this.#listeners) fn(e)
  }
}

export const eventStream = new EventStream()
