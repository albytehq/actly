import type { ActFn, ActOptions, ActResult, AnyStateStore, SyncStateStore, AsyncStateStore } from '../types/index.js';
/**
 * Execute `fn` with the given reliability policies.
 *
 * @param key     Stable identifier for this action. Scopes dedupe + cache.
 * @param fn      The async work to run. Receives an `AbortSignal` for
 *                cooperative cancellation (legacy `() => Promise<T>` is
 *                still accepted — the signal is simply ignored).
 * @param options Which policies to apply and how. All fields are optional.
 *
 * @returns       `ActResult<T>` — always resolves, never throws.
 *                Check `result.ok` before reading `result.value`.
 *
 * @example
 * // With cooperative cancellation
 * const result = await act('user:42', async (signal) => {
 *   return fetch(`/api/users/42`, { signal })
 * }, {
 *   retry:        { attempts: 3, delayMs: 200, backoff: 'exponential' },
 *   timeout:      { ms: 5_000 },
 *   totalTimeout: { ms: 12_000 },
 *   dedupe:       true,
 *   cache:        { ttl: 60_000 },
 * })
 *
 * if (result.ok) {
 *   console.log(result.value, result.source, result.attempts)
 * } else {
 *   console.error(result.error)
 * }
 */
export declare function act<T>(key: string, fn: ActFn<T>, options?: ActOptions): Promise<ActResult<T>>;
/**
 * Invalidate the cached value for `key` on the default module-level store.
 *
 * Only clears the cache slot — does not affect in-flight dedupe entries
 * (those will settle on their own). Returns `true` if a cache entry was
 * removed, `false` otherwise.
 *
 * Useful when you know the underlying data has changed and you want the
 * next `act()` call to re-run `fn` instead of serving stale cache:
 *
 * ```ts
 * await act('user:42', () => fetchUser(42), { cache: { ttl: 60_000 } })
 * // ... user updates their profile ...
 * invalidate('user:42')  // next call will re-fetch
 * ```
 */
export declare function invalidate(key: string): boolean;
/** Result of `withStore()` for a sync store: `act` + sync `invalidate`. */
export interface ScopedActSync {
    <T>(key: string, fn: ActFn<T>, options?: ActOptions): Promise<ActResult<T>>;
    invalidate(key: string): boolean;
    /** The store this scope is bound to. Useful for `store.destroy()` etc. */
    readonly store: AnyStateStore;
}
/** Result of `withStore()` for an async store: `act` + async `invalidate`. */
export interface ScopedActAsync {
    <T>(key: string, fn: ActFn<T>, options?: ActOptions): Promise<ActResult<T>>;
    invalidate(key: string): Promise<boolean>;
    readonly store: AnyStateStore;
}
/**
 * Create a scoped `act` function bound to an explicit store.
 *
 * Use this for:
 *  - **SSR request isolation**: one store per request, no cross-request
 *    cache/dedupe leakage.
 *  - **Multi-tenant scenarios**: one store per tenant, no cross-tenant
 *    data leakage.
 *  - **Test isolation**: each test gets a fresh store, no shared state.
 *
 * The returned function has the same signature as `act()`. It also exposes
 * an `invalidate(key)` method and a `store` reference for cleanup.
 *
 * For sync stores, `invalidate` returns `boolean` synchronously.
 * For async stores, `invalidate` returns `Promise<boolean>`.
 *
 * @example
 * ```ts
 * import { withStore, InMemoryStore } from 'actly'
 *
 * const store = new InMemoryStore({ maxSize: 1000, autoCleanup: true })
 * const act = withStore(store)
 *
 * try {
 *   await act('user:42', () => fetchUser(42), { cache: { ttl: 60_000 } })
 *   // ... user updates their profile ...
 *   act.invalidate('user:42')  // next call re-fetches
 * } finally {
 *   store.destroy()
 * }
 * ```
 */
export declare function withStore(store: SyncStateStore): ScopedActSync;
export declare function withStore(store: AsyncStateStore): ScopedActAsync;
export declare function withStore(store: AnyStateStore): ScopedActSync | ScopedActAsync;
//# sourceMappingURL=act.d.ts.map