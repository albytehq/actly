/**
 * Synchronous key-value store. All operations complete in the same tick.
 *
 * # Why synchronous?
 *
 * `dedupePolicy` must read an in-flight Promise from the store and, if absent,
 * write a new one — all within a single synchronous frame. If `get()` were
 * async, two concurrent callers could both observe a miss before either
 * write lands, defeating deduplication entirely. There is no lock primitive
 * in JavaScript that can paper over this: the constraint is structural, not
 * implementation-level.
 *
 * # The `_sync` discriminant
 *
 * `_sync: true` is a runtime tag that lets `execute()` enforce the dedupe
 * constraint for plain-JS callers who bypass TypeScript. It is NOT part of
 * the semantic contract and MUST NOT be used for anything beyond that guard.
 * Implementations must set it as a `readonly` literal (`true as const`).
 *
 * # Lifecycle
 *
 * Implementations that hold background resources (timers, connections) should
 * expose a `destroy()` method as a convention. See `InMemoryStore` for the
 * reference pattern.
 */
export interface SyncStateStore {
    /** Runtime discriminant. Must be `true as const`. */
    readonly _sync: true;
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttlMs?: number): void;
    delete(key: string): void;
    has(key: string): boolean;
    /**
     * Remove all entries synchronously.
     * After `clear()` returns, `size()` returns 0.
     */
    clear(): void;
    /**
     * Return the count of live (non-expired) entries.
     * Side-effect free: does not mutate the store. Implementations MAY evict
     * expired entries opportunistically during this call, but MUST NOT have
     * observable side effects beyond internal cleanup.
     */
    size(): number;
}
/**
 * Asynchronous key-value store. All operations return Promises.
 *
 * # Policy compatibility
 *
 * Compatible with `cachePolicy` only. Passing an `AsyncStateStore` to a
 * policy chain that includes `dedupePolicy` is a TypeScript error and a
 * runtime error — `execute()` throws at chain-build time. See
 * `SyncStateStore` for why dedupe requires synchronous access.
 *
 * # TTL semantics
 *
 * The store is responsible for honouring `ttlMs`. Actly passes it as a hint.
 * Implementations may delegate to a native TTL mechanism (e.g. Redis EXPIRE).
 *
 * # The `_sync` discriminant
 *
 * `_sync: false` mirrors the discriminant on `SyncStateStore`. Must be set
 * as a `readonly` literal (`false as const`).
 */
export interface AsyncStateStore {
    /** Runtime discriminant. Must be `false as const`. */
    readonly _sync: false;
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
    delete(key: string): Promise<void>;
    has(key: string): Promise<boolean>;
    /** Remove all entries managed by this store. */
    clear(): Promise<void>;
    /** Return the count of live (non-expired) entries. */
    size(): Promise<number>;
}
/**
 * Narrows `AnyStateStore` to `SyncStateStore` via the `_sync` discriminant.
 * Used by `execute()` and `cachePolicy` to branch between sync and async paths.
 */
export declare function isSyncStore(store: SyncStateStore | AsyncStateStore): store is SyncStateStore;
/**
 * Narrows `AnyStateStore` to `AsyncStateStore` via the `_sync` discriminant.
 * Provided for symmetry; prefer `isSyncStore` for the common guard pattern.
 */
export declare function isAsyncStore(store: SyncStateStore | AsyncStateStore): store is AsyncStateStore;
//# sourceMappingURL=base.d.ts.map