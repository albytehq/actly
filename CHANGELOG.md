# Changelog

## v1.3.0 - 2026-07-06

Hardening release. Smaller tarball, more policies, deeper audit. 6 breaking changes (see [MIGRATION.md](./MIGRATION.md)).

A line-by-line audit across core, policies, utils, stores, types, errors, and observability turned up 61 bugs. All fixed. Test count grew from 609 to 633.

### Breaking changes

1. Hedge cancels the losing promise via `AbortController` instead of running it to completion. Set `hedge.keepLoser: true` for the old behavior.
2. Hedge placement defaults to `outside-retry` (one hedge per `act()` call). Was `inside-retry` (one per retry attempt, multiplying downstream load).
3. `dedupe.inflightTtl: 0` now throws. Use `inflightTtl: 1` or omit.
4. `defaultShouldRetry` skips per-attempt `TimeoutError`. `timeout: 1000, retry: { attempts: 5 }` now fails at 1s, not 5s. Override with `shouldRetry: () => true`.
5. Default `inflightTtl` is 5 minutes. Was `Infinity` (a hung `fn` blocked the key forever).
6. `observability` shape is validated. Typos in hook names throw at call time.

### Bug fixes

**Contract and resource leaks**

- Fast-path `act()` rejected under resource exhaustion. The never-rejects contract now holds on every path. (`BUG-CORE-001`)
- `registerInflight` failure leaked an abort listener on `options.signal` in both main and scoped paths. (`BUG-CORE-002`, `BUG-CORE-003`)
- Scoped `act()` did not wrap `buildPolicies` in try/catch. A buggy policy constructor leaked the inflight counter, drain counter, and signal listener, and rejected the promise. (`BUG-CORE-004`)
- `InMemoryStore` leaked its cleanup interval if `destroy()` was never called. Registered a `FinalizationRegistry` as a safety net. (`BUG-ST-003`)
- `createAsyncTenantStore.evict()` did not call `destroy()` on the evicted store. Connection pools leaked per eviction.
- `InMemoryStore.destroy()` did not clear the map. Entry closures leaked.
- `_sweep()` had no try/catch. A corrupted entry could crash the process via `uncaughtException` from a `setInterval` callback.
- `cache` and `dedupe` cleanup callbacks were not wrapped in try/catch. A buggy custom store could trigger `unhandledRejection`. (`BUG-POL-009`, `BUG-POL-011`)
- Idle policy state (bulkhead, circuit breaker, rate limit) was never cleaned up. State lingered per-key forever.
- `drain()` on a non-existent scope created an empty entry that was never pruned. (`BUG-CORE-012`)
- Hedge aborted the winner's controller too. Downstream side-effects (streaming bodies, cursor cleanup) could be cancelled. Now only the loser is aborted. (`BUG-CORE-015`)
- `RetryExhaustedError.errors[]` was unbounded. Capped at 10.
- `withStore` scope ID used 6-char `Math.random`. Birthday-paradox collision at ~47k scoped stores. Switched to `crypto.randomUUID()`.

**Correctness**

