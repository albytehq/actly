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
