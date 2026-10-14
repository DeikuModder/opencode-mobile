/**
 * Typed client for the opencode gateway.
 *
 * Two rules hold everywhere in this file:
 *
 *  1. Every call is same-origin and sends the session cookie. There is no token
 *     in localStorage, because a token readable by script is a token an XSS can
 *     steal, whereas an HttpOnly cookie is not.
 *  2. Upstream opencode lives behind /api/serve and is reached with the
 *     browser's own credentials. The gateway injects the upstream Basic auth, so
 *     the serve password never reaches the browser.
 */

/** Error carrying the gateway's machine-readable code and HTTP status. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSeconds: number | undefined
  /** True when the failure was a transport problem, not a server response. */
  readonly isNetwork: boolean
  /** Non-secret guidance, e.g. which second factor to use. */
  readonly hint: string | undefined
  /** True when the password was correct and only a second factor is missing. */
  readonly passwordAccepted: boolean | undefined

  constructor(
    status: number,
    code: string,
    message: string,
    opts: {
      retryAfterSeconds?: number
      isNetwork?: boolean
      hint?: string
      passwordAccepted?: boolean
    } = {},
  ) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.retryAfterSeconds = opts.retryAfterSeconds
    this.isNetwork = opts.isNetwork ?? false
    this.hint = opts.hint
    this.passwordAccepted = opts.passwordAccepted
  }

  /** The session is gone; the caller should return to the login screen. */
  get isUnauthenticated(): boolean {
    return this.status === 401
  }
}

async function parseError(res: Response): Promise<ApiError> {
  // The gateway sets Retry-After on both 429 and 423 so the client can count
  // down instead of hammering the endpoint.
  const ra = res.headers.get("retry-after")
  const retryAfterSeconds = ra ? Number.parseInt(ra, 10) : undefined

  let code = `http_${res.status}`
  let message = res.statusText || "Request failed"
  let hint: string | undefined
  let passwordAccepted: boolean | undefined
  try {
    const body = (await res.json()) as {
      code?: string
      message?: string
      hint?: string
      passwordAccepted?: boolean
    }
    if (typeof body.code === "string") code = body.code
    if (typeof body.message === "string") message = body.message
    hint = typeof body.hint === "string" ? body.hint : undefined
    if (typeof body.passwordAccepted === "boolean") passwordAccepted = body.passwordAccepted
  } catch {
    // Non-JSON error body (HTML from the SPA fallback, or an empty 502). The
    // status-derived code is still useful.
  }
  return new ApiError(res.status, code, message, {
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    hint,
    passwordAccepted,
  })
}

interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? "GET",
    // Same-origin only: the cookie is host-only, so there is no cross-site case
    // to serve, and sending credentials would widen the CSRF surface.
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: opts.signal,
  }
  if (opts.body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" }
    init.body = JSON.stringify(opts.body)
  }

  let res: Response
  try {
    res = await fetch(path, init)
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e
    // The gateway being down looks like this to fetch. Surfacing a distinct code
    // lets the UI say "the gateway is unreachable" instead of "not authorised",
    // which would send the user to the login screen for no reason.
    throw new ApiError(0, "gateway_unreachable", "Could not reach the gateway", {
      isNetwork: true,
    })
  }

  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T

  // opencode serves the SPA index.html for any path it does not recognise, with
  // HTTP 200 and a text/html content type. So a wrong path arrives here looking
  // like a success, and bare JSON.parse turns it into
  // "Unexpected token '<', "<!doctype "... is not valid JSON" — which says
  // nothing about the real problem. Several guessed endpoints hit exactly this:
  // /model and /api/session/:id/model are not real routes, /api/model is.
  // Naming the path in the error is the difference between an unreproducible UI
  // bug and a one-line fix.
  if (looksLikeHtml(text, res.headers.get("content-type"))) {
    throw new ApiError(res.status, "unexpected_html", `Expected JSON but got the SPA page for ${path}`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(res.status, "invalid_json", `Malformed JSON from ${path}`)
  }
}

/** True when a body is the SPA fallback rather than API data. */
function looksLikeHtml(text: string, contentType: string | null): boolean {
  if (contentType?.includes("text/html")) return true
  return /^\s*(<!doctype|<html)/i.test(text)
}

