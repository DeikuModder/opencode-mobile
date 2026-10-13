/**
 * Fixed-window request counter.
 *
 * Written by hand rather than using @nestjs/throttler for one specific reason:
 * that service keeps hit expiries in a private map alongside the counter map,
 * so clearing the counters resurrects them on the next increment. That makes
 * rate limiting effectively untestable without waiting out a real window, and
 * untestable security-relevant code tends to be untested security-relevant
 * code.
 *
 * The trade-off is deliberate: this is O(memory) in distinct keys, single
 * process only, and loses precision at window edges (up to 2x burst across a
 * boundary). For "stop a password-guessing flood" that is entirely adequate.
 */
export interface WindowResult {
  count: number
  limited: boolean
  /** Seconds until the current window ends. */
  resetSeconds: number
  /** Seconds to wait before retrying; 0 when not limited. */
  retryAfterSeconds: number
}

interface Window {
  count: number
  resetAt: number
}

/**
 * Above this many live keys, `hit` sweeps expired entries before inserting.
 *
 * The key is "<ip>:<path>", so a flood from many source addresses is enough to
 * grow the map without bound — an unauthenticated attacker controls that input
 * directly. Sweeping on a timer instead would need a handle to clean up on
 * shutdown and a way to keep it out of the test process; a threshold check costs
 * one integer comparison and cannot leak a timer.
 */
const SWEEP_THRESHOLD = 10_000

/**
 * Hard ceiling on tracked keys.
 *
 * SWEEP_THRESHOLD alone is not a bound: a flood of distinct keys inside a single
 * window is all unexpired, so sweeping reclaims nothing and the map keeps growing
 * for the whole window. An unauthenticated attacker controls the key (it is
 * "<ip>:<path>") and can generate millions, so the cap has to be enforced, not
 * just the sweep.
 *
 * When full, the oldest-inserted window is evicted. Evicting a live counter means
 * one bucket starts over, which is the correct trade: the alternative is unbounded
 * memory growth, and a flood that reaches this size is already being rejected by
 * the per-bucket limit.
 */
const MAX_KEYS = 100_000

/** Minimum wall-clock gap between opportunistic sweeps. */
const SWEEP_INTERVAL_MS = 1_000

export class FixedWindowStore {
  private readonly windows = new Map<string, Window>()
  /** When the last opportunistic sweep ran, for amortisation. */
  private lastSweepAt = 0

  hit(key: string, limit: number, windowMs: number, now = Date.now()): WindowResult {
    // Amortised by time, not by size. Sweeping whenever the map merely passes a
    // size threshold is O(n) on *every* subsequent insert, so a flood of N keys
    // costs O(N^2) — and the component that has to stay fast under attack is the
    // rate limiter. Gating on elapsed time keeps the total cost proportional to
    // the number of seconds that actually elapsed.
    if (this.windows.size >= SWEEP_THRESHOLD && now - this.lastSweepAt >= SWEEP_INTERVAL_MS) {
      this.sweep(now)
    }

    let window = this.windows.get(key)
    if (!window || window.resetAt <= now) {
      // A brand new key and an expired one both start a fresh window, so the
      // count must reset in both cases. Reusing the old object and only sliding
      // resetAt would carry the previous window's count forward, which makes an
      // expired key stay limited and is exactly what a rate limiter must not do.
      if (!window && this.windows.size >= MAX_KEYS) {
        // Only a genuinely new key can push past the cap; a hit on an existing key
        // never grows the map.
        this.evictOne()
      }
      window = { count: 0, resetAt: now + windowMs }
      this.windows.set(key, window)
    }
    window.count += 1

    const remainingMs = window.resetAt - now
    return {
      count: window.count,
      limited: window.count > limit,
      resetSeconds: Math.ceil(remainingMs / 1000),
      retryAfterSeconds: window.count > limit ? Math.ceil(remainingMs / 1000) : 0,
    }
  }

  /**
   * Drops expired windows so idle keys do not accumulate.
   *
   * Records the sweep time, because an explicit call should also reset the
   * amortisation clock; otherwise a manual sweep followed by a size-triggered
   * one would double up the work.
   */
  sweep(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key)
    }
    this.lastSweepAt = now
  }

  /**
   * Make room for one more key by dropping the oldest-inserted entry.
   *
   * Map iteration is insertion order, so the first key is the oldest and deleting
   * it is O(1).
   *
   * This deliberately does not sweep first. Sweeping here would be O(n) on every
   * insert past the cap, which is exactly the quadratic behaviour this exists to
   * avoid: the cap already bounds memory, and `hit` sweeps on a time interval, so
   * expired entries are reclaimed shortly anyway.
   */
  private evictOne(): void {
    for (const key of this.windows.keys()) {
      this.windows.delete(key)
      return
    }
  }

  get size(): number {
    return this.windows.size
  }

  /** Test seam. */
  clear(): void {
    this.windows.clear()
  }
}
