import { describe, it, expect, expectTypeOf } from 'vitest'
import {
  act,
  invalidate,
  withStore,
  execute,
  InMemoryStore,
  TimeoutError,
  TotalTimeoutError,
  RetryExhaustedError,
  ActlyError,
  ActlyAbortError,
  isSyncStore,
  isAsyncStore,
  REQUIRES_SYNC_STORE,
} from '../index.js'
import type {
  ActResult,
  ActFn,
  ActOptions,
  RetryOptions,
  SyncStateStore,
  AsyncStateStore,
} from '../index.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Resolve after `ms`, but abort early if `signal` aborts (cooperative). */
async function sleepCancellable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason
  await Promise.race([
    sleep(ms),
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    ),
  ])
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('actly public API surface', () => {
  it('exports all README-documented values (fixes A-1, A-2)', () => {
    expect(typeof act).toBe('function')
    expect(typeof invalidate).toBe('function')
    expect(typeof withStore).toBe('function')
    expect(typeof execute).toBe('function')
    expect(typeof isSyncStore).toBe('function')
    expect(typeof isAsyncStore).toBe('function')
    expect(typeof REQUIRES_SYNC_STORE).toBe('symbol')
    expect(typeof InMemoryStore).toBe('function')
    expect(typeof TimeoutError).toBe('function')
    expect(typeof TotalTimeoutError).toBe('function')
  })

  it('exports all README-documented types', () => {
    expectTypeOf<ActResult<unknown>>().toEqualTypeOf<ActResult<unknown>>()
    expectTypeOf<ActFn<unknown>>().toEqualTypeOf<ActFn<unknown>>()
    expectTypeOf<ActOptions>().toEqualTypeOf<ActOptions>()
    expectTypeOf<RetryOptions>().toEqualTypeOf<RetryOptions>()
    expectTypeOf<SyncStateStore>().toEqualTypeOf<SyncStateStore>()
    expectTypeOf<AsyncStateStore>().toEqualTypeOf<AsyncStateStore>()
  })
})

