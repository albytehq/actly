import type { SyncStateStore } from './base.js'
import { LIMITS } from '../utils/limits.js'

// ─── Internal types ───────────────────────────────────────────────────────────

interface Entry<T> {
  value: T
  // null = never expires (used by dedupe's in-flight promises).
  expiresAt: number | null
  // Wall-clock insertion time, used by cachePolicy for accurate ageMs.
  insertedAt: number
  // LRU doubly-linked list pointers. Undefined at head/tail.
  prev?: LRUNode
  next?: LRUNode
  key: string
}

// The LRU list uses Entry nodes directly - aliased for readability.
type LRUNode = Entry<unknown>

// Node.js timers expose unref(); browser timers don't. Duck-type the check
// so the same code runs in both.
interface UnrefableTimer {
  unref(): void
}

function isUnrefable(t: unknown): t is UnrefableTimer {
  return typeof (t as UnrefableTimer).unref === 'function'
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface InMemoryStoreOptions {
  /**
   * Periodically sweep expired entries in the background. Off by default
   * for explicit-store users; the module-level default store enables it.
   */
  autoCleanup?: boolean

  /** Sweep interval in ms. Default 30 000. Ignored when autoCleanup is false. */
  cleanupIntervalMs?: number

  /**
   * Max live entries. On overflow, set() evicts the least-recently-used
   * first. Updates to an existing key don't trigger eviction. The LRU
   * order refreshes on both get() and set() via an O(1) linked-list move.
   *
   * Default is bounded (LIMITS.DEFAULT_STORE_MAX_SIZE, 10 000). Pass
   * `Infinity` for unbounded storage - pair with autoCleanup.
   */
  maxSize?: number

  /**
   * React to Node.js memory-pressure events by sweeping immediately. On
   * Node 22+ V8 emits a 'memory' warning at the lowest-pressure tier;
   * this sweeps expired entries proactively before GC pressure becomes
   * critical. No-op on older runtimes. Default off.
   */
  memoryPressureCleanup?: boolean
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Reference SyncStateStore backed by a Map + doubly-linked list for LRU.
 *
 * `size()` is O(1) (tracked via Map.size). LRU reordering uses the
 * linked list instead of delete+set Map churn. Default maxSize is bounded
 * when used as the module-level default.
 *
 * Expiry is lazy on get()/has(); the optional background sweep reclaims
 * entries that are never re-read.
 */
export class InMemoryStore implements SyncStateStore {
  readonly _sync = true as const

  /**
   * Auto-clear the cleanup interval when the store is GC'd, so a
   * forgotten destroy() doesn't leak the timer + Map + entries for the
   * process lifetime. FinalizationRegistry is available in Node 14.5+
   * and modern browsers; in environments without it, this is a no-op
   * and the caller must remember destroy().
   */
  private static finalizer: FinalizationRegistry<ReturnType<typeof setInterval>> | undefined
  static {
    if (typeof FinalizationRegistry === 'function') {
      InMemoryStore.finalizer = new FinalizationRegistry((timer) => {
        try { clearInterval(timer) } catch { /* already cleared */ }
      })
    }
  }

  private readonly map = new Map<string, LRUNode>()
  private readonly maxSize: number
  private head?: LRUNode  // least recently used
  private tail?: LRUNode  // most recently used
  private cleanupTimer: ReturnType<typeof setInterval> | undefined
  private memoryListener: ((...args: unknown[]) => void) | undefined

  constructor(options: InMemoryStoreOptions = {}) {
    const {
      autoCleanup = false,
      cleanupIntervalMs = 30_000,
      maxSize = LIMITS.DEFAULT_STORE_MAX_SIZE,
      memoryPressureCleanup = false,
    } = options

    if (!Number.isFinite(maxSize) || maxSize <= 0) {
      // Infinity is allowed (unbounded); anything else non-positive is a bug.
      if (maxSize !== Number.POSITIVE_INFINITY) {
        throw new RangeError(
          `Actly: InMemoryStore maxSize must be a positive finite number or Infinity, got ${maxSize}`,
        )
      }
    }
    // Reject non-integer maxSize - fractional sizes produce surprising
    // eviction behaviour.
    if (maxSize !== Number.POSITIVE_INFINITY && !Number.isInteger(maxSize)) {
      throw new RangeError(
        `Actly: InMemoryStore maxSize must be a positive integer or Infinity, got ${maxSize}`,
      )
    }

    this.maxSize = maxSize

    if (autoCleanup) {
      const timer = setInterval(() => this.sweep(), cleanupIntervalMs)
      if (isUnrefable(timer)) timer.unref()
      this.cleanupTimer = timer
      // Register so the timer is cleared even if the caller forgets destroy().
      InMemoryStore.finalizer?.register(this, timer, this)
    }

    // Node 22+ memory-pressure hook. The 'memory' event doesn't exist on
    // older versions - the listener simply never fires there.
    if (memoryPressureCleanup) {
      const processOn = (process as unknown as {
        on?: (event: string, listener: (...args: unknown[]) => void) => void
      }).on
      if (typeof processOn === 'function') {
        const memoryListener = () => {
          try { this.sweep() } catch { /* never crash on housekeeping */ }
        }
        processOn.call(process, 'memory', memoryListener)
        this.memoryListener = memoryListener
      }
    }
  }

  get<T>(key: string): T | undefined {
    const node = this.map.get(key)
    if (!node) return undefined

    if (node.expiresAt !== null && Date.now() > node.expiresAt) {
      this.removeNode(node)
      this.map.delete(key)
      return undefined
    }

    this.moveToTail(node)
    return node.value as T
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    const existing = this.map.get(key)
    const now = Date.now()

    if (existing) {
      existing.value = value
      // Treat Infinity, null, 0, negative as "no expiry". Normalising to
      // null avoids surprising code that reads expiresAt directly.
      existing.expiresAt = ttlMs != null && Number.isFinite(ttlMs) && ttlMs > 0 ? now + ttlMs : null
      existing.insertedAt = now
      this.moveToTail(existing)
      return
    }

    // New key - evict LRU entries while at capacity.
    while (this.map.size >= this.maxSize && this.head) {
      const evict = this.head
      this.removeNode(evict)
      this.map.delete(evict.key)
    }

    const node: LRUNode = {
      key,
      value,
      expiresAt: ttlMs != null && Number.isFinite(ttlMs) && ttlMs > 0 ? now + ttlMs : null,
      insertedAt: now,
    }
    this.map.set(key, node)
    this.appendTail(node)
  }

  delete(key: string): void {
    const node = this.map.get(key)
    if (!node) return
    this.removeNode(node)
    this.map.delete(key)
  }

  has(key: string): boolean {
    // Inline the expiry check - has() must be a pure query, not a touch.
    const node = this.map.get(key)
    if (!node) return false
    if (node.expiresAt !== null && Date.now() > node.expiresAt) {
      this.removeNode(node)
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
   * Live entry count. O(1) - returns Map.size directly. Expired-but-
   * not-yet-evicted entries are counted; they're reclaimed lazily on
   * next access or by the background sweep. An accurate count would
   * need an O(n) scan.
   */
  size(): number {
    return this.map.size
  }

  /**
   * Stop the cleanup timer and release internal state. Safe to call
   * multiple times. Clears the Map and LRU pointers so the GC can
   * reclaim entry values (including any closures over pending Promise
   * resolvers or AbortController refs held by cache/dedupe/bulkhead).
   */
  destroy(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
      // Unregister so the finalizer doesn't try to clear twice after GC.
      InMemoryStore.finalizer?.unregister(this)
    }
    if (this.memoryListener) {
      const processOff = (process as unknown as {
        off?: (event: string, listener: (...args: unknown[]) => void) => void
      }).off
      if (typeof processOff === 'function') {
        processOff.call(process, 'memory', this.memoryListener)
      }
      this.memoryListener = undefined
    }
    this.map.clear()
    this.head = undefined
    this.tail = undefined
  }

  // ─── LRU list operations ──────────────────────────────────────────────────
  //
  // All O(1). The list runs head (LRU) → tail (MRU).

  private appendTail(node: LRUNode): void {
    if (this.tail) {
      this.tail.next = node
      node.prev = this.tail
      node.next = undefined
    } else {
      this.head = node
    }
    this.tail = node
  }

  private removeNode(node: LRUNode): void {
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

  private moveToTail(node: LRUNode): void {
    if (this.tail === node) return
    this.removeNode(node)
    this.appendTail(node)
  }

  /**
   * Sweep expired entries. Two-pass to avoid mutating the Map during
   * iteration. Wrapped in try/catch - a corrupted entry must never kill
   * the process via uncaughtException from a setInterval callback.
   */
  private sweep(): void {
    try {
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
          this.removeNode(node)
          this.map.delete(key)
        }
      }
    } catch {
      // Swallow - the next sweep will retry.
    }
  }
}

/**
 * Factory for the default module-level store. Bounded by
 * LIMITS.DEFAULT_STORE_MAX_SIZE with background sweep, so long-running
 * servers don't grow memory unbounded without opting in.
 */
export function createDefaultStore(): InMemoryStore {
  return new InMemoryStore({
    maxSize: LIMITS.DEFAULT_STORE_MAX_SIZE,
    autoCleanup: true,
    cleanupIntervalMs: LIMITS.DEFAULT_STORE_CLEANUP_INTERVAL_MS,
  })
}
