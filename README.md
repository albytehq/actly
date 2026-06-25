# actly

**Reliability primitive for async functions.**
Retry. Timeout. Dedupe. Cache. Composable, typed, zero-throw — with proper `AbortSignal` cancellation, single-flight cache, LRU store, and jittered backoff.

```bash
npm install actly
```

> Requires Node 18+. Ships ESM + CJS. Zero dependencies.

---

## The problem

Every async call can fail. Networks blip. Services time out. The same UI mounts three times and fires the same fetch in parallel. You need retry logic, but not for 4xx errors. You need timeouts, but not the kind that let retry loops run forever.

These patterns are solved the same way every time. `actly` solves them once.

---

## Quick start

```ts
import { act } from 'actly'

const result = await act(
  'user:42',
  async (signal) => fetch(`/api/users/42`, { signal }),
  {
    retry:        { attempts: 3, delayMs: 200, backoff: 'exponential' },
    timeout:      { ms: 5_000 },
    totalTimeout: { ms: 12_000 },
    dedupe:       true,
    cache:        { ttl: 60_000 },
  },
)

if (result.ok) {
  console.log(result.value)    // T
  console.log(result.source)   // 'fresh' | 'cache'
  console.log(result.attempts) // number (0 on cache hit)
} else {
  console.error(result.error)  // unknown — never throws
}
```

`act` always resolves. It never rejects. You check `.ok` and move on.

The `signal` passed to `fn` is your escape hatch: wire it through to `fetch`, `AbortController`, database drivers, or any primitive that accepts one. If a timeout fires (per-attempt or total), or the caller aborts via `options.signal`, `fn`'s signal aborts and the operation rejects promptly — no leaked resources, no hung retry loops.

---

## API

```ts
act<T>(key: string, fn: ActFn<T>, options?: ActOptions): Promise<ActResult<T>>
```

| Argument | Type | Description |
|---|---|---|
| `key` | `string` | Stable, unique identifier. Scopes dedupe and cache state. Must be non-empty and must not start with reserved prefixes (`dedupe:`, `cache:`, `__inflight:`). |
| `fn` | `(signal: AbortSignal) => Promise<T> \| T` | The async function to execute. Receives an `AbortSignal` for cooperative cancellation. Backwards compatible: `() => Promise<T>` is accepted (the signal is simply ignored). |
| `options` | `ActOptions` | All optional. See policies below. |

### Result shape

```ts
type ActResult<T> =
  | { ok: true;  value: T; source: 'fresh' | 'cache'; attempts: number }
  | { ok: false; error: unknown;                       attempts: number }
```

`attempts` semantics:
- Fresh success on first try: `1`
- Fresh success after N retries: `N`
- Cache hit: `0` (no work was performed)
- Dedupe joiner: mirrors the originator's attempt count (v1.1.5 fix — see changelog)

---

## Policies

All policies are optional and compose freely. The execution order is **fixed**:

```
totalTimeout → cache → dedupe → retry → timeout
```

### Retry

```ts
const result = await act('payments:charge', async (signal) => chargeCard(payload, signal), {
  retry: {
    attempts: 3,            // total attempts (including first). Must be integer >= 1.
    delayMs:  200,          // base delay between attempts (ms)
    backoff:  'exponential',// 'none' | 'linear' | 'exponential'
    maxDelay: 30_000,       // cap (ms) — prevents 8.5-minute waits on long exponential chains
    jitter:   'full',       // 'none' | 'full' | 'equal' | 'decorrelated' (default: 'full')
  },
})
```

`result.attempts` tells you how many tries it took.

#### Jitter (default: `'full'`)

Jitter prevents thundering-herd retry storms when many callers fail simultaneously. Without jitter, all callers retry on the same tick after an upstream outage recovers. The default `'full'` jitter randomises each delay to `[0, computed]`.

