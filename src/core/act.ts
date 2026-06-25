import type {
  ActFn,
  ActOptions,
  ActResult,
  PolicyApplier,
  RunMeta,
  AnyStateStore,
  SyncStateStore,
  AsyncStateStore,
} from '../types/index.js'
import { execute }                from './executor.js'
import { retryPolicy }            from '../policies/retry.js'
import { timeoutPolicy, totalTimeoutPolicy } from '../policies/timeout.js'
import { dedupePolicy }           from '../policies/dedupe.js'
import { cachePolicy }            from '../policies/cache.js'
import { InMemoryStore }          from '../stores/memory.js'
import { isSyncStore }            from '../stores/base.js'
import { linkSignal }             from '../utils/abort.js'
import {
  assertKey,
  assertOptions,
} from '../utils/validate.js'

// Module-level default store so cache and dedupe persist across calls.
// Always an InMemoryStore (SyncStateStore) — required because the default
// chain may include dedupePolicy, which mandates synchronous store access.
// For SSR isolation or per-test control, use `withStore()` or call
// `execute()` directly with an explicit store.
const defaultStore = new InMemoryStore()

// Namespace prefixes used by policies. Kept here (not in policy files) so
// `invalidate()` can resolve cache keys without importing policy internals.
const CACHE_NS = 'cache:'

/**
 * Normalise `dedupe: true` shorthand to `DedupeOptions`.
 * Returns `undefined` if dedupe is disabled or absent.
 */
function normalizeDedupe(
  opt: ActOptions['dedupe'],
): { enabled: true; inflightTtl?: number } | undefined {
  if (opt === true) return { enabled: true }
  if (opt && typeof opt === 'object' && opt.enabled) {
    return {
      enabled: true,
      ...(opt.inflightTtl !== undefined ? { inflightTtl: opt.inflightTtl } : {}),
    }
  }
  return undefined
}

/**
 * Build the policy chain from `ActOptions`. The order is fixed and
 * documented in `executor.ts`. Policies with no effect (e.g. `retry.attempts: 1`)
 * are skipped — they would be pure overhead.
 */
function buildPolicies<T>(options: ActOptions): Array<PolicyApplier<T>> {
  const dedupe = normalizeDedupe(options.dedupe)
  const policies: Array<PolicyApplier<T>> = []

  // 0. Outermost: hard wall-clock budget over the entire operation.
  //    If it fires, no inner policy can extend the deadline.
  if (options.totalTimeout && options.totalTimeout.ms > 0) {
    policies.push(totalTimeoutPolicy<T>(options.totalTimeout))
  }

  // 1. Cache: a hit short-circuits everything below it.
  if (options.cache && options.cache.ttl > 0) {
    policies.push(cachePolicy<T>(options.cache))
  }

  // 2. Dedupe: collapses concurrent callers before retry fires.
  if (dedupe) {
    policies.push(dedupePolicy<T>(dedupe))
  }

  // 3. Retry: owns the attempt loop.
  //    `attempts: 1` is a no-op — skip to avoid overhead.
  if (options.retry && options.retry.attempts > 1) {
    policies.push(retryPolicy<T>(options.retry))
  }

  // 4. Innermost: per-attempt clock. Resets on every retry.
  if (options.timeout && options.timeout.ms > 0) {
    policies.push(timeoutPolicy<T>(options.timeout))
  }

  return policies
}

/**
 * Build a root AbortController from `options.signal`.
 *
 * - If no user signal: returns a fresh controller that never aborts unless
 *   an outer timeout policy aborts it.
 * - If user signal is already aborted: returns a controller that is already
 *   aborted with the user's reason (so the operation rejects immediately).
 * - Otherwise: links the user signal to the controller.
 */
