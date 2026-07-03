import type { SyncStateStore } from './base.js';
export interface InMemoryStoreOptions {
    /**
     * Periodically sweep and remove expired entries in the background.
     *
     * Disabled by default for explicit-store users. The DEFAULT module-level
     * store (used when you call `act()` without `withStore()`) enables this
     * automatically — see `core/act.ts`.
     */
    autoCleanup?: boolean;
    /**
     * Interval between background sweeps in milliseconds.
     * Defaults to 30 000 (30 seconds). Ignored when `autoCleanup` is false.
     */
    cleanupIntervalMs?: number;
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
    maxSize?: number;
}
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
export declare class InMemoryStore implements SyncStateStore {
    readonly _sync: true;
    private readonly map;
    private readonly maxSize;
    private head?;
    private tail?;
    private cleanupTimer;
    constructor(options?: InMemoryStoreOptions);
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttlMs?: number): void;
    delete(key: string): void;
    has(key: string): boolean;
    clear(): void;
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
    size(): number;
    /**
     * Stop the background cleanup timer and release internal state.
     * Safe to call multiple times — subsequent calls are no-ops.
     */
    destroy(): void;
    private _appendTail;
    private _removeNode;
    private _moveToTail;
    /**
     * Sweep all entries and remove those past their expiry time.
     * Called by the autoCleanup interval; not part of the public contract.
     *
     * Two-pass to avoid mutating the Map during iteration (spec-safe).
     */
    private _sweep;
}
/**
 * Factory for the default module-level store.
 *
 * Bounded by `LIMITS.DEFAULT_STORE_MAX_SIZE` with background sweep —
 * prevents unbounded memory growth in long-running servers without
 * requiring callers to opt in.
 */
export declare function createDefaultStore(): InMemoryStore;
//# sourceMappingURL=memory.d.ts.map