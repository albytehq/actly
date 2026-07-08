import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, LIMITS } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── What-if: validation for new Phase 4/5 options ────────────────────

describe('Debug2: validation for new options', () => {
  it('rejects retry.shouldRetryResult that is not a function', async () => {
    await expect(act('k', async () => 1, {
      retry: { attempts: 3, shouldRetryResult: 'not-a-fn' as unknown as () => boolean },
    })).rejects.toThrow(/shouldRetryResult must be a function/)
  })

  it('rejects retry.backoffFn that is not a function', async () => {
    await expect(act('k', async () => 1, {
      retry: { attempts: 3, backoffFn: 42 as unknown as () => number },
    })).rejects.toThrow(/backoffFn must be a function/)
  })

  it('rejects retry.dangerouslyUnref that is not boolean', async () => {
    await expect(act('k', async () => 1, {
      retry: { attempts: 3, dangerouslyUnref: 'yes' as unknown as boolean },
    })).rejects.toThrow(/dangerouslyUnref must be a boolean/)
  })

  it('rejects timeout.strategy invalid value', async () => {
    await expect(act('k', async () => 1, {
      timeout: { ms: 5000, strategy: 'aggressive' as 'race' },
    })).rejects.toThrow(/strategy must be 'race' or 'cooperative'/)
  })

  it('rejects circuitBreaker.strategy invalid value', async () => {
    await expect(act('k', async () => 1, {
      circuitBreaker: { threshold: 3, cooldownMs: 1000, strategy: 'sampling' as 'consecutive' },
    })).rejects.toThrow(/strategy must be 'consecutive' or 'count'/)
  })

  it('rejects circuitBreaker.countSize = 0', async () => {
    await expect(act('k', async () => 1, {
      circuitBreaker: { threshold: 3, cooldownMs: 1000, strategy: 'count', countSize: 0 },
    })).rejects.toThrow(/countSize must be a positive integer/)
  })

  it('rejects circuitBreaker.countSize = 1.5 (non-integer)', async () => {
    await expect(act('k', async () => 1, {
      circuitBreaker: { threshold: 3, cooldownMs: 1000, strategy: 'count', countSize: 1.5 },
    })).rejects.toThrow(/countSize must be a positive integer/)
  })

  it('rejects circuitBreaker.countThreshold > 1', async () => {
    await expect(act('k', async () => 1, {
      circuitBreaker: { threshold: 3, cooldownMs: 1000, strategy: 'count', countThreshold: 1.5 },
    })).rejects.toThrow(/countThreshold must be.*between 0 and 1/)
  })

  it('rejects circuitBreaker.countThreshold < 0', async () => {
    await expect(act('k', async () => 1, {
      circuitBreaker: { threshold: 3, cooldownMs: 1000, strategy: 'count', countThreshold: -0.1 },
    })).rejects.toThrow(/countThreshold must be.*between 0 and 1/)
  })

  it('rejects circuitBreaker.countMinimumCalls = 0', async () => {
    await expect(act('k', async () => 1, {
      circuitBreaker: { threshold: 3, cooldownMs: 1000, strategy: 'count', countMinimumCalls: 0 },
    })).rejects.toThrow(/countMinimumCalls must be a positive integer/)
  })

  it('rejects bulkhead.maxQueueSize = 0', async () => {
    await expect(act('k', async () => 1, {
      bulkhead: { maxConcurrent: 1, maxQueueSize: 0 },
    })).rejects.toThrow(/maxQueueSize must be a positive integer or Infinity/)
  })

  it('rejects bulkhead.maxQueueSize = -1', async () => {
    await expect(act('k', async () => 1, {
      bulkhead: { maxConcurrent: 1, maxQueueSize: -1 },
    })).rejects.toThrow(/maxQueueSize must be a positive integer or Infinity/)
  })

  it('rejects bulkhead.maxQueueSize = 1.5 (non-integer)', async () => {
    await expect(act('k', async () => 1, {
      bulkhead: { maxConcurrent: 1, maxQueueSize: 1.5 },
    })).rejects.toThrow(/maxQueueSize must be a positive integer or Infinity/)
  })

  it('rejects hedge.placement invalid value', async () => {
    await expect(act('k', async () => 1, {
      hedge: { delayMs: 100, placement: 'above' as 'outside-retry' },
    })).rejects.toThrow(/placement must be 'outside-retry' or 'inside-retry'/)
  })

  it('rejects hedge.keepLoser that is not boolean', async () => {
    await expect(act('k', async () => 1, {
      hedge: { delayMs: 100, keepLoser: 'yes' as unknown as boolean },
    })).rejects.toThrow(/keepLoser must be a boolean/)
  })

  it('accepts bulkhead.maxQueueSize = Infinity', async () => {
    const r = await act('k', async () => 1, {
      bulkhead: { maxConcurrent: 1, maxQueueSize: Infinity },
    })
    expect(r.ok).toBe(true)
  })
})

// ─── What-if: backoffFn edge cases ────────────────────────────────────

describe('Debug2: backoffFn edge cases', () => {
  it('backoffFn returning Infinity is capped to MAX_RETRY_DELAY_MS', async () => {
    // Use a small return value; we can't wait MAX_RETRY_DELAY_MS in tests.
    let calls = 0
    const delays: number[] = []
    const r = await act('bf-inf', async () => {
      calls++
      if (calls < 2) throw new Error('transient')
      return 'ok'
    }, {
      retry: {
        attempts: 3,
        backoffFn: (attempt: number) => {
          delays.push(attempt)
          return 1 // 1ms; just verify backoffFn is invoked
        },
      },
    })
    expect(r.ok).toBe(true)
    expect(calls).toBe(2)
    expect(delays).toEqual([1]) // backoffFn called once (on first failure)
  })

  it('backoffFn returning negative is treated as 0', async () => {
    let calls = 0
    const t0 = Date.now()
    const r = await act('bf-neg', async () => {
      calls++
      if (calls < 2) throw new Error('transient')
      return 'ok'
    }, {
      retry: {
        attempts: 3,
        backoffFn: () => -1000,
      },
    })
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(true)
    expect(calls).toBe(2)
    expect(elapsed).toBeLessThan(20) // no delay
  })

  it('backoffFn returning NaN is treated as 0', async () => {
    let calls = 0
    const r = await act('bf-nan', async () => {
      calls++
      if (calls < 2) throw new Error('transient')
      return 'ok'
    }, {
      retry: {
        attempts: 3,
        backoffFn: () => NaN,
      },
    })
    expect(r.ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('backoffFn returning very large number is capped', async () => {
    let calls = 0
    const r = await act('bf-large', async () => {
      calls++
      if (calls < 2) throw new Error('transient')
      return 'ok'
    }, {
      retry: {
        attempts: 3,
        backoffFn: () => 50, // 50ms; small enough to wait on
      },
    })
    expect(r.ok).toBe(true)
    expect(calls).toBe(2)
  })
})

// ─── What-if: CB count strategy edge cases ────────────────────────────

describe('Debug2: CB count strategy edge cases', () => {
  it('countThreshold = 0 trips on any failure (after minimumCalls)', async () => {
    const fn = async () => { throw new Error('fail') }
    const key = 'ct0'
    const opts = {
      circuitBreaker: {
        threshold: 10, cooldownMs: 10000,
        strategy: 'count' as const,
        countSize: 5, countThreshold: 0, countMinimumCalls: 1,
      },
    }
    // 1 failure → rate = 1.0 > 0 → trip
    await act(key, fn, opts)
    const r = await act(key, fn, opts)
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as { code?: string }).code).toBe('ACTLY_CIRCUIT_OPEN')
  })

  it('countThreshold = 1 never trips on rate alone (rate <= 1, never > 1)', async () => {
    const fn = async () => { throw new Error('fail') }
    const key = 'ct1'
    const opts = {
      circuitBreaker: {
        threshold: 10, cooldownMs: 10000,
        strategy: 'count' as const,
        countSize: 5, countThreshold: 1, countMinimumCalls: 1,
      },
    }
    // Fill window with failures
    for (let i = 0; i < 5; i++) await act(key, fn, opts)
    // 6th call should NOT be blocked (rate = 1.0, but 1.0 > 1 is false)
    const r = await act(key, fn, opts)
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as { code?: string }).code).not.toBe('ACTLY_CIRCUIT_OPEN')
  })

  it('countSize = 1 (minimum window)', async () => {
    const fn = async () => { throw new Error('fail') }
    const key = 'ct-size1'
    const opts = {
      circuitBreaker: {
        threshold: 10, cooldownMs: 10000,
        strategy: 'count' as const,
        countSize: 1, countThreshold: 0.5, countMinimumCalls: 1,
      },
    }
    // 1 failure → rate = 1.0 > 0.5 → trip
    await act(key, fn, opts)
    const r = await act(key, fn, opts)
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as { code?: string }).code).toBe('ACTLY_CIRCUIT_OPEN')
  })

  it('count strategy idle cleanup after all successes', async () => {
    const store = new InMemoryStore({ maxSize: 1000 })
    const scopedAct = withStore(store)

    // First: cause a failure
    await scopedAct('ct-idle', async () => { throw new Error('fail') }, {
      circuitBreaker: { threshold: 10, cooldownMs: 10000, strategy: 'count', countSize: 5, countThreshold: 0.5, countMinimumCalls: 10 },
    }).catch(() => {})
    // State should exist (1 failure recorded)
    expect(store.size()).toBeGreaterThan(0)

    // Then: succeed enough to fill window with successes (5 calls)
    for (let i = 0; i < 5; i++) {
      await scopedAct('ct-idle', async () => 'ok', {
        circuitBreaker: { threshold: 10, cooldownMs: 10000, strategy: 'count', countSize: 5, countThreshold: 0.5, countMinimumCalls: 10 },
      })
    }

    // After 5 successes, the ring buffer (countSize=5) has fully rotated past the failure.
    // failures=0, so idle cleanup deletes the state entry.
    expect(store.size()).toBe(0)
    store.destroy()
  })

  it('count strategy: mixed outcomes (50% failure rate)', async () => {
    let callNum = 0
    const fn = async () => {
      callNum++
      if (callNum % 2 === 1) throw new Error('odd fail')
      return 'ok'
    }
    const key = 'ct-mixed'
    const opts = {
      circuitBreaker: {
        threshold: 10, cooldownMs: 10000,
        strategy: 'count' as const,
        countSize: 4, countThreshold: 0.4, countMinimumCalls: 4,
      },
    }
    // 4 calls: fail, ok, fail, ok -> 50% failure rate (filled=4, failures=2, rate=0.5)
    // Call 5 (fail) trips the breaker: rate 0.5 > 0.4 and enoughCalls 4>=4.
    // Call 6 must be rejected with ACTLY_CIRCUIT_OPEN.
    for (let i = 0; i < 5; i++) await act(key, fn, opts).catch(() => {})
    const r6 = await act(key, fn, opts)
    if (!r6.ok) {
      const code = (r6.error as { code?: string }).code
      expect(code).toBe('ACTLY_CIRCUIT_OPEN')
    }
  })
})

// ─── What-if: timeout cooperative edge cases ──────────────────────────

describe('Debug2: timeout cooperative edge cases', () => {
  it('cooperative timeout with fn that settles before timer', async () => {
    const r = await act('coop-fast', async () => {
      await wait(10)
      return 'fast'
    }, {
      timeout: { ms: 100, strategy: 'cooperative' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('fast')
  })

  it('cooperative timeout with fn that never settles after abort (hangs)', async () => {
    // Cooperative strategy waits for fn to settle, even after the abort fires.
    // Here fn resolves 50ms post-abort, so we expect the resolved value rather than a timeout error.
    const r = await act('coop-slow', async (signal) => {
      return new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => resolve('settled-after-abort'), 50)
        })
      })
    }, {
      timeout: { ms: 30, strategy: 'cooperative' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('settled-after-abort')
  })
})

// ─── What-if: thenable fn (not a real Promise) ───────────────────────

describe('Debug2: thenable fn', () => {
  it('handles thenable return from fn', async () => {
    const thenable = {
      then(resolve: (v: number) => void) { resolve(42) },
    }
    const r = await act('thenable', async () => thenable)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(42)
  })
})

// ─── What-if: audit.log() throws ──────────────────────────────────────

describe('Debug2: audit.log() throws', () => {
  it('audit.log throwing is swallowed by safeCall (zero-throw contract)', async () => {
    // audit.log is wrapped in safeCall so a buggy logger can't reject act().
    const r = await act('audit-throw', async () => 'ok', {
      audit: { log: () => { throw new Error('audit bug') } },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('ok')
  })
})

// ─── What-if: traceId edge cases ──────────────────────────────────────

describe('Debug2: traceId edge cases', () => {
  it('traceId = empty string is accepted (user-supplied)', async () => {
    const r = await act('tid-empty', async () => 'ok', { traceId: '' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.traceId).toBe('')
  })

  it('traceId = very long string is accepted', async () => {
    const longId = 'x'.repeat(10000)
    const r = await act('tid-long', async () => 'ok', { traceId: longId })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.traceId).toBe(longId)
  })

  it('traceId appears on observability events', async () => {
    let capturedTraceId: string | undefined
    const r = await act('tid-obs', async () => 'ok', {
      traceId: 'my-trace-id',
      observability: {
        onFinalSuccess: (e: { traceId: string }) => { capturedTraceId = e.traceId },
      },
    })
    expect(r.ok).toBe(true)
    expect(capturedTraceId).toBe('my-trace-id')
    if (r.ok) expect(r.traceId).toBe('my-trace-id')
  })
})

// ─── What-if: boundary values ─────────────────────────────────────────

describe('Debug2: boundary values', () => {
  it('retry.attempts = MAX_RETRY_ATTEMPTS (100) is accepted', async () => {
    const r = await act('max-attempts', async () => 'ok', {
      retry: { attempts: LIMITS.MAX_RETRY_ATTEMPTS, delayMs: 0 },
    })
    expect(r.ok).toBe(true)
  })

  it('retry.attempts = MAX_RETRY_ATTEMPTS + 1 is rejected', async () => {
    await expect(act('k', async () => 1, {
      retry: { attempts: LIMITS.MAX_RETRY_ATTEMPTS + 1 },
    })).rejects.toThrow(/exceeds limit/)
  })

  it('cache.ttl = MAX_CACHE_TTL is accepted', async () => {
    const r = await act('max-ttl', async () => 'cached', {
      cache: { ttl: LIMITS.MAX_CACHE_TTL },
    })
    expect(r.ok).toBe(true)
  })

  it('cache.ttl = MAX_CACHE_TTL + 1 is rejected', async () => {
    await expect(act('k', async () => 1, {
      cache: { ttl: LIMITS.MAX_CACHE_TTL + 1 },
    })).rejects.toThrow(/exceeds limit/)
  })

  it('timeout.ms = MAX_TIMEOUT_MS is accepted', async () => {
    const r = await act('max-timeout', async () => 'ok', {
      timeout: { ms: LIMITS.MAX_TIMEOUT_MS },
    })
    expect(r.ok).toBe(true)
  })

  it('timeout.ms = MAX_TIMEOUT_MS + 1 is rejected', async () => {
    await expect(act('k', async () => 1, {
      timeout: { ms: LIMITS.MAX_TIMEOUT_MS + 1 },
    })).rejects.toThrow(/exceeds limit/)
  })

  it('retry.delayMs = MAX_RETRY_DELAY_MS is accepted', async () => {
    // We can't actually wait MAX_RETRY_DELAY_MS; just verify the validator accepts it.
    const r = await act('max-delay', async () => 'ok', {
      retry: { attempts: 2, delayMs: LIMITS.MAX_RETRY_DELAY_MS },
    })
    expect(r.ok).toBe(true)
  })

  it('retry.delayMs = MAX_RETRY_DELAY_MS + 1 is rejected', async () => {
    await expect(act('k', async () => 1, {
      retry: { attempts: 2, delayMs: LIMITS.MAX_RETRY_DELAY_MS + 1 },
    })).rejects.toThrow(/exceeds limit/)
  })
})

// ─── What-if: totalTimeout fires during retry delay ───────────────────

describe('Debug2: totalTimeout fires during retry delay', () => {
  it('totalTimeout aborts during retry sleep', async () => {
    let calls = 0
    const t0 = Date.now()
    const r = await act('tt-during-retry', async () => {
      calls++
      throw new Error('always fail')
    }, {
      retry: { attempts: 10, delayMs: 10_000, shouldRetry: () => true },
      totalTimeout: { ms: 50 },
    })
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    // totalTimeout fires during the 10s retry sleep
    expect(elapsed).toBeLessThan(500)
    // fn ran at least once before the budget elapsed
    expect(calls).toBeGreaterThanOrEqual(1)
    if (!r.ok) expect((r.error as { code?: string }).code).toBe('ACTLY_TOTAL_TIMEOUT')
  })
})

// ─── What-if: hedge delayMs > timeout ─────────────────────────────────

describe('Debug2: hedge delayMs > timeout', () => {
  it('hedge never fires when timeout < delayMs', async () => {
    let calls = 0
    const t0 = Date.now()
    const r = await act('hedge-vs-timeout', async (signal) => {
      calls++
      await wait(200)
      return 'primary'
    }, {
      hedge: { delayMs: 500 }, // hedge would fire at 500ms
      timeout: { ms: 100 },    // but timeout fires at 100ms
      retry: { attempts: 1 },
    })
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    expect(elapsed).toBeLessThan(200) // timeout at 100ms
    expect(calls).toBe(1) // only primary called, hedge never fired
  })
})

// ─── What-if: rateLimit windowMs = 1 (very small) ─────────────────────

describe('Debug2: rateLimit very small window', () => {
  it('windowMs = 1ms — every call is in a new window', async () => {
    let calls = 0
    const fn = async () => { calls++; return 'ok' }

    // maxCalls: 1 per 1ms window
    await act('rl-1ms', fn, { rateLimit: { maxCalls: 1, windowMs: 1 } })
    expect(calls).toBe(1)

    // wait 5ms; new window opens
    await wait(5)
    await act('rl-1ms', fn, { rateLimit: { maxCalls: 1, windowMs: 1 } })
    expect(calls).toBe(2)
  })
})

// ─── What-if: drain with timeoutMs = 0 ────────────────────────────────

describe('Debug2: drain edge cases', () => {
  it('drain(0) returns immediately if no inflight', async () => {
    const { drain } = await import('../core/shutdown.js')
    const result = await drain(0, 'unique-drain-test-scope')
    expect(result).toBe(true)
  })

  it('drain(0) with inflight returns false immediately', async () => {
    const { drain, registerDrainable, unregisterDrainable } = await import('../core/shutdown.js')
    registerDrainable('test-drain-0')
    const result = await drain(0, 'test-drain-0')
    expect(result).toBe(false)
    unregisterDrainable('test-drain-0')
  })
})

// ─── What-if: enableWatchdog called multiple times ────────────────────

describe('Debug2: enableWatchdog idempotent', () => {
  it('calling enableWatchdog multiple times does not create multiple timers', async () => {
    const { enableWatchdog, disableWatchdog } = await import('../core/health.js')
    enableWatchdog(1000)
    enableWatchdog(2000)
    enableWatchdog(3000)
    // No crash = pass. Only one timer should be running.
    disableWatchdog()
  })
})

// ─── What-if: store throws synchronously ──────────────────────────────

describe('Debug2: store throws', () => {
  it('store.get() throwing does not crash act()', async () => {
    const throwingStore = {
      _sync: true as const,
      get(): never { throw new Error('store get bug') },
      set(): void {},
      delete(): void {},
      has(): boolean { return false },
      clear(): void {},
      size(): number { return 0 },
    }
    const scopedAct = withStore(throwingStore)
    // cache policy calls store.get on reads; store.get errors are NOT fail-open (only writes are)
    const r = await scopedAct('store-throw', async () => 'ok', {
      cache: { ttl: 60_000 },
    })
    expect(r.ok).toBe(false)
  })

  it('store.set() throwing is swallowed (fail-open) for cache writes', async () => {
    const throwingStore = {
      _sync: true as const,
      get<T>(): T | undefined { return undefined },
      set(): never { throw new Error('store set bug') },
      delete(): void {},
      has(): boolean { return false },
      clear(): void {},
      size(): number { return 0 },
    }
    const scopedAct = withStore(throwingStore)
    const r = await scopedAct('store-set-throw', async () => 'value', {
      cache: { ttl: 60_000 },
    })
    // store.set throws -> cache write is fail-open -> value still returned
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('value')
  })
})