| Strategy | Formula |
|---|---|
| `'none'` | `delay` |
| `'full'` | `random() * delay` |
| `'equal'` | `delay/2 + random() * delay/2` |
| `'decorrelated'` | `base + random() * (delay - base)` |

#### Selective retry with `shouldRetry`

By default, `actly` retries on every error EXCEPT `AbortError` (which indicates the caller or a timeout cancelled the operation — retrying would just abort again). Use `shouldRetry` to skip retrying other permanent errors — a `404` will never recover, a `503` might.

```ts
const result = await act('api:resource', async (signal) => fetchResource(id, signal), {
  retry: {
    attempts: 4,
    delayMs:  150,
    backoff:  'exponential',
    shouldRetry: (err, attempt) => {
      if (err instanceof HttpError && err.status < 500) return false
      return true
    },
  },
})
```

`shouldRetry(error, attempt)` receives the error and the 1-based attempt number. Return `false` to surface the error immediately.

> **v1.1.5 change:** `shouldRetry` is now called on EVERY failure, including the final attempt. This preserves the predicate's contract for observers / metrics. The return value is only consulted when there are remaining attempts.

---

### Timeout

Per-attempt deadline. Each retry gets a fresh clock. Implemented via `AbortController` + race — `act()` returns promptly even if `fn` ignores the signal (the underlying work may continue in the background, but the caller is unblocked).

```ts
import { act, TimeoutError } from 'actly'

const result = await act('geo:lookup', async (signal) => lookupCoords(ip, signal), {
  timeout: { ms: 3_000 },
})

if (!result.ok && result.error instanceof TimeoutError) {
  console.log(`timed out after ${result.error.ms}ms`)
}
```

For cooperative cancellation, pass `signal` through to your async primitive (`fetch`, `AbortController`, etc.). `actly` will abort the signal when the deadline fires — `fn` rejects immediately, no background leak.

---

### Total timeout

Hard budget over the **entire** operation — all attempts, delays, and per-attempt timeouts combined. The per-attempt `timeout` resets on retry; `totalTimeout` does not.

**v1.1.5 fix:** When `totalTimeout` fires, the inner retry loop is cancelled — no more attempts fire, no more delays are slept. Previous versions would continue running `fn` in the background after `TotalTimeoutError` was returned to the caller.

```ts
import { act, TimeoutError, TotalTimeoutError } from 'actly'

const result = await act('search:query', async (signal) => runQuery(q, signal), {
  retry:        { attempts: 5, delayMs: 100, backoff: 'linear' },
  timeout:      { ms: 2_000 },  // per attempt
  totalTimeout: { ms: 8_000 },  // whole operation
})

if (!result.ok) {
  if (result.error instanceof TotalTimeoutError) {
    console.log(`budget exhausted after ${result.error.ms}ms`)
  } else if (result.error instanceof TimeoutError) {
    console.log(`last attempt timed out after ${result.error.ms}ms`)
  }
}
```

`TotalTimeoutError` and `TimeoutError` are separate classes — `instanceof` distinguishes which deadline fired.

---

### Dedupe

Concurrent calls with the same key collapse into one in-flight Promise. The first caller executes; the rest wait and receive the same result. After settlement, the next call starts fresh.

```ts
const result = await act('config:load', async (signal) => loadRemoteConfig(signal), {
  dedupe: true,
})
```

`dedupe: { enabled: true }` is also valid — object form for forward compatibility.

#### v1.1.5 fixes

- **Shared `attempts`**: joiners now mirror the originator's attempt count. If the originator retried twice before succeeding, all joiners report `attempts: 3` (was `1` in v1.0 — a misleading default).
- **Abort safety**: joiners race the in-flight promise against their own `AbortSignal`. If a joiner's signal aborts (e.g. their `totalTimeout` fires), they reject immediately — they don't block on a hung originator.
- **In-flight TTL** (optional): `dedupe: { enabled: true, inflightTtl: 30_000 }` removes the store entry after 30s if the originator never settles, so subsequent callers can start fresh. Pair with `timeout` / `totalTimeout` for proper cancellation in production.

