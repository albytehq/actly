// ─── Store interfaces ─────────────────────────────────────────────────────────

/**
 * Synchronous key-value store. All operations complete in the same tick.
 *
 * # Why synchronous?
 *
 * dedupePolicy must read an in-flight Promise from the store and, if absent,
 * write a new one — all within a single synchronous frame. If get() were async,
 * two concurrent callers could both observe a miss before either write lands,
 * defeating deduplication entirely. There is no lock primitive in JavaScript
 * that can paper over this: the constraint is structural, not implementation-
 * level.
 *
 * # The _sync discriminant
 *
 * `_sync: true` is a runtime tag that lets execute() enforce the dedupe
 * constraint for plain-JS callers who bypass TypeScript. It is NOT part of the
 * semantic contract and MUST NOT be used for anything beyond that guard.
 * Implementations must set it as a `readonly` literal (`true as const`).
 *
 * # Lifecycle
 *
 * Implementations that hold background resources (timers, connections) should
 * expose a `destroy()` method as a convention, though it is not part of this
 * interface — the async counterpart cannot enforce it symmetrically without
 * requiring Promise returns. See InMemoryStore for the reference pattern.
 *
 * InMemoryStore is the canonical implementation of this interface.
 */
export interface SyncStateStore {
  /**
   * Runtime discriminant. Read by isSyncStore() in execute() to enforce the
   * dedupe constraint without an instanceof check. Must be `true as const`.
   */
  readonly _sync: true

  get<T>(key: string): T | undefined
  set<T>(key: string, value: T, ttlMs?: number): void
  delete(key: string): void
  has(key: string): boolean

  /**
   * Remove all entries synchronously.
   * Must be deterministic: after clear() returns, size() must return 0.
   */
  clear(): void

  /**
   * Return the count of live (non-expired) entries.
   * Expired entries must not be counted, but implementations are free to
   * evict lazily — the count must reflect only entries observable via get().
   */
  size(): number
}

/**
 * Asynchronous key-value store. All operations return Promises.
 *
 * # Policy compatibility
 *
 * Compatible with cachePolicy only. Passing an AsyncStateStore to a policy
 * chain that includes dedupePolicy is a TypeScript error and a runtime error —
 * execute() will throw at chain-build time. See SyncStateStore for why dedupe
 * requires synchronous access.
 *
 * # TTL semantics
 *
 * The store is responsible for honouring ttlMs. Actly passes it as a hint.
 * Implementations may delegate to a native TTL mechanism (e.g. Redis EXPIRE).
 * There is no enforcement layer above the store boundary.
 *
 * # The _sync discriminant
 *
 * `_sync: false` mirrors the discriminant on SyncStateStore. The executor uses
 * this at runtime to reject async stores in contexts that require synchronous
 * access. Must be set as a `readonly` literal (`false as const`).
 *
 * # Contract parity
 *
 * clear() and size() mirror the SyncStateStore contract so callers building
 * against AnyStateStore can rely on both operations regardless of which variant
 * they receive. Async implementations that do not have a native equivalent
 * (e.g. a bounded Redis namespace) must still satisfy the signature.
 */
export interface AsyncStateStore {
  /**
   * Runtime discriminant. Must be `false as const`.
   */
  readonly _sync: false

  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>

  /**
   * Remove all entries managed by this store.
   * For scoped adapters (e.g. a Redis key-prefix namespace), remove only the
   * entries owned by this instance — not the entire backing store.
   */
  clear(): Promise<void>

  /**
   * Return the count of live (non-expired) entries.
   * Expired entries must not be counted. For eventually-consistent backends,
   * the count is a best-effort snapshot at the time of the call.
   */
  size(): Promise<number>
}

// ─── Type guards ──────────────────────────────────────────────────────────────

/**
 * Narrows AnyStateStore to SyncStateStore via the _sync discriminant.
 * Used by execute() and cachePolicy to branch between sync and async paths.
 */
export function isSyncStore(store: SyncStateStore | AsyncStateStore): store is SyncStateStore {
  return store._sync === true
}

/**
 * Narrows AnyStateStore to AsyncStateStore via the _sync discriminant.
 * Provided for symmetry; prefer isSyncStore for the common guard pattern.
 */
export function isAsyncStore(store: SyncStateStore | AsyncStateStore): store is AsyncStateStore {
  return store._sync === false
}
