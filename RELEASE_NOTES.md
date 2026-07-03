# actly v1.2.0

**Circuit breaker, bulkhead, rate limit, hedge · Error taxonomy · Observability hooks · Security hardening · Contains breaking changes — read before upgrading**

This release adds four new resilience policies (circuit breaker, bulkhead, rate limit, hedge), a proper error taxonomy, observability hooks, and a set of security/correctness fixes found during a deep-dive audit of v1.1.5. **It contains two breaking changes** — a Node version bump and a change to how exhausted retries surface their error — both documented below with exact migration steps.

---

## Breaking changes — read this first

- **Node 20+ is now required** (was 18+). Node 18 reached EOL in April 2025. The bump lets signal composition use native `AbortSignal.any()` instead of a manual listener-based fallback.
- **`retryPolicy` now throws `RetryExhaustedError`** when every configured attempt fails and at least one retry actually happened. Previously the raw last error was surfaced directly. The original error is preserved on `err.lastError`, and the full per-attempt history on `err.errors[]`. If `shouldRetry` rejected retrying on the very first attempt (zero retries happened), the raw error is still surfaced unwrapped — no change there.
- **`TimeoutError` and `TotalTimeoutError` now extend `ActlyError`** (which extends `Error`). Existing `instanceof Error` and `instanceof TimeoutError` checks keep working unchanged; there's a new `.code` field for stable string-based discrimination.
- **`ActResult` gained two optional fields**: `traceId?: string`, `durationMs?: number`. Code that only reads `ok`, `value`, `error`, `source`, `attempts` is unaffected.

If you only use `retry`/`timeout`/`totalTimeout`/`dedupe`/`cache` and don't inspect the error type on an exhausted retry, the only thing you need to do is make sure you're on Node 20+. If you do inspect the error, see "Migration from v1.1.5" below.

---

## New policies

### Circuit breaker

```ts
await act('payments:charge', fn, {
  circuitBreaker: { threshold: 5, cooldownMs: 30_000 },
})
```

Opens after `threshold` consecutive failures, rejects immediately while open, and allows exactly one probe call through once `cooldownMs` elapses — the probe result decides whether the breaker closes or re-opens. Only one probe is admitted per cooldown window, so a burst of callers hitting a freshly half-open breaker doesn't turn the probe into a second stampede.

### Bulkhead

```ts
await act('search:query', fn, {
  bulkhead: { maxConcurrent: 20, maxQueue: 100, queueTimeoutMs: 5_000 },
})
```

Caps in-flight concurrency per key. Callers beyond `maxConcurrent` either queue (if `maxQueue` is set) or reject immediately.

### Rate limit

```ts
await act('api:external-call', fn, {
  rateLimit: { maxCalls: 100, windowMs: 60_000 },
})
```

Sliding-window limiter, keyed the same way as every other policy.

### Hedge

```ts
await act('search:query', fn, {
  hedge: { delayMs: 200 },
})
```

If the primary call hasn't settled after `delayMs`, a second call is sent and the two race — whichever settles first wins, the loser is abandoned (its rejection is caught internally so it can't produce an unhandled rejection).

---

## Correctness fixes

Found and fixed during the v1.1.5 → v1.2.0 audit:

- **Zero listener accumulation on long-lived `AbortSignal`s.** Every `addEventListener('abort', ...)` is now paired with `removeEventListener` on the success path — long-running processes that reuse a signal across many `act()` calls no longer leak listeners.
- **Dedupe joiner isolation.** An originator's own caller-signal abort no longer propagates to joiners riding the same in-flight call; only the originator's own abort surfaces the originator's own outcome.
- **Generation-safe dedupe cleanup.** When `inflightTtl` expires a stuck originator and a new one takes its place, the stale originator's cleanup can no longer delete the new entry — a generation token gates the delete.
- **Cache single-flight originator isolation** and **cache hit honours abort** — mirrors the dedupe fixes above for the cache policy's own single-flight path.
- **Async store cache path re-checks the abort signal between awaits**, so an abort during an async store round-trip is observed promptly instead of only after the round-trip completes.
- **`act()` returns promptly on caller abort even with no `timeout` policy configured** — previously, abort without an explicit timeout could leave the caller waiting on `fn` to finish naturally.
- **Joiner abort reports `attempts: 0`**, consistent with the existing cache-hit behavior.
- **Decorrelated jitter no longer produces a negative delay** when `maxDelay` caps below the base delay — the formula degrades to full jitter in that edge case instead of computing a negative number.
- **`onCacheHit`'s `ageMs` field now reports the real entry age** instead of always `0` — `InMemoryStore` entries now carry an `insertedAt` timestamp that the cache policy reads.
- **`withStore`'s async `invalidate` no longer has a TOCTOU race** between checking whether a key exists and deleting it; it's now a single `delete()` call that reports whether anything was removed.
- **`InMemoryStore.size()` is O(1)**, and the LRU list is a genuine doubly-linked list, not delete+reinsert on a `Map`.