---

### Cache

Stores successful results for `ttl` milliseconds. Failures are never cached. A cache hit short-circuits everything — dedupe, retry, and timeout are all skipped.

```ts
const result = await act('flags:all', async (signal) => fetchFeatureFlags(signal), {
  cache: { ttl: 60_000 },
})

console.log(result.source) // 'fresh' on miss, 'cache' on hit
console.log(result.attempts) // 1 on miss, 0 on hit (v1.1.5 fix)
```

#### v1.1.5 fixes

- **Single-flight (cache stampede prevention)**: on a sync store, concurrent cache misses for the same key now collapse into a single `fn` invocation. Previously, 10 concurrent callers would all run `fn` (10x redundant work). Now they share one in-flight Promise.
- **`attempts: 0` on cache hit**: cache hits now report `attempts: 0` (was `1` in v1.0), consistent with the documented meaning ("number of attempts made before success").
- **Fail-open writes**: if `store.set()` throws (e.g. Redis transient error), the value is still returned to the caller. Caching is an optimisation, not a correctness requirement.

#### Invalidation

```ts
import { act, invalidate } from 'actly'

await act('user:42', async (signal) => fetchUser(42, signal), { cache: { ttl: 60_000 } })
// ... user updates their profile ...
invalidate('user:42')  // returns true if a cache entry was removed
await act('user:42', ...)  // re-fetches
```

For scoped stores (see `withStore` below), use the scoped `invalidate`:

```ts
const scopedAct = withStore(myStore)
scopedAct.invalidate('user:42')  // sync store: returns boolean
                                // async store: returns Promise<boolean>
```

---

### Combining policies

```ts
const result = await act('product:detail', async (signal) => fetchProduct(id, signal), {
  totalTimeout: { ms: 10_000 },  // outermost wall
  cache:        { ttl: 30_000 }, // short-circuits on hit
  dedupe:       true,            // collapses concurrent calls
  retry:        { attempts: 3, delayMs: 100, backoff: 'linear' },
  timeout:      { ms: 3_000 },   // per attempt
  signal:       userSignal,      // caller-provided cancellation
})
```

---

## Cancellation: `options.signal`

`act()` accepts an `AbortSignal` for caller-driven cancellation:

```ts
const controller = new AbortController()
const promise = act('search:big', async (signal) => runBigQuery(q, signal), {
  signal: controller.signal,
  timeout: { ms: 30_000 },
})

// User clicks "Cancel":
controller.abort(new Error('user-cancelled'))

const r = await promise
// r.ok === false, r.error.message === 'user-cancelled'
```

When `signal` aborts:
- If the operation hasn't started, `act()` returns immediately with `attempts: 0` and the signal's `reason` as the error.
- If it's in progress, `fn`'s inner signal aborts (cooperative). `fn` should propagate the signal to its primitives (`fetch`, `AbortController`, etc.) for proper cleanup.
- If it has already settled, the result is returned as normal.

The signal propagates through the entire chain: `totalTimeout`, `retry` (interrupts delay sleeps), and `timeout` all observe it. No more attempts fire after abort.

---

## Options reference

```ts
interface ActOptions {
  retry?:        RetryOptions
  timeout?:      TimeoutOptions      // per-attempt
  totalTimeout?: TimeoutOptions      // entire operation
  dedupe?:       boolean | DedupeOptions
  cache?:        CacheOptions
  signal?:       AbortSignal         // caller-provided cancellation
}

interface RetryOptions {
  attempts:     number               // integer >= 1
  delayMs?:     number               // non-negative finite
  backoff?:     'none' | 'linear' | 'exponential'
  maxDelay?:    number               // cap, default Infinity
  jitter?:      'none' | 'full' | 'equal' | 'decorrelated'  // default 'full'
  shouldRetry?: (error: unknown, attempt: number) => boolean
}

interface TimeoutOptions  { ms: number }   // positive finite
interface DedupeOptions   {
  enabled: boolean
  inflightTtl?: number   // safety-net TTL for in-flight entry, default Infinity
}
interface CacheOptions    { ttl: number }  // positive finite
```

