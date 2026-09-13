import type { SyncStateStore } from './contract.js'
import { LIMITS } from '../limits.js'

interface Entry<T> {
  value: T
  /** null = never expires. */
  expiresAt: number | null
  /** Wall-clock insertion time, reported by cachePolicy as ageMs. */
  insertedAt: number
  prev?: LRUNode
  next?: LRUNode
  key: string
}

type LRUNode = Entry<unknown>

interface UnrefableTimer {
  unref(): void
}

function isUnrefable(t: unknown): t is UnrefableTimer {
  return typeof (t as UnrefableTimer).unref === 'function'
}

export interface InMemoryStoreOptions {
  /**
   * Periodically sweep expired entries in the background. Off by default;
   * the module-level default store enables it.
   */
  autoCleanup?: boolean
  /** Sweep interval in ms. Default 30 000. Ignored when autoCleanup is false. */
  cleanupIntervalMs?: number
  /**
   * Max live entries; `set()` evicts the least-recently-used on overflow.
   * LRU order refreshes on `get()` and `set()` in O(1). Default
   * `LIMITS.DEFAULT_STORE_MAX_SIZE` (10 000). Pass `Infinity` for unbounded.
   */
  maxSize?: number
  /**
   * Sweep immediately on Node 22+ `memory` pressure events. No-op on older
   * runtimes. Default off.
   */
  memoryPressureCleanup?: boolean
}

/**
 * Reference `SyncStateStore`: a Map plus a doubly-linked list for O(1) LRU.
 * Expiry is lazy on `get()`/`has()`; the optional background sweep reclaims
 * entries that are never re-read. A FinalizationRegistry clears the sweep
 * timer if the store is GC'd without `destroy()`.
 */
export class InMemoryStore implements SyncStateStore {
  readonly _sync = true as const

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
  private head?: LRUNode
  private tail?: LRUNode
  private cleanupTimer: ReturnType<typeof setInterval> | undefined
  private memoryListener: ((...args: unknown[]) => void) | undefined

  constructor(options: InMemoryStoreOptions = {}) {
    const {
      autoCleanup = false,
      cleanupIntervalMs = 30_000,
      maxSize = LIMITS.DEFAULT_STORE_MAX_SIZE,
      memoryPressureCleanup = false,
    } = options

    if (maxSize !== Number.POSITIVE_INFINITY) {
      if (!Number.isFinite(maxSize) || maxSize <= 0 || !Number.isInteger(maxSize)) {
        throw new RangeError(
          `Actly: InMemoryStore maxSize must be a positive integer or Infinity, got ${maxSize}`,
        )
      }
    }

    this.maxSize = maxSize

    if (autoCleanup) {
      const timer = setInterval(() => this.sweep(), cleanupIntervalMs)
      if (isUnrefable(timer)) timer.unref()
      this.cleanupTimer = timer
      InMemoryStore.finalizer?.register(this, timer, this)
    }

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
      existing.expiresAt = ttlMs != null && Number.isFinite(ttlMs) && ttlMs > 0 ? now + ttlMs : null
      existing.insertedAt = now
      this.moveToTail(existing)
      return
    }

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
   * Live entry count, O(1). Expired-but-unvisited entries are counted until
   * reclaimed lazily or by the sweep.
   */
  size(): number {
    return this.map.size
  }

  /**
   * Stop the cleanup timer, drop the memory listener, and clear all entries.
   * Safe to call multiple times.
   */
  destroy(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
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

  // LRU list operations, all O(1); the list runs head (LRU) → tail (MRU).

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
   * Sweep expired entries. Two passes to avoid mutating the Map during
   * iteration; failures are swallowed so a corrupted entry can never kill
   * the process from a timer callback.
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
      // next sweep retries
    }
  }
}

/**
 * Module-level default store: bounded, with a background sweep, so
 * long-running servers cannot grow memory unbounded by default.
 */
export function createDefaultStore(): InMemoryStore {
  return new InMemoryStore({
    maxSize: LIMITS.DEFAULT_STORE_MAX_SIZE,
    autoCleanup: true,
    cleanupIntervalMs: LIMITS.DEFAULT_STORE_CLEANUP_INTERVAL_MS,
  })
}
