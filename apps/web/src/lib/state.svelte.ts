/**
 * App-wide reactive state.
 *
 * Svelte 5 runes are used directly in .svelte.ts modules, so these are real
 * reactive containers that can be read and written from any component without a
 * store contract.
 */
import {
  authApi,
  gatewayApi,
  type AuthState,
  type GatewayHealth,
  type ProjectSummary,
  type SessionState,
} from "./api.js"
import { eventStream } from "./events.svelte.js"

class AppState {
  /** null means "not yet checked", which the UI renders as a splash screen. */
  auth = $state<AuthState | null>(null)
  /** Who is signed in, or null. Separate from `auth`, which says nothing about it. */
  session = $state<SessionState | null>(null)
  health = $state<GatewayHealth | null>(null)
  projects = $state<ProjectSummary[]>([])
  booted = $state(false)
  /** Set when the gateway itself is unreachable, to distinguish from a 401. */
  gatewayDown = $state(false)

  get isAuthenticated(): boolean {
    return this.session?.authenticated === true
  }

  get needsSetup(): boolean {
    // setupRequired, not `!configured`: the endpoint returns setupRequired, and
    // `configured` is never present, so the old check was always true.
    return this.auth !== null && this.auth.setupRequired
  }

  get username(): string | null {
    return this.session?.username ?? null
  }

  async boot() {
    try {
      // Both requests are needed and neither implies the other: /state says what
      // the install requires, /session says whether this browser holds a valid
      // cookie. Firing them together keeps first paint to one round trip.
      const [auth, session] = await Promise.all([authApi.state(), authApi.session()])
      this.auth = auth
      this.session = session
      this.gatewayDown = false
    } catch (e) {
      this.gatewayDown = true
      this.booted = true
      return
    }
    if (this.isAuthenticated) {
      // Deliberately not awaited together: the UI should render as soon as auth
      // state is known, and gateway data arrives a moment later.
      void this.refreshGateway()
    }
    this.booted = true
  }

  async refreshGateway() {
    try {
      const [h, p] = await Promise.all([gatewayApi.health(), gatewayApi.projects()])
      this.health = h
      this.projects = p
      this.gatewayDown = false
    } catch {
      this.health = null
      this.projects = []
    }
  }

  async setActiveProject(id: string) {
    await gatewayApi.setActive(id)
    await this.refreshGateway()
  }

  /** Called after login succeeds so the shell does not wait on a reload. */
  async onLoggedIn() {
    // The session now exists, so /session answers instead of 401.
    const [auth, session] = await Promise.all([authApi.state(), authApi.session()])
    this.auth = auth
    this.session = session
    this.booted = true
    await this.refreshGateway()
  }

  async logout() {
    // Drop the upstream connection first: the cookie is about to become
    // invalid, and a reconnect attempt in that window would just log noise.
    eventStream.close()
    try {
      await authApi.logout()
    } finally {
      this.session = null
      this.auth = await authApi.state().catch(() => null)
      this.health = null
      this.projects = []
    }
  }
}

export const app = new AppState()