All options are validated upfront. Invalid input (negative `attempts`, non-positive `ms`, empty `key`, etc.) throws `RangeError` or `TypeError` — these are programmer errors, not runtime failures, so they surface as thrown exceptions rather than `ActFailure`.

---

## Exported values

```ts
import {
  // Primary API
  act,                       // execute with reliability policies
  invalidate,                // clear cache for a key on the default store
  withStore,                 // create a scoped act() with explicit store

  // Execution engine (for custom policy chains)
  execute,                   // run a policy chain with explicit store + signal
  REQUIRES_SYNC_STORE,       // symbol stamped on dedupe policy

  // Stores
  InMemoryStore,             // sync store with LRU + maxSize + autoCleanup
  isSyncStore,               // type guard
  isAsyncStore,              // type guard

  // Error classes
  TimeoutError,              // per-attempt deadline (.ms)
  TotalTimeoutError,         // total budget exhausted (.ms)
} from 'actly'
```

---

## Exported types

```ts
import type {
  ActResult, ActSuccess, ActFailure, ActSource,
  ActOptions, ActFn,
  RetryOptions, TimeoutOptions, DedupeOptions, CacheOptions,
  // Policy internals (for custom policy authors)
  PolicyApplier, PolicyContext, RunMeta,
  // Store interfaces
  SyncStateStore,
  AsyncStateStore,
  AnyStateStore,
  InMemoryStoreOptions,
  // v1.0 alias — still valid, zero migration needed
  StateStore,
  // withStore result types
  ScopedActSync,
  ScopedActAsync,
} from 'actly'
```

---

## Custom store

By default `act` uses a module-level `InMemoryStore`. For SSR request isolation, multi-tenant scenarios, or test control, use `withStore()`:

### `withStore(store)`

Returns a scoped `act` function bound to the provided store, with an `invalidate(key)` method and a `store` reference attached.

```ts
import { withStore, InMemoryStore } from 'actly'

// Basic
const store = new InMemoryStore()
const act = withStore(store)

// With LRU + background cleanup (long-lived server store)
const serverStore = new InMemoryStore({
  maxSize: 10_000,           // evict least-recently-used when exceeded
  autoCleanup: true,
  cleanupIntervalMs: 60_000, // sweep every 60s (default: 30s)
})
const serverAct = withStore(serverStore)

try {
  await serverAct('user:42', async (signal) => fetchUser(42, signal), {
    cache: { ttl: 60_000 },
  })

  // ... user updates their profile ...
  serverAct.invalidate('user:42')  // next call re-fetches

  // Access the underlying store if needed:
  console.log(serverAct.store.size())
} finally {
  serverStore.destroy()  // stop the cleanup timer
}
```

For sync stores, `invalidate` returns `boolean` synchronously.
For async stores, `invalidate` returns `Promise<boolean>`.

### `execute()` directly

For full control (custom policy chains, custom meta, custom signal composition), call `execute()` directly:

```ts
import { execute, InMemoryStore, retryPolicy, timeoutPolicy } from 'actly'

const store = new InMemoryStore()
const meta = { attempts: 1, source: 'fresh' as const }

const value = await execute({
  key: 'custom:chain',
  fn: async (signal) => fetchThing(signal),
  policies: [
    retryPolicy({ attempts: 3, delayMs: 100 }),
    timeoutPolicy({ ms: 5_000 }),
  ],
  store,
  meta,
  signal: new AbortController().signal,
})

console.log(meta.attempts)  // final attempt count
```

