# actly

**Reliability primitive for async functions.**  
Retry. Timeout. Dedupe. Cache. Composable, typed, zero-throw.

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

const result = await act('user:42', () => fetchUser(42))

if (result.ok) {
  console.log(result.value)    // T
  console.log(result.source)   // 'fresh' | 'cache'
  console.log(result.attempts) // number
} else {
  console.error(result.error)  // unknown — never throws
}
```

`act` always resolves. It never rejects. You check `.ok` and move on.

---

## API

```ts
act<T>(key: string, fn: () => Promise<T>, options?: ActOptions): Promise<ActResult<T>>
```

| Argument | Type | Description |
|---|---|---|
| `key` | `string` | Stable, unique identifier. Scopes dedupe and cache state. |
| `fn` | `() => Promise<T>` | The async function to execute. |
| `options` | `ActOptions` | All optional. See policies below. |

### Result shape

```ts
type ActResult<T> =
  | { ok: true;  value: T; source: 'fresh' | 'cache'; attempts: number }
  | { ok: false; error: unknown;                       attempts: number }
```

---

## Policies

All policies are optional and compose freely. The execution order is **fixed**:

```
totalTimeout → cache → dedupe → retry → timeout
```

### Retry

```ts
const result = await act('payments:charge', () => chargeCard(payload), {
  retry: {
    attempts: 3,            // total attempts (including first)
    delayMs:  200,          // base delay between attempts (ms)
    backoff:  'exponential' // 'none' | 'linear' | 'exponential'
  },
})
```

`result.attempts` tells you how many tries it took.

#### Selective retry with `shouldRetry`

By default, every error triggers a retry. Use `shouldRetry` to skip retrying permanent errors — a `404` will never recover, a `503` might.

```ts
const result = await act('api:resource', () => fetchResource(id), {
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

`shouldRetry(error, attempt)` receives the error and the 1-based attempt number. Return `false` to surface the error immediately. Not called on the final attempt — that always surfaces.

---

### Timeout

Per-attempt deadline. Each retry gets a fresh clock.

```ts
import { act, TimeoutError } from 'actly'

const result = await act('geo:lookup', () => lookupCoords(ip), {
  timeout: { ms: 3_000 },
})

if (!result.ok && result.error instanceof TimeoutError) {
  console.log(`timed out after ${result.error.ms}ms`)
}
```

---

### Total timeout

Hard budget over the **entire** operation — all attempts, delays, and per-attempt timeouts combined. The per-attempt `timeout` resets on retry; `totalTimeout` does not.

```ts
import { act, TimeoutError, TotalTimeoutError } from 'actly'

const result = await act('search:query', () => runQuery(q), {
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
const result = await act('config:load', () => loadRemoteConfig(), {
  dedupe: true,
})
```

`dedupe: { enabled: true }` is also valid — object form for forward compatibility.

> **Note:** Deduped callers (those that joined an in-flight Promise) always receive `attempts: 1` in their result, because the retry counter belongs to the originating call. This is a known trade-off.

---

### Cache

Stores successful results for `ttl` milliseconds. Failures are never cached. A cache hit short-circuits everything — dedupe, retry, and timeout are all skipped.

```ts
const result = await act('flags:all', () => fetchFeatureFlags(), {
  cache: { ttl: 60_000 },
})

console.log(result.source) // 'fresh' on miss, 'cache' on hit
```

---

### Combining policies

```ts
const result = await act('product:detail', () => fetchProduct(id), {
  totalTimeout: { ms: 10_000 },  // outermost wall
  cache:        { ttl: 30_000 }, // short-circuits on hit
  dedupe:       true,            // collapses concurrent calls
  retry:        { attempts: 3, delayMs: 100, backoff: 'linear' },
  timeout:      { ms: 3_000 },   // per attempt
})
```

---

## Options reference

```ts
interface ActOptions {
  retry?:        RetryOptions
  timeout?:      TimeoutOptions      // per-attempt
  totalTimeout?: TimeoutOptions      // entire operation
  dedupe?:       boolean | DedupeOptions
  cache?:        CacheOptions
}

interface RetryOptions {
  attempts:     number
  delayMs?:     number
  backoff?:     'none' | 'linear' | 'exponential'
  shouldRetry?: (error: unknown, attempt: number) => boolean
}

interface TimeoutOptions  { ms: number }
interface DedupeOptions   { enabled: boolean }
interface CacheOptions    { ttl: number }
```

---

## Exported values

```ts
import {
  act,                       // primary function
  InMemoryStore,             // isolated store for SSR / tests
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
  // v1.1 — store interfaces
  SyncStateStore,
  AsyncStateStore,
  InMemoryStoreOptions,
  // v1.0 alias — still valid, zero migration needed
  StateStore,
} from 'actly'
```

---

## Custom store

By default `act` uses a module-level `InMemoryStore`. For SSR request isolation or test control, instantiate your own:

```ts
import { InMemoryStore } from 'actly'

// Basic
const store = new InMemoryStore()

// With background cleanup (useful for long-lived server-side stores)
const store = new InMemoryStore({
  autoCleanup: true,
  cleanupIntervalMs: 60_000, // sweep every 60s (default: 30s)
})

// Always call destroy() when done to prevent timer leaks
store.destroy()
```

`InMemoryStore` satisfies `SyncStateStore`. Use it with `execute()` directly for full control.

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

> `AsyncStateStore` is compatible with `cache` only. Using it with `dedupe` is a TypeScript error and a runtime error — dedupe requires synchronous store access. See `SyncStateStore` docs for the reason.

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

The `_sync` discriminant is read at runtime by the executor to enforce the dedupe constraint. Set it as a `readonly` literal — `true as const` or `false as const`.

---

## Zero-throw contract

`act()` always resolves. Under any condition — network error, thrown exception, timeout, total budget exhaustion — the result is an `ActFailure`, not a rejected promise. This contract holds across all versions.

---

## Philosophy

One function. One return type. No exceptions in userland.

The key is your responsibility. Make it stable and specific. `user:42` is good. `fetch` is not.

Policies are composable but intentionally constrained. There is no builder API, no middleware system, no hooks. If you need something `act` doesn't do, write a wrapper around it — that's the right boundary.

---

## Changelog

### v1.1.0 — 2026-06-01

**New features**

- **`AsyncStateStore` interface** — plug in any async key-value backend (Redis, Upstash, Cloudflare KV). Compatible with `cache` policy. Using with `dedupe` is a compile-time and runtime error by design.
- **`SyncStateStore` interface** — the canonical public name for what was previously the internal store shape. `StateStore` is preserved as an alias with zero breakage for existing code.
- **`InMemoryStore` is now a public export** — construct isolated stores for SSR request isolation, per-test control, or multi-tenant scenarios. Accepts `InMemoryStoreOptions`.
- **`InMemoryStoreOptions`** — opt-in `autoCleanup` with configurable `cleanupIntervalMs`. Call `destroy()` to stop the background timer and prevent leaks.
- **`TotalTimeoutError`** — new error class thrown when `totalTimeout` fires. Distinct from `TimeoutError` (per-attempt) so `instanceof` tells you which deadline fired.
- **`totalTimeout` option** — hard wall-clock budget over the entire operation including all retry attempts and delays. Use alongside `timeout` to express both per-attempt and total constraints.
- **`dedupe: true` shorthand** — equivalent to `dedupe: { enabled: true }`. Object form still valid for forward compatibility.
- **`isSyncStore()` / `isAsyncStore()` type guards** — exported from `actly` for consumers building custom policy chains or store adapters.

**Internal improvements**

- Executor validates sync-store requirement at chain-build time — async store + `dedupePolicy` throws immediately with a clear message instead of producing silent correctness failures.
- `dedupePolicy` tagged with `REQUIRES_SYNC_STORE` symbol — allows executor to detect the constraint without importing the policy module (avoids circular deps).
- `cachePolicy` now branches sync/async paths — fast synchronous path for `InMemoryStore`, async-await path for external stores.

**Non-breaking changes**

- `StateStore` preserved as type alias for `SyncStateStore` — all v1.0 code compiles without changes.
- All new exports are purely additive.

---

### v1.0.1

- Initial stable release.
- `act()`, `retry`, `timeout`, `totalTimeout`, `dedupe`, `cache`.
- `TimeoutError` exported for `instanceof` checks.
- Zero dependencies. ESM + CJS. Node 18+.

---

## License

MIT
