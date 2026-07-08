# actly v1.3.0

Hardening release. Smaller tarball, more policies, deeper audit. 6 breaking changes (see [MIGRATION.md](./MIGRATION.md)).

A line-by-line audit across core, policies, utils, stores, types, errors, and observability turned up 61 bugs. All fixed. Test count grew from 609 to 633.

## Headlines

- **61 audit bugs fixed.** Contract violations on the error path, listener leaks, timer leaks, memory leaks, NaN propagation, circuit breaker correctness, watchdog spam, and a broken error taxonomy. See [CHANGELOG.md](./CHANGELOG.md) for the full list with bug IDs.
- **8 Cockatiel-parity features.** `shouldRetryResult`, `timeout.strategy: 'cooperative'`, `circuitBreaker.strategy: 'count'`, `retry.backoffFn`, `retry.dangerouslyUnref`, `noopPolicy()`, `@usePolicy(options)`, `./testing` subpath.
- **7 stability features.** Per-scope health, `drainAll`, periodic probe, resource budget, `onBackpressure`, watchdog, `memoryPressureCleanup`.
- **57 KB tarball** (was 91 KB). 287 KB dist (was 435 KB).

## Breaking changes

1. Hedge cancels the losing promise via `AbortController`. Set `hedge.keepLoser: true` for the old behavior.
2. Hedge placement defaults to `outside-retry`. Set `hedge.placement: 'inside-retry'` for the old behavior.
3. `dedupe.inflightTtl: 0` now throws. Use `inflightTtl: 1` or omit.
4. `defaultShouldRetry` skips per-attempt `TimeoutError`. Override with `shouldRetry: () => true`.
5. Default `inflightTtl` is 5 minutes (was `Infinity`). Pass `Infinity` explicitly for the old behavior.
6. `observability` shape is validated. Typos in hook names throw at call time.

See [MIGRATION.md](./MIGRATION.md) for before/after code examples.

## Public API additions (additive)

- `isActlyError(e)` realm-safe predicate
- `ActlyError.toJSON({ redact?: boolean })` opt-in message redaction
- `HedgeTimeoutError` now extends `ActlyError`
- `ExecutorInput` and `ObservabilityContext` re-exported from `index.ts`
- `ActlyFailedBy` literal union type
- `TenantStoreOptions.maxTenants` with LRU eviction
- `LIMITS.MAX_HEDGE_DELAY_MS` and `LIMITS.MAX_TENANTS`
- `waitForObsHook` returns a Promise with `.cancel()` for test cleanup

## Performance

- Fast path: ~680k ops/sec (no regression)
- Cache hit: ~700k ops/sec (no regression)
- Slow path: marginal improvement from const caching, lazy allocation, in-place filters
- `usePolicy`: dynamic `import()` cached as a top-level Promise
- `safeCall`: `IS_DEV` flag cached at module load
- `monotonicNow()`: `performance.now()` for sub-microsecond monotonic durations

## Compatibility

| | v1.2.0 | v1.3.0 |
|---|---|---|
| Node.js | 20+ | 20+ |
| TypeScript | 5.x | 5.x |
| Module formats | ESM + CJS | ESM + CJS |
| Dependencies | Zero | Zero |
| Tarball | 91 KB | 57 KB |
| Tests | ~576 | 633 |

## Install

```bash
npm install actly@1.3.0
```

## Full changelog

See [CHANGELOG.md](./CHANGELOG.md).