### InMemoryStore options

```ts
new InMemoryStore({
  // Periodically sweep expired entries. Default: false (lazy eviction on access).
  autoCleanup?: boolean,
  cleanupIntervalMs?: number,  // default 30_000

  // Bounded cache with LRU eviction. Default: Infinity (unbounded).
  // On set(), if size would exceed maxSize, the least-recently-used entry
  // is evicted before the new one is inserted.
  maxSize?: number,
})
```

`InMemoryStore` satisfies `SyncStateStore`. Call `destroy()` to stop the background timer and prevent leaks.

### Async store (v1.1+)

For external cache backends (Redis, Upstash, etc.), implement `AsyncStateStore`:

```ts
import type { AsyncStateStore } from 'actly'

class RedisStore implements AsyncStateStore {
  readonly _sync = false as const

  async get<T>(key: string): Promise<T | undefined> { /* ... */ }
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> { /* ... */ }
  async delete(key: string): Promise<void> { /* ... */ }
  async has(key: string): Promise<boolean> { /* ... */ }
  async clear(): Promise<void> { /* ... */ }
  async size(): Promise<number> { /* ... */ }
}
```

`AsyncStateStore` is compatible with `cache` only. Using it with `dedupe` is a TypeScript error and a runtime error — `execute()` throws at chain-build time. Dedupe requires synchronous store access (the read-then-write that makes deduplication work must happen in a single tick; an async `await` between `get()` and `set()` would let two concurrent callers both see a miss).

---

## Store interfaces

```ts
interface SyncStateStore {
  readonly _sync: true
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T, ttlMs?: number): void
  delete(key: string): void
  has(key: string): boolean
  clear(): void
  size(): number
}

interface AsyncStateStore {
  readonly _sync: false
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
  clear(): Promise<void>
  size(): Promise<number>
}
```

The `_sync` discriminant is read at runtime by `execute()` to enforce the dedupe constraint. Set it as a `readonly` literal — `true as const` or `false as const`.

---

## Zero-throw contract

`act()` always resolves. Under any condition — network error, thrown exception, timeout, total budget exhaustion, caller abort — the result is an `ActFailure`, not a rejected promise. This contract holds across all versions.

The only exceptions are programmer errors (invalid options, invalid keys) — these throw synchronously so bugs surface at development time rather than degrading silently in production.

---

## Philosophy

One function. One return type. No exceptions in userland.

The key is your responsibility. Make it stable and specific. `user:42` is good. `fetch` is not. (Empty keys and reserved prefixes are rejected — see validation.)

Policies are composable but intentionally constrained. There is no builder API, no middleware system, no hooks. If you need something `act` doesn't do, write a wrapper around it — that's the right boundary.

Cancellation is cooperative: pass the `signal` through. `act()` will return promptly regardless (via internal race), but only you can stop `fn` from leaking resources.

---

## Changelog

### v1.1.5 — 2026-06-25

**Critical correctness fixes**

- **`totalTimeout` now cancels the inner retry loop.** Previously, when `totalTimeout` fired, `act()` returned `TotalTimeoutError` to the caller but the inner `retryPolicy` continued firing attempts and sleeping delays in the background — leaking resources for the full retry budget. Now, the abort propagates through the chain: no more attempts fire, delay sleeps reject immediately. *(Fixes C-1.)*
- **`timeout` (per-attempt) cancels `fn` via `AbortSignal`.** `fn` now receives a signal that aborts when the per-attempt deadline fires. If `fn` cooperates (passes signal to `fetch`, `AbortController`, etc.), the underlying work is cancelled properly. `act()` returns promptly even if `fn` ignores the signal (via internal race). *(Fixes C-2.)*
- **Dedupe joiners can abort independently.** Previously, if the originator's `fn` hung, all joiners blocked forever waiting for the in-flight promise. Now, joiners race the in-flight promise against their own `AbortSignal` — they reject immediately when their signal aborts, without waiting for the originator. *(Fixes C-3.)*
- **Cache stampede prevention (single-flight).** Concurrent cache misses for the same key on a sync store now collapse into a single `fn` invocation. Previously, 10 concurrent callers would all run `fn` (10x redundant work). Now they share one in-flight Promise via an internal `__inflight:cache:<key>` slot. *(Fixes C-4.)*
- **Dedupe joiners mirror originator's `attempts`.** Previously, joiners reported `attempts: 1` regardless of how many retries the originator performed. Now, joiners copy the originator's final `attempts` and `source` from a shared `RunMeta` reference. *(Fixes C-5.)*
- **Cache hit reports `attempts: 0`.** Previously, cache hits reported `attempts: 1`, inconsistent with the documented meaning ("number of attempts made before success"). Now: `0` on hit, `1+` on miss. *(Fixes C-6.)*

