import type {
  ActFn,
  ActOptions,
  ActResult,
  AnyStateStore,
  SyncStateStore,
  AsyncStateStore,
} from '../types.js'
import { runAct } from './engine.js'
import { registerStoreScope } from './health.js'
import { createDefaultStore } from '../stores/memory.js'
import { isSyncStore } from '../stores/contract.js'
import { assertKey, assertOptions } from '../validate.js'
import { generateScopeId } from './time.js'

// Module-level default store: bounded (10k entries, 60s sweep) so
// long-running servers do not leak. Pass a custom store via withStore().
const defaultStore = createDefaultStore()

const CACHE_NS = 'cache:'

/**
 * Execute `fn` under the reliability policies in `options`.
 *
 * Programmer errors (invalid key or options) throw synchronously; runtime
 * failures always resolve to `ActResult` — this function never rejects on
 * runtime errors. Check `result.ok` before reading `result.value`.
 *
 * @param key     Stable identifier; scopes dedupe + cache.
 * @param fn      Async work. Receives an AbortSignal for cooperative
 *                cancellation; a legacy `() => Promise<T>` also works.
 * @param options All fields optional; none set means the fast path.
 * @returns       ActResult<T>
 *
 * @example
 * const result = await act('user:42', async (signal) => {
 *   return fetch(`/api/users/42`, { signal })
 * }, {
 *   retry:   { attempts: 3, delayMs: 200, backoff: 'exponential' },
 *   timeout: { ms: 5_000 },
 *   dedupe:  true,
 *   cache:   { ttl: 60_000 },
 * })
 * if (result.ok) console.log(result.value, result.source, result.attempts)
 * else console.error(result.error)
 */
export function act<T>(
  key: string,
  fn: ActFn<T>,
  options: ActOptions<T> = {},
): Promise<ActResult<T>> {
  assertKey(key)
  assertOptions(options)
  return runAct(defaultStore, 'default', key, fn, options)
}

/**
 * Invalidate the cached value for `key` on the default store. Only clears
 * the cache slot; in-flight dedupe entries settle on their own.
 * @returns true if a cache entry was removed.
 *
 * @example
 * await act('user:42', () => fetchUser(42), { cache: { ttl: 60_000 } })
 * invalidate('user:42') // next call re-fetches
 */
export function invalidate(key: string): boolean {
  assertKey(key)
  const cacheKey = CACHE_NS + key
  const existed = defaultStore.has(cacheKey)
  defaultStore.delete(cacheKey)
  return existed
}

/** Result of `withStore()` for a sync store: `act` + sync `invalidate`. */
export interface ScopedActSync {
  <T>(key: string, fn: ActFn<T>, options?: ActOptions<T>): Promise<ActResult<T>>
  invalidate(key: string): boolean
  /** The store this scope is bound to. */
  readonly store: AnyStateStore
  /**
   * The internal scope string this scoped `act()` writes health/drain state
   * under. Pass to `createHealthCheck(store, { scope })` for explicit
   * wiring, or rely on auto-resolution via the store instance.
   */
  readonly scope: string
}

/** Result of `withStore()` for an async store: `act` + async `invalidate`. */
export interface ScopedActAsync {
  <T>(key: string, fn: ActFn<T>, options?: ActOptions<T>): Promise<ActResult<T>>
  invalidate(key: string): Promise<boolean>
  readonly store: AnyStateStore
  /** @see ScopedActSync.scope */
  readonly scope: string
}

/**
 * Create a scoped `act` bound to an explicit store: SSR request isolation,
 * multi-tenant scenarios, or test isolation. The returned function has the
 * same signature and contract as `act()`, plus `invalidate(key)` and a
 * `store` reference for cleanup. Sync stores return `boolean` from
 * `invalidate`; async stores return `Promise<boolean>`.
 *
 * @example
 * import { withStore, InMemoryStore } from 'actly'
 *
 * const store = new InMemoryStore({ maxSize: 1000, autoCleanup: true })
 * const act = withStore(store)
 * try {
 *   await act('user:42', () => fetchUser(42), { cache: { ttl: 60_000 } })
 *   act.invalidate('user:42') // next call re-fetches
 * } finally {
 *   store.destroy()
 * }
 */
export function withStore(store: SyncStateStore): ScopedActSync
export function withStore(store: AsyncStateStore): ScopedActAsync
export function withStore(store: AnyStateStore): ScopedActSync | ScopedActAsync
export function withStore(store: AnyStateStore): ScopedActSync | ScopedActAsync {
  const scope = generateScopeId()
  // register so createHealthCheck(store) resolves this scope automatically
  registerStoreScope(store, scope)

  const scopedAct = <T>(
    key: string,
    fn: ActFn<T>,
    options: ActOptions<T> = {},
  ): Promise<ActResult<T>> => {
    assertKey(key)
    assertOptions(options)
    return runAct(store, scope, key, fn, options)
  }

  // Prefer atomic deleteIfExists; the has()+delete() fallback is safe on
  // sync stores (no await can interleave) but has a TOCTOU race on async
  // stores — implementors should override deleteIfExists.
  const invalidateImpl = (key: string): boolean | Promise<boolean> => {
    assertKey(key)
    const cacheKey = CACHE_NS + key
    if (typeof (store as { deleteIfExists?: unknown }).deleteIfExists === 'function') {
      return (store as { deleteIfExists: (k: string) => boolean | Promise<boolean> }).deleteIfExists(cacheKey)
    }
    if (isSyncStore(store)) {
      const existed = store.has(cacheKey)
      store.delete(cacheKey)
      return existed
    }
    return (async () => {
      const existed = await store.has(cacheKey)
      await store.delete(cacheKey)
      return existed
    })()
  }

  // Object.assign (not mutation) so the types narrow cleanly at the call
  // site; the cast through unknown bridges the impl signature being wider
  // than either overload.
  return Object.assign(scopedAct, {
    invalidate: invalidateImpl,
    store,
    scope,
  }) as unknown as ScopedActSync | ScopedActAsync
}
