# actly

A typed reliability kernel for async execution. Retry, timeout, dedupe, cache — composable, zero-throw, with `AbortSignal` cancellation, jittered backoff, observability hooks, and a typed error taxonomy.

```bash
npm install actly
```

> Requires Node 20+. Ships ESM + CJS. Zero runtime dependencies. Tree-shakeable.

---

## What it does

`act()` wraps an async function with configurable reliability policies. It always resolves with a result object — never rejects. You check `.ok` to branch on success or failure.

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
  console.log(result.value)      // T
  console.log(result.source)     // 'fresh' | 'cache'
  console.log(result.attempts)   // number (0 on cache hit)
  console.log(result.durationMs) // number (wall-clock ms)
} else {
  console.error(result.error)    // typed — see Error taxonomy
}
```

---

## Compared to Cockatiel

Both are typed, zero-dependency resilience libraries for Node/TypeScript. The core difference is scope and composition model.

| | actly | Cockatiel |
|---|---|---|
| Retry (backoff + jitter) | ✅ exponential/linear/constant, 4 jitter modes | ✅ exponential, `ExponentialBackoff` |
| Timeout (per-attempt) | ✅ | ✅ |
| Total/wall-clock timeout | ✅ `totalTimeout` spans the whole retry loop | — (compose manually) |
| Circuit breaker | ✅ half-open single-probe | ✅ |
| Bulkhead | ✅ with optional queue + queue timeout | ✅ |
| Rate limit | ✅ sliding window | — |
| Cache (with single-flight) | ✅ built in, stampede-proof | — |
| Request dedupe (single-flight) | ✅ generation-safe, joiner-isolated | — |
| Hedged requests | ✅ | — |
| Fallback | — (compose at call site) | ✅ |
| Composition model | one `act()` call, declarative options object | explicit `wrap()` chaining of policy objects |
| Cancellation | native `AbortSignal`, propagated through every policy | `CancellationToken` (custom, pre-dates broad `AbortSignal` adoption) |
| Observability | opt-in hooks, zero-cost when unused | events per policy object |
| State store | pluggable (`InMemoryStore` built in; bring your own for Redis etc.) | in-process only |

Where the two overlap (retry, timeout, circuit breaker, bulkhead), the semantics are comparable and both are well-suited to production use. actly additionally folds cache, dedupe, rate limiting, and hedging into the same policy chain and result type, so a single `act()` call can express what would otherwise require composing several Cockatiel policies plus your own caching/dedupe layer. Cockatiel's `fallback` policy has no direct equivalent in actly — compose it at the call site by catching the returned `ActResult` and substituting a default when `!result.ok`.

### Measured overhead: actly vs Cockatiel

Feature parity is only half the story — here are actual numbers, not marketing claims. Run it yourself: `npm run build && npm install --no-save cockatiel && node bench/compare-cockatiel.mjs`.

Representative run (Node 20, single machine, trivial no-op `fn`, 20,000 iterations per case — see `bench/compare-cockatiel.mjs` for full methodology):

| Policy (happy path) | actly | Cockatiel | Cockatiel is faster by |
|---|---|---|---|
| retry (3 attempts configured, succeeds on 1st) | 5.0 µs/op | 0.9 µs/op | ~5.5x |
| timeout (5s limit, resolves fast) | 13.7 µs/op | 7.1 µs/op | ~1.9x |
| circuit breaker (closed) | 3.5 µs/op | 0.5 µs/op | ~7.1x |
| bulkhead (under cap) | 4.2 µs/op | 0.5 µs/op | ~8.0x |
| retry + timeout + circuitBreaker composed | 14.5 µs/op | 7.9 µs/op | ~1.8x |

**Honest read:** Cockatiel is faster, consistently, on every policy they both implement. Its policies are closures with no external state lookup. actly's policies go through a keyed state store (`Map` get/set per call, even for `InMemoryStore`) to support cross-call features Cockatiel doesn't have — a circuit breaker's failure count has to live somewhere addressable by `key` across separate `act()` calls, not captured in a closure. That indirection costs microseconds per call.

For nearly all real workloads this difference is noise — both add single-digit-to-low-double-digit microseconds against I/O that costs milliseconds. It matters if you're calling a policy millions of times per second in a hot loop with no I/O; it does not matter wrapping network or database calls, which is what both libraries are for. Pick actly when you want cache/dedupe/rate-limit/hedge in the same call and don't want to hand-wire a state layer around Cockatiel; pick Cockatiel when you only need retry/timeout/circuit-breaker/bulkhead/fallback and want the leanest possible per-call cost.

---

## API

### `act(key, fn, options?)`

Wraps `fn` with reliability policies. Returns `Promise<ActResult<T>>`.

| Param | Type | Description |
|-------|------|-------------|
| `key` | `string` | Stable identifier. Scopes dedupe + cache. Validated for prototype pollution, control chars, CRLF, length (≤1024), reserved prefixes. |
| `fn` | `(signal: AbortSignal) => Promise<T> \| T` | The async work. Signal aborts on caller cancel, per-attempt timeout, or total timeout. Legacy `() => Promise<T>` accepted (signal ignored). |
| `options` | `ActOptions` | Policy configuration. All fields optional. |

**Returns:** `Promise<ActResult<T>>` — always resolves, never rejects.

```ts
interface ActSuccess<T> {
  ok: true
  value: T
  source: 'fresh' | 'cache'
  attempts: number      // 1-based; 0 on cache hit
  traceId?: string      // present when observability or traceId option set
  durationMs?: number   // wall-clock ms
}