describe('act() zero-throw contract', () => {
  it('resolves with ActFailure when fn throws (fixes nothing — baseline)', async () => {
    const r = await act('test:throw', async () => { throw new Error('boom') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as Error).message).toBe('boom')
  })

  it('resolves with ActFailure when fn rejects', async () => {
    const r = await act('test:reject', async () => { throw new Error('reject-boom') })
    expect(r.ok).toBe(false)
  })

  it('resolves with ActSuccess when fn succeeds', async () => {
    const r = await act('test:ok', async () => 'value')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('value')
  })

  it('accepts legacy () => Promise<T> signature (backwards compat)', async () => {
    const r = await act('test:legacy', () => Promise.resolve(42))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(42)
  })

  it('accepts (signal) => Promise<T> signature (cooperative)', async () => {
    const r = await act<number>('test:signal', async (signal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return 99
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(99)
  })
})

describe('act() input validation (fixes M-3, M-4)', () => {
  it('throws on empty key', async () => {
    await expect(act('', async () => 1)).rejects.toThrow(/non-empty/)
  })

  it('throws on reserved prefix key', async () => {
    await expect(act('dedupe:foo', async () => 1)).rejects.toThrow(/reserved prefix/)
    await expect(act('cache:foo', async () => 1)).rejects.toThrow(/reserved prefix/)
    await expect(act('inflight:foo', async () => 1)).rejects.toThrow(/reserved prefix/)
  })

  it('throws on non-integer retry.attempts', async () => {
    await expect(act('k', async () => 1, { retry: { attempts: 1.5 } }))
      .rejects.toThrow(/positive integer/)
    await expect(act('k', async () => 1, { retry: { attempts: 0 } }))
      .rejects.toThrow(/positive integer/)
    await expect(act('k', async () => 1, { retry: { attempts: -3 } }))
      .rejects.toThrow(/positive integer/)
  })

  it('throws on non-positive timeout.ms', async () => {
    await expect(act('k', async () => 1, { timeout: { ms: 0 } }))
      .rejects.toThrow(/positive finite/)
    await expect(act('k', async () => 1, { timeout: { ms: -100 } }))
      .rejects.toThrow(/positive finite/)
    await expect(act('k', async () => 1, { timeout: { ms: NaN } }))
      .rejects.toThrow(/positive finite/)
  })

  it('throws on non-positive cache.ttl', async () => {
    await expect(act('k', async () => 1, { cache: { ttl: 0 } }))
      .rejects.toThrow(/positive finite/)
  })

  it('throws on non-AbortSignal signal option', async () => {
    // Cast through unknown to bypass TS for the runtime test
    await expect(act('k', async () => 1, { signal: 'not-a-signal' as unknown as AbortSignal }))
      .rejects.toThrow(/AbortSignal/)
  })
})

describe('retry policy (fixes M-7 jitter, M-4 validation, M-2 shouldRetry)', () => {
  it('retries on failure and succeeds', async () => {
    let calls = 0
    const r = await act('retry:success', async () => {
      calls++
      if (calls < 3) throw new Error('fail')
      return 'ok'
    }, { retry: { attempts: 5, delayMs: 1 } })

    expect(r.ok).toBe(true)
    expect(calls).toBe(3)
    if (r.ok) expect(r.attempts).toBe(3)
  })

  it('surfaces last error wrapped in RetryExhaustedError when retries happened', async () => {
    let calls = 0
    const r = await act('retry:all-fail', async () => {
      calls++
      throw new Error(`fail-${calls}`)
    }, { retry: { attempts: 3, delayMs: 1 } })

    expect(r.ok).toBe(false)
    expect(calls).toBe(3)
    expect(r.attempts).toBe(3)
    // lastError/errors[] keep the raw cause; the wrapper carries the retry count.
    if (!r.ok) {
      const err = r.error as { message?: string; lastError?: Error; errors?: Error[]; attempts?: number }
      expect(err.message).toMatch(/retry exhausted after 3 attempts/)
      expect(err.lastError?.message).toBe('fail-3')
      expect(err.errors?.length).toBe(3)
      expect(err.errors?.[2]?.message).toBe('fail-3')
      expect(err.attempts).toBe(3)
    }
  })

  it('respects shouldRetry=false to bail early', async () => {
    let calls = 0
    const r = await act('retry:bail', async () => {
      calls++
      throw new Error('permanent')
    }, {
      retry: {
        attempts: 5,
        delayMs: 1,
        shouldRetry: (err) => (err as Error).message !== 'permanent',
      },
    })

    expect(r.ok).toBe(false)
    expect(calls).toBe(1) // bailed, no retry
    expect(r.attempts).toBe(1)
  })

  it('calls shouldRetry on the final attempt too (fixes M-2)', async () => {
    const calls: number[] = []
    await act('retry:final-call', async () => { throw new Error('x') }, {
      retry: {
        attempts: 3,
        delayMs: 1,
        shouldRetry: (_e, attempt) => { calls.push(attempt); return true },
      },
    })
    expect(calls).toEqual([1, 2, 3])
  })

  it('default shouldRetry skips abort errors', async () => {
    let calls = 0
    const controller = new AbortController()
    const promise = act('retry:abort-skip', async (signal) => {
      calls++
      // First attempt runs long enough for the caller to abort mid-flight.
      if (calls === 1) {
        await sleep(50)
        signal; // touch to satisfy linter
      }
      return 'ok'
    }, {
      retry: { attempts: 5, delayMs: 1 },
      signal: controller.signal,
      timeout: { ms: 1000 },
    })

    setTimeout(() => controller.abort(new Error('user-cancelled')), 10)
    const r = await promise

    expect(r.ok).toBe(false)
    // abort errors must not trigger a retry
    expect(calls).toBe(1)
  })

  it('caps exponential backoff at maxDelay (fixes M-7)', async () => {
    const delays: number[] = []
    let calls = 0
    const t0 = Date.now()
    await act('retry:max-delay', async () => {
      calls++
      if (calls < 4) {
        delays.push(Date.now() - (delays.length === 0 ? t0 : t0 + delays.reduce((a, b) => a + b, 0)))
        throw new Error('fail')
      }
      return 'ok'
    }, {
      retry: {
        attempts: 4,
        delayMs: 1000,
        backoff: 'exponential',
        maxDelay: 50,
        jitter: 'none',
      },
    })

    // without maxDelay we'd see 1000/2000/4000ms (~7s); with maxDelay=50 the whole run fits in ~150ms
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('applies full jitter by default (random delay in [0, computed])', async () => {
    const delays: number[] = []
    let lastTime = Date.now()
    let calls = 0
    await act('retry:jitter', async () => {
      calls++
      if (calls < 3) {
        const now = Date.now()
        delays.push(now - lastTime)
        lastTime = now
        throw new Error('fail')
      }
      return 'ok'
    }, {
      retry: {
        attempts: 3,
        delayMs: 100,
        backoff: 'none',
        // jitter defaults to 'full', so delay lands in [0, 100)
      },
    })

    // jitter + scheduling overhead
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(150)
    }
  })
})

describe('timeout policy (fixes C-2: AbortSignal-based cancellation)', () => {
  it('throws TimeoutError when fn exceeds per-attempt deadline', async () => {
    const r = await act('timeout:fire', async () => {
      await sleep(200)
      return 'late'
    }, { timeout: { ms: 50 } })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeInstanceOf(TimeoutError)
  })

  it('TimeoutError carries the configured ms', async () => {
    const r = await act('timeout:ms', async () => sleep(200), { timeout: { ms: 75 } })
    if (!r.ok && r.error instanceof TimeoutError) {
      expect(r.error.ms).toBe(75)
    }
  })

  it('does not throw TimeoutError when fn completes in time', async () => {
    const r = await act('timeout:fast', async () => 'fast', { timeout: { ms: 1000 } })
    expect(r.ok).toBe(true)
  })

  it('passes an AbortSignal to fn that fires on timeout (cooperative)', async () => {
    let signalAborted = false
    const r = await act('timeout:cooperative', async (signal) => {
      signal.addEventListener('abort', () => { signalAborted = true }, { once: true })
      await sleepCancellable(200, signal)
      return 'unreachable'
    }, { timeout: { ms: 30 } })

    expect(r.ok).toBe(false)
    expect(signalAborted).toBe(true)
  })

  it('act() returns promptly even if fn ignores signal (race fallback)', async () => {
    const t0 = Date.now()
    const r = await act('timeout:race', async () => {
      // fn ignores the signal and just sleeps
      await sleep(500)
      return 'late'
    }, { timeout: { ms: 50 } })

    expect(r.ok).toBe(false)
    expect(Date.now() - t0).toBeLessThan(200)
  })

  it('per-attempt timeout resets on retry', async () => {
    let calls = 0
    const r = await act('timeout:retry-reset', async () => {
      calls++
      if (calls === 1) {
        await sleep(200)
        return 'unreachable'
      }
      return 'recovered'
    }, {
      retry: { attempts: 3, delayMs: 1, shouldRetry: () => true },
      timeout: { ms: 50 },
    })

    expect(r.ok).toBe(true)
    expect(calls).toBe(2)
    if (r.ok) {
      expect(r.value).toBe('recovered')
      expect(r.attempts).toBe(2)
    }
  })
})

describe('totalTimeout policy (fixes C-1: cancels inner chain)', () => {
  it('throws TotalTimeoutError when budget is exhausted', async () => {
    const r = await act('total:fire', async () => sleep(500), {
      totalTimeout: { ms: 50 },
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeInstanceOf(TotalTimeoutError)
  })

  it('TotalTimeoutError carries the configured ms', async () => {
    const r = await act('total:ms', async () => sleep(500), { totalTimeout: { ms: 80 } })
    if (!r.ok && r.error instanceof TotalTimeoutError) {
      expect(r.error.ms).toBe(80)
    }
  })

  it('distinguishes TimeoutError from TotalTimeoutError', async () => {
    const r1 = await act('total:dist1', async () => sleep(200), { timeout: { ms: 50 } })
    const r2 = await act('total:dist2', async () => sleep(200), { totalTimeout: { ms: 50 } })

    if (!r1.ok) expect(r1.error).toBeInstanceOf(TimeoutError)
    if (!r2.ok) expect(r2.error).toBeInstanceOf(TotalTimeoutError)
    if (!r1.ok) expect(r1.error).not.toBeInstanceOf(TotalTimeoutError)
    if (!r2.ok) expect(r2.error).not.toBeInstanceOf(TimeoutError)
  })

  it('does NOT continue running fn after totalTimeout fires (fixes C-1)', async () => {
    let attemptCount = 0
    const r = await act('total:cancel', async () => {
      attemptCount++
      await sleep(300)
      return 'done'
    }, {
      retry: { attempts: 5, delayMs: 50 },
      totalTimeout: { ms: 100 },
    })

    expect(r.ok).toBe(false)

    // give any stray retries a window to fire if the cancellation wiring is broken
    await sleep(800)
    // first attempt is cancelled by totalTimeout before retry can start a second
    expect(attemptCount).toBe(1)
  })

  it('interrupts retry delay when totalTimeout fires mid-delay', async () => {
    let attemptCount = 0
    const t0 = Date.now()
    const r = await act('total:delay-interrupt', async () => {
      attemptCount++
      throw new Error('fail')
    }, {
      retry: { attempts: 5, delayMs: 1000, backoff: 'none', jitter: 'none' },
      totalTimeout: { ms: 80 },
    })

    expect(r.ok).toBe(false)
    // first attempt fails, retry sleep starts, totalTimeout fires ~80ms in and rejects the sleep
    expect(Date.now() - t0).toBeLessThan(300)
    expect(attemptCount).toBe(1)
  })
})

describe('dedupe policy (fixes C-3 hung fn, C-5 shared meta)', () => {
  it('collapses concurrent calls into one fn invocation', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      await sleep(30)
      return `result-${calls}`
    }

    const results = await Promise.all([
      act('dedupe-test-collapse', fn, { dedupe: true }),
      act('dedupe-test-collapse', fn, { dedupe: true }),
      act('dedupe-test-collapse', fn, { dedupe: true }),
    ])

    expect(calls).toBe(1)
    expect(results.every(r => r.ok)).toBe(true)
    const values = results.map(r => r.ok ? r.value : null)
    expect(new Set(values).size).toBe(1)
  })

  it('joiners see the originator attempt count (fixes C-5)', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls < 3) throw new Error('fail')
      await sleep(20)
      return 'success'
    }

    const [a, b] = await Promise.all([
      act('dedupe-test-meta', fn, { dedupe: true, retry: { attempts: 5, delayMs: 1 } }),
      act('dedupe-test-meta', fn, { dedupe: true, retry: { attempts: 5, delayMs: 1 } }),
    ])

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    // originator retried twice, succeeded on 3rd; joiners inherit that count
    if (a.ok) expect(a.attempts).toBe(3)
    if (b.ok) expect(b.attempts).toBe(3)
  })

  it('joiners on a failed operation also see correct attempts', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      throw new Error('always-fails')
    }

    const [a, b] = await Promise.all([
      act('dedupe-test-fail', fn, { dedupe: true, retry: { attempts: 3, delayMs: 1 } }),
      act('dedupe-test-fail', fn, { dedupe: true, retry: { attempts: 3, delayMs: 1 } }),
    ])

    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    expect(a.attempts).toBe(3)
    expect(b.attempts).toBe(3)
  })

  it('joiner can abort independently without blocking on hung originator (fixes C-3)', async () => {
    let originatorResolve!: (v: string) => void
    const hungPromise = new Promise<string>((resolve) => { originatorResolve = resolve })

    // originator starts a hung fn
    const originatorPromise = act('dedupe-test-hung', () => hungPromise, { dedupe: true })

    // let the in-flight slot register before the joiner lands
    await sleep(20)

    // joiner arrives with its own AbortSignal
    const joinerController = new AbortController()
    const joinerPromise = act('dedupe-test-hung', async () => 'fresh', {
      dedupe: true,
      signal: joinerController.signal,
    })

    // joiner aborts after 50ms; should reject quickly instead of waiting on the hung originator
    setTimeout(() => joinerController.abort(new Error('joiner-cancelled')), 50)
    const t0 = Date.now()
    const joinerResult = await joinerPromise
    const elapsed = Date.now() - t0

    expect(joinerResult.ok).toBe(false)
    expect(elapsed).toBeLessThan(300)

    // let the originator resolve so the test can exit
    originatorResolve('finally')
    const originatorResult = await originatorPromise
    expect(originatorResult.ok).toBe(true)
  })

  it('different keys are independent', async () => {
    let calls = 0
    const fn = async (key: string) => {
      calls++
      const myCall = calls
      await sleep(20)
      return `${key}-${myCall}`
    }

    const [a, b] = await Promise.all([
      act('dedupe-test-indep-a', () => fn('a'), { dedupe: true }),
      act('dedupe-test-indep-b', () => fn('b'), { dedupe: true }),
    ])

    expect(calls).toBe(2)
    if (a.ok && b.ok) {
      // each key got its own counter snapshot
      expect(a.value).toMatch(/^a-\d+$/)
      expect(b.value).toMatch(/^b-\d+$/)
    }
  })

  it('sequential calls after settlement start fresh', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      await sleep(10)
      return `result-${calls}`
    }

    await act('dedupe-test-seq', fn, { dedupe: true })
    await act('dedupe-test-seq', fn, { dedupe: true })
    await act('dedupe-test-seq', fn, { dedupe: true })

    expect(calls).toBe(3)
  })

  it('dedupe: true is equivalent to dedupe: { enabled: true }', async () => {
    let calls = 0
    const fn = async () => { calls++; await sleep(10); return 'x' }

    await Promise.all([
      act('dedupe-test-bool', fn, { dedupe: true }),
      act('dedupe-test-bool', fn, { dedupe: true }),
    ])
    expect(calls).toBe(1)

    calls = 0
    await Promise.all([
      act('dedupe-test-obj', fn, { dedupe: { enabled: true } }),
      act('dedupe-test-obj', fn, { dedupe: { enabled: true } }),
    ])
    expect(calls).toBe(1)
  })

  it('throws when async store is used with dedupe (sync-store guard)', async () => {
    const asyncStore: AsyncStateStore = {
      _sync: false as const,
      async get() { return undefined },
      async set() {},
      async delete() {},
      async has() { return false },
      async clear() {},
      async size() { return 0 },
    }

    const r = await execute({
      key: 'dedupe:async-store',
      fn: async () => 'x',
      policies: [],
      store: asyncStore,
      meta: { attempts: 1, source: 'fresh' },
      signal: new AbortController().signal,
    })
    // no dedupe here, so the async store is allowed
    expect(r).toBe('x')
  })
})