function buildRootSignal(userSignal: AbortSignal | undefined): AbortController {
  const controller = new AbortController()
  if (userSignal) linkSignal(userSignal, controller)
  return controller
}

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
export async function act<T>(
  key: string,
  fn: ActFn<T>,
  options: ActOptions = {},
): Promise<ActResult<T>> {
  // Validate input upfront. Programmer errors throw — they should not be
  // swallowed into an ActFailure because the caller's code is broken.
  assertKey(key)
  assertOptions(options)

  const meta: RunMeta = { attempts: 1, source: 'fresh' }
  const rootController = buildRootSignal(options.signal)

  // Fast-fail if the user signal is already aborted. We do this after
  // validation so the caller still gets a TypeError for bad options rather
  // than a silent abort.
  if (rootController.signal.aborted) {
    return { ok: false, error: rootController.signal.reason, attempts: 0 }
  }

  const policies = buildPolicies<T>(options)

  try {
    const value = await execute({
      key,
      fn,
      policies,
      store: defaultStore,
      meta,
      signal: rootController.signal,
    })
    return { ok: true, value, source: meta.source, attempts: meta.attempts }
  } catch (error) {
    return { ok: false, error, attempts: meta.attempts }
  }
}

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
export function invalidate(key: string): boolean {
  const cacheKey = CACHE_NS + key
  const existed = defaultStore.has(cacheKey)
  defaultStore.delete(cacheKey)
  return existed
}

// ─── withStore: scoped act() with explicit store ──────────────────────────────

/** Result of `withStore()` for a sync store: `act` + sync `invalidate`. */
export interface ScopedActSync {
  <T>(key: string, fn: ActFn<T>, options?: ActOptions): Promise<ActResult<T>>
  invalidate(key: string): boolean
  /** The store this scope is bound to. Useful for `store.destroy()` etc. */
  readonly store: AnyStateStore
}

/** Result of `withStore()` for an async store: `act` + async `invalidate`. */
export interface ScopedActAsync {
  <T>(key: string, fn: ActFn<T>, options?: ActOptions): Promise<ActResult<T>>
  invalidate(key: string): Promise<boolean>
  readonly store: AnyStateStore
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
export function withStore(store: SyncStateStore): ScopedActSync
export function withStore(store: AsyncStateStore): ScopedActAsync
export function withStore(store: AnyStateStore): ScopedActSync | ScopedActAsync
export function withStore(store: AnyStateStore): ScopedActSync | ScopedActAsync {
  const scopedAct = async <T>(
    key: string,
    fn: ActFn<T>,
    options: ActOptions = {},
  ): Promise<ActResult<T>> => {
    assertKey(key)
    assertOptions(options)

    const meta: RunMeta = { attempts: 1, source: 'fresh' }
    const rootController = buildRootSignal(options.signal)

    if (rootController.signal.aborted) {
      return { ok: false, error: rootController.signal.reason, attempts: 0 }
    }

    const policies = buildPolicies<T>(options)

    try {
      const value = await execute({
        key,
        fn,
        policies,
        store,
        meta,
        signal: rootController.signal,
      })
      return { ok: true, value, source: meta.source, attempts: meta.attempts }
    } catch (error) {
      return { ok: false, error, attempts: meta.attempts }
    }
  }

  // Build the `invalidate` implementation. The runtime branch on
  // `isSyncStore` selects the correct path; the cast through `unknown`
  // is required because TypeScript cannot narrow the union return type
  // (`boolean | Promise<boolean>`) to match either overload signature
  // individually. The overloads at the call site guarantee callers see
  // the correct type.
  const invalidateImpl = (key: string): boolean | Promise<boolean> => {
    assertKey(key)
    const cacheKey = CACHE_NS + key
    if (isSyncStore(store)) {
      const existed = store.has(cacheKey)
      store.delete(cacheKey)
      return existed
    }
    // Async store branch.
    return (async () => {
      const existed = await store.has(cacheKey)
      await store.delete(cacheKey)
      return existed
    })()
  }

  // Attach `invalidate` and `store` to the function object. We use
  // `Object.assign` rather than mutation so the types narrow cleanly at
  // the call site. The cast through `unknown` is necessary because the
  // implementation signature is wider than either overload.
  return Object.assign(scopedAct, {
    invalidate: invalidateImpl,
    store,
  }) as unknown as ScopedActSync | ScopedActAsync
}
