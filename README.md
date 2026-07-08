# actly

A typed reliability kernel for async TypeScript. Retry, timeout, circuit breaker, bulkhead, rate limit, dedupe, cache, hedge, fallback, and graceful shutdown, all composed through one `act()` call that never rejects.

```bash
npm install actly
```

Node 20+. ESM + CJS. Zero runtime deps. 57 KB tarball, 243 KB JS runtime (335 KB installed with type defs). 12 policies in one `act()` call.

> **Bundle note:** This is ~4× larger than [Cockatiel](https://github.com/vjkramer/cockatiel) (63 KB JS) because actly ships cache, dedupe, rate limit, hedge, audit log, multi-tenant isolation, drain, watchdog, and health check in the same package. If you only need retry/timeout/circuit-breaker/bulkhead/fallback and bundle size is critical, use Cockatiel. If you want the broader policy surface in one call, the size delta is the cost.

## Quick start

```ts
import { act } from 'actly'

const r = await act('user:42', async (signal) => {
  const res = await fetch('/api/users/42', { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}, {
  retry: { attempts: 3, delayMs: 200, backoff: 'exponential' },
  timeout: { ms: 5_000 },
  totalTimeout: { ms: 12_000 },
  cache: { ttl: 60_000 },
})

if (r.ok) {
  console.log(r.value, r.source, r.attempts, r.durationMs)
} else {
  console.error(r.error)
}
```

`act()` always resolves. You branch on `r.ok` instead of try/catch around `await`. Failures are typed (see [Errors](#errors)) so you can switch on `r.error.code` for telemetry.

## Features

- **Retry** with exponential/linear/constant backoff, four jitter modes, custom `backoffFn` with per-call state, and `shouldRetryResult` for retrying on returned values (HTTP 500 without throwing)
- **Per-attempt timeout** with `race` (aggressive) or `cooperative` (gentle) strategies
- **Total timeout** spanning the whole retry loop, not just one attempt
- **Circuit breaker** with `consecutive` or `count` (sliding-window ratio) strategies, half-open probe, idle reset
- **Bulkhead** with bounded queue, queue timeout, backpressure event
- **Rate limit** (sliding window, per key)
- **Cache** with stampede protection (single-flight on sync stores), TTL, LRU eviction
- **Dedupe** (single-flight) with generation-safe cleanup and joiner isolation
- **Hedge** with cancel-loser semantics, `outside-retry` (one hedge per call) or `inside-retry` (one per attempt) placement
- **Fallback** value or function
- **AbortSignal** cancellation everywhere, with cross-realm duck-typed signal support
- **Observability** hooks (10 event types) wrapped in `safeCall` so a buggy hook never crashes the main path
- **Health check**, **watchdog** for hung calls, **graceful drain** for shutdown
- **Multi-tenant** store isolation with LRU eviction
- **Pluggable state store** (built-in `InMemoryStore`; bring your own for Redis, DynamoDB, etc.)
- **`@usePolicy`** method decorator
- Typed error taxonomy with stable `.code` strings for cross-realm handling

## API

### `act(key, fn, options?)`

Wraps `fn` with reliability policies. Returns `Promise<ActResult<T>>`, always resolves.

```ts
interface ActSuccess<T> {
  ok: true
  value: T
  source: 'fresh' | 'cache'
  attempts: number       // 1-based; 0 on cache hit
  traceId?: string
  durationMs?: number
}

interface ActFailure {
  ok: false
  error: unknown         // see Errors
  attempts: number
  traceId?: string
  durationMs?: number
}

type ActResult<T> = ActSuccess<T> | ActFailure
```

`key` scopes dedupe and cache. Validated for prototype pollution, control chars, CRLF, length (1024 max), and reserved prefixes (`dedupe:`, `cache:`, `inflight:`, `tenant:`).

### `invalidate(key)`

Removes the cached value for `key` from the default store. Returns `true` if a cache entry was removed.

```ts
await act('user:42', () => fetchUser(42), { cache: { ttl: 60_000 } })
invalidate('user:42')  // next call re-fetches
```

### `withStore(store)`

Returns a scoped `act` bound to an explicit store. Use for SSR request isolation, multi-tenant scenarios, or tests.

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

The scoped `act` has the same signature as the default `act`, plus an `invalidate(key)` method, a `store` property, and a `scope` property (the internal scope string for `createHealthCheck`).

### `execute(input)`

Low-level execution engine for custom policy chains. Accepts `{ key, fn, policies, store, meta, signal, observability }`. Most callers should use `act()`.

### `noopPolicy()`

Passthrough policy. No retry, no timeout, no state. Useful for testing and conditional chains.

```ts
const retry = isProd
  ? retryPolicy({ attempts: 3 })
  : noopPolicy()
```

### `usePolicy(options)`

Method decorator. Wraps a class method with `act()`. Preserves `this` and the method `name`.

```ts
import { usePolicy } from 'actly'

class UserService {
  @usePolicy({ retry: { attempts: 3, delayMs: 100 }, timeout: { ms: 5000 } })
  async fetchUser(signal: AbortSignal, id: string): Promise<User> {
    const res = await fetch(`/api/users/${id}`, { signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }
}
```

### `createHealthCheck(store, options?)`

Returns a function that produces a `HealthStatus` snapshot.

```ts
import { createHealthCheck, InMemoryStore } from 'actly'

const store = new InMemoryStore()
const health = createHealthCheck(store, {
  scope: 'default',
  probeIntervalMs: 30_000,  // optional: warn on stuck inflight calls
})

const status = health()
// { storeSize, pendingInflight, uptimeMs, lastError?, lastSuccessAt? }
```

### `drain(timeoutMs, scope?)` and `drainAll(timeoutMs)`

Wait for in-flight `act()` calls to settle. `drainAll` drains all scopes in parallel.

```ts
process.on('SIGTERM', async () => {
  const ok = await drainAll(10_000)
  process.exit(ok ? 0 : 1)
})
```

### `enableWatchdog(thresholdMs?, hooks?)`

Opt-in background watchdog. Fires `onWatchdog` when an in-flight call exceeds `thresholdMs` (default 60s). Catches hung `fn` calls that ignore the signal and have no timeout configured.

```ts
enableWatchdog(30_000, {
  onWatchdog: (e) => logger.warn({ elapsedMs: e.elapsedMs }, 'hung act() call'),
})
```

### `createTenantStore(options)` and `createAsyncTenantStore(factory)`

Per-tenant store isolation. Each tenant gets its own store instance (not a shared store with key prefixes). LRU-evicts idle tenants when `maxTenants` is reached.

```ts
import { createTenantStore } from 'actly'

const tenants = createTenantStore({ maxSize: 1000, autoCleanup: true, maxTenants: 10_000 })
const tenant1Act = tenants.get('tenant-1')
await tenant1Act('user:42', async () => fetchUser(42))
tenants.evict('tenant-1')  // destroys the store, releases resources
```

### `InMemoryStore`

Reference `SyncStateStore`. Bounded LRU with TTL, background sweep, O(1) operations. Default `maxSize` is 10,000 (bounded). Pass `Infinity` explicitly for unbounded storage.

```ts
const store = new InMemoryStore({
  maxSize: 10_000,              // default 10_000; pass Infinity for unbounded
  autoCleanup: true,            // default false
  cleanupIntervalMs: 30_000,    // default 30s
  memoryPressureCleanup: true,  // react to Node 22+ 'memory' events
})

store.destroy()  // stops timer, clears map, removes listeners. Idempotent.
```

The store registers a `FinalizationRegistry` so the cleanup timer is cleared even if you forget `destroy()`. Still call `destroy()` explicitly when you can; GC timing is not deterministic.

## Options

All fields optional. Compose any combination.

### `retry`

```ts
{
  retry: {
    attempts: 3,                    // total attempts including first (1-100)
    delayMs: 200,                   // base delay (0-300_000)
    backoff: 'exponential',         // 'none' | 'linear' | 'exponential' (default 'none')
    maxDelay: 30_000,               // cap on computed delay (default Infinity)
    jitter: 'full',                 // 'none' | 'full' | 'equal' | 'decorrelated' (default 'full')
    shouldRetry: (error, attempt) => true,
    shouldRetryResult: (value, attempt) => true,  // retry on returned values (HTTP 500)
    backoffFn: (attempt, error, state) => 1000,   // custom backoff, overrides backoff+jitter
    dangerouslyUnref: false,        // unref sleep timer (CLI/scripts/tests)
  }
}
```

`shouldRetryResult` retries on returned values that are semantic failures. The common pattern: `fetch` returns a 500 without throwing.

```ts
await act('fetch-api', async (signal) => fetch('/api', { signal }), {
  retry: {
    attempts: 3,
    shouldRetryResult: (res) => res.ok && res.status < 500,
  },
})
```

`backoffFn` carries per-call state. Useful for honoring `Retry-After`.

```ts
await act('fetch-retry-after', async (signal) => {
  const res = await fetch('/api', { signal })
  if (!res.ok) {
    const ra = parseInt(res.headers.get('retry-after') ?? '0', 10)
    if (ra > 0) state.retryAfter = ra * 1000
    throw new Error(`HTTP ${res.status}`)
  }
  return res
}, {
  retry: {
    attempts: 5,
    backoffFn: (_attempt, _err, state) => state.retryAfter ?? 1000,
  },
})
```

Default `shouldRetry` skips `AbortError`, `ACTLY_TIMEOUT`, and `ACTLY_TOTAL_TIMEOUT` so a slow endpoint with `timeout: 1000, retry: { attempts: 5 }` fails at 1s, not 5s. Override with `shouldRetry: () => true` to retry on everything.

`attempts: 1` is a no-op; the retry policy is skipped.

### `timeout`

Per-attempt deadline. Each retry gets a fresh clock.

```ts
{ timeout: { ms: 5_000, strategy: 'race' } }
```

`strategy: 'race'` (default) races `fn(signal)` against the abort event and returns promptly at `ms` whether `fn` cooperates or not.

`strategy: 'cooperative'` aborts the signal but waits for `fn` to settle. Gentler on downstreams that don't cooperate with `AbortSignal` (they get to clean up), but can run past `ms` if `fn` is slow to reject after the abort.

### `totalTimeout`

Hard wall-clock budget over the whole operation, including retries, delays, and per-attempt timeouts.

```ts
{ totalTimeout: { ms: 12_000 } }
```

### `dedupe`

Collapses concurrent calls with the same key into one in-flight Promise.

```ts
dedupe: true
// or
dedupe: { enabled: true, inflightTtl: 30_000 }
```

`inflightTtl` (default 5 minutes) is a safety-net TTL for the in-flight entry. If the originator's Promise doesn't settle within this window, the entry is removed so subsequent callers can start fresh. Pass `Infinity` explicitly for the old "wait forever" behavior.

Joiner isolation: if the originator's caller aborts, joiners are not affected. Each joiner races the in-flight Promise against their own signal.

Requires a sync store. `execute()` throws at chain-build time if an async store is used with dedupe.

### `cache`

Stores successful results for a TTL.

```ts
{ cache: { ttl: 60_000 } }  // 0 < ttl <= 86_400_000
```

Failures are never cached. Only successful values.

Single-flight (cache stampede protection): on sync stores, concurrent cache misses join one in-flight Promise. On async stores, stampedes are a known limitation.

`store.set()` failures (e.g. Redis transient error) are swallowed; the value is still returned to the caller.

### `circuitBreaker`

Opens after threshold failures, rejects immediately while open, allows one probe call after cooldown.

```ts
{
  circuitBreaker: {
    threshold: 5,             // consecutive failures before opening
    cooldownMs: 30_000,       // how long to stay open
    resetTimeoutMs: 600_000,  // optional: reset failure count after idle (default Infinity)
    strategy: 'consecutive',  // 'consecutive' (default) | 'count'
    // For strategy: 'count':
    countSize: 100,            // window size
    countThreshold: 0.5,       // failure rate to trip (0-1)
    countMinimumCalls: 100,    // min calls before tripping
  }
}
```

`consecutive` opens after N failures in a row. Resets on any success. Good for "downstream is fully down."

`count` is a sliding-window ratio breaker. Trips when the failure rate in the last `countSize` calls exceeds `countThreshold`. Use for "downstream is degraded" (e.g. trip when >30% of last 100 calls fail).

Half-open probe: probe failure re-opens immediately. Probe success resets the window (count strategy) or the failure counter (consecutive).

### `bulkhead`

Caps in-flight concurrency per key.

```ts
{
  bulkhead: {
    maxConcurrent: 10,
    maxQueueSize: 100,         // default Infinity
    queueTimeoutMs: 5_000,     // default Infinity
  }
}
```

When `maxConcurrent` is reached, new callers queue. When the queue is full or `queueTimeoutMs` elapses, callers get `BulkheadOverflowError`. `onBackpressure` observability hook fires when queue utilization crosses 80%.

### `rateLimit`

Sliding window rate limit per key.

```ts
{ rateLimit: { maxCalls: 100, windowMs: 60_000 } }
```

### `hedge`

Sends a second call after `delayMs`, races them, cancels the loser.

```ts
{
  hedge: {
    delayMs: 100,                  // > 0, <= 300_000
    keepLoser: false,              // default false; true = don't cancel
    placement: 'outside-retry',    // 'outside-retry' (default) | 'inside-retry'
  }
}
```

`outside-retry` (default) wraps the whole execute chain. One hedge per `act()` call regardless of retry count. `inside-retry` wraps `fn` directly, so each retry attempt can spawn its own hedge (multiplies downstream load; rarely what you want).

When one settles, the loser is aborted via its `AbortController`. If `fn` cooperates with the signal (passes it to `fetch`, DB drivers, etc.) the underlying work is cancelled. The winner's controller is not aborted, so downstream side-effects (streaming bodies, cursor cleanup) run to completion.

### `fallback`

Returns a value (or function result) instead of the failure when `fn` fails.

```ts
{ fallback: { value: 'default' } }
// or
{ fallback: { value: () => computeFallback() } }
```

If the fallback function itself throws, the original `fn` error is surfaced. The fallback error is logged via `console.warn` in non-production and emitted via `onFinalFailure` so you can detect a broken fallback.

### `observability`

Hooks fire on lifecycle events. Wrapped in `safeCall` so a buggy hook never crashes the main path.

```ts
{
  observability: {
    onAttempt: (e) => ...,        // before each attempt
    onRetry: (e) => ...,          // before each retry delay
    onCacheHit: (e) => ...,
    onCacheMiss: (e) => ...,
    onDedupeJoin: (e) => ...,
    onTimeout: (e) => ...,
    onFinalSuccess: (e) => ...,
    onFinalFailure: (e) => ...,
    onBackpressure: (e) => ...,
    onWatchdog: (e) => ...,
  }
}
```

Each event carries `key`, `traceId`, `timestamp`. Pass `traceId` explicitly or let actly generate a UUID.

### `audit`

Single hook for structured logging of every call result.

```ts
{
  audit: {
    log: (entry: AuditEntry) => {
      // { key, traceId, timestamp, durationMs, ok, attempts, failedBy?, error? }
      logger.info(entry)
    },
  }
}
```

### `signal`

Caller-supplied `AbortSignal`. Linked to the root controller. Aborting it cancels the entire operation.

## Errors

All actly-thrown errors extend `ActlyError` and carry a stable `.code` string. Use the code (not `instanceof`) for cross-realm handling. `isActlyError(e)` is a realm-safe predicate.

| Class | code | Meaning |
|---|---|---|
| `ActlyAbortError` | `ACTLY_ABORT` | caller signal, per-attempt timeout, or total timeout aborted |
| `TimeoutError` | `ACTLY_TIMEOUT` | per-attempt deadline fired |
| `TotalTimeoutError` | `ACTLY_TOTAL_TIMEOUT` | operation-wide budget exhausted |
| `RetryExhaustedError` | `ACTLY_RETRY_EXHAUSTED` | all retry attempts failed |
| `ValidationError` | `ACTLY_VALIDATION` | programmer error (invalid options) |
| `CircuitBreakerOpenError` | `ACTLY_CIRCUIT_OPEN` | breaker is open |
| `BulkheadOverflowError` | `ACTLY_BULKHEAD_FULL` | bulkhead queue full or timed out |
| `RateLimitError` | `ACTLY_RATE_LIMIT` | rate limit exceeded |
| `ResourceExhaustedError` | `ACTLY_RESOURCE_EXHAUSTED` | process-wide inflight budget exceeded |
| `HedgeTimeoutError` | `ACTLY_HEDGE_TIMEOUT` | hedge deadline fired before primary settled |

`ActlyError.toJSON({ redact?: true })` returns a plain object with `name`, `code`, `message`, `key`, `stack`, plus subclass-specific fields (`attempts`, `ms`, `current`, `limit`, etc.). Pass `redact: true` to HTML-escape and length-cap the message for log shipping.

## Compared to Cockatiel

Both are typed, zero-dependency resilience libraries for Node/TypeScript. Both use native `AbortSignal` for cancellation. The core difference is scope *and* size.

| | actly | Cockatiel |
|---|---|---|
| Policies | retry, timeout, totalTimeout, circuitBreaker, bulkhead, rateLimit, cache, dedupe, hedge, fallback, noop, decorator | retry, timeout, circuitBreaker, bulkhead, fallback, noop |
| Cross-call state | Yes (keyed store: cache, dedupe, breaker counter, rate limit) | No (policies are stateless per-instance) |
| Multi-tenant isolation | Yes (`createTenantStore`) | No |
| Audit log / health / drain / watchdog | Built-in | External |
| Tarball size | 57 KB | ~30 KB |
| JS runtime (installed) | 243 KB | 63 KB (~4× smaller) |
| Per-call overhead (retry configured) | ~2.4 µs | ~0.35 µs (~7× faster) |
| Runtime deps | 0 | 0 |

Where they overlap (retry, timeout, circuit breaker, bulkhead), semantics are comparable. actly uses a keyed state store (`Map` get/set per call) to support cross-call features (circuit breaker failure counts, cache, dedupe) that Cockatiel doesn't have. That indirection costs a few microseconds per call and the extra code adds bundle weight.

For wrapping network or database calls (what both libraries are for), the per-call overhead difference is noise — a single intra-region AWS RTT is ~1,000 µs, so a 2 µs delta is 0.2% of one network hop. But for in-process cache layers or routers at 100k+ calls/sec, the overhead and bundle size matter; pick Cockatiel there.

Pick actly when you want cache/dedupe/rate-limit/hedge/audit/multi-tenant in the same call and can absorb the bundle cost. Pick Cockatiel when you only need retry/timeout/circuit-breaker/bulkhead/fallback and want the leanest per-call cost and smallest install footprint.

## Performance

Numbers from `npm run bench` on a 2023 MacBook Pro with Node 22. 20,000 iterations, 500 warmup. Live sandbox re-run (Node 24) confirms the same shape.

| Configuration | ops/sec | µs/op | Notes |
|---|---|---|---|
| Fast path (zero options) | ~680,000 | ~1.5 | Just `act(key, fn)`, no policies applied |
| Cache hit | ~700,000 | ~1.4 | Single-flight in-memory store |
| Retry only (attempts=3) | ~415,000 | ~2.4 | Same as the Quick Start example |
| Circuit breaker (closed) | ~720,000 | ~1.4 | Happy path, breaker not tripped |
| Bulkhead (maxConcurrent=10) | ~313,000 | ~3.2 | Under cap, no queuing |
| Composed (retry+timeout+breaker) | ~84,000 | ~11.9 | The realistic case |

**Cockatiel comparison (same sandbox, same workload):**

| Configuration | actly ops/sec | Cockatiel ops/sec | actly overhead |
|---|---|---|---|
| Retry | 415,000 | 2,835,000 | 6.8× slower |
| Timeout | 87,000 | 177,000 | 2.0× slower |
| Circuit breaker | 722,000 | 2,272,000 | 3.1× slower |
| Bulkhead | 313,000 | 5,533,000 | 17.7× slower |
| Composed (3 policies) | 84,000 | 156,000 | 1.9× slower |

The composed case is the closest to a real workload. The 1.9× delta is microseconds, not milliseconds — invisible behind a 50ms network call. The bulkhead 17.7× delta is the worst case and matters only for in-process routers; if your `fn` is a no-op or in-memory lookup, the bulkhead machinery dominates total time.

Observability hooks have zero overhead when not configured. When configured, `safeCall` wraps every hook invocation so a buggy hook never propagates into the main path.

## Limitations

- `dedupe`, `circuitBreaker`, `bulkhead`, and `rateLimit` require a sync store. `cache` works with both sync and async stores.
- Async stores can't do single-flight for cache misses (no atomic check-and-publish). Use a sync store or accept the stampede risk.
- `cooperative` timeout strategy can wait past `ms` if `fn` doesn't reject after the abort. Pair with `totalTimeout` for a hard ceiling.
- `instanceof ActlyError` works only within the same realm (worker_threads, vm contexts break the prototype chain). Use `isActlyError(e)` or switch on `.code` for cross-realm handling.

## License

MIT
