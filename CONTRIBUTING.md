# Contributing

Thanks for your interest. This document covers the rules every change must follow before merge.

## Naming

Enforced by ESLint (`npm run lint`) and review. PRs that violate these are blocked.

**Files**: camelCase. `circuitBreaker.ts`, `sanitizeKey.ts`. One default export per file is discouraged. Named exports let consumers tree-shake.

**Functions and variables**: camelCase. `act()`, `withStore()`, `sanitizeKey()`. No underscore prefix for private members. Use the TypeScript `private` keyword. Unused parameters may keep a single leading `_` only when intentionally unused.

**Types and interfaces**: PascalCase. `ActResult`, `InMemoryStore`, `SyncStateStore`. No `I` prefix (no `IStore`). Discriminated unions follow `<Verb><Noun>Event`: `CacheHitEvent`, `DedupeJoinEvent`, `TimeoutEvent`.

**Error classes**: PascalCase with `Error` suffix. `TimeoutError`, `RetryExhaustedError`, `HedgeTimeoutError`. Each carries a stable `.code` string for cross-realm telemetry. Internal error classes still follow the rule.

**Constants**: SCREAMING_SNAKE_CASE for module-level constants. `MAX_RETRY_ATTEMPTS`, `CACHE_NS`. Numeric bounds go in the `LIMITS` object (`utils/limits.ts`), not ad-hoc elsewhere.

**No double underscore** in new code. `__proto__` is a JS language feature. The `__` prefix is reserved for the language. Use an `Error` subclass or a `Symbol` for internal sentinels.

**Internal helpers**: camelCase, marked with `@internal` JSDoc. `stripInternal: true` in `tsconfig.build.json` strips them from `.d.ts` output.

### The `_sync` exception

`SyncStateStore._sync` and `AsyncStateStore._sync` use a leading underscore intentionally. It is a runtime discriminant tag used by `isSyncStore()` / `isAsyncStore()`. The underscore signals "use the type guards, not this field directly." Renaming it would break every custom store implementation. New discriminants should use a tagged-union `kind: 'sync' | 'async'` shape instead.

## Tests

### TDD

1. Write a failing test that captures the desired behavior.
2. Run it. Confirm it fails for the right reason.
3. Implement.
4. Run it. Confirm it passes.
5. Add an edge-case test the implementer didn't think of.

### Categories

Tests live under `src/__tests__/`. Organized by intent:

- `unit/` single-function tests, no I/O
- `integration/` multi-policy composition
- `regression/` bug-specific tests
- `property/` property-based tests via `fast-check`
- `stress/` real concurrency, 1M+ ops, memory-flat assertions
- `conformance/` store contract conformance (for custom store authors)
- `e2e/` full real-world scenarios

### Coverage

New code: 90%+ line coverage. Existing code: never decrease coverage. Run `npm run test:coverage` before opening a PR.

## Code review

Five passes before merge. A PR is not "reviewed" until all five are signed off.

1. **Author self-review.** Read the diff line by line. Verify each change matches the spec.
2. **Reviewer A: correctness.** Logic matches intent. Race conditions checked. Edge cases covered (empty, null, undefined, NaN, Infinity).
3. **Reviewer B: style and naming.** Convention compliance. No `any`. JSDoc on new public API. No internal naming leaks.
4. **Reviewer C: architect.** Fits the design. No layering violations. Backwards compat preserved, or `MIGRATION.md` updated.
5. **Automated.** ESLint clean. `tsc --noEmit` clean. Bench no regression over 5%. Bundle size no increase.

## Performance

Anything that touches a hot path (anything called by `act()`) must include a bench measurement.

1. Run `npm run bench` on `main`. Save the result.
2. Make your change.
3. Run `npm run bench` again.
4. Compare. If any scenario regresses by more than 5%, investigate before requesting review.

Bench results go in `bench/results/<date>.json` so regressions are visible in the diff.

## Breaking changes

Breaking changes require:

1. A semver-minor bump at minimum (1.2.0 to 1.3.0). Major bump if the change is large.
2. An entry in `MIGRATION.md` with before/after code.
3. A deprecation path in the prior minor release when feasible. Emit `console.warn` on the old behavior for one release before removing.
4. An updated `CHANGELOG.md` entry under "Breaking changes".

## Pre-publish

`npm publish` runs `prepublishOnly` automatically:

```json
"prepublishOnly": "npm run typecheck && npm test && npm run build"
```

A broken publish is impossible if this hook is in place and the local environment is clean.