// ---------------------------------------------------------------- auth types

/**
 * GET /api/auth/state.
 *
 * Field names are camelCase because that is what the endpoint actually returns
 * (verified live: {"setupRequired":false,"totpEnabled":false}). An earlier
 * snake_case declaration typed `configured` and `totp_enabled`, which are never
 * present on the wire, so `!state.configured` was permanently true and the app
 * sat on the "set up an account" screen for a fully configured server.
 *
 * `authenticated`/`username` are not part of this response; session validity is
 * decided by whether the cookie works on a guarded route, not by this endpoint.
 */
export interface AuthState {
  setupRequired: boolean
  totpEnabled: boolean
}

/** GET /api/auth/session — 401 when signed out, so callers must catch that. */
export interface SessionState {
  authenticated: boolean
  username: string | null
}

export interface RecoveryCodes {
  codes: string[]
}

export interface LoginSuccess {
  ok: true
  requires_totp: boolean
  totp_required: boolean
  /** Present when a second factor is needed. */
  challenge: string | null
  /** Non-secret human guidance, e.g. which recovery option to use. */
  hint: string | null
  user: string
}

export interface SessionSummary {
  id: string
  created_at: number
  last_used_at: number
  user_agent: string | null
  ip: string | null
}

export interface BotToken {
  id: string
  label: string
  created_at: number
  last_used_at: number | null
  /** Only ever returned once, at creation. */
  token?: string
}

export const authApi = {
  state: () => request<AuthState>("/api/auth/state"),
  /**
   * Current session, or null when signed out.
   *
   * A 401 is the expected answer for a signed-out visitor, not a failure, so it
   * is translated to null here rather than forcing every caller to catch.
   */
  session: async (): Promise<SessionState | null> => {
    try {
      return await request<SessionState>("/api/auth/session")
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null
      throw e
    }
  },
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  sessions: () => request<SessionSummary[]>("/api/auth/sessions"),
  revoke: (id: string) => request<void>(`/api/auth/sessions/revoke/${encodeURIComponent(id)}`, { method: "POST" }),
  revokeAll: () => request<void>("/api/auth/sessions/revoke-all", { method: "POST" }),
  changePassword: (current: string, next: string) =>
    request<void>("/api/auth/password", { method: "POST", body: { current, next } }),
  botTokens: () => request<BotToken[]>("/api/auth/bot-tokens"),
  createBotToken: (label: string) =>
    request<BotToken>("/api/auth/bot-tokens", { method: "POST", body: { label } }),
  revokeBotToken: (id: string) =>
    request<void>(`/api/auth/bot-tokens/revoke/${encodeURIComponent(id)}`, { method: "POST" }),
}

/**
 * Login is a two-step flow, and the shape of the response differs per step, so
 * it gets its own function rather than going through the generic request().
 *
 * A 423 is a real, expected response here (TOTP is enabled but the challenge
 * has not been solved), so it is translated into a value instead of a throw.
 * Throwing would force every caller to catch it just to advance the form.
 */
export interface LoginFailure {
  ok: false
  code: string
  message: string
  retryAfterSeconds?: number
  /**
   * True when the password was correct and only the second factor is missing.
   *
   * This is the API's real signal that the TOTP step is next. There is no
   * `totp_required` code: the server returns invalid_totp with
   * passwordAccepted:true when it has no code to check yet, and that is a
   * normal mid-flow state, not a failure to report as an error.
   */
  passwordAccepted?: boolean
  /** Non-secret guidance, present when a second factor is required. */
  hint?: string
}

