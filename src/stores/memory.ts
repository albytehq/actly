import type { SyncStateStore } from './base.js'
import { LIMITS } from '../utils/limits.js'

// ─── Internal types ───────────────────────────────────────────────────────────

interface Entry<T> {
  value: T
  // null = never expires (used by dedupe's in-flight promises)
  expiresAt: number | null
  // Wall-clock timestamp when this entry was inserted/updated.
  // Used by cachePolicy to report accurate `ageMs` in onCacheHit events.
  insertedAt: number
  // LRU doubly-linked list pointers. Undefined at the head/tail.
  prev?: LRUNode
  next?: LRUNode
  key: string
}

// `Entry` IS the node — aliased for readability in the LRU list code.
type LRUNode = Entry<unknown>

// Node.js timers expose `unref()` to prevent the event loop from being kept
// alive solely by a housekeeping interval. Browser timers do not. Duck-type
// the check so the same code works in both environments.
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
   * Disabled by default for explicit-store users. The DEFAULT module-level
   * store (used when you call `act()` without `withStore()`) enables this
   * automatically — see `core/act.ts`.
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
   * key to the most-recent position. Implementation uses a doubly-linked
   * list for O(1) reordering (no `delete + set` Map churn).
   */
  maxSize?: number
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Reference `SyncStateStore` implementation backed by a `Map` + doubly-linked
 * list for LRU.
 *
 * # Properties
 *
 *  - `size()` is O(1) — tracked via a counter instead of full scan.
 *  - LRU reordering uses an explicit doubly-linked list, avoiding the
 *    `delete + set` Map churn that was 2 Map operations per `get()`.
 *  - Default `maxSize` is bounded (`LIMITS.DEFAULT_STORE_MAX_SIZE`) when
 *    used as the module-level default — prevents unbounded memory growth
 *    in long-running servers.
 *
 * # Expiry
 *
 * Lazy on `get()` / `has()`: expired entries are deleted when touched.
 * Background sweep (optional) reclaims entries that are never re-read.
 */
export class InMemoryStore implements SyncStateStore {
  readonly _sync = true as const

  private readonly map = new Map<string, LRUNode>()
  private readonly maxSize: number
  private head?: LRUNode  // least recently used
  private tail?: LRUNode  // most recently used
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
    const node = this.map.get(key)
    if (!node) return undefined

    if (node.expiresAt !== null && Date.now() > node.expiresAt) {
      this._removeNode(node)
      this.map.delete(key)
      return undefined
    }

    // LRU refresh: move to tail (most-recent).
    this._moveToTail(node)

    return node.value as T
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    const existing = this.map.get(key)
    const now = Date.now()

    if (existing) {
      // Update in place — don't grow size, don't evict.
      existing.value = value
      existing.expiresAt = ttlMs != null && ttlMs > 0 ? now + ttlMs : null
      existing.insertedAt = now
      this._moveToTail(existing)
      return
    }

    // New key — evict if at capacity.
    while (this.map.size >= this.maxSize && this.head) {
      const evict = this.head
      this._removeNode(evict)
      this.map.delete(evict.key)
    }

    const node: LRUNode = {
      key,
      value,
      expiresAt: ttlMs != null && ttlMs > 0 ? now + ttlMs : null,
      insertedAt: now,
    }
    this.map.set(key, node)
    this._appendTail(node)
  }

  delete(key: string): void {
    const node = this.map.get(key)
    if (!node) return
    this._removeNode(node)
    this.map.delete(key)
  }

  has(key: string): boolean {
    // Inline the expiry check to avoid the LRU side-effect of get().
    // `has()` should be a pure query, not a touch.
    const node = this.map.get(key)
    if (!node) return false
    if (node.expiresAt !== null && Date.now() > node.expiresAt) {
      this._removeNode(node)
      this.map.delete(key)
      return false
    }
    return true
  }

  clear(): void {
    this.map.clear()
    this.head = undefined
    this.tail = undefined
  }

  /**
   * Return the count of live (non-expired) entries.
   *
   * O(1) — returns the Map size directly. Expired-but-not-yet-
   * evicted entries are counted; they're reclaimed lazily on next access
   * or by the background sweep. This is intentional: a fully-accurate
   * count would require an O(n) scan, defeating the purpose.
   *
   * Pure query — does NOT touch LRU order.
   */
  size(): number {
    return this.map.size
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

  // ─── LRU list operations ──────────────────────────────────────────────────
  //
  // All operations are O(1). The list runs head (LRU) → tail (MRU).

  private _appendTail(node: LRUNode): void {
    if (this.tail) {
      this.tail.next = node
      node.prev = this.tail
      node.next = undefined
    } else {
      // Empty list — node is both head and tail.
      this.head = node
    }
    this.tail = node
  }

  private _removeNode(node: LRUNode): void {
    if (node.prev) {
      node.prev.next = node.next
    } else {
      this.head = node.next
    }
    if (node.next) {
      node.next.prev = node.prev
    } else {
      this.tail = node.prev
    }
    node.prev = undefined
    node.next = undefined
  }

  private _moveToTail(node: LRUNode): void {
    if (this.tail === node) return  // already MRU
    this._removeNode(node)
    this._appendTail(node)
  }

  /**
   * Sweep all entries and remove those past their expiry time.
   * Called by the autoCleanup interval; not part of the public contract.
   *
   * Two-pass to avoid mutating the Map during iteration (spec-safe).
   */
  private _sweep(): void {
    const now = Date.now()
    const expired: string[] = []
    for (const [key, node] of this.map) {
      if (node.expiresAt !== null && now > node.expiresAt) {
        expired.push(key)
      }
    }
    for (const key of expired) {
      const node = this.map.get(key)
      if (node) {
        this._removeNode(node)
        this.map.delete(key)
      }
    }
  }
}

/**
 * Factory for the default module-level store.
 *
 * Bounded by `LIMITS.DEFAULT_STORE_MAX_SIZE` with background sweep —
 * prevents unbounded memory growth in long-running servers without
 * requiring callers to opt in.
 */
export function createDefaultStore(): InMemoryStore {
  return new InMemoryStore({
    maxSize: LIMITS.DEFAULT_STORE_MAX_SIZE,
    autoCleanup: true,
    cleanupIntervalMs: LIMITS.DEFAULT_STORE_CLEANUP_INTERVAL_MS,
  })
}
