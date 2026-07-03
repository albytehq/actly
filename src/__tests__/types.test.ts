/**
 * Type-level tests.
 *
 * Asserts that public type contracts compile correctly. Run via vitest
 * (already included in the default test run via `expectTypeOf`).
 */
import { describe, it, expectTypeOf } from 'vitest'
import { act, withStore, InMemoryStore, execute, RetryExhaustedError } from '../index.js'
import type {
  ActResult,
  ActSuccess,
  ActFailure,
  ActFn,
  ActOptions,
  RetryOptions,
  TimeoutOptions,
  DedupeOptions,
  CacheOptions,
  SyncStateStore,
  AsyncStateStore,
  AnyStateStore,
  StateStore,
  ScopedActSync,
  ScopedActAsync,
  PolicyApplier,
  PolicyContext,
  RunMeta,
  ObservabilityHooks,
} from '../index.js'
import type {
  ActlyError,
  ActlyAbortError,
  TimeoutError,
  TotalTimeoutError,
  ValidationError,
} from '../index.js'

describe('type-level contracts', () => {
  it('ActSuccess narrows correctly on ok: true', () => {
    const r: ActResult<string> = { ok: true, value: 'x', source: 'fresh', attempts: 1 }
    if (r.ok) {
      expectTypeOf(r.value).toEqualTypeOf<string>()
      expectTypeOf(r.source).toEqualTypeOf<'fresh' | 'cache'>()
      expectTypeOf(r.attempts).toEqualTypeOf<number>()
      // optional fields
      expectTypeOf(r.traceId).toEqualTypeOf<string | undefined>()
      expectTypeOf(r.durationMs).toEqualTypeOf<number | undefined>()
    }
  })

  it('ActFailure narrows correctly on ok: false', () => {
    const r: ActResult<string> = { ok: false, error: new Error('x'), attempts: 1 }
    if (!r.ok) {
      expectTypeOf(r.error).toEqualTypeOf<unknown>()
      expectTypeOf(r.attempts).toEqualTypeOf<number>()
      expectTypeOf(r.traceId).toEqualTypeOf<string | undefined>()
      expectTypeOf(r.durationMs).toEqualTypeOf<number | undefined>()
    }
  })

  it('ActFn accepts both (signal) => Promise and () => Promise', () => {
    const fn1: ActFn<number> = async (signal) => { return 1 }
    const fn2: ActFn<number> = () => Promise.resolve(2)
    expectTypeOf(fn1).toEqualTypeOf<ActFn<number>>()
    expectTypeOf(fn2).toEqualTypeOf<ActFn<number>>()
  })

  it('withStore(SyncStateStore) returns ScopedActSync', () => {
    const store = new InMemoryStore()
    const scoped = withStore(store)
    expectTypeOf(scoped).toMatchTypeOf<ScopedActSync>()
    expectTypeOf(scoped.invalidate).toEqualTypeOf<(key: string) => boolean>()
  })

  it('withStore(AsyncStateStore) returns ScopedActAsync', () => {
    const store: AsyncStateStore = {
      _sync: false as const,
      async get() { return undefined },
      async set() {},
      async delete() {},
      async has() { return false },
      async clear() {},
      async size() { return 0 },
    }
    const scoped = withStore(store)
    expectTypeOf(scoped).toMatchTypeOf<ScopedActAsync>()
    expectTypeOf(scoped.invalidate).toEqualTypeOf<(key: string) => Promise<boolean>>()
  })

  it('error classes extend ActlyError and Error', () => {
    expectTypeOf<ActlyError>().toMatchTypeOf<Error>()
    expectTypeOf<ActlyAbortError>().toMatchTypeOf<ActlyError>()
    expectTypeOf<TimeoutError>().toMatchTypeOf<ActlyError>()
    expectTypeOf<TotalTimeoutError>().toMatchTypeOf<ActlyError>()
    expectTypeOf<RetryExhaustedError>().toMatchTypeOf<ActlyError>()
    expectTypeOf<ValidationError>().toMatchTypeOf<ActlyError>()
  })

  it('RetryExhaustedError carries attempts, lastError, errors', () => {
    const err = new RetryExhaustedError({
      attempts: 3,
      lastError: new Error('boom'),
      errors: [new Error('a'), new Error('b'), new Error('c')],
    })
    expectTypeOf(err.attempts).toEqualTypeOf<number>()
    expectTypeOf(err.lastError).toEqualTypeOf<unknown>()
    expectTypeOf(err.errors).toEqualTypeOf<readonly unknown[]>()
    expectTypeOf(err.code).toEqualTypeOf<'ACTLY_RETRY_EXHAUSTED'>()
  })

  it('ObservabilityHooks has all 8 event hooks', () => {
    expectTypeOf<ObservabilityHooks>().toHaveProperty('onAttempt')
    expectTypeOf<ObservabilityHooks>().toHaveProperty('onRetry')
    expectTypeOf<ObservabilityHooks>().toHaveProperty('onCacheHit')
    expectTypeOf<ObservabilityHooks>().toHaveProperty('onCacheMiss')
    expectTypeOf<ObservabilityHooks>().toHaveProperty('onDedupeJoin')
    expectTypeOf<ObservabilityHooks>().toHaveProperty('onTimeout')
    expectTypeOf<ObservabilityHooks>().toHaveProperty('onFinalSuccess')
    expectTypeOf<ObservabilityHooks>().toHaveProperty('onFinalFailure')
  })

  it('StateStore alias still works (backwards compat)', () => {
    const store: StateStore = new InMemoryStore()
    expectTypeOf(store).toMatchTypeOf<SyncStateStore>()
  })

  it('ActOptions includes all current fields', () => {
    const opts: ActOptions = {
      retry: { attempts: 3 },
      timeout: { ms: 1000 },
      totalTimeout: { ms: 5000 },
      dedupe: true,
      cache: { ttl: 60_000 },
      signal: new AbortController().signal,
      observability: { onFinalSuccess: () => {} },
      traceId: 'trace-123',
    }
    expectTypeOf(opts).toEqualTypeOf<ActOptions>()
  })
})