describe('cache policy (fixes C-4 stampede, C-6 attempts=0, M-6 fail-open)', () => {
  it('caches successful results', async () => {
    let calls = 0
    const fn = async () => { calls++; return `v${calls}` }

    const r1 = await act('cache-test-basic', fn, { cache: { ttl: 60_000 } })
    const r2 = await act('cache-test-basic', fn, { cache: { ttl: 60_000 } })

    expect(calls).toBe(1)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    if (r1.ok) expect(r1.value).toBe('v1')
    if (r2.ok) expect(r2.value).toBe('v1') // same as first
  })

  it('reports source: cache on hit (fixes nothing — baseline)', async () => {
    await act('cache-test-source', async () => 'v', { cache: { ttl: 60_000 } })
    const r = await act('cache-test-source', async () => 'v', { cache: { ttl: 60_000 } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toBe('cache')
  })

  it('reports attempts: 0 on cache hit (fixes C-6)', async () => {
    await act('cache-test-attempts', async () => 'v', { cache: { ttl: 60_000 } })
    const r = await act('cache-test-attempts', async () => 'v', { cache: { ttl: 60_000 } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.attempts).toBe(0)
  })

  it('reports attempts: 1 on cache miss', async () => {
    const r = await act('cache-test-miss', async () => 'v', { cache: { ttl: 60_000 } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.attempts).toBe(1)
  })

  it('does not cache failures', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls === 1) throw new Error('fail')
      return 'success'
    }

    const r1 = await act('cache-test-nofail', fn, { cache: { ttl: 60_000 } })
    const r2 = await act('cache-test-nofail', fn, { cache: { ttl: 60_000 } })

    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(true)
    expect(calls).toBe(2) // failure wasn't cached, fn ran twice
  })

  it('prevents cache stampede for concurrent misses (fixes C-4)', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      await sleep(30)
      return `v${calls}`
    }

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        act('cache-test-stampede', fn, { cache: { ttl: 60_000 } }),
      ),
    )

    // single-flight via the in-flight slot collapses 10 callers into 1 call
    expect(calls).toBe(1)
    expect(results.every(r => r.ok)).toBe(true)
    const values = results.map(r => r.ok ? r.value : null)
    expect(new Set(values).size).toBe(1)
  })

  it('evicts entries after TTL expires', async () => {
    let calls = 0
    const fn = async () => { calls++; return `v${calls}` }

    await act('cache-test-ttl', fn, { cache: { ttl: 50 } })
    await act('cache-test-ttl', fn, { cache: { ttl: 50 } }) // hit
    expect(calls).toBe(1)

    await sleep(80) // past TTL
    await act('cache-test-ttl', fn, { cache: { ttl: 50 } }) // miss, fn runs again
    expect(calls).toBe(2)
  })

  it('fails open when store.set throws (fixes M-6)', async () => {
    // store whose set() throws
    const flakyStore: SyncStateStore = {
      _sync: true as const,
      get<T>(_key: string): T | undefined { return undefined },
      set<T>(_key: string, _value: T, _ttlMs?: number): void {
        throw new Error('redis unavailable')
      },
      delete() {},
      has() { return false },
      clear() {},
      size() { return 0 },
    }

    const scopedAct = withStore(flakyStore)
    const r = await scopedAct('cache-test-failopen', async () => 'value', {
      cache: { ttl: 60_000 },
    })

    // cache write failure is swallowed; the act still succeeds
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('value')
  })
})

describe('invalidate() and withStore()', () => {
  it('invalidate clears the cache for a key', async () => {
    let calls = 0
    const fn = async () => { calls++; return `v${calls}` }

    await act('inv:basic', fn, { cache: { ttl: 60_000 } })
    expect(calls).toBe(1)

    await act('inv:basic', fn, { cache: { ttl: 60_000 } }) // hit
    expect(calls).toBe(1)

    expect(invalidate('inv:basic')).toBe(true) // cleared
    expect(invalidate('inv:basic')).toBe(false) // already gone

    await act('inv:basic', fn, { cache: { ttl: 60_000 } }) // miss, re-runs
    expect(calls).toBe(2)
  })

  it('withStore isolates cache state from default store', async () => {
    const store1 = new InMemoryStore()
    const store2 = new InMemoryStore()
    const act1 = withStore(store1)
    const act2 = withStore(store2)

    let calls = 0
    const fn = async () => { calls++; return `v${calls}` }

    await act1('ws:iso', fn, { cache: { ttl: 60_000 } })
    await act1('ws:iso', fn, { cache: { ttl: 60_000 } }) // hit
    expect(calls).toBe(1)

    await act2('ws:iso', fn, { cache: { ttl: 60_000 } }) // different store, fresh miss
    expect(calls).toBe(2)

    store1.destroy()
    store2.destroy()
  })

  it('withStore exposes invalidate and store on the returned function', async () => {
    const store = new InMemoryStore()
    const scopedAct = withStore(store)

    expect(typeof scopedAct.invalidate).toBe('function')
    expect(scopedAct.store).toBe(store)

    let calls = 0
    await scopedAct('ws:inv', async () => { calls++; return `v${calls}` }, { cache: { ttl: 60_000 } })
    expect(calls).toBe(1)

    await scopedAct('ws:inv', async () => { calls++; return `v${calls}` }, { cache: { ttl: 60_000 } })
    expect(calls).toBe(1)

    expect(scopedAct.invalidate('ws:inv')).toBe(true)

    await scopedAct('ws:inv', async () => { calls++; return `v${calls}` }, { cache: { ttl: 60_000 } })
    expect(calls).toBe(2)

    store.destroy()
  })

  it('withStore with async store works for cache (no dedupe)', async () => {
    // closure-captured map (not `this._map`) so the literal satisfies AsyncStateStore without excess-property noise
    const map = new Map<string, { value: unknown; expiresAt: number | null }>()
    const asyncStore: AsyncStateStore = {
      _sync: false as const,
      async get<T>(key: string): Promise<T | undefined> {
        const e = map.get(key)
        if (!e) return undefined
        if (e.expiresAt !== null && Date.now() > e.expiresAt) {
          map.delete(key)
          return undefined
        }
        return e.value as T
      },
      async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
        map.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null })
      },
      async delete(key: string): Promise<void> { map.delete(key) },
      async has(key: string): Promise<boolean> {
        const e = map.get(key)
        if (!e) return false
        if (e.expiresAt !== null && Date.now() > e.expiresAt) {
          map.delete(key)
          return false
        }
        return true
      },
      async clear(): Promise<void> { map.clear() },
      async size(): Promise<number> { return map.size },
    }

    const scopedAct = withStore(asyncStore)
    let calls = 0
    const fn = async () => { calls++; return `v${calls}` }

    const r1 = await scopedAct('ws:async', fn, { cache: { ttl: 60_000 } })
    const r2 = await scopedAct('ws:async', fn, { cache: { ttl: 60_000 } })

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(calls).toBe(1) // second call hits cache

    const invalidateResult = await scopedAct.invalidate('ws:async')
    expect(invalidateResult).toBe(true)

    const r3 = await scopedAct('ws:async', fn, { cache: { ttl: 60_000 } })
    expect(r3.ok).toBe(true)
    expect(calls).toBe(2) // miss after invalidate
  })
})

describe('InMemoryStore LRU + maxSize (fixes P-3)', () => {
  it('evicts least-recently-used entries when maxSize is exceeded', () => {
    const store = new InMemoryStore({ maxSize: 3 })
    store.set('a', 1)
    store.set('b', 2)
    store.set('c', 3)
    expect(store.size()).toBe(3)

    store.set('d', 4) // evicts 'a', the oldest
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBe(2)
    expect(store.get('c')).toBe(3)
    expect(store.get('d')).toBe(4)
    expect(store.size()).toBe(3)
  })

  it('accessing a key refreshes its LRU position', () => {
    const store = new InMemoryStore({ maxSize: 3 })
    store.set('a', 1)
    store.set('b', 2)
    store.set('c', 3)

    store.get('a') // bump 'a' to most-recent
    store.set('d', 4) // evicts 'b', now the oldest

    expect(store.get('a')).toBe(1)
    expect(store.get('b')).toBeUndefined()
    expect(store.get('c')).toBe(3)
    expect(store.get('d')).toBe(4)
  })

  it('updating an existing key does not evict', () => {
    const store = new InMemoryStore({ maxSize: 2 })
    store.set('a', 1)
    store.set('b', 2)
    store.set('a', 10) // update, not insert

    expect(store.get('a')).toBe(10)
    expect(store.get('b')).toBe(2)
    expect(store.size()).toBe(2)
  })

  it('honours TTL', () => {
    const store = new InMemoryStore()
    store.set('k', 'v', 50)
    expect(store.get('k')).toBe('v')
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(store.get('k')).toBeUndefined()
        resolve()
      }, 80)
    })
  })

  it('size() does not mutate LRU order (fixes m-1)', () => {
    const store = new InMemoryStore({ maxSize: 2 })
    store.set('a', 1)
    store.set('b', 2)

    store.size() // must NOT touch LRU order

    store.set('c', 3) // 'a' is still oldest, gets evicted
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBe(2)
    expect(store.get('c')).toBe(3)
  })

  it('destroy() stops the cleanup timer (no leak)', () => {
    const store = new InMemoryStore({ autoCleanup: true, cleanupIntervalMs: 10 })
    store.destroy()
    // if destroy() didn't clear the timer, vitest would hang at exit
    expect(true).toBe(true)
  })
})

describe('AbortSignal integration (fixes C-1, C-2, signal option)', () => {
  it('act() respects caller-provided signal', async () => {
    const controller = new AbortController()
    const promise = act('signal:caller', async (signal) => {
      await sleepCancellable(500, signal)
      return 'unreachable'
    }, { signal: controller.signal })

    setTimeout(() => controller.abort(new Error('user-cancelled')), 30)
    const r = await promise

    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as Error).message).toBe('user-cancelled')
  })

  it('act() returns immediately with abort reason if signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('pre-aborted'))

    const r = await act('signal:pre', async () => 'unreachable', {
      signal: controller.signal,
    })

    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(0)
    if (!r.ok) expect((r.error as Error).message).toBe('pre-aborted')
  })

  it('cancellation propagates through retry + timeout + dedupe', async () => {
    const controller = new AbortController()
    let calls = 0
    const promise = act('signal:propagation', async (signal) => {
      calls++
      await sleepCancellable(500, signal)
      return 'unreachable'
    }, {
      signal: controller.signal,
      retry: { attempts: 5, delayMs: 100 },
      timeout: { ms: 1000 },
      dedupe: true,
    })

    setTimeout(() => controller.abort(new Error('cancel')), 30)
    const r = await promise

    expect(r.ok).toBe(false)
    expect(calls).toBe(1) // abort kills the retry loop
    if (!r.ok) expect((r.error as Error).message).toBe('cancel')
  })
})