interface ActFailure {
  ok: false
  error: unknown        // typed — see Error taxonomy
  attempts: number
  traceId?: string
  durationMs?: number
}
```

### `invalidate(key)`

Removes the cached value for `key` from the default module-level store. Returns `true` if a cache entry was removed.

Does **not** cancel in-flight dedupe entries — those settle on their own.

```ts
await act('user:42', () => fetchUser(42), { cache: { ttl: 60_000 } })
// ... user updates their profile ...
invalidate('user:42')  // next call re-fetches
```

### `withStore(store)`

Creates a scoped `act` function bound to an explicit store. Use for SSR request isolation, multi-tenant scenarios, or test isolation.

```ts
import { withStore, InMemoryStore } from 'actly'

const store = new InMemoryStore({ maxSize: 1000, autoCleanup: true })
const act = withStore(store)

try {
  await act('user:42', () => fetchUser(42), { cache: { ttl: 60_000 } })
  act.invalidate('user:42')
} finally {
  store.destroy()
}
```

For sync stores, `invalidate` returns `boolean`. For async stores, returns `Promise<boolean>`.

### `execute(input)`

Low-level execution engine for building custom policy chains. Accepts `{ key, fn, policies, store, meta, signal, observability }`. Most callers should use `act()` instead.

### `InMemoryStore`

Reference `SyncStateStore` implementation. Bounded LRU with TTL, background cleanup, O(1) operations.

```ts
import { InMemoryStore } from 'actly'