## Security hardening

- **Key sanitisation**: keys can no longer be `__proto__`, `constructor`, `prototype`, contain control characters or CRLF, exceed 1024 characters, or start with a reserved internal prefix (`dedupe:`, `cache:`, `__inflight:`) — all rejected synchronously at call time.
- **Numeric input caps** prevent pathological configuration from causing runaway behavior: `retry.attempts ≤ 100`, `timeout.ms ≤ 100_000_000`, `cache.ttl ≤ 86_400_000`, `retry.delayMs ≤ 300_000`, `dedupe.inflightTtl ≤ 86_400_000`.
- **Enum validation** on `retry.backoff` and `retry.jitter` — invalid values throw at call time instead of silently falling through to unexpected behavior.
- **Default store is bounded** (`maxSize: 10_000`, `autoCleanup: 60s`) — a long-running process using the default store without an explicit `InMemoryStore` can no longer grow it unbounded.

## Error taxonomy

Six error classes, all extending a common `ActlyError` (which extends `Error`) and carrying a stable string `.code` for programmatic discrimination:

```ts
import { ActlyError, ActlyAbortError, TimeoutError, TotalTimeoutError, RetryExhaustedError, ValidationError } from 'actly'
```

Existing `instanceof Error` and `instanceof TimeoutError` checks from v1.1.x continue to work unchanged.

## Observability

```ts
await act('user:42', fn, {
  observability: {
    onAttempt:      (e) => metrics.increment('actly.attempt', { key: e.key }),
    onRetry:        (e) => metrics.increment('actly.retry'),
    onCacheHit:     (e) => metrics.timing('actly.cache.age_ms', e.ageMs),
    onFinalSuccess: (e) => metrics.timing('actly.duration_ms', e.durationMs),
    onFinalFailure: (e) => log.error('actly failure', { key: e.key, error: e.error }),
  },
})
```

Eight hook types (`onAttempt`, `onRetry`, `onCacheHit`, `onCacheMiss`, `onDedupeJoin`, `onTimeout`, `onFinalSuccess`, `onFinalFailure`). Zero-cost when `observability` isn't passed — no hook object is allocated in that path.

## Performance

- **Fast path**: `act('key', fn)` called with no options at all skips policy-chain construction, observability-context allocation, and the abort-race wrapper entirely, going straight to `await fn(...)`.
- **`AbortController` pooling**: up to 64 controllers are reused across calls instead of allocated fresh each time, reducing GC pressure under high call-rate workloads.
- **`InMemoryStore.size()` is O(1)**; LRU eviction and reordering use an explicit doubly-linked list (all O(1) operations).

## Multi-tenant & lifecycle primitives

- **`createTenantStore()` / `createAsyncTenantStore()`** — each tenant gets a fully separate store instance (not a shared store with key-prefixing), so one tenant's cache pressure can't evict another tenant's entries. `evict(tenantId)` tears one tenant down completely.
- **`drain(timeoutMs, scope?)`** — waits for all in-flight `act()` calls in a scope to settle, for graceful shutdown (SIGTERM handlers, etc.) without cutting off in-progress requests.

## New public exports

```ts
import {
  act,
  invalidate, withStore, execute,
  isSyncStore, isAsyncStore, REQUIRES_SYNC_STORE,
  InMemoryStore,
  anySignal, raceAbort, sleep, linkSignal, isAbortError,   // NEW
  sanitizeKey, computeDelay, LIMITS,                        // NEW
  ActlyError, ActlyAbortError, TimeoutError, TotalTimeoutError,
  RetryExhaustedError, ValidationError,                     // NEW error taxonomy
  createTenantStore, createAsyncTenantStore, drain,          // NEW
} from 'actly'
```

---

## Migration from v1.1.5

1. **Bump your Node version to 20+** if you're on 18. Nothing else required for this part.
2. **Audit any code that inspects the error from an exhausted retry.** If you match on error type or message after `act()` returns `{ ok: false, error }` for a key with `retry.attempts > 1`, the error is now `RetryExhaustedError` wrapping the original. Update to read `error.lastError` (or `error.errors[]` for the full attempt history) where you previously read `error` directly. Keys with `retry` unset, or `attempts: 1`, are unaffected — no retry loop means no wrapping.
3. Everything else — `signal`, `withStore`, `invalidate`, `execute`, jitter/`maxDelay`, `inflightTtl`, all v1.1.5 exports — continues to work exactly as documented in v1.1.5. No further changes required.

---

## Compatibility

| | |
|---|---|
| Node.js | **20+** (was 18+) |
| TypeScript | 5.x |
| Module formats | ESM + CJS |
| Dependencies | Zero |
| Breaking changes | Yes — see "Breaking changes" and "Migration from v1.1.5" above |

---

## Checksums

Verify the published package against the registry:

```bash
npm info actly@1.2.0 dist.integrity
```

---

**Full diff:** [`v1.1.5...v1.2.0`](https://github.com/albytehq/actly/compare/v1.1.5...v1.2.0)
