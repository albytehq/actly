# Migration Guide

## v1.3.0 → v1.4

One intentional contract change (validation now throws synchronously), a strictness change for standalone policy factories, two deprecations, and a distribution change. Everything else is fixes and speed.

### 1. Validation throws synchronously

`act()` (and scoped `act()`) now throw **synchronously** for programmer errors — invalid keys, invalid options, unknown observability hook names — instead of returning a rejected promise. Runtime failures still always resolve to `ActResult`. README 1.3.0 already documented this as the intended contract; the implementation finally matches.

```ts
// before (1.3 actual behavior): rejected promise
await act('k', fn, { retry: { attempts: 0 } }).catch(handle) // .catch never ran

// after: sync throw at the call site
try {
  await act('k', fn, { retry: { attempts: 1 } }) // valid
} catch (e) {
  // never reached for runtime errors — only for invalid input
}
```

If you called `.catch()` on `act()` specifically to handle validation errors, wrap the call in `try/catch` instead.

### 2. Hedge winner is no longer aborted (the fix you were promised in 1.3.0)

On the default `outside-retry` placement, v1.3.0 still aborted the winner's controller after the race settled, cancelling live downstream work. If you worked around it (checking `signal.aborted` after resolve, or forcing `placement: 'inside-retry'`), remove the workaround.

### 3. Distribution: real CJS, no deep files

- `require('actly')` now works on every Node 20+ (v1.3 required Node 22.12+/20.19+ via `require(esm)`).
- `dist/` contains two single-file bundles (`index.js`, `index.cjs`) plus per-module `.d.ts` files. Deep imports like `require('actly/dist/core/act.js')` (never part of the `exports` map) no longer resolve — import from `'actly'`.
- Tarball 84 → 66.1 KB; unpacked 400 → 209 KB; package files 152 → 43 (dist 37).

### 4. Deprecated (still working, removal in 2.0)

- `retry.shouldRetryResult` → `retry.acceptResult` (same semantics, non-inverted name).
- `acquireController` / `releaseController` / `poolSize` — the fast path uses a shared never-aborted signal; the pool has no internal use.

### 5. Stricter `isActlyError`

Plain objects that merely carry an `ACTLY_*`-prefixed `code` no longer match. Real actly errors (any realm) and Error-shaped objects with a known code still match.

### 6. `createHealthCheck` accepts any store

The parameter type widened from the concrete `InMemoryStore` class to the store contract. Async stores report `storeSize: -1`.

### 7. Standalone policy factories validate (previously silent coercion)

`retryPolicy`, `timeoutPolicy`, `totalTimeoutPolicy`, `cachePolicy`, `dedupePolicy`, `rateLimitPolicy`, and `circuitBreakerPolicy` now throw at construction for the same invalid options `act()` always rejected. Code that "worked" only because invalid values were silently coerced will now throw:

```ts
// before: silently became 1 attempt
const p = retryPolicy({ attempts: 0 })   // RangeError now
// before: setTimeout clamped ms: Infinity to a 1 ms fire
const t = timeoutPolicy({ ms: Infinity }) // RangeError now
// before: ttl: 0 meant "never expires" in the store layer
const c = cachePolicy({ ttl: 0 })        // RangeError now
```

`enableWatchdog(NaN)` / `enableWatchdog(Infinity)` likewise throw instead of creating a 1 ms busy interval. All of these were programmer errors with silent misbehavior before; if your code throws now, it was already broken.

---

# Migration Guide: v1.2.0 to v1.3.0

Six breaking changes. If you only use `retry` / `timeout` / `totalTimeout` / `dedupe` / `cache` and don't inspect error types on exhausted retries, you probably don't need to change anything.

## 1. Hedge cancels the losing promise

Previously the loser ran to completion, wasting downstream resources. Now it is aborted via `AbortController`. If `fn` cooperates with the signal, the underlying work is cancelled.

```ts
// old: loser kept running
await act('search', async (signal) => searchDB({ signal }), {
  hedge: { delayMs: 200 },
})

// new: loser is cancelled (default)
await act('search', async (signal) => searchDB({ signal }), {
  hedge: { delayMs: 200 },
})

// opt out if you need the loser's side-effects
await act('search', async (signal) => searchDB({ signal }), {
  hedge: { delayMs: 200, keepLoser: true },
})
```

## 2. Hedge placement defaults to `outside-retry`

Previously hedge wrapped `fn` before the policy chain. Each retry attempt could spawn its own hedge, multiplying downstream load by the retry count. Now hedge wraps the whole chain. One hedge per `act()` call.

```ts
// old: 5 retries + hedge could spawn up to 10 fn invocations
await act('k', fn, { retry: { attempts: 5 }, hedge: { delayMs: 50 } })

// new: 5 retries + hedge spawns at most 2 fn invocations total
await act('k', fn, { retry: { attempts: 5 }, hedge: { delayMs: 50 } })

// opt in to per-attempt hedge (old behavior)
await act('k', fn, {
  retry: { attempts: 5 },
  hedge: { delayMs: 50, placement: 'inside-retry' },
})
```

