import type { SyncStateStore } from './base.js';
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
     * key to the most-recent position.
     */
    maxSize?: number;
}
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
export declare class InMemoryStore implements SyncStateStore {
    readonly _sync: true;
    private readonly entries;
    private readonly maxSize;
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
     * Pure query — does NOT touch LRU order. Expired entries discovered during
     * the scan are evicted opportunistically (they were already invisible to
     * `get()`, so eviction has no observable effect beyond memory reclamation).
     *
     * Two-pass to avoid mutating the Map during iteration (spec-safe).
     */
    size(): number;
    /**
     * Stop the background cleanup timer and release internal state.
     * Safe to call multiple times — subsequent calls are no-ops.
     */
    destroy(): void;
    /**
     * Sweep all entries and remove those past their expiry time.
     * Called by the autoCleanup interval; not part of the public contract.
     */
    private _sweep;
}
//# sourceMappingURL=memory.d.ts.map