export async function login(
  username: string,
  password: string,
  code?: string,
  recovery?: string,
): Promise<LoginSuccess | LoginFailure> {
  // Field names must match LoginBody in auth.controller.ts. They used to be
  // `code`/`recovery` here while the server read `totpCode`/`recoveryCode`, so
  // every code from the browser arrived as undefined and came back as
  // invalid_totp no matter how correct it was. Nothing caught it because the
  // API tests call svc.login() directly and never exercise this JSON shape.
  const body: Record<string, string> = { username, password }
  if (code) body.totpCode = code
  if (recovery) body.recoveryCode = recovery

  let res: Response
  try {
    res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, code: "gateway_unreachable", message: "Could not reach the gateway" }
  }

  if (res.ok) {
    const j = (await res.json()) as LoginSuccess
    return { ...j, ok: true }
  }

  const ra = res.headers.get("retry-after")
  // The body is read exactly once: parseError consumes it, and the hint has to
  // come from that same read. Cloning first would double a read for no benefit.
  const err = await parseError(res)

  return {
    ok: false,
    code: err.code,
    message: err.message,
    hint: err.hint,
    // Threaded through so the caller can advance to the second-factor step. The
    // API has no totp_required code; passwordAccepted is the signal.
    passwordAccepted: err.passwordAccepted,
    retryAfterSeconds: err.retryAfterSeconds ?? (Number.parseInt(ra ?? "", 10) || undefined),
  }
}

// ------------------------------------------------------------ gateway types

export interface ProjectSummary {
  id: string
  name: string
  port: number
  directory?: string
}

export interface GatewayHealth {
  ok: boolean
  activeProject: ProjectSummary | null
  projects: ProjectSummary[]
  supervisor: {
    ok: boolean
    opencodeBin: string
    running: { id: string; port: number }[]
    error?: string
  }
}

export const gatewayApi = {
  health: () => request<GatewayHealth>("/api/gateway/health"),
  projects: () => request<ProjectSummary[]>("/api/projects"),
  setActive: (id: string) => request<{ ok: true }>("/api/projects/active", { method: "POST", body: { id } }),
}

// -------------------------------------------------------------- opencode API

/** Shape of the subset of opencode's API this client uses. */
export interface SessionInfo {
  id: string
  title: string
  projectID?: string
  directory?: string
  path?: string
  summary?: unknown
  cost?: number
  tokens?: unknown
  version?: string
  metadata?: Record<string, unknown>
  time: { created: number; updated: number; completed?: number }
  agent?: string
  model?: {
    id: string
    providerID: string
  } | null
  parentID?: string
  children?: unknown[]
  permission?: unknown
  /**
   * Set while the session is rewound. `messageID` is the last message kept, not
   * the first one dropped — verified by reverting to the first user message of a
   * three-turn session and confirming the edit replaced everything from there on.
   */
  revert?: { messageID?: string; partID?: string; files?: unknown[] } | null
  share?: unknown
}
export interface ModelInfo {
  id: string
  providerID: string
  name: string
  family?: string
  enabled?: boolean
  status?: string
}

/** One provider's slice of the catalog, with models reduced to picker fields. */
export interface ModelCatalogProvider {
  id: string
  name: string
  models: ModelInfo[]
}

/** Every configured model of this instance, grouped by provider. */
export interface ModelCatalog {
  providers: ModelCatalogProvider[]
}

/** One selectable answer to a question. */
export interface QuestionOption {
  label: string
  description: string
}

/**
 * A single question within a request.
 *
 * `multiple` makes the options a multi-select, and `custom` adds a free-text
 * answer alongside them. Both are optional, and a question with neither is a
 * plain single choice.
 */
export interface QuestionInfo {
  question: string
  /** Very short label, max 30 chars; used as the card heading. */
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

/**
 * A pending decision request. opencode blocks the turn until it is answered, so
 * these cannot be allowed to go unnoticed.
 */
export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
}

/** A pending tool-permission request, from the same family of blocking prompts. */
export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
}

/** An agent as GET /agent describes it; only what the mode toggle needs. */
export interface AgentInfo {
  id?: string
  name?: string
  mode?: "primary" | "subagent" | "all" | string
  description?: string
  hidden?: boolean
}

/** GET /path — the instance's own view of where it is working. */
export interface ServePath {
  home: string
  state: string
  config: string
  worktree: string
  directory: string
}

/**
 * A directory the gateway is allowed to point opencode at.
 *
 * These come from the gateway's own allowlist (`/api/projects`), NOT from
 * opencode's `/project`. The registry is the security boundary that stops a
 * session from aiming the agent at an arbitrary directory, so the switcher must
 * only ever offer ids the gateway returned.
 */
export interface ProjectInfo {
  id: string
  name: string
  port?: number
}