## 3. `inflightTtl: 0` is rejected

Previously `inflightTtl: 0` was accepted but silently treated as `Infinity`. Now it throws `RangeError` at call time. Use `inflightTtl: 1` for near-immediate expiry, or omit the field for the 5-minute default.

```ts
// old: silently Infinity (probably not what you wanted)
await act('k', fn, { dedupe: { inflightTtl: 0 } })

// new: explicit
await act('k', fn, { dedupe: { inflightTtl: 1 } })        // 1ms
await act('k', fn, { dedupe: { inflightTtl: 30_000 } })   // 30s
await act('k', fn, { dedupe: true })                       // 5min default
```

## 4. `defaultShouldRetry` skips per-attempt `TimeoutError`

Previously the default `shouldRetry` retried on every error except `AbortError`. Per-attempt timeout aborts with `TimeoutError` (not `AbortError`), so timeouts were retried. `timeout: 1000, retry: { attempts: 5 }` could wait 5 seconds, not 1.

Now `defaultShouldRetry` also skips `ACTLY_TIMEOUT`. `timeout: 1000, retry: { attempts: 5 }` fails after 1 second.

```ts
// old: retried on per-attempt timeout (5s worst-case)
await act('k', fn, { timeout: { ms: 1000 }, retry: { attempts: 5 } })

// new: fails fast after 1s (default)
await act('k', fn, { timeout: { ms: 1000 }, retry: { attempts: 5 } })

// preserve old behavior
await act('k', fn, {
  timeout: { ms: 1000 },
  retry: {
    attempts: 5,
    shouldRetry: () => true,  // retry on everything, including timeouts
  },
})
```

## 5. Default `inflightTtl` is 5 minutes (was `Infinity`)

Previously an unset `inflightTtl` meant in-flight entries lived forever. A single hung `fn` blocked all subsequent callers on that key. Now the default is 5 minutes.

```ts
// old: Infinity (hung fn blocks forever)
await act('k', fn, { dedupe: true })

// new: 5min default
await act('k', fn, { dedupe: true })

// preserve old behavior (pair with a timeout)
await act('k', fn, { dedupe: { inflightTtl: Infinity } })
```

## 6. `observability` shape is validated

Previously typos in hook names (`onFinalSucess` instead of `onFinalSuccess`) were silently ignored. You thought you were observing but weren't. Now unknown keys throw `ValidationError` at call time.

> **Honesty note:** this validation was *claimed* in the 1.3.0 release notes but not actually implemented — 1.3.0 silently ignored typos exactly like 1.2.0 did. The validation exists and is regression-tested since 1.4.

```ts
// old: typo silently ignored
await act('k', fn, {
  observability: { onFinalSucess: (e) => log(e) },  // never fires
})

// new: typo throws
await act('k', fn, {
  observability: { onFinalSuccess: (e) => log(e) },  // correct
})
```

## Non-breaking improvements

- `onDedupeJoin` and `onTimeout` hooks now fire (previously declared but never emitted).
- `HedgeTimeoutError` is a proper `ActlyError` subclass. The old `__HEDGE_TIMEOUT__` string sentinel is gone.
- Internal namespace prefixes changed: `__inflight:` to `inflight:`, `__tenant:` removed. User-facing behavior unchanged.
- `InMemoryStore.destroy()` now clears the map.
- `sweep()` wraps its body in try/catch. A bad entry no longer crashes the process.
- Idle policy state (bulkhead, circuit breaker, rate limit) is cleaned up when no longer needed.
- `RetryExhaustedError.errors[]` capped at 10 entries.
- `createAsyncTenantStore.evict()` calls `destroy()` on the evicted store.
- Hedge losing promise is cancelled via `AbortController`.
- Observability hook throws no longer crash the main path (wrapped in `safeCall`).
- `InMemoryStore` default `maxSize` is 10,000 (was `Infinity`). Pass `Infinity` explicitly for unbounded.
- Tenant manager has `maxTenants` (default 10,000) with LRU eviction.
- `monotonicNow()` uses `performance.now()` for durations. `Date.now()` still used for timestamps.
- `isActlyError(e)` realm-safe predicate. `instanceof ActlyError` only works within the same realm.

## Compatibility

| | v1.2.0 | v1.3.0 |
|---|---|---|
| Node.js | 20+ | 20+ |
| TypeScript | 5.x | 5.x |
| Module formats | ESM + CJS | ESM + CJS |
| Dependencies | Zero | Zero |
| Breaking changes | - | 6 |

## Need help

Open an issue at <https://github.com/albytehq/actly/issues> with the `migration` label. Include the code that broke, the error message, and the version you're upgrading from.
