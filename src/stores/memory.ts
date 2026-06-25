import type { SyncStateStore } from './base.js'

// ─── Internal types ───────────────────────────────────────────────────────────

interface Entry<T> {
  value: T
  // null = never expires (used by dedupe's in-flight promises)
  expiresAt: number | null
}

// Node.js timers expose `unref()` to prevent the event loop from being kept
// alive solely by a housekeeping interval. Browser timers do not. Duck-type
// the check so the same code works in both environments without importing
// `@types/node` at runtime.
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
   * Disabled by default. The store evicts lazily on `get()` / `has()` access,
   * which is sufficient for most use cases. Enable `autoCleanup` when the
   * store is long-lived and accumulates many TTL'd entries that are never
   * re-read — for example, a server-side cache that receives write-heavy
   * traffic with low subsequent read rates.
   */
  autoCleanup?: boolean

  /**
   * Interval between background sweeps in milliseconds.
   * Defaults to 30 000 (30 seconds). Ignored when `autoCleanup` is false.
   */
  cleanupIntervalMs?: number

  /**
   * Maximum number of live entries the store will hold.
   *
   * When `set()` would exceed this limit, the least-recently-used entry is
   * evicted before the new one is inserted (LRU semantics). Updates to an
   * existing key do not trigger eviction.
   *
   * Defaults to `Infinity` (unbounded). Set a finite value for long-running
   * caches with high-cardinality keys to bound memory usage.
   *
   * The LRU order is updated on `get()` and `set()` — both move the accessed
   * key to the most-recent position.
   */
  maxSize?: number
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Reference `SyncStateStore` implementation backed by a `Map`.
 *
 * # LRU semantics
 *
 * `Map` iteration order is insertion order, so we implement LRU by
 * `delete` + `set` on every access — the most-recently-touched key ends up
 * at the end of the iteration, and the oldest is `entries.keys().next().value`.
 *
 * # Expiry
 *
 * Lazy on `get()` / `has()`: expired entries are deleted when touched.
 * Background sweep (optional) reclaims entries that are never re-read.
 */
export class InMemoryStore implements SyncStateStore {
  readonly _sync = true as const

  private readonly entries = new Map<string, Entry<unknown>>()
  private readonly maxSize: number
  private cleanupTimer: ReturnType<typeof setInterval> | undefined

  constructor(options: InMemoryStoreOptions = {}) {
    const {
      autoCleanup = false,
      cleanupIntervalMs = 30_000,
      maxSize = Number.POSITIVE_INFINITY,
    } = options

    if (!Number.isFinite(maxSize) || maxSize <= 0) {
      // Infinity is allowed (unbounded); any other non-positive finite value
      // is a programmer error.
      if (maxSize !== Number.POSITIVE_INFINITY) {
        throw new RangeError(
          `Actly: InMemoryStore maxSize must be a positive finite number or Infinity, got ${maxSize}`,
        )
      }
    }

    this.maxSize = maxSize

    if (autoCleanup) {
      const timer = setInterval(() => this._sweep(), cleanupIntervalMs)
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

    // LRU refresh: move to most-recent position.
    // delete + set is the canonical pattern for reordering a Map.
    this.entries.delete(key)
    this.entries.set(key, entry)

    return entry.value as T
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    // Evict if at capacity AND adding a new key (updates don't grow size).
    if (!this.entries.has(key) && this.entries.size >= this.maxSize) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }

    const expiresAt = ttlMs != null && ttlMs > 0 ? Date.now() + ttlMs : null
    // delete + set ensures the key is moved to the most-recent position
    // even on update, keeping LRU order consistent.
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt })
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  has(key: string): boolean {
    // Inline the expiry check to avoid the LRU side-effect of get().
    // `has()` should be a pure query, not a touch.
    const entry = this.entries.get(key)
    if (!entry) return false
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.entries.delete(key)
      return false
    }
    return true
  }

  clear(): void {
    this.entries.clear()
  }

  /**
   * Return the count of live (non-expired) entries.
   *
   * Pure query — does NOT touch LRU order. Expired entries discovered during
   * the scan are evicted opportunistically (they were already invisible to
   * `get()`, so eviction has no observable effect beyond memory reclamation).
   *
   * Two-pass to avoid mutating the Map during iteration (spec-safe).
   */
  size(): number {
    const now = Date.now()
    const expired: string[] = []
    let count = 0

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        expired.push(key)
      } else {
        count++
      }
    }

    for (const key of expired) this.entries.delete(key)
    return count
  }

  /**
   * Stop the background cleanup timer and release internal state.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  destroy(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }

  /**
   * Sweep all entries and remove those past their expiry time.
   * Called by the autoCleanup interval; not part of the public contract.
   */
  private _sweep(): void {
    const now = Date.now()
    const expired: string[] = []
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        expired.push(key)
      }
    }
    for (const key of expired) this.entries.delete(key)
  }
}