const store = new InMemoryStore({
  maxSize: 10_000,          // default Infinity
  autoCleanup: true,        // default false
  cleanupIntervalMs: 30_000 // default 30s
})
```

---

## Options

### `retry`

Retry `fn` on failure.

```ts
{
  retry: {
    attempts: 3,                    // total attempts including first call (≥1, ≤100)
    delayMs: 200,                   // base delay (≥0, ≤300_000)
    backoff: 'exponential',         // 'none' | 'linear' | 'exponential' (default 'none')
    maxDelay: 30_000,               // cap on computed delay (default Infinity)
    jitter: 'full',                 // 'none' | 'full' | 'equal' | 'decorrelated' (default 'full')
    shouldRetry: (error, attempt) => true  // default: retry all except AbortError
  }
}
```

**Delay computation order:** backoff grows → maxDelay caps → jitter randomizes.

**Default `shouldRetry`:** retries on every error except `AbortError` (caller/timeout cancellation). Override to skip non-recoverable errors (HTTP 4xx, auth failures).

**`attempts: 1` is a no-op** — the retry policy is skipped (pure overhead if included).

### `timeout`

Per-attempt deadline. Each retry gets a fresh clock.

```ts
{ timeout: { ms: 5_000 } }  // ms > 0, ≤100_000_000
```

If `fn` cooperates (passes `signal` to `fetch`, database drivers, etc.), the underlying work is cancelled. If `fn` ignores the signal, `act()` still returns promptly via a race — but the underlying work continues in the background (resource leak).

### `totalTimeout`

Hard wall-clock budget over the entire operation — including all retry attempts, delays, and per-attempt timeouts.

```ts
{ totalTimeout: { ms: 12_000 } }
```

Use with `timeout` to express: "each attempt may take at most X ms, but the whole operation must finish within Y ms."

### `dedupe`

Collapse concurrent calls with the same key into one in-flight Promise.

```ts
dedupe: true
// or
dedupe: { enabled: true, inflightTtl: 30_000 }
```

`inflightTtl` is a safety-net TTL for the in-flight entry. If the originator's promise doesn't settle within this window, the entry is removed so subsequent callers can start fresh. Default: `Infinity` (no safety net). Pair with `timeout` or `totalTimeout` for proper cancellation.

**Joiner isolation:** if the originator's caller aborts, joiners are NOT affected. Each joiner races the in-flight promise against their own signal.

**Requires sync store.** `execute()` throws at chain-build time if an async store is used with dedupe.

### `cache`

Store successful results for a TTL.

```ts
{ cache: { ttl: 60_000 } }  // ttl > 0, ≤86_400_000
```

**Failures are never cached.** Only successful values are stored.

**Single-flight (cache stampede prevention):** on sync stores, concurrent cache misses join a single in-flight Promise. On async stores, stampedes are a known limitation.

**Fail-open writes:** if `store.set()` throws (e.g. Redis transient error), the error is swallowed and the value is returned to the caller. Caching is an optimization, not a correctness requirement.

### `signal`

Caller-provided `AbortSignal` for external cancellation.

```ts
const controller = new AbortController()
setTimeout(() => controller.abort(new Error('user-cancelled')), 5_000)

await act('user:42', async (signal) => fetch(url, { signal }), {
  signal: controller.signal,
})
```

### `observability`

Event hooks for metrics, logging, and tracing. Zero overhead when not registered.

```ts
{
  observability: {
    onAttempt:       (e) => metrics.increment('act.attempt', { attempt: e.attempt }),
    onRetry:         (e) => metrics.increment('act.retry', { attempt: e.attempt }),
    onCacheHit:      (e) => metrics.increment('act.cache_hit', { ageMs: e.ageMs }),
    onCacheMiss:     (e) => metrics.increment('act.cache_miss'),
    onDedupeJoin:    (e) => metrics.increment('act.dedupe_join'),
    onTimeout:       (e) => metrics.increment('act.timeout', { kind: e.kind }),
    onFinalSuccess:  (e) => metrics.histogram('act.duration', e.durationMs),
    onFinalFailure:  (e) => logger.error({ traceId: e.traceId, failedBy: e.failedBy }, 'act failed'),
  }
}
```

**Zero-cost contract:** when `observability` is `undefined` or an empty hooks object, no event objects are allocated and no function calls are made. Verified by benchmark: empty observability adds ~0.24 µs over fast path.

### `traceId`

Correlation ID for logs/metrics. Auto-generated via `crypto.randomUUID()` on Node 20+. Falls back to timestamp+random string. Surfaces on every event and on `ActResult.traceId`.

---

## Error taxonomy

Six error classes. All extend `ActlyError` which extends `Error`. Each carries a stable `.code` string for cross-realm telemetry (e.g. errors serialized over IPC).

```ts
import {
  ActlyError,           // abstract base — instanceof ActlyError
  ActlyAbortError,      // .code = 'ACTLY_ABORT' — caller/signal cancellation
  TimeoutError,         // .code = 'ACTLY_TIMEOUT' — per-attempt deadline
  TotalTimeoutError,    // .code = 'ACTLY_TOTAL_TIMEOUT' — operation-wide budget
  RetryExhaustedError,  // .code = 'ACTLY_RETRY_EXHAUSTED' — all attempts failed
  ValidationError,      // .code = 'ACTLY_VALIDATION' — programmer error (invalid options)
} from 'actly'
```

**`ValidationError` throws synchronously** — it's not wrapped in `ActFailure` because the caller's code is broken, not the runtime.

**`RetryExhaustedError`** carries `attempts`, `lastError`, and `errors[]` for debugging retry patterns.

```ts
if (!result.ok && result.error instanceof RetryExhaustedError) {
  console.log(`failed after ${result.error.attempts} attempts`)
  console.log(`last error:`, result.error.lastError)
}
```

**Cross-realm safety:** prefer `err.code === 'ACTLY_TIMEOUT'` over `err instanceof TimeoutError` when errors cross process/worker boundaries.

---

## Stores

### Sync vs Async

`SyncStateStore` — all operations complete synchronously. Required for `dedupePolicy` (the read-then-write that makes deduplication work must happen in a single synchronous frame).

`AsyncStateStore` — all operations return Promises. Compatible with `cachePolicy` only.

```ts
import type { SyncStateStore, AsyncStateStore } from 'actly'