/** GET /api/projects — the switchable directories, with the active one marked. */
export interface ProjectList {
  active: string | null
  projects: ProjectInfo[]
}

/**
 * Tool execution state, as the OpenAPI spec defines it.
 *
 * `input` is deliberately `unknown`: it is tool-specific, and for `todowrite` it
 * is the todo list the plan UI renders.
 */
export interface ToolState {
  status: "pending" | "running" | "completed" | "error" | string
  input?: unknown
  output?: string
  title?: string
  metadata?: unknown
  error?: string
  time?: { start?: number; end?: number }
  attachments?: unknown[]
}

/** One entry of GET /session/:id/todo. */
export interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled" | string
  priority: "low" | "medium" | "high" | string
}

export type Part =
  | { type: "text"; text: string; id?: string; synthetic?: boolean; time?: { start?: number; end?: number } }
  | { type: "reasoning"; text: string; id?: string; time?: { start?: number; end?: number } }
  | { type: "tool"; tool: string; id?: string; callID?: string; state: ToolState }
  | { type: "step-start" | "step-finish"; id?: string }
  | { type: "file"; id?: string; filename: string; mime?: string; url?: string }
  | { type: string; [k: string]: unknown }



/**
 * The flat message shape the UI works with.
 *
 * opencode's `/session/:id/message` does NOT return this. On the wire each element
 * is `{ info: {...}, parts: [...] }`, with id/role/sessionID/summary/time all
 * nested under `info`. `normalizeMessage` flattens that at the boundary so no
 * component has to know about the nesting.
 */
export interface Message {
  id: string
  role: "user" | "assistant" | "system"
  sessionID?: string
  parts: Part[]
  time?: { created?: number; completed?: number }
  error?: { name: string; data?: { message?: string } } | null
  /**
   * Turn metadata, NOT a visibility flag.
   *
   * opencode sends an object such as `{ diffs: [] }` here, and it is present on
   * ordinary completed assistant messages. Declaring it `boolean` made a
   * truthiness check on it look reasonable, which is how a completed reply ended
   * up being discarded on arrival. Typed as it actually appears so the mistake is
   * a compile error rather than a vanished message.
   */
  summary?: { diffs?: unknown[] } | boolean
  /** Present on assistant messages; identifies the model that produced the turn. */
  modelID?: string
  providerID?: string
  /** The opencode agent that ran the turn, e.g. `build` or `plan`. */
  agent?: string
  /** Required on assistant messages per the spec; kept loose because the enum is version-dependent. */
  mode?: string
}

/** The raw wire shape: metadata under `info`, content alongside it. */
interface RawMessage {
  info?: Omit<Message, "parts"> & { error?: Message["error"] }
  parts?: Part[]
}

/**
 * Flattens `{ info, parts }` into a flat Message.
 *
 * Returns null when there is no usable id, because a message the UI cannot key
 * on would break the `{#each}` reconciliation and silently drop updates.
 */
function normalizeMessage(raw: RawMessage): Message | null {
  const info = raw.info
  if (!info || typeof info.id !== "string") return null
  return {
    ...info,
    id: info.id,
    role: info.role ?? "assistant",
    parts: Array.isArray(raw.parts) ? raw.parts : [],
  }
}

