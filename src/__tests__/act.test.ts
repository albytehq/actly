/**
 * ACT v1 test suite.
 *
 * Design rules:
 *  - Every test uses an isolated InMemoryStore injected via the internal
 *    execute() path so the module-level defaultStore never leaks between cases.
 *  - Fake timers (jest.useFakeTimers) control all setTimeout/Date.now calls
 *    for determinism — no real waits anywhere.
 *  - "act never throws" is proven by awaiting the promise; if it rejects the
 *    test itself fails.
 */

import { execute }       from '../core/executor.js'
import { retryPolicy }   from '../policies/retry.js'
import { timeoutPolicy, TimeoutError, totalTimeoutPolicy } from '../policies/timeout.js'
import { dedupePolicy }  from '../policies/dedupe.js'
import { cachePolicy }   from '../policies/cache.js'
import { InMemoryStore } from '../state/store.js'
import type { ActFn, PolicyApplier, RunMeta } from '../types/index.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshMeta(): RunMeta {
  return { attempts: 1, source: 'fresh' }
}

/** Run fn through the given policy chain with a clean, isolated store. */
async function run<T>(
  fn: ActFn<T>,
  policies: Array<PolicyApplier<T>>,
  key = 'test',
  store = new InMemoryStore(),
  meta = freshMeta(),
): Promise<T> {
  return execute({ key, fn, policies, store, meta })
}

/**
 * Thin wrapper that mirrors act() but accepts an explicit store.
 * Lets us test the full policy stack without touching the module-level store.
 */
async function actWith<T>(
  key: string,
  fn: ActFn<T>,
  opts: {
    retry?:        { attempts: number; delayMs?: number; backoff?: 'none' | 'linear' | 'exponential'; shouldRetry?: (error: unknown, attempt: number) => boolean }
    timeout?:      { ms: number }
    dedupe?:       { enabled: boolean }
    cache?:        { ttl: number }
    totalTimeout?: { ms: number }
  },
  store: InMemoryStore,
) {
  const meta = freshMeta()
  const policies: Array<PolicyApplier<T>> = []

  if (opts.totalTimeout && opts.totalTimeout.ms > 0) policies.push(totalTimeoutPolicy<T>(opts.totalTimeout))
  if (opts.cache        && opts.cache.ttl > 0)       policies.push(cachePolicy<T>(opts.cache))
  if (opts.dedupe?.enabled)                           policies.push(dedupePolicy<T>())
  if (opts.retry        && opts.retry.attempts > 1)  policies.push(retryPolicy<T>(opts.retry))
  if (opts.timeout      && opts.timeout.ms > 0)      policies.push(timeoutPolicy<T>(opts.timeout))

  try {
    const value = await execute({ key, fn, policies, store, meta })
    return { ok: true as const, value, source: meta.source, attempts: meta.attempts }
  } catch (error) {
    return { ok: false as const, error, attempts: meta.attempts }
  }
}

// ─── Retry ───────────────────────────────────────────────────────────────────

