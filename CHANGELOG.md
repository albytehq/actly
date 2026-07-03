# Changelog

## v1.2.0 — 2026-07-04

Hardening release. New resilience policies, an error taxonomy, observability
hooks, security hardening, and a set of correctness fixes found during a
deep-dive audit — all shipped together as a single 1.2.0 release.

### Breaking changes

- **Node 20+ required** (was 18+). Node 18 reached EOL April 2025. Native
  `AbortSignal.any()` enables leak-free signal composition.
- **`retryPolicy` now throws `RetryExhaustedError`** when all attempts fail
  AND at least one retry happened. Previously, the raw last error was
  surfaced. The raw error is available on `err.lastError` and
  `err.errors[]`. If `shouldRetry` returned `false` on the first attempt
  (no retries happened), the raw error is still surfaced unwrapped — no
  change in that path.
- **`TimeoutError` and `TotalTimeoutError` now extend `ActlyError`** (which
  extends `Error`). Existing `instanceof Error` and `instanceof
  TimeoutError` checks continue to work. New `.code` field provides a
  stable string discriminator.
- **`ActResult` has new optional fields**: `traceId?`, `durationMs?`.
  Existing code that reads only `ok`, `value`, `error`, `source`,
  `attempts` is unaffected.

### New policies

- **Circuit breaker** (`circuitBreaker: { threshold, cooldownMs }`) — opens
  after `threshold` consecutive failures, allows exactly one probe call
  through once `cooldownMs` elapses.
- **Bulkhead** (`bulkhead: { maxConcurrent, maxQueue?, queueTimeoutMs? }`)
  — caps in-flight concurrency per key, with optional queueing.
- **Rate limit** (`rateLimit: { maxCalls, windowMs }`) — sliding-window
  limiter.
- **Hedge** (`hedge: { delayMs }`) — sends a second call if the first
  hasn't settled after `delayMs`, races them, abandons the loser.

### Correctness fixes

- Zero listener accumulation on long-lived `AbortSignal`s. Every
  `addEventListener('abort', ...)` is paired with `removeEventListener` on
  the success path.
- Default store is bounded (`maxSize: 10_000`, `autoCleanup: 60s`).
- Dedupe joiner isolation: originator's caller-signal abort does not
  propagate to joiners.
- Generation-safe dedupe cleanup: stale originator cleanup does not delete
  newer entries when `inflightTtl` triggers replacement.
- Cache single-flight originator isolation.
- Cache hit honours abort.
- Async store cache path re-checks signal between awaits.
- `act()` returns promptly on caller abort even without `timeout` policy.
- Joiner abort reports `attempts: 0`.
- `InMemoryStore.size()` is O(1); LRU uses an explicit doubly-linked list.
- `computeDelay` decorrelated jitter no longer produces a negative delay
  when `maxDelay` caps below `delayMs` — clamped to `[0, delay]`.
- Cache `onCacheHit` event now reports the real entry age (`ageMs`)
  instead of always `0`. `InMemoryStore` entries carry an `insertedAt`
  timestamp that `cachePolicy` reads.
- `withStore`'s async `invalidate` no longer has a TOCTOU race between
  checking whether a key exists and deleting it — now a single
  `store.delete()` call that reports whether anything was removed.

### Security hardening

- Key sanitisation: rejects `__proto__`, `constructor`, `prototype`,
  control chars, CRLF, keys > 1024 chars, reserved prefixes (`dedupe:`,
  `cache:`, `__inflight:`).
- Numeric input caps: `retry.attempts ≤ 100`, `timeout.ms ≤
  100_000_000`, `cache.ttl ≤ 86_400_000`, `retry.delayMs ≤ 300_000`,
  `dedupe.inflightTtl ≤ 86_400_000`.
- Enum validation for `retry.backoff` and `retry.jitter`.

### New features

- Error taxonomy: 6 error classes with stable `.code` field
  (`ActlyError`, `ActlyAbortError`, `TimeoutError`, `TotalTimeoutError`,
  `RetryExhaustedError`, `ValidationError`).
- Observability hooks: 8 event types (`onAttempt`, `onRetry`,
  `onCacheHit`, `onCacheMiss`, `onDedupeJoin`, `onTimeout`,
  `onFinalSuccess`, `onFinalFailure`), zero-cost when not registered.
- Enriched `ActResult`: optional `traceId` and `durationMs` fields.
- Fast path for `act('k', fn)` with no options — skips policy-chain
  construction and observability-context allocation entirely.
- Native `AbortSignal.any()` on Node 20+.
- `AbortController` pooling (up to 64 reused controllers) to reduce GC
  pressure under high call-rate workloads.
- Multi-tenant stores: `createTenantStore()` / `createAsyncTenantStore()`
  — fully separate store per tenant, `evict(tenantId)` for teardown.
- `drain(timeoutMs, scope?)` — waits for all in-flight `act()` calls in a
  scope to settle, for graceful shutdown.

### New public exports

The following are now exported from `'actly'`:

- `anySignal(signals)` — compose multiple AbortSignals into one
- `raceAbort(promise, signal)` — race a promise against an AbortSignal
- `sleep(ms, signal?)` — cancellable sleep
- `linkSignal(parent, child)` — link parent signal to child controller
- `isAbortError(err)` — check if error is an AbortError
- `sanitizeKey(key)` — validate/sanitize a key
- `computeDelay(attempt, opts)` — compute retry delay with backoff + jitter
- `LIMITS` — numeric input caps
- `ActlyError`, `ActlyAbortError`, `RetryExhaustedError`, `ValidationError`
  — error taxonomy (in addition to the existing `TimeoutError`,
  `TotalTimeoutError`)
- `createTenantStore`, `createAsyncTenantStore`, `drain`

### Documentation

- README: removed unsubstantiated "production-ready" claim and marketing
  language in favor of factual, verifiable statements; added a
  "Compared to Cockatiel" section with a runnable benchmark
  (`bench/compare-cockatiel.mjs`) backing every performance claim.
- Removed a stale internal comment in `limits.ts` referencing a
  `configure({ limits })` API that was never implemented.

### Internal

- Test suite reorganized: `src/__tests__/bugfix-verification.test.ts`
  renamed to `regression-suite.test.ts`, with `describe()` labels
  rewritten to name the invariant under test instead of an internal
  ticket-style tag (e.g. `BUG-1`, `EDGE-3`).
- Confirmed `npm audit` reports 0 vulnerabilities in runtime dependencies
  (actly ships zero runtime dependencies). One moderate devDependency
  advisory (`esbuild`, via `vitest`) is dev-server-only, does not affect
  the published package, and is tracked in `SECURITY.md`'s out-of-scope
  section.

---

## v1.1.x

Initial public releases. `totalTimeout` cancels inner retry loop, `timeout`
policy is cooperative via AbortSignal, dedupe joiners can abort
independently, cache stampede prevention (single-flight), dedupe joiners
mirror originator's `attempts`, cache hit reports `attempts: 0`.
`AsyncStateStore` interface, `InMemoryStore` public export,
`TotalTimeoutError` distinct from `TimeoutError`, `totalTimeout` option,
`dedupe: true` shorthand, `isSyncStore()` / `isAsyncStore()` type guards.

---

## v1.0.x

Initial stable release. `act()`, `retry`, `timeout`, `totalTimeout`,
`dedupe`, `cache`. `TimeoutError` exported for `instanceof` checks. Zero
dependencies. ESM + CJS. Node 18+.

---

## License

MIT