- Observability hook throws crashed the main path. Wrapped in `safeCall`.
- `onDedupeJoin` and `onTimeout` hooks were never emitted. Dead code, now fire correctly.
- Hedge did not cancel the losing promise. Self-DoS on downstream.
- Hedge inside retry multiplied downstream load. Moved outside by default.
- `defaultShouldRetry` retried on per-attempt timeout. Misleading. Now skips.
- Count-strategy circuit breaker did not reset the sliding window on a successful half-open probe. One failure after recovery re-tripped it immediately. (`BUG-POL-006`)
- Abort during a half-open probe re-opened the breaker. Caller cancellation is not a downstream failure. Now the breaker stays half-open so the next caller probes. (`BUG-POL-007`)
- `isAbortError` heuristic was too broad. A manual `AbortError` thrown by `fn` for non-signal reasons did not trip the breaker. Now gated on `signal.aborted`. (`BUG-POL-014`)
- Idle-reset behavior diverged between `consecutive` and `count` strategies. Now symmetric: both fully reset on idle. (`BUG-POL-005`)
- NaN delay from `backoffFn` defeated backoff. `Math.max(0, NaN)` is `NaN`, so `if (delay > 0)` was false and the sleep was skipped. Now sanitized to 0. (`BUG-POL-001`)
- Async `shouldRetryResult` predicate was silently treated as "accept" (a Promise is truthy). Runtime type guard added. (`BUG-POL-003`)
- `onBackpressure` flag could get stuck at `true`, suppressing future events. Now resets in `releaseSlot`. (`BUG-POL-012`)
- `Date.now()` was used for duration measurement. Non-monotonic, jumped under NTP. Switched to `performance.now()` via a `monotonicNow()` helper. (`BUG-CORE-014`)
- `hedge.delayMs` had no upper bound. `setTimeout` wraps to 1ms for values over 2^31-1. Capped at 300s. (`BUG-CORE-020`)
- `computeDelay` decorrelated jitter produced zero jitter when `maxDelay < base`. Now degrades to full jitter. (`BUG-UTIL-007`)
- `sanitizeError` discarded `ActlyError.code` and `.key`. Audit logs lost the stable discriminator. Now preserved. (`BUG-CORE-010`)
- `sanitizeError` lost the original stack trace. Now copies `.stack` and chains via `.cause`. (`BUG-UTIL-009`)
- `sanitizeErrorMessage` did not coerce `Error.message` to string. A non-string message threw `TypeError` inside the audit path. (`BUG-UTIL-004`)
- `safeCall` called `result.catch(...)` on thenables without verifying `.catch` exists. Custom thenables were silently dropped. Switched to `Promise.resolve(result).catch(...)`. (`BUG-UTIL-002`)
- `safeCall` accessed `process.env.NODE_ENV` per invocation. Threw `ReferenceError` in environments without `process`. Cached at module load with a typeof guard. (`BUG-UTIL-003`)
- Async observability hook rejections were silently swallowed. Now emit a dev-mode `console.warn`. (`BUG-ST-009`)
- `usePolicy` performed `await import()` on every method invocation. Cached as a top-level Promise. (`BUG-UTIL-006`)
- `usePolicy` did not preserve the original method `name`. Stack traces showed `wrappedMethod`. Now copies via `Object.defineProperty`. (`BUG-UTIL-005`)
- `usePolicy` used `instanceof AbortSignal` for signal detection. Broke across realms. Switched to duck-typing. (`BUG-UTIL-010`)
- `assertOptions` signal duck-type check did not verify `removeEventListener`. A signal-like object without it threw `TypeError` later. (`BUG-UTIL-008`)
- `assertNonNegativeFinite` rejected `Infinity` for `circuitBreaker.resetTimeoutMs`. Inconsistent with `dedupe.inflightTtl`. Now allowed. (`BUG-UTIL-011`)
- `dedupe: null` threw a confusing `TypeError` instead of a clear validation error. Treated as "not provided" now. (`BUG-UTIL-001`)
- `enableWatchdog` did not recreate the interval when `thresholdMs` changed. A 100ms threshold with a 15s interval fired 15s late. (`BUG-CORE-013`)
- Watchdog fired every `intervalMs` for the entire stuck duration. A 10-minute-stuck `fn` produced 40 events. Now fires once per busy period. (`BUG-CORE-018`)
- Scoped `act()` fallback path did not emit `onFinalSuccess`. Operators saw a phantom "missing success" for scoped fallback calls. (`BUG-CORE-005`)
- Scoped `act()` fallback audit-log timestamp used stale `now` captured before the fallback ran. (`BUG-CORE-011`)
- Fallback error was silently swallowed. Now emits `onFinalFailure` and `console.warn` in non-production. (`BUG-CORE-006`)
- `registerInflight` catch did not emit `onFinalFailure`, audit, or `recordError`. Resource exhaustion was invisible to dashboards. (`BUG-CORE-007`)
- `waitForObsHook` timer was not `unref`'d and had no `cancel()`. Tests could hang or leak wrappers across test boundaries. (`BUG-ST-010`)

**Type safety and taxonomy**

- `HedgeTimeoutError` extended `Error` instead of `ActlyError`. `instanceof ActlyError` missed it. `JSON.stringify` returned `{}`. Moved into `errors.ts`, now extends `ActlyError` with `as const` code. (`BUG-ST-001`)
- `ActlyError.toJSON()` silently dropped subclass fields (`attempts`, `ms`, `current`, `limit`, `field`). Now picks up enumerable own properties via `Object.keys(this)`. (`BUG-ST-002`)
- `act<T>()` and `scopedAct<T>()` accepted wrong-typed `fallback.value`. TypeScript now propagates `T` to `ActOptions<T>`. (`BUG-ST-004`)
- `AuditEntry.failedBy` was typed as `string`. Now the `ActlyFailedBy` literal union. (`BUG-ST-008`)
- `ObservabilityContext` was duplicated in `types/index.ts` and `observability.ts`. Re-exported from the source of truth. (`BUG-ST-006`)
- `ExecutorInput` and `ObservabilityContext` were not re-exported from `index.ts`. Now exported. (`BUG-ST-007`)
- `ActlyError.toJSON()` included `message` verbatim. Added `{ redact: true }` option to HTML-escape and length-cap for log shipping. (`BUG-ST-014`)
- `cause` support was inconsistent across `ActlyError` subclasses. Standardized: every subclass accepts `cause` in its options. (`BUG-ST-013`)
- `instanceof ActlyError` is unreliable across realms. Documented. Added `isActlyError(e)` realm-safe predicate. (`BUG-ST-016`)

**Memory safety**

- `InMemoryStore` default `maxSize` was `Infinity`. Unbounded memory growth in long-running servers. Default is now 10,000. Pass `Infinity` explicitly for unbounded. (`BUG-ST-005`)
- `InMemoryStore` allowed non-integer `maxSize`. Surprising eviction behavior. Now requires integer or `Infinity`. (`BUG-ST-015`)
- Tenant manager `tenants` Map grew monotonically. No eviction. Added `maxTenants` (default 10,000) with LRU eviction. (`BUG-CORE-008`, `BUG-CORE-009`)

### New features

**Cockatiel parity**

- `shouldRetryResult`: retry on returned values that are semantic failures (HTTP 500 without throwing).
- `timeout.strategy: 'cooperative'`: wait for `fn` to settle after signal abort.
- `circuitBreaker.strategy: 'count'`: sliding-window ratio breaker.
- `retry.backoffFn`: custom backoff with per-call state carry.
- `retry.dangerouslyUnref`: unref sleep timer for CLI/scripts/tests.
- `noopPolicy()`: passthrough policy for testing and conditional chains.
- `@usePolicy(options)`: method decorator for class methods.
- `./testing` subpath: `waitForObsHook()` and `isActlyEventType()` test helpers.

**Stability**

- Per-scope health state. `createHealthCheck(store, { scope })` respects the scope parameter.
- `drainAll(timeoutMs)`: drain all scopes in parallel for K8s graceful shutdown.
- `createHealthCheck(store, { probeIntervalMs })`: periodic probe warns on stuck inflight.
- Resource budget: `MAX_GLOBAL_INFLIGHT = 100_000` and `ResourceExhaustedError` prevent self-DoS. Opt out via `ACTLY_NO_INFLIGHT_LIMIT=1`.
- `onBackpressure` event: fires when bulkhead queue utilization crosses 80%.
- Watchdog: `enableWatchdog(thresholdMs, hooks)` detects hung `fn` calls.
- `memoryPressureCleanup`: `InMemoryStore({ memoryPressureCleanup: true })` reacts to Node 22+ `process.on('memory')` events.

**Store interface**

- `SyncStateStore.deleteIfExists()` and `AsyncStateStore.deleteIfExists()`: optional atomic delete-and-return-existed. TOCTOU-free `invalidate`.
- `SyncStateStore.destroy()` and `AsyncStateStore.destroy()`: optional lifecycle method. Prevents connection pool leaks on tenant eviction.

**Error taxonomy**

- `ResourceExhaustedError` (`ACTLY_RESOURCE_EXHAUSTED`).
- `HedgeTimeoutError` (`ACTLY_HEDGE_TIMEOUT`), now in the `ActlyError` hierarchy.

### Performance

- Fast path: ~680k ops/sec (no regression).
- Cache hit: ~700k ops/sec (no regression).
- Slow path: marginal improvement from const caching, lazy `errors[]` allocation, and `rateLimit` in-place filter.
- `anySignal` polyfill: hoisted `AbortSignal.any` detection to a module-level constant.
- Bulkhead queue entry: hidden class stabilized (all fields declared up-front).
- `raceAbort` skip: when no `options.signal` is configured, skip Promise and listener allocation.
- `usePolicy`: dynamic `import()` cached as a top-level Promise. No per-call allocation.
- `safeCall`: `IS_DEV` flag cached at module load. No `process.env` access per invocation.
- `monotonicNow()`: uses `performance.now()` (sub-microsecond, monotonic). No regression.

### Size

- tarball: 91 KB to 57 KB.
- dist: 435 KB to 287 KB.
- `.d.ts`: 57 KB to 21 KB via `removeComments` + `stripInternal`.
- Source maps dropped from the npm tarball (kept in repo).
- Deleted deprecated `src/state/store.ts` shim.

### Naming

- Private methods: `_appendTail` to `appendTail`, `_removeNode` to `removeNode`, `_moveToTail` to `moveToTail`, `_sweep` to `sweep`. The TS `private` keyword suffices.
- Namespace prefixes: `__inflight:` to `inflight:`. Removed redundant `__tenant:`.
- Hedge sentinel: `'__HEDGE_TIMEOUT__'` string to `HedgeTimeoutError` class.

### Tests

576 tests in v1.2.0. 633 in v1.3.0 across 25 files. New: `phase2-stability`, `phase4-features`, `phase5-stability`, `debug-fixes`, `edge-cases`, `debug2` through `debug7` edge cases, `audit-fixes`, `v131-audit-fixes` (24 regression tests for the audit bugs above).

### Known limitations

- Bulkhead queue cleanup on `store.destroy()` needs a cooperative cleanup API. Deferred.
- Circuit breaker `serialize()`/`hydrate()` for serverless cold start. Per-key state in store, complex API. Deferred.
- `runStoreConformanceTests()` export. Too complex for this release.
- `SamplingBreaker`. Cockatiel has 3 breaker strategies; actly has 2 (consecutive + count).

---

## v1.2.0 - 2026-07-04

Hardening release. New resilience policies, an error taxonomy, observability hooks, security hardening, and a set of correctness fixes from a deep-dive audit.

### Breaking changes

- Node 20+ required (was 18+). Node 18 reached EOL April 2025. Native `AbortSignal.any()` enables leak-free signal composition.
- `retryPolicy` now throws `RetryExhaustedError` when all attempts fail and at least one retry happened. The raw last error is on `err.lastError` and `err.errors[]`. If `shouldRetry` returned `false` on the first attempt (no retries), the raw error is still surfaced unwrapped.
- `TimeoutError` and `TotalTimeoutError` now extend `ActlyError` (which extends `Error`). Existing `instanceof Error` and `instanceof TimeoutError` checks continue to work. New `.code` field provides a stable string discriminator.
- `ActResult` has new optional fields: `traceId?`, `durationMs?`. Existing code that reads only `ok`, `value`, `error`, `source`, `attempts` is unaffected.

### New policies

- Circuit breaker (`circuitBreaker: { threshold, cooldownMs }`).
- Bulkhead (`bulkhead: { maxConcurrent, maxQueue?, queueTimeoutMs? }`).
- Rate limit (`rateLimit: { maxCalls, windowMs }`).
- Hedge (`hedge: { delayMs }`).

### Correctness fixes

- Zero listener accumulation on long-lived `AbortSignal`s. Every `addEventListener('abort', ...)` is paired with `removeEventListener` on the success path.
- Default store is bounded (`maxSize: 10_000`, `autoCleanup: 60s`).
- Dedupe joiner isolation: originator's caller-signal abort does not propagate to joiners.
- Generation-safe dedupe cleanup: stale originator cleanup does not delete newer entries when `inflightTtl` triggers replacement.
- Cache single-flight originator isolation.
- Cache hit honors abort.
- Async store cache path re-checks signal between awaits.
- `act()` returns promptly on caller abort even without `timeout` policy.
- Joiner abort reports `attempts: 0`.
- `InMemoryStore.size()` is O(1). LRU uses an explicit doubly-linked list.
- `computeDelay` decorrelated jitter no longer produces a negative delay when `maxDelay` caps below `delayMs`. Clamped to `[0, delay]`.
- Cache `onCacheHit` event reports the real entry age (`ageMs`) instead of always `0`.
- `withStore`'s async `invalidate` no longer has a TOCTOU race. Now a single `store.deleteIfExists()` call when the store implements it.

### Security

- Key sanitisation: rejects `__proto__`, `constructor`, `prototype`, control chars, CRLF, keys over 1024 chars, reserved prefixes.
- Numeric input caps: `retry.attempts` 100, `timeout.ms` 100M, `cache.ttl` 24h, `retry.delayMs` 5min, `dedupe.inflightTtl` 24h.
- Enum validation for `retry.backoff` and `retry.jitter`.

### New features

- Error taxonomy: 6 classes with stable `.code` field.
- Observability hooks: 8 event types, zero-cost when not registered.
- Enriched `ActResult`: optional `traceId` and `durationMs`.
- Fast path for `act('k', fn)` with no options. Skips policy-chain construction and observability-context allocation.
- Native `AbortSignal.any()` on Node 20+.
- `AbortController` pooling (up to 64 reused controllers) to reduce GC pressure.
- Multi-tenant stores: `createTenantStore()` / `createAsyncTenantStore()`.
- `drain(timeoutMs, scope?)` for graceful shutdown.

### New exports

`anySignal`, `raceAbort`, `sleep`, `linkSignal`, `isAbortError`, `sanitizeKey`, `computeDelay`, `LIMITS`, `ActlyError`, `ActlyAbortError`, `RetryExhaustedError`, `ValidationError`, `createTenantStore`, `createAsyncTenantStore`, `drain`.

---

## v1.1.x

Initial public releases. `totalTimeout` cancels the inner retry loop. `timeout` policy is cooperative via `AbortSignal`. Dedupe joiners can abort independently. Cache stampede prevention (single-flight). Dedupe joiners mirror originator's `attempts`. Cache hit reports `attempts: 0`. `AsyncStateStore` interface, `InMemoryStore` public export, `TotalTimeoutError` distinct from `TimeoutError`, `totalTimeout` option, `dedupe: true` shorthand, `isSyncStore()` / `isAsyncStore()` type guards.

---

## v1.0.x

Initial stable release. `act()`, `retry`, `timeout`, `totalTimeout`, `dedupe`, `cache`. `TimeoutError` exported for `instanceof` checks. Zero dependencies. ESM + CJS. Node 18+.

---

## License

MIT