describe('retry policy', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('success on first attempt — attempts=1', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const meta = freshMeta()
    const result = await execute({
      key: 'k', fn, store: new InMemoryStore(), meta,
      policies: [retryPolicy({ attempts: 3 })],
    })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(meta.attempts).toBe(1)
  })

  test('succeeds on second attempt after one failure', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValue('recovered')

    const meta = freshMeta()
    const p = execute({
      key: 'k', fn, store: new InMemoryStore(), meta,
      policies: [retryPolicy({ attempts: 3 })],
    })

    // No delay configured — microtasks only, no timers to advance
    const result = await p
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(meta.attempts).toBe(2)
  })

  test('exhausts all attempts and surfaces last error', async () => {
    const err = new Error('always fails')
    const fn = jest.fn().mockRejectedValue(err)
    const meta = freshMeta()

    const p = execute({
      key: 'k', fn, store: new InMemoryStore(), meta,
      policies: [retryPolicy({ attempts: 3 })],
    }).catch(e => e)

    // Flush the pending microtasks/timers (no delay here)
    await p
    const result = await p
    expect(result).toBe(err)
    expect(fn).toHaveBeenCalledTimes(3)
    expect(meta.attempts).toBe(3)
  })

  test('respects delayMs between attempts (fake timers)', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('done')

    const meta = freshMeta()
    const p = execute({
      key: 'k', fn, store: new InMemoryStore(), meta,
      policies: [retryPolicy({ attempts: 2, delayMs: 500 })],
    })

    // fn called once synchronously inside the loop before the sleep
    await Promise.resolve() // flush microtask that runs the first fn()
    expect(fn).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(500)
    const result = await p
    expect(result).toBe('done')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('attempts: 1 behaves like no-retry', async () => {
    const err = new Error('boom')
    const fn = jest.fn().mockRejectedValue(err)

    await expect(
      execute({ key: 'k', fn, store: new InMemoryStore(), meta: freshMeta(), policies: [retryPolicy({ attempts: 1 })] })
    ).rejects.toBe(err)

    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// ─── Timeout ─────────────────────────────────────────────────────────────────

describe('timeout policy', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('resolves when fn finishes before deadline', async () => {
    const fn = jest.fn().mockResolvedValue(42)
    const result = await run(fn, [timeoutPolicy({ ms: 1000 })])
    expect(result).toBe(42)
  })

  test('rejects with TimeoutError when fn takes too long', async () => {
    // fn that never settles
    const fn = jest.fn(() => new Promise<number>(() => {}))

    const p = run(fn, [timeoutPolicy({ ms: 200 })]).catch(e => e)
    jest.advanceTimersByTime(200)
    const err = await p

    expect(err).toBeInstanceOf(TimeoutError)
    expect((err as TimeoutError).ms).toBe(200)
  })

  test('TimeoutError carries correct ms value', async () => {
    const fn = () => new Promise<never>(() => {})
    const p = run(fn, [timeoutPolicy({ ms: 750 })]).catch(e => e)
    jest.advanceTimersByTime(750)
    const err = await p
    expect(err).toBeInstanceOf(TimeoutError)
    expect((err as TimeoutError).ms).toBe(750)
  })

  test('sync throw inside fn is surfaced (not swallowed by race)', async () => {
    const boom = new Error('sync boom')
    // fn throws synchronously inside the Promise constructor
    const fn = (): Promise<never> => { throw boom }

    const caught = await run(fn, [timeoutPolicy({ ms: 1000 })]).catch(e => e)
    expect(caught).toBe(boom)
  })

  test('timer is cleared after successful resolve (no leak)', async () => {
    const fn = jest.fn().mockResolvedValue('fast')
    // If clearTimeout were broken the fake timer would still fire — Jest would
    // complain about open handles or the next test would see a spurious rejection.
    await run(fn, [timeoutPolicy({ ms: 5000 })])
    jest.runAllTimers() // should be a no-op, nothing left pending
    // reaching here without error is the assertion
  })
})

// ─── Dedupe ──────────────────────────────────────────────────────────────────

describe('dedupe policy', () => {
  test('concurrent callers with same key share one Promise', async () => {
    let resolveInner!: (v: string) => void
    const inner = new Promise<string>(r => { resolveInner = r })
    const fn = jest.fn(() => inner)

    const store = new InMemoryStore()
    const make = () => run(fn, [dedupePolicy()], 'shared-key', store)

    const [p1, p2, p3] = [make(), make(), make()]
    resolveInner('result')

    const results = await Promise.all([p1, p2, p3])
    expect(results).toEqual(['result', 'result', 'result'])
    // Only one real execution despite three concurrent callers
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('second call after first resolves runs fn again (no stale dedup)', async () => {
    const fn = jest.fn().mockResolvedValue('v')
    const store = new InMemoryStore()

    await run(fn, [dedupePolicy()], 'k', store)
    await run(fn, [dedupePolicy()], 'k', store)

    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('failed in-flight does not persist in store', async () => {
    const err = new Error('inflight fail')
    let rejectInner!: (e: unknown) => void
    const inner = new Promise<string>((_, r) => { rejectInner = r })
    const fn = jest.fn(() => inner)

    const store = new InMemoryStore()
    const p = run(fn, [dedupePolicy()], 'k', store).catch(() => {})
    rejectInner(err)
    await p

    // Store must be clean after failure so next caller starts fresh
    expect(store.has('dedupe:k')).toBe(false)
  })

  test('different keys do not collapse into each other', async () => {
    const fn = jest.fn().mockResolvedValue(0)
    const store = new InMemoryStore()

    await Promise.all([
      run(fn, [dedupePolicy()], 'key-A', store),
      run(fn, [dedupePolicy()], 'key-B', store),
    ])

    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('concurrent same-key stress: 20 callers, fn executes once', async () => {
    let resolveInner!: (v: number) => void
    const inner = new Promise<number>(r => { resolveInner = r })
    const fn = jest.fn(() => inner)

    const store = new InMemoryStore()
    const callers = Array.from({ length: 20 }, () =>
      run(fn, [dedupePolicy()], 'stress-key', store)
    )

    resolveInner(99)
    const results = await Promise.all(callers)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBe(99)
  })
})

// ─── Cache ────────────────────────────────────────────────────────────────────

describe('cache policy', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('cache miss — fn is called, result stored', async () => {
    const fn = jest.fn().mockResolvedValue('fresh')
    const store = new InMemoryStore()
    const meta = freshMeta()

    await execute({ key: 'k', fn, store, meta, policies: [cachePolicy({ ttl: 5000 })] })

    expect(fn).toHaveBeenCalledTimes(1)
    expect(meta.source).toBe('fresh')
  })

  test('cache hit — fn is NOT called again, source=cache', async () => {
    const fn = jest.fn().mockResolvedValue('data')
    const store = new InMemoryStore()

    const meta1 = freshMeta()
    await execute({ key: 'k', fn, store, meta: meta1, policies: [cachePolicy({ ttl: 5000 })] })

    const meta2 = freshMeta()
    const result = await execute({ key: 'k', fn, store, meta: meta2, policies: [cachePolicy({ ttl: 5000 })] })

    expect(result).toBe('data')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(meta2.source).toBe('cache')
  })

  test('TTL expiry — entry evicted, fn called again', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValue('second')

    const store = new InMemoryStore()
    const policies = [cachePolicy<string>({ ttl: 1000 })]

    await execute({ key: 'k', fn, store, meta: freshMeta(), policies })

    jest.advanceTimersByTime(1001) // past TTL

    const result = await execute({ key: 'k', fn, store, meta: freshMeta(), policies })
    expect(result).toBe('second')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('failures are never cached — next call retries fn', async () => {
    const err = new Error('transient')
    const fn = jest.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('recovered')

    const store = new InMemoryStore()
    const policies = [cachePolicy<string>({ ttl: 5000 })]

    // First call: fn throws → cache must NOT store anything
    await expect(
      execute({ key: 'k', fn, store, meta: freshMeta(), policies })
    ).rejects.toBe(err)

    // Second call: fn succeeds now
    const result = await execute({ key: 'k', fn, store, meta: freshMeta(), policies })
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('cache with TTL=0 is treated as disabled (always calls fn)', async () => {
    const store = new InMemoryStore()
    const fn = jest.fn().mockResolvedValue('x')

    // ttl=0 means the cachePolicy is not added (guarded in actWith)
    const r1 = await actWith('k', fn, { cache: { ttl: 0 } }, store)
    const r2 = await actWith('k', fn, { cache: { ttl: 0 } }, store)

    expect(fn).toHaveBeenCalledTimes(2)
    expect(r1.ok && r1.source).toBe('fresh')
    expect(r2.ok && r2.source).toBe('fresh')
  })
})

// ─── act() contract ───────────────────────────────────────────────────────────

describe('actWith() contract (act() behavioural guarantees)', () => {
  test('always returns ActResult — never throws on success', async () => {
    const store = new InMemoryStore()
    const result = await actWith('k', async () => 'hi', {}, store)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('hi')
  })

  test('always returns ActResult — never throws on failure', async () => {
    const store = new InMemoryStore()
    const result = await actWith('k', async () => { throw new Error('oops') }, {}, store)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBeInstanceOf(Error)
  })

  test('source=fresh for a new call', async () => {
    const store = new InMemoryStore()
    const r = await actWith('k', async () => 1, {}, store)
    expect(r.ok && r.source).toBe('fresh')
  })

  test('attempts=1 when no retry configured', async () => {
    const store = new InMemoryStore()
    const r = await actWith('k', async () => 'ok', {}, store)
    expect(r.attempts).toBe(1)
  })
})

// ─── Trap: double execution ───────────────────────────────────────────────────

describe('trap: double execution', () => {
  test('dedupe prevents fn running twice for overlapping concurrent calls', async () => {
    let callCount = 0
    let resolveOuter!: (v: string) => void
    const blocker = new Promise<string>(r => { resolveOuter = r })

    const fn = jest.fn(async () => {
      callCount++
      return blocker
    })

    const store = new InMemoryStore()
    const p1 = run(fn, [dedupePolicy()], 'x', store)
    const p2 = run(fn, [dedupePolicy()], 'x', store)

    resolveOuter('done')
    await Promise.all([p1, p2])

    expect(callCount).toBe(1)
  })
})

// ─── Trap: retry limit ────────────────────────────────────────────────────────

describe('trap: retry limit', () => {
  test('retry does not exceed configured attempt ceiling', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always'))
    const meta = freshMeta()

    await execute({
      key: 'k', fn, store: new InMemoryStore(), meta,
      policies: [retryPolicy({ attempts: 4 })],
    }).catch(() => {})

    expect(fn).toHaveBeenCalledTimes(4)
    expect(meta.attempts).toBe(4)
  })

  test('attempts=1 means exactly one call, no retry', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('x'))

    await execute({
      key: 'k', fn, store: new InMemoryStore(), meta: freshMeta(),
      policies: [retryPolicy({ attempts: 1 })],
    }).catch(() => {})

    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// ─── Policy stack integration ─────────────────────────────────────────────────

describe('combined policy stack', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('retry + timeout: each attempt gets its own clock', async () => {
    let calls = 0
    const fn = jest.fn(async () => {
      calls++
      // Hangs forever — timeout will fire
      return new Promise<string>(() => {})
    })

    const store = new InMemoryStore()
    // retry wraps timeout: [retryPolicy, timeoutPolicy] → retry is outer
    const p = execute({
      key: 'k', fn, store, meta: freshMeta(),
      // outer→inner: [retry, timeout]
      policies: [retryPolicy({ attempts: 3 }), timeoutPolicy({ ms: 100 })],
    }).catch(e => e)

    // Advance through all 3 per-attempt timeouts
    jest.advanceTimersByTime(100) // attempt 1 times out
    await Promise.resolve()
    jest.advanceTimersByTime(100) // attempt 2 times out
    await Promise.resolve()
    jest.advanceTimersByTime(100) // attempt 3 times out

    const err = await p
    expect(err).toBeInstanceOf(TimeoutError)
    expect(calls).toBe(3)
  })

  test('cache hit skips retry+timeout entirely', async () => {
    const fn = jest.fn().mockResolvedValue('cached-val')
    const store = new InMemoryStore()
    const policies = [
      cachePolicy<string>({ ttl: 5000 }),
      retryPolicy<string>({ attempts: 3 }),
      timeoutPolicy<string>({ ms: 50 }),
    ]

    // Warm the cache
    await execute({ key: 'k', fn, store, meta: freshMeta(), policies })
    fn.mockRejectedValue(new Error('should not be called'))

    // Second call should serve from cache without touching fn
    const result = await execute({ key: 'k', fn, store, meta: freshMeta(), policies })
    expect(result).toBe('cached-val')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// ─── act() dedupe — public API surface ───────────────────────────────────────
//
// The existing dedupe tests run through execute() directly, which bypasses the
// public act() entry point. These tests exercise act() itself to catch regressions
// in the options-normalisation layer — the class of bug where `dedupe: true`
// silently fails to register the policy.
//
// All tests here use real timers and the module-level defaultStore, which means
// keys MUST be globally unique across the file to avoid cross-test contamination.

import { act } from '../index.js'

describe('act() dedupe — public API', () => {
  // Unique key prefix so module-level defaultStore entries don't bleed across tests
  const uid = () => `act-dedupe-${Math.random().toString(36).slice(2)}`

  test('boolean shorthand: dedupe:true — simultaneous Promise.all calls fn exactly once', async () => {
    // This is the exact scenario that was broken: `dedupe: true` (not the object form).
    // All three act() calls are launched in the same synchronous frame.
    let callCount = 0
    let resolveInner!: (v: string) => void
    const blocker = new Promise<string>(r => { resolveInner = r })
    const fn = jest.fn(() => { callCount++; return blocker })

    const key = uid()
    const all = Promise.all([
      act(key, fn, { dedupe: true }),
      act(key, fn, { dedupe: true }),
      act(key, fn, { dedupe: true }),
    ])

    resolveInner('shared')
    const results = await all

    expect(callCount).toBe(1)
    expect(results.every(r => r.ok && r.value === 'shared')).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('object form: dedupe:{enabled:true} — simultaneous Promise.all calls fn exactly once', async () => {
    let callCount = 0
    let resolveInner!: (v: number) => void
    const blocker = new Promise<number>(r => { resolveInner = r })
    const fn = jest.fn(() => { callCount++; return blocker })

    const key = uid()
    const all = Promise.all([
      act(key, fn, { dedupe: { enabled: true } }),
      act(key, fn, { dedupe: { enabled: true } }),
      act(key, fn, { dedupe: { enabled: true } }),
    ])

    resolveInner(42)
    const results = await all

    expect(callCount).toBe(1)
    expect(results.every(r => r.ok && r.value === 42)).toBe(true)
  })

  test('webhook-style duplicate storm: 10 concurrent calls, one execution', async () => {
    // Simulates an at-least-once delivery webhook arriving 10 times for the same event.
    // Only one handler execution should occur.
    let executions = 0
    let resolveInner!: (v: string) => void
    const blocker = new Promise<string>(r => { resolveInner = r })

    const fn = jest.fn(async () => {
      executions++
      return blocker
    })

    const key = uid()
    const storm = Promise.all(
      Array.from({ length: 10 }, () => act(key, fn, { dedupe: true }))
    )

    resolveInner('processed')
    const results = await storm

    expect(executions).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(results.every(r => r.ok && r.value === 'processed')).toBe(true)
  })

  test('dedupe failure cleanup: failed in-flight allows a fresh call next time', async () => {
    // After a deduped in-flight promise rejects, the next call must start fresh.
    // Not serve a stale failure or silently dedupe to a dead promise.
    const err = new Error('inflight failure')
    let rejectInner!: (e: unknown) => void
    const blocker = new Promise<string>((_, r) => { rejectInner = r })

    const failingFn = jest.fn(() => blocker)
    const key = uid()

    const p1 = act(key, failingFn, { dedupe: true })
    const p2 = act(key, failingFn, { dedupe: true })

    rejectInner(err)
    const [r1, r2] = await Promise.all([p1, p2])

    // Both callers see the failure — zero-throw contract holds
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toBe(err)

    // Store must be clean — next call must start fresh, not redupe onto a dead promise
    const freshFn = jest.fn().mockResolvedValue('recovered')
    const r3 = await act(key, freshFn, { dedupe: true })

    expect(r3.ok).toBe(true)
    if (r3.ok) expect(r3.value).toBe('recovered')
    expect(freshFn).toHaveBeenCalledTimes(1)
  })

  test('staggered callers join the same in-flight promise', async () => {
    // First caller fires and registers the in-flight promise.
    // Five more arrive after one microtask tick — they should join, not start fresh.
    let callCount = 0
    let resolveInner!: (v: string) => void
    const blocker = new Promise<string>(r => { resolveInner = r })
    const fn = jest.fn(() => { callCount++; return blocker })

    const key = uid()

    // First caller — starts the in-flight promise
    const p1 = act(key, fn, { dedupe: true })

    // Yield so p1's body has run and registered the in-flight entry
    await Promise.resolve()

    // Five late callers — should dedupe onto p1's promise
    const p2 = act(key, fn, { dedupe: true })
    const p3 = act(key, fn, { dedupe: true })
    const p4 = act(key, fn, { dedupe: true })
    const p5 = act(key, fn, { dedupe: true })
    const p6 = act(key, fn, { dedupe: true })

    resolveInner('joined')
    const results = await Promise.all([p1, p2, p3, p4, p5, p6])

    expect(callCount).toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(results.every(r => r.ok && r.value === 'joined')).toBe(true)
  })
})

// ─── shouldRetry ──────────────────────────────────────────────────────────────

import { TotalTimeoutError } from '../policies/timeout.js'

describe('retry policy — shouldRetry predicate', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('shouldRetry returning false stops immediately — fn called once', async () => {
    const err = new Error('non-retryable')
    const fn = jest.fn().mockRejectedValue(err)

    const caught = await execute({
      key: 'k', fn, store: new InMemoryStore(), meta: freshMeta(),
      policies: [retryPolicy({ attempts: 5, shouldRetry: () => false })],
    }).catch(e => e)

    expect(caught).toBe(err)
    // shouldRetry=false on attempt 1 → no further attempts
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('shouldRetry returning true retries as normal', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('try again'))
      .mockResolvedValue('ok')

    const result = await execute({
      key: 'k', fn, store: new InMemoryStore(), meta: freshMeta(),
      policies: [retryPolicy({ attempts: 3, shouldRetry: () => true })],
    })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('shouldRetry receives the thrown error and 1-based attempt number', async () => {
    const err1 = new Error('first')
    const err2 = new Error('second')
    const calls: Array<[unknown, number]> = []

    const fn = jest.fn()
      .mockRejectedValueOnce(err1)
      .mockRejectedValueOnce(err2)
      .mockResolvedValue('done')

    await execute({
      key: 'k', fn, store: new InMemoryStore(), meta: freshMeta(),
      policies: [retryPolicy({
        attempts: 4,
        shouldRetry: (error, attempt) => { calls.push([error, attempt]); return true },
      })],
    })

    expect(calls).toEqual([[err1, 1], [err2, 2]])
  })

  test('shouldRetry is not called on the final attempt — error surfaces regardless', async () => {
    const predicate = jest.fn().mockReturnValue(true)
    const err = new Error('always')
    const fn = jest.fn().mockRejectedValue(err)

    const caught = await execute({
      key: 'k', fn, store: new InMemoryStore(), meta: freshMeta(),
      policies: [retryPolicy({ attempts: 3, shouldRetry: predicate })],
    }).catch(e => e)

    expect(caught).toBe(err)
    expect(fn).toHaveBeenCalledTimes(3)
    // Called for attempts 1 and 2 — NOT for attempt 3 (the last one has nowhere to retry to)
    expect(predicate).toHaveBeenCalledTimes(2)
  })

  test('class-based shouldRetry: skip retries for 4xx, retry for 5xx', async () => {
    class HttpError extends Error {
      constructor(public status: number) { super(`HTTP ${status}`) }
    }

    const notFound = new HttpError(404)
    const fn = jest.fn().mockRejectedValue(notFound)

    const caught = await execute({
      key: 'k', fn, store: new InMemoryStore(), meta: freshMeta(),
      policies: [retryPolicy({
        attempts: 5,
        shouldRetry: (err) => !(err instanceof HttpError && err.status < 500),
      })],
    }).catch(e => e)

    // 404 is non-retryable — stops after first attempt
    expect(fn).toHaveBeenCalledTimes(1)
    expect(caught).toBe(notFound)
  })

  test('shouldRetry false still surfaces via ActResult — zero-throw preserved', async () => {
    const store = new InMemoryStore()
    const err = new Error('abort')
    const result = await actWith(
      'k',
      async () => { throw err },
      { retry: { attempts: 5, shouldRetry: () => false } },
      store,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(err)
  })
})

// ─── totalTimeout ─────────────────────────────────────────────────────────────

describe('totalTimeout policy', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('resolves normally when fn finishes before total deadline', async () => {
    const fn = jest.fn().mockResolvedValue('fast')
    const store = new InMemoryStore()

    const result = await actWith('k', fn, { totalTimeout: { ms: 5000 } }, store)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('fast')
  })

  test('TotalTimeoutError fires when the budget is exhausted across retries', async () => {
    // fn always hangs — retry has 3 attempts each with per-attempt timeout of 200ms
    // total budget is 400ms — fires mid-way through the second attempt
    const fn = jest.fn(() => new Promise<never>(() => {}))
    const store = new InMemoryStore()

    const p = actWith('k', fn, {
      retry:        { attempts: 3 },
      timeout:      { ms: 200 },     // per-attempt
      totalTimeout: { ms: 400 },     // whole operation budget
    }, store)

    // Advance past the total budget
    jest.advanceTimersByTime(200) // attempt 1 per-attempt timeout fires
    await Promise.resolve()
    jest.advanceTimersByTime(200) // total budget now exhausted

    const result = await p
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBeInstanceOf(TotalTimeoutError)
  })

  test('TotalTimeoutError carries correct ms value', async () => {
    const fn = () => new Promise<never>(() => {})
    const store = new InMemoryStore()

    const p = actWith('k', fn, { totalTimeout: { ms: 999 } }, store)
    jest.advanceTimersByTime(999)

    const result = await p
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(TotalTimeoutError)
      expect((result.error as TotalTimeoutError).ms).toBe(999)
    }
  })

  test('TotalTimeoutError is distinct from TimeoutError', async () => {
    // Both errors must be instanceOf-checkable independently
    const totalErr = new TotalTimeoutError(500)
    const perErr = new TimeoutError(500)

    expect(totalErr).toBeInstanceOf(TotalTimeoutError)
    expect(totalErr).not.toBeInstanceOf(TimeoutError)
    expect(perErr).toBeInstanceOf(TimeoutError)
    expect(perErr).not.toBeInstanceOf(TotalTimeoutError)
  })

  test('totalTimeout=0 is treated as disabled (passthrough)', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    const store = new InMemoryStore()

    // totalTimeout.ms=0 should not register the policy (guarded in actWith / act)
    const result = await actWith('k', fn, { totalTimeout: { ms: 0 } }, store)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('ok')
  })

  test('totalTimeout zero-throw contract — TotalTimeoutError in result.error, never thrown', async () => {
    const fn = () => new Promise<never>(() => {})
    const store = new InMemoryStore()

    const p = actWith('k', fn, { totalTimeout: { ms: 100 } }, store)
    jest.advanceTimersByTime(100)

    // Must resolve (not reject) — zero-throw contract
    const result = await p
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBeInstanceOf(TotalTimeoutError)
  })
})

// ─── totalTimeout + shouldRetry integration ───────────────────────────────────

describe('shouldRetry + totalTimeout integration', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('shouldRetry false short-circuits before totalTimeout can fire', async () => {
    const err = new Error('abort immediately')
    const fn = jest.fn().mockRejectedValue(err)
    const store = new InMemoryStore()

    // shouldRetry false + 10s total budget — shouldRetry wins, no timer fires
    const result = await actWith('k', fn, {
      retry:        { attempts: 5, shouldRetry: () => false },
      totalTimeout: { ms: 10_000 },
    }, store)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      // The error is from the fn, not TotalTimeoutError
      expect(result.error).toBe(err)
      expect(result.error).not.toBeInstanceOf(TotalTimeoutError)
    }
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
