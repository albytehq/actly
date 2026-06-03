import type { SyncStateStore } from './base.js';
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
    autoCleanup?: boolean;
    /**
     * Interval between background sweeps in milliseconds.
     * Defaults to 30 000 (30 seconds). Ignored when autoCleanup is false.
     *
     * Choose a value appropriate to your TTL distribution — sweeping more often
     * than your shortest TTL is wasteful; sweeping much less often than your
     * longest TTL wastes memory.
     */
    cleanupIntervalMs?: number;
}
export declare class InMemoryStore implements SyncStateStore {
    readonly _sync: true;
    private readonly entries;
    private cleanupTimer;
    constructor(options?: InMemoryStoreOptions);
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttlMs?: number): void;
    delete(key: string): void;
    has(key: string): boolean;
    /**
     * Remove all entries.
     * After this call, size() returns 0.
     */
    clear(): void;
    /**
     * Return the count of live (non-expired) entries.
     *
     * Expired entries are evicted during the scan, so repeated calls are
     * slightly cheaper as the map self-prunes. O(n) in the number of entries.
     */
    size(): number;
    /**
     * Stop the background cleanup timer and release internal state.
     * Safe to call multiple times — subsequent calls are no-ops.
     *
     * Call destroy() when discarding a long-lived store instance to prevent
     * timer leaks. Stores without autoCleanup enabled have nothing to release,
     * but destroy() is safe to call on them regardless.
     */
    destroy(): void;
    private _sweep;
}
//# sourceMappingURL=memory.d.ts.map