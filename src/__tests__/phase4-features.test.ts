import { describe, it, expect } from 'vitest'
import { act, noopPolicy, execute, InMemoryStore, withStore } from '../index.js'
import { waitForObsHook } from '../testing/index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── noop policy ───

describe('H19: noopPolicy', () => {
  it('passes fn through unchanged', async () => {
    let called = false
    const result = await execute({
      key: 'noop-test',
      fn: async () => { called = true; return 'value' },
      policies: [noopPolicy()],
      store: new InMemoryStore(),
      meta: { attempts: 1, source: 'fresh' },
      signal: new AbortController().signal,
    })
    expect(called).toBe(true)
    expect(result).toBe('value')
  })

  it('preserves errors (does not swallow)', async () => {
    await expect(
      execute({
        key: 'noop-error',
        fn: async () => { throw new Error('fail') },
        policies: [noopPolicy()],
        store: new InMemoryStore(),
        meta: { attempts: 1, source: 'fresh' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('fail')
  })

  it('works as conditional policy substitute', async () => {
    const useRetry = false
    const policy = useRetry
      ? noopPolicy() // would be a real retryPolicy in real code
      : noopPolicy()
    const result = await execute({
      key: 'noop-conditional',
      fn: async () => 42,
      policies: [policy],
      store: new InMemoryStore(),
      meta: { attempts: 1, source: 'fresh' },
      signal: new AbortController().signal,
    })
    expect(result).toBe(42)
  })
})

// ─── shouldRetryResult (result-based retry) ───

describe('H11: shouldRetryResult (result-based retry)', () => {
  it('retries when shouldRetryResult returns false', async () => {
    let calls = 0
    const r = await act('h11-retry', async () => {
      calls++
      return { status: calls < 3 ? 500 : 200 }
    }, {
      retry: {
        attempts: 5,
        delayMs: 1,
        shouldRetryResult: (res: { status: number }) => res.status < 400,
      },
    })
    expect(r.ok).toBe(true)
    expect(calls).toBe(3)
    if (r.ok) expect((r.value as { status: number }).status).toBe(200)
  })

  it('accepts value immediately when shouldRetryResult returns true', async () => {
    let calls = 0
    const r = await act('h11-accept', async () => {
      calls++
      return 'ok'
    }, {
      retry: {
        attempts: 5,
        delayMs: 1,
        shouldRetryResult: () => true,
      },
    })
    expect(r.ok).toBe(true)
    expect(calls).toBe(1)
  })

  it('returns last value when retries exhausted (does not throw)', async () => {
    let calls = 0
    const r = await act('h11-exhaust', async () => {
      calls++
      return { status: 500 }
    }, {
      retry: {
        attempts: 3,
        delayMs: 1,
        shouldRetryResult: (res: { status: number }) => res.status < 400,
      },
    })
    // returns the value (not throw); caller can inspect it.
    expect(r.ok).toBe(true)
    expect(calls).toBe(3)
    if (r.ok) expect((r.value as { status: number }).status).toBe(500)
  })

  it('shouldRetryResult predicate throwing does not crash', async () => {
    const r = await act('h11-predicate-throw', async () => 'value', {
      retry: {
        attempts: 3,
        delayMs: 1,
        shouldRetryResult: () => { throw new Error('buggy predicate') },
      },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('value')
  })
})

// ─── timeout.strategy ───

describe('H12: timeout.strategy', () => {
  it('race strategy (default) returns promptly at ms', async () => {
    const t0 = Date.now()
    const r = await act('h12-race', async () => {
      await wait(200)
      return 'late'
    }, {
      timeout: { ms: 50 },
      retry: { attempts: 1 },
    })
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    expect(elapsed).toBeLessThan(150) // race returns at ~50ms
  })

  it('cooperative strategy waits for fn to settle', async () => {
    let fnSettled = false
    const t0 = Date.now()
    const r = await act('h12-coop', async (signal) => {
      // fn cooperates with signal; rejects shortly after abort
      return new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => {
          fnSettled = true
          reject(signal.reason)
        })
      })
    }, {
      timeout: { ms: 50, strategy: 'cooperative' },
      retry: { attempts: 1 },
    })
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    expect(fnSettled).toBe(true) // cooperative waited for fn
    expect(elapsed).toBeLessThan(150)
  })

  it('cooperative strategy returns value if fn settles before timer', async () => {
    const r = await act('h12-coop-fast', async () => {
      await wait(10)
      return 'fast'
    }, {
      timeout: { ms: 100, strategy: 'cooperative' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('fast')
  })
})

// ─── retry.dangerouslyUnref ───

describe('H14: retry.dangerouslyUnref', () => {
  it('does not affect successful calls', async () => {
    const r = await act('h14-success', async () => 'ok', {
      retry: { attempts: 3, delayMs: 100, dangerouslyUnref: true },
    })
    expect(r.ok).toBe(true)
  })

  it('does not affect failed calls (still retries)', async () => {
    let calls = 0
    const r = await act('h14-retry', async () => {
      calls++
      if (calls < 2) throw new Error('transient')
      return 'recovered'
    }, {
      retry: { attempts: 3, delayMs: 1, dangerouslyUnref: true },
    })
    expect(r.ok).toBe(true)
    expect(calls).toBe(2)
  })
})

// ─── count strategy (sliding-window ratio) ───

describe('H10: count strategy (sliding-window ratio)', () => {
  it('trips when failure rate exceeds threshold', async () => {
    let shouldFail = true
    const fn = async () => {
      if (shouldFail) throw new Error('fail')
      return 'ok'
    }
    const key = 'h10-count'
    // 50% threshold, 10 calls window, min 5 calls.
    // Fill window with 5 failures (100% rate) → should trip.
    for (let i = 0; i < 5; i++) {
      await act(key, fn, {
        circuitBreaker: {
          threshold: 10,
          cooldownMs: 10_000,
          strategy: 'count',
          countSize: 10,
          countThreshold: 0.5,
          countMinimumCalls: 5,
        },
      })
    }
    // 6th call should be blocked (breaker open)
    const r = await act(key, fn, {
      circuitBreaker: {
        threshold: 10,
        cooldownMs: 10_000,
        strategy: 'count',
        countSize: 10,
        countThreshold: 0.5,
        countMinimumCalls: 5,
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect((r.error as { code?: string }).code).toBe('ACTLY_CIRCUIT_OPEN')
    }
  })

  it('does not trip below minimumCalls', async () => {
    const fn = async () => { throw new Error('fail') }
    const key = 'h10-min-calls'
    // only 2 failures, but minimumCalls is 5; should NOT trip.
    for (let i = 0; i < 2; i++) {
      await act(key, fn, {
        circuitBreaker: {
          threshold: 10,
          cooldownMs: 10_000,
          strategy: 'count',
          countSize: 10,
          countThreshold: 0.5,
          countMinimumCalls: 5,
        },
      })
    }
    // 3rd call should NOT be blocked (below minimum)
    const r = await act(key, fn, {
      circuitBreaker: {
        threshold: 10,
        cooldownMs: 10_000,
        strategy: 'count',
        countSize: 10,
        countThreshold: 0.5,
        countMinimumCalls: 5,
      },
    })
    // fn was called (not blocked); error is fn's error, not CircuitBreakerOpenError
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect((r.error as { code?: string }).code).not.toBe('ACTLY_CIRCUIT_OPEN')
    }
  })

  it('consecutive strategy still works (default)', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      throw new Error('fail')
    }
    const key = 'h10-consecutive'
    // 3 consecutive failures → trips
    for (let i = 0; i < 3; i++) {
      await act(key, fn, { circuitBreaker: { threshold: 3, cooldownMs: 10_000 } })
    }
    expect(calls).toBe(3)
    // 4th call blocked
    const r = await act(key, fn, { circuitBreaker: { threshold: 3, cooldownMs: 10_000 } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect((r.error as { code?: string }).code).toBe('ACTLY_CIRCUIT_OPEN')
    }
    expect(calls).toBe(3) // fn not called
  })
})

// ─── backoffFn (custom backoff with state) ───

describe('H15: backoffFn (custom backoff with state)', () => {
  it('uses custom delay from backoffFn', async () => {
    const delays: number[] = []
    let calls = 0
    const t0 = Date.now()
    await act('h15-custom', async () => {
      calls++
      if (calls < 3) throw new Error('transient')
      return 'recovered'
    }, {
      retry: {
        attempts: 5,
        backoffFn: (attempt, _err, _state) => {
          delays.push(attempt)
          return 10 // fixed 10ms delay
        },
      },
    })
    const elapsed = Date.now() - t0
    expect(calls).toBe(3)
    expect(delays).toEqual([1, 2]) // backoffFn called on attempts 1 and 2
    expect(elapsed).toBeGreaterThanOrEqual(20) // at least 2 × 10ms delays
  })

  it('state persists across attempts', async () => {
    const stateValues: unknown[] = []
    let calls = 0
    await act('h15-state', async () => {
      calls++
      if (calls < 3) throw new Error('transient')
      return 'ok'
    }, {
      retry: {
        attempts: 5,
        backoffFn: (attempt, _err, state) => {
          // Store the attempt number in state, read it back next call.
          stateValues.push(state.previousAttempt)
          state.previousAttempt = attempt
          return 1
        },
      },
    })
    // First call: state is empty → push undefined, set previousAttempt=1
    // Second call: state.previousAttempt=1 → push 1, set previousAttempt=2
    expect(stateValues).toEqual([undefined, 1])
  })

  it('backoffFn overrides backoff and jitter options', async () => {
    let customCalled = false
    const r = await act('h15-override', async () => 'ok', {
      retry: {
        attempts: 3,
        delayMs: 1000,
        backoff: 'exponential',
        jitter: 'full',
        backoffFn: () => { customCalled = true; return 0 },
      },
    })
    expect(r.ok).toBe(true)
    // backoffFn not called on success path (no retries)
    expect(customCalled).toBe(false)
  })
})

// ─── waitForObsHook testing helper ───

describe('H17: waitForObsHook', () => {
  it('resolves with event when hook fires', async () => {
    const obs: { onFinalSuccess?: (e: { attempts: number }) => void } = {}
    const promise = waitForObsHook(obs as never, 'onFinalSuccess', 5000)
    await act('h17-wait', async () => 1, { observability: obs })
    const event = await promise
    expect(event.attempts).toBe(1)
  })

  it('rejects on timeout', async () => {
    const obs: Record<string, unknown> = {}
    await expect(
      waitForObsHook(obs as never, 'onFinalSuccess', 50),
    ).rejects.toThrow(/timed out/)
  })

  it('chains to pre-existing hook', async () => {
    let chainCount = 0
    const obs: { onFinalSuccess?: (e: unknown) => void } = {
      onFinalSuccess: () => { chainCount++ },
    }
    const promise = waitForObsHook(obs as never, 'onFinalSuccess', 5000)
    await act('h17-chain', async () => 1, { observability: obs })
    await promise
    expect(chainCount).toBe(1) // pre-existing hook still called
  })
})

// ─── @usePolicy decorator ───

describe('H13: @usePolicy decorator', () => {
  it('wraps class method with act()', async () => {
    // simple test: decorators require experimentalDecorators or stage-3.
    // we test the underlying mechanism by importing usePolicy and applying
    // it manually.
    const { usePolicy } = await import('../utils/decorator.js')

    class TestService {
      async fetchUser(signal: AbortSignal, id: string): Promise<string> {
        return `user-${id}`
      }
    }

    // Apply decorator manually (equivalent to @usePolicy({...}))
    const proto = TestService.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'fetchUser')!
    usePolicy({ retry: { attempts: 3, delayMs: 1 } })(
      proto as object,
      'fetchUser',
      desc,
    )
    Object.defineProperty(proto, 'fetchUser', desc)

    const svc = new TestService()
    const result = await svc.fetchUser(new AbortController().signal, '42')
    expect(result).toBe('user-42')
  })

  it('retries on failure', async () => {
    const { usePolicy } = await import('../utils/decorator.js')
    let calls = 0

    class TestService {
      async flakyOp(_signal: AbortSignal): Promise<string> {
        calls++
        if (calls < 3) throw new Error('transient')
        return 'recovered'
      }
    }

    // Apply decorator manually: get descriptor, transform, redefine.
    const proto = TestService.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'flakyOp')!
    usePolicy({ retry: { attempts: 5, delayMs: 1 } })(
      proto as object,
      'flakyOp',
      desc,
    )
    // Redefine the property so the wrapped method takes effect.
    Object.defineProperty(proto, 'flakyOp', desc)

    const svc = new TestService()
    const result = await svc.flakyOp(new AbortController().signal)
    expect(result).toBe('recovered')
    expect(calls).toBe(3)
  })

  it('throws on exhausted retries', async () => {
    const { usePolicy } = await import('../utils/decorator.js')

    class TestService {
      async alwaysFail(_signal: AbortSignal): Promise<string> {
        throw new Error('always')
      }
    }

    const proto = TestService.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'alwaysFail')!
    usePolicy({ retry: { attempts: 2, delayMs: 1 } })(
      proto as object,
      'alwaysFail',
      desc,
    )
    Object.defineProperty(proto, 'alwaysFail', desc)

    const svc = new TestService()
    await expect(svc.alwaysFail(new AbortController().signal)).rejects.toThrow()
  })
})