**Public API additions (fixes A-1, A-2, m-8)**

- **`execute()` is now exported.** Call it directly with a custom policy chain, store, meta, and signal for full control (SSR isolation, multi-tenant scenarios, custom policy composition).
- **`isSyncStore()` / `isAsyncStore()` are now exported.** Type guards for `AnyStateStore`, useful when building custom policy chains or store adapters.
- **`invalidate(key)`** clears cache entries on the default store. Returns `boolean` (true if an entry was removed).
- **`withStore(store)`** returns a scoped `act` function bound to an explicit store, with `invalidate(key)` and `store` attached. Overloads for sync (`invalidate: boolean`) vs async (`invalidate: Promise<boolean>`) stores.
- **`REQUIRES_SYNC_STORE` symbol** is now exported for consumers building custom policy chains that need to declare sync-store requirements.
- **`ScopedActSync` / `ScopedActAsync` types** exported for typed `withStore` results.
- **`PolicyApplier`, `PolicyContext`, `RunMeta`, `AnyStateStore`** are now exported as public types (previously internal).

**New options**

- **`options.signal: AbortSignal`** — caller-provided cancellation signal. Propagates through the entire chain: `totalTimeout`, `retry` (interrupts delay sleeps), and `timeout` all observe it. `fn` receives the composite signal.
- **`RetryOptions.maxDelay`** — cap on computed delay. Prevents 8.5-minute waits on long exponential chains (`delayMs: 1000, attempts: 10, exponential` → 256s between attempts 9 and 10 without a cap).
- **`RetryOptions.jitter`** — jitter strategy: `'none' | 'full' | 'equal' | 'decorrelated'`. Default: `'full'` (random in `[0, delay]`). Prevents thundering-herd retry storms.
- **`DedupeOptions.inflightTtl`** — safety-net TTL for the in-flight entry. If the originator never settles, subsequent callers can start fresh after the TTL expires.
- **`InMemoryStoreOptions.maxSize`** — bounded cache with LRU eviction. On `set()`, if size would exceed `maxSize`, the least-recently-used entry is evicted before the new one is inserted. Default: `Infinity` (unbounded).

**Behaviour changes (non-breaking)**

- **`shouldRetry` is now called on every failure, including the final attempt.** Previously, it was skipped on the last attempt. The return value is still only consulted when there are remaining attempts — but observers / metrics now see every failure. *(Fixes M-2.)*
- **Default `shouldRetry` skips abort errors.** Previously, the default retried on every error. Now it skips `AbortError` (which indicates cancellation — retrying would just abort again, wasting delay budget). User-supplied `shouldRetry` overrides this entirely.
- **Input validation throws on invalid options.** Empty keys, reserved prefixes (`dedupe:`, `cache:`, `__inflight:`), non-integer `attempts`, non-positive `ms`/`ttl`, non-finite delays — all throw `RangeError` or `TypeError` synchronously, rather than degrading silently. *(Fixes M-3, M-4.)*
- **`RetryOptions.attempts: 1` is a documented no-op.** The retry policy is not added to the chain when `attempts <= 1` (would be pure overhead). This was already the behaviour; it's now explicitly documented.