export const serveApi = {
  sessions: () => request<SessionInfo[]>("/api/serve/session"),
  session: (id: string) => request<SessionInfo>(`/api/serve/session/${encodeURIComponent(id)}`),
  /**
   * Child sessions, i.e. the subagents this session spawned.
   *
   * A bare array with no `{ data }` envelope, unlike most v2 routes.
   */
  children: (id: string) => request<SessionInfo[]>(`/api/serve/session/${encodeURIComponent(id)}/children`),
  createSession: (title?: string) =>
    request<SessionInfo>("/api/serve/session", { method: "POST", body: title ? { title } : {} }),
  deleteSession: (id: string) =>
    request<boolean>(`/api/serve/session/${encodeURIComponent(id)}`, { method: "DELETE" }),
  messages: async (id: string, limit = 100) => {
    const raw = await request<RawMessage[]>(
      `/api/serve/session/${encodeURIComponent(id)}/message?limit=${limit}`,
    )
    return raw.map(normalizeMessage).filter((m): m is Message => m !== null)
  },
  /**
   * Sends a turn. `agent` is required in practice: opencode defaults it to
   * `build` per request and does not fall back to the session's persisted
   * agent, so omitting it runs the turn as `build` even after the user
   * selected Plan.
   */
  prompt: (id: string, text: string, agent?: string) =>
    request<Message>(`/api/serve/session/${encodeURIComponent(id)}/message`, {
      method: "POST",
      body: { ...(agent ? { agent } : {}), parts: [{ type: "text", text }] },
    }),
  abort: (id: string) =>
    request<boolean>(`/api/serve/session/${encodeURIComponent(id)}/abort`, { method: "POST" }),
  /**
   * Rewind the conversation to `messageID`, discarding it and everything after.
   *
   * This only sets a marker (`session.revert = { messageID }`); the messages
   * themselves are still returned by `GET /message` and are not flagged, so a
   * client that renders the raw list shows a revert as having done nothing. The
   * tail is actually dropped by the *next* prompt: sending after a revert
   * replaces the transcript from that point on. Verified live — reverting to the
   * first user message of a three-turn session and then sending left exactly the
   * new exchange.
   *
   * The v2 staged variant (`/api/session/:id/revert/stage|commit|clear`) is not
   * used: on this runtime it answers `404 MessageNotFoundError` for message IDs
   * that v1 hands out, the same spec-versus-runtime mismatch the question routes
   * had. Reverting is also refused with `409 SessionBusyError` while a turn runs.
   */
  revert: (id: string, messageId: string) =>
    request<SessionInfo>(`/api/serve/session/${encodeURIComponent(id)}/revert`, {
      method: "POST",
      body: { messageID: messageId },
    }),
  /** Clears the revert marker, putting the discarded turns back. */
  unrevert: (id: string) =>
    request<SessionInfo>(`/api/serve/session/${encodeURIComponent(id)}/unrevert`, { method: "POST" }),
  diff: (id: string) => request<unknown[]>(`/api/serve/session/${encodeURIComponent(id)}/diff`),
  /**
   * Pending permission requests.
   *
   * Repointed to `/api/session/...` and the `{ data }` envelope. The old
   * `/session/:id/permission` path is not a route at all — v1 only has the
   * plural `/session/:id/permissions/{id}` reply — so this silently returned the
   * SPA page.
   */
  permissions: async (id: string): Promise<PermissionRequest[]> => {
    const res = await request<{ data?: PermissionRequest[] | null }>(
      `/api/serve/api/session/${encodeURIComponent(id)}/permission`,
    )
    return Array.isArray(res?.data) ? res.data : []
  },
  /**
   * `response` is the literal opencode enum: once | always | reject.
   *
   * Kept on the v1 route deliberately: it is the one that exists and answers 200
   * with a body, whereas the v2 route answers 204 with none.
   */
  replyPermission: (sessionId: string, permissionId: string, response: "once" | "always" | "reject") =>
    request<boolean>(
      `/api/serve/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
      { method: "POST", body: { response } },
    ),
  /**
   * The complete model catalog, grouped by provider.
   *
   * Served by the gateway, not proxied: `/api/model` answers only with the
   * personal catalog — 39 entries, every one providerID "opencode" — while the
   * upstream that names everything ("Personal / OpenCode", "OpenCode Go",
   * Anthropic, ...) is `/provider`, which runs to megabytes. The gateway
   * reduces and caches it, so the phone fetches kilobytes.
   */
  catalog: () => request<ModelCatalog>("/api/gateway/model-catalog"),
  /**
   * The instance's working directory and the worktree it belongs to.
   *
   * This is the only source of truth for "where is opencode running": sessions
   * carry no directory field, so the cwd selector has nothing else to read.
   */
  path: () => request<ServePath>("/api/serve/path"),
  /**
   * Agents the instance exposes. The agent for a session comes from
   * `GET /session/:id`, not from this list.
   */
  agents: () => request<AgentInfo[]>("/api/serve/agent"),
  /**
   * The session's todo list.
   *
   * Served directly by opencode rather than reconstructed from `todowrite` tool
   * parts: the endpoint is the authority on the current list, whereas tool parts
   * only reveal it once the agent has already written them.
   */
  todos: async (sessionId: string): Promise<TodoItem[]> => {
    const res = await request<TodoItem[] | null>(
      `/api/serve/session/${encodeURIComponent(sessionId)}/todo`,
    )
    return Array.isArray(res) ? res : []
  },
  /**
   * Switches which directory the agent works in.
   *
   * Points the proxy at another allowlisted project's opencode instance, so
   * everything about the session changes: this is not a per-session setting and
   * the caller has to reload afterwards rather than patch its state in place.
   */
  switchProject: (id: string) =>
    request<{ ok: boolean; active: string; serve: { ok: boolean; detail?: string } }>(
      "/api/projects/active",
      { method: "POST", body: { id } },
    ),
  /** The switchable directories, from the gateway's allowlist. */
  projects: () => request<ProjectList>("/api/projects"),
  /**
   * Selects the model for a session.
   *
   * The body is opencode's `ModelRef`, which needs BOTH `providerID` and `id`;
   * sending a bare `modelID` is rejected with a 400. The response carries no
   * body, so the model is taken from the selection rather than from the reply.
   *
   * The path is the `/api/session/...` family, not `/session/...`. Verified live:
   * `/session/:id/model` returns the SPA page, `/api/session/:id/model` is the
   * real endpoint and answers 204.
   */
  setModel: (sessionId: string, model: { providerID: string; id: string }) =>
    request<void>(`/api/serve/api/session/${encodeURIComponent(sessionId)}/model`, {
      method: "POST",
      body: { model },
    }),
  /** Switches the agent, which is how opencode models Plan versus Build. */
  setAgent: (sessionId: string, agent: string) =>
    request<void>(`/api/serve/api/session/${encodeURIComponent(sessionId)}/agent`, {
      method: "POST",
      body: { agent },
    }),
  /**
   * Decisions the agent is blocked on.
   *
   * Both lists come from the `/api/session/...` family; the unprefixed variants
   * are not routes and answer with the SPA page.
   *
   * The response is `{ data: [...] }` and is the authority on what is still
   * pending, so the UI re-reads it on the relevant events instead of trusting
   * event payloads to stay in sync. opencode holds the turn open until these are
   * answered, which means a missed request is a session that stalls forever.
   */
  questions: async (sessionId: string): Promise<QuestionRequest[]> => {
    // This reads the v1 GLOBAL list (`GET /question`) and filters by session,
    // NOT the per-session v2 route. Verified live on 1.18.33: the v2 route
    // `/api/session/:id/question` answers `{ data: [] }` even while the agent is
    // demonstrably blocked on a question, so a client using it sees nothing and
    // the turn hangs forever. The v1 route carries the real pending requests.
    const res = await request<QuestionRequest[] | { data?: QuestionRequest[] | null }>(
      `/api/serve/question`,
    )
    const list = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    return list.filter((q) => q.sessionID === sessionId)
  },
  /**
   * Answers a request. `answers` is positional: one entry per question, in the
   * order they were asked, each being the array of chosen labels. A question with
   * nothing selected is an empty array, so the array must not be filtered.
   *
   * The v1 route, for the same reason as `questions` above: the v2 per-session
   * route does not resolve the request that the v1 list actually reports.
   */
  replyQuestion: (requestId: string, answers: string[][]) =>
    request<void>(`/api/serve/question/${encodeURIComponent(requestId)}/reply`, {
      method: "POST",
      body: { answers },
    }),
  /** Declines the request, which releases the turn without answering. */
  rejectQuestion: (requestId: string) =>
    request<void>(`/api/serve/question/${encodeURIComponent(requestId)}/reject`, {
      method: "POST",
      body: {},
    }),
  fileContent: (path: string) =>
    request<{ type: string; content: string; encoding?: string }>(
      `/api/serve/file/content?path=${encodeURIComponent(path)}`,
    ),
  fileTree: (path: string) =>
    request<{ name: string; path: string; type: "file" | "directory"; children?: unknown[] }>(
      `/api/serve/file?path=${encodeURIComponent(path)}`,
    ),
}