// Sync: InMemoryStore is the reference implementation
const syncStore: SyncStateStore = new InMemoryStore()

// Async: implement the interface for Redis, DynamoDB, etc.
const asyncStore: AsyncStateStore = {
  _sync: false as const,
  async get<T>(key: string): Promise<T | undefined> { /* ... */ },
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> { /* ... */ },
  async delete(key: string): Promise<void> { /* ... */ },
  async has(key: string): Promise<boolean> { /* ... */ },
  async clear(): Promise<void> { /* ... */ },
  async size(): Promise<number> { /* ... */ },
}
```

### Default store

`act()` without `withStore()` uses a module-level default `InMemoryStore` bounded at 10,000 entries with 60-second background cleanup.

**Multi-tenant warning:** the default store is shared across all callers in the process. For multi-tenant applications, use `withStore()` with per-tenant stores to prevent cross-tenant data leakage.

### `InMemoryStore` internals

- **LRU:** doubly-linked list for O(1) reordering (no `delete + set` Map churn).
- **TTL:** lazy on `get()`/`has()`, background sweep for unreferenced entries.
- **`size()`:** O(1) via Map size counter.
- **`destroy():** stops cleanup timer. Idempotent.

---

## Policy order

Policies are applied in a fixed order, outermost to innermost:

```
totalTimeout → cache → dedupe → retry → timeout → fn
```

- `totalTimeout` is outermost — if it fires, no inner policy can extend the deadline.
- `cache` short-circuits everything below it on a hit.
- `dedupe` collapses concurrent callers before retry fires.
- `retry` owns the attempt loop.
- `timeout` is innermost — each attempt gets a fresh clock.

Policies with no effect (e.g. `retry.attempts: 1`) are skipped.

---

## Limits

All numeric inputs are bounded to prevent memory/CPU/timer exhaustion:

| Limit | Value | Rationale |
|-------|-------|-----------|
| `MAX_KEY_LENGTH` | 1024 chars | Prevents multi-MB keys bloating stores |
| `MAX_RETRY_ATTEMPTS` | 100 | ~100 fn invocations |
| `MAX_TIMEOUT_MS` | 100,000,000 ms (~27h) | Prevents timer overflow |
| `MAX_CACHE_TTL` | 86,400,000 ms (24h) | Prevents pathological TTLs |
| `MAX_RETRY_DELAY_MS` | 300,000 ms (5 min) | Bounds worst-case latency per retry |
| `MAX_INFLIGHT_TTL` | 86,400,000 ms (24h) | Bounds dedupe inflight window |
| `DEFAULT_STORE_MAX_SIZE` | 10,000 entries | Bounds default store memory |

Exceeding a limit throws `RangeError`. If you need more, you likely have a bug.

---

## Migration

### From v1.1.x to v1.2.0

**Node 20+ required** (was 18+). Node 18 reached EOL April 2025.

**`retryPolicy` now throws `RetryExhaustedError`** when all attempts fail AND at least one retry happened. Previously, the raw last error was surfaced. The raw error is available on `err.lastError` and `err.errors[]`. If `shouldRetry` returned `false` on the first attempt (no retries), the raw error is still surfaced — no wrapping.

**`TimeoutError` and `TotalTimeoutError` now extend `ActlyError`** (which extends `Error`). Existing `instanceof Error` and `instanceof TimeoutError` checks continue to work. Optional: switch to `err.code === 'ACTLY_TIMEOUT'` for cross-realm safety.

**`ActResult` has new optional fields**: `traceId?`, `durationMs?`. Existing code that reads only `ok`, `value`, `error`, `source`, `attempts` is unaffected.

---

## License

MIT
