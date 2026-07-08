// ─── Store interfaces ─────────────────────────────────────────────────────────

/**
 * Synchronous key-value store.
 *
 * `dedupePolicy` reads an in-flight Promise and writes a new one in the
 * same synchronous frame; an async get() would let two callers both miss
 * before either write lands, defeating deduplication. There's no JS lock
 * that can paper over that - the constraint is structural.
 *
 * `readonly _sync: true` is a runtime tag execute() uses to enforce the
 * dedupe constraint for plain-JS callers who bypass TypeScript. Set it as
 * `true as const`; it's not part of the semantic contract.
 *
 * Implementations holding background resources (timers, connections)
 * should expose a `destroy()`. See InMemoryStore for the reference pattern.
 */
export interface SyncStateStore {
  /** Runtime discriminant. Must be `true as const`. */
  readonly _sync: true

  get<T>(key: string): T | undefined
  set<T>(key: string, value: T, ttlMs?: number): void
  delete(key: string): void
  has(key: string): boolean

  /**
   * Atomically delete `key` if it exists. Returns true if removed.
   *
   * Optional - implementations with a native atomic delete-and-return
   * (e.g. Redis DEL) should override this. The default fallback in
   * withStore's invalidate() uses has()+delete() which has a TOCTOU race.
   */
  deleteIfExists?(key: string): boolean

  /** Remove all entries synchronously. */
  clear(): void

  /**
   * Count of live (non-expired) entries. Side-effect free apart from
   * optional opportunistic eviction of expired entries.
   */
  size(): number

  /**
   * Release internal resources (timers, connections, listeners). Safe to
   * call multiple times. Optional - omit only when the store holds no
   * background resources.
   */
  destroy?(): void
}

/**
 * Asynchronous key-value store. All operations return Promises.
 *
 * Compatible with `cachePolicy` only - passing an AsyncStateStore to a
 * chain with `dedupePolicy` is a runtime error. See SyncStateStore for
 * why dedupe requires synchronous access.
 *
 * The store is responsible for honouring `ttlMs`; actly passes it as a
 * hint. Implementations may delegate to a native TTL (e.g. Redis EXPIRE).
 *
 * `readonly _sync: false` mirrors the discriminant on SyncStateStore.
 */
export interface AsyncStateStore {
  /** Runtime discriminant. Must be `false as const`. */
  readonly _sync: false

  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>

  /**
   * Atomically delete `key` if it exists. Returns true if removed.
   * Optional - see SyncStateStore.deleteIfExists.
   */
  deleteIfExists?(key: string): Promise<boolean>

  /** Remove all entries managed by this store. */
  clear(): Promise<void>

  /** Count of live (non-expired) entries. */
  size(): Promise<number>

  /**
   * Release internal resources. Safe to call multiple times. Optional -
   * omit only when the store holds no background resources.
   */
  destroy?(): void | Promise<void>
}

// ─── Type guards ──────────────────────────────────────────────────────────────

/**
 * Narrows to SyncStateStore via the `_sync` discriminant. Used by
 * execute() and cachePolicy to branch sync vs async paths.
 */
export function isSyncStore(
  store: SyncStateStore | AsyncStateStore,
): store is SyncStateStore {
  return store._sync === true
}

/**
 * Narrows to AsyncStateStore. Provided for symmetry; prefer isSyncStore
 * for the common guard pattern.
 */
export function isAsyncStore(
  store: SyncStateStore | AsyncStateStore,
): store is AsyncStateStore {
  return store._sync === false
}