**Internal improvements**

- **`ActFn<T>` signature changed to `(signal: AbortSignal) => Promise<T> | T`.** Backwards compatible: `() => Promise<T>` is assignable (signal arg is ignored). New code can opt-in to cooperative cancellation.
- **`cachePolicy` fails open on `store.set()` errors.** If the cache write throws (e.g. Redis transient error), the value is still returned to the caller. Caching is an optimisation, not a correctness requirement. *(Fixes M-6.)*
- **`InMemoryStore.size()` is now side-effect free** with respect to LRU order. Previously, it called `has()` (which delegated to `get()`), refreshing LRU positions. Now it scans without touching order. *(Fixes m-1.)*
- **`InMemoryStore` implements LRU** via `Map` insertion-order semantics: `delete` + `set` on every access moves the key to the most-recent position. *(Fixes P-3.)*
- **`retryPolicy` checks `parentSignal.aborted` before each attempt and before each delay sleep.** When `totalTimeout` or caller signal aborts, the retry loop bails immediately — no more attempts, no more delays. Delay sleeps use a signal-aware `sleep()` helper that rejects early on abort.
- **`package.json` `engines.node` set to `>=18`** (was missing — README claimed Node 18+ but it wasn't enforced). *(Fixes D-7.)*
- **`package.json` `sideEffects: false`** for tree-shaking. *(Fixes D-8.)*
- **`package.json` `exports` field:** `types` condition is now first (was last) — required for correct TypeScript resolution in some bundlers. *(Fixes A-3.)*
- **`tsconfig` updated:** target ES2022, `lib: ["ES2022"]`, `types: ["node"]`. Removed `DOM` lib (was unnecessary for a Node-targeted library). *(Fixes D-9, D-11, D-12.)*
- **`tsconfig.cjs.json` `moduleResolution: "Node"`** (was `"Bundler"` — incompatible with `module: "CommonJS"`). *(Fixes D-9.)*
- **Test suite added.** 64 tests covering: API surface, zero-throw contract, input validation, retry (jitter, maxDelay, shouldRetry on final attempt, abort-skip), timeout (cooperative + race fallback), totalTimeout (cancellation, delay interrupt), dedupe (collapse, shared meta, abort safety, hung originator), cache (single-flight, attempts=0, fail-open, TTL), invalidate, withStore (sync + async, isolation, scoped invalidate), InMemoryStore (LRU, maxSize, TTL, size() purity, destroy), AbortSignal integration, execute() public API. *(Fixes D-1.)*

**Non-breaking changes**

- `StateStore` preserved as type alias for `SyncStateStore` — all v1.0 code compiles without changes.
- All new exports are purely additive.
- `ActFn<T>` signature widened to accept `(signal) => ...` — existing `() => Promise<T>` is assignable.
- `withStore()` is a new function — no impact on existing `act()` callers.

---

### v1.1.0 — 2026-06-01

- `AsyncStateStore` interface for plug-in async backends (Redis, Upstash, Cloudflare KV).
- `SyncStateStore` canonical name; `StateStore` preserved as alias.
- `InMemoryStore` public export with `InMemoryStoreOptions` (`autoCleanup`, `cleanupIntervalMs`).
- `TotalTimeoutError` class distinct from `TimeoutError`.
- `totalTimeout` option for hard wall-clock budget.
- `dedupe: true` shorthand.
- `isSyncStore()` / `isAsyncStore()` type guards.

---

### v1.0.1

- Initial stable release.
- `act()`, `retry`, `timeout`, `totalTimeout`, `dedupe`, `cache`.
- `TimeoutError` exported for `instanceof` checks.
- Zero dependencies. ESM + CJS. Node 18+.

---

## License

MIT