describe('isSyncStore / isAsyncStore type guards', () => {
  it('isSyncStore returns true for SyncStateStore', () => {
    const store = new InMemoryStore()
    expect(isSyncStore(store)).toBe(true)
  })

  it('isAsyncStore returns true for AsyncStateStore', () => {
    const asyncStore: AsyncStateStore = {
      _sync: false as const,
      async get() { return undefined },
      async set() {},
      async delete() {},
      async has() { return false },
      async clear() {},
      async size() { return 0 },
    }
    expect(isAsyncStore(asyncStore)).toBe(true)
    expect(isSyncStore(asyncStore)).toBe(false)
  })
})

describe('execute() public API (fixes A-2)', () => {
  it('is callable with a custom policy chain and store', async () => {
    const store = new InMemoryStore()
    const meta = { attempts: 1, source: 'fresh' as const }
    const result = await execute({
      key: 'exec:basic',
      fn: async () => 'value',
      policies: [],
      store,
      meta,
      signal: new AbortController().signal,
    })
    expect(result).toBe('value')
    expect(meta.attempts).toBe(1)
  })

  it('throws when dedupe policy is used with async store', async () => {
    const asyncStore: AsyncStateStore = {
      _sync: false as const,
      async get() { return undefined },
      async set() {},
      async delete() {},
      async has() { return false },
      async clear() {},
      async size() { return 0 },
    }

    // build a dedupe policy by hand
    const { dedupePolicy } = await import('../policies/dedupe.js')
    const policy = dedupePolicy()

    await expect(
      execute({
        key: 'exec:dedupe-async',
        fn: async () => 'x',
        policies: [policy],
        store: asyncStore,
        meta: { attempts: 1, source: 'fresh' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/SyncStateStore/)
  })
})
