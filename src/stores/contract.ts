/**
 * Synchronous key-value store contract.
 *
 * `dedupePolicy` reads an in-flight promise and writes a new one in the same
 * synchronous frame; an async get() would let two callers both miss, which
 * no JS lock can prevent. The `_sync: true` discriminant lets `execute()`
 * enforce this at runtime for JS callers.
 *
 * Implementations holding background resources (timers, connections) should
 * expose `destroy()`.
 */
export interface SyncStateStore {
  readonly _sync: true

  get<T>(key: string): T | undefined
  set<T>(key: string, value: T, ttlMs?: number): void
  delete(key: string): void
  has(key: string): boolean

  /**
   * Atomically delete `key` if it exists; returns true if removed. Optional;
   * implementations with a native atomic delete (e.g. Redis DEL) should
   * override it, otherwise `invalidate()` falls back to has()+delete().
   */
  deleteIfExists?(key: string): boolean

  clear(): void
  size(): number
  destroy?(): void
}

/**
 * Asynchronous key-value store contract. Compatible with `cachePolicy`
 * only: passing an AsyncStateStore to a chain containing `dedupePolicy`
 * fails at runtime. The store is responsible for honouring `ttlMs`.
 */
export interface AsyncStateStore {
  readonly _sync: false

  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>

  deleteIfExists?(key: string): Promise<boolean>

  clear(): Promise<void>
  size(): Promise<number>
  destroy?(): void | Promise<void>
}

export function isSyncStore(
  store: SyncStateStore | AsyncStateStore,
): store is SyncStateStore {
  return store._sync === true
}

export function isAsyncStore(
  store: SyncStateStore | AsyncStateStore,
): store is AsyncStateStore {
  return store._sync === false
}
