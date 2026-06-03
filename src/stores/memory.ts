import type { SyncStateStore } from './base.js'

// ─── Internal types ───────────────────────────────────────────────────────────

interface Entry<T> {
  value: T
  // null = never expires (used by dedupe's in-flight promises)
  expiresAt: number | null
}

// Node.js timers expose unref() to prevent the event loop from being kept alive
// solely by a housekeeping interval. Browser timers do not. Duck-type the check
// so the same code works in both environments without importing @types/node.
interface UnrefableTimer {
  unref(): void
}

function isUnrefable(t: unknown): t is UnrefableTimer {
  return typeof (t as UnrefableTimer).unref === 'function'
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface InMemoryStoreOptions {
  /**
   * Periodically sweep and remove expired entries in the background.
   *
   * Disabled by default. The store evicts lazily on get()/has() access, which
   * is sufficient for most use cases. Enable autoCleanup when the store is
   * long-lived and accumulates many TTL'd entries that are never re-read — for
   * example, a server-side cache that receives write-heavy traffic with low
   * subsequent read rates.
   *
   * The sweep does not affect observable store semantics: expired entries are
   * already invisible to get()/has()/size() before the sweep runs.
   */
  autoCleanup?: boolean

  /**
   * Interval between background sweeps in milliseconds.
   * Defaults to 30 000 (30 seconds). Ignored when autoCleanup is false.
   *
   * Choose a value appropriate to your TTL distribution — sweeping more often
   * than your shortest TTL is wasteful; sweeping much less often than your
   * longest TTL wastes memory.
   */
  cleanupIntervalMs?: number
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class InMemoryStore implements SyncStateStore {
  // Discriminant read by isSyncStore() in execute() to enforce the dedupe
  // constraint at runtime for JS callers who bypass TypeScript.
  readonly _sync = true as const

  private readonly entries = new Map<string, Entry<unknown>>()
  private cleanupTimer: ReturnType<typeof setInterval> | undefined

  constructor(options: InMemoryStoreOptions = {}) {
    const { autoCleanup = false, cleanupIntervalMs = 30_000 } = options

    if (autoCleanup) {
      const timer = setInterval(() => this._sweep(), cleanupIntervalMs)
      // Prevent the interval from keeping the Node.js process alive when the
      // application has otherwise finished its work. Safe no-op in browsers.
      if (isUnrefable(timer)) timer.unref()
      this.cleanupTimer = timer
    }
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined

    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }

    return entry.value as T
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    // ttlMs = 0 or undefined → no expiry (sentinel null)
    const expiresAt = ttlMs != null && ttlMs > 0 ? Date.now() + ttlMs : null
    this.entries.set(key, { value, expiresAt })
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  has(key: string): boolean {
    // Delegate to get() so expired entries are evicted on access.
    return this.get(key) !== undefined
  }

  /**
   * Remove all entries.
   * After this call, size() returns 0.
   */
  clear(): void {
    this.entries.clear()
  }

  /**
   * Return the count of live (non-expired) entries.
   *
   * Expired entries are evicted during the scan, so repeated calls are
   * slightly cheaper as the map self-prunes. O(n) in the number of entries.
   */
  size(): number {
    // Evict expired entries as we scan — keeps the map tidy between sweeps
    // and ensures the returned count reflects only observable entries.
    for (const key of this.entries.keys()) this.has(key)
    return this.entries.size
  }

  /**
   * Stop the background cleanup timer and release internal state.
   * Safe to call multiple times — subsequent calls are no-ops.
   *
   * Call destroy() when discarding a long-lived store instance to prevent
   * timer leaks. Stores without autoCleanup enabled have nothing to release,
   * but destroy() is safe to call on them regardless.
   */
  destroy(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }

  // Sweep all entries and remove those past their expiry time.
  // Called by the autoCleanup interval — not part of the public contract.
  private _sweep(): void {
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.entries.delete(key)
      }
    }
  }
}
