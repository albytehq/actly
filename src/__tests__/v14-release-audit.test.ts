import { describe, it, expect, vi } from 'vitest'
import {
  act,
  HedgeTimeoutError,
  enableWatchdog,
  disableWatchdog,
  registerWatchdogHooks,
  unregisterWatchdogHooks,
  timeoutPolicy,
  totalTimeoutPolicy,
  retryPolicy,
  cachePolicy,
  rateLimitPolicy,
  circuitBreakerPolicy,
  bulkheadPolicy,
  dedupePolicy,
} from '../index.js'
import type { FinalFailureEvent } from '../observability.js'

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Pre-push release audit regressions (findings RA-1..RA-9 in the 1.4
// release investigation). Every fix here was reproduced as broken on the
// pre-audit build first.

describe('RA-1: fallback that throws — one event, original error surfaces', () => {
  it('fires onFinalFailure exactly once with the original error and fallbackError attached', async () => {
    const events: FinalFailureEvent[] = []
    const auditEntries: unknown[] = []

    const r = await act('ra1', async () => { throw new Error('boom') }, {
      fallback: { value: () => { throw new Error('fb-down') } },
      observability: { onFinalFailure: (e) => { events.push(e) } },
      audit: { log: (e) => { auditEntries.push(e) } },
    })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeInstanceOf(Error)
    expect(events.length).toBe(1)
    expect((events[0]!.error as Error).message).toBe('boom')
    expect((events[0]!.fallbackError as Error).message).toBe('fb-down')
    expect(auditEntries.length).toBe(1)
  })

  it('plain failure (no fallback) has no fallbackError field at all', async () => {
    const events: FinalFailureEvent[] = []
    await act('ra1b', async () => { throw new Error('x') }, {
      observability: { onFinalFailure: (e) => { events.push(e) } },
    })
    expect(events.length).toBe(1)
    expect('fallbackError' in events[0]!).toBe(false)
  })
})

describe('RA-2: durationMs includes the fallback runtime', () => {
  it('counts the time the fallback value function took', async () => {
    const r = await act('ra2', async () => { throw new Error('x') }, {
      fallback: { value: () => wait(80).then(() => 'late') },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.durationMs).toBeGreaterThan(70)
  })
})

describe('RA-3: fallback without "value" is a programmer error', () => {
  it('fallback: {} throws synchronously (before the promise is created)', () => {
    expect(() => act('ra3', async () => 'x', { fallback: {} as never })).toThrow(TypeError)
    expect(() => act('ra3', async () => 'x', { fallback: 'static' as never })).toThrow(TypeError)
  })

  it('a function-free fallback value passes validation (T = value type)', () => {
    expect(() => act('ra3b', async () => 'x', { fallback: { value: 42 } })).not.toThrow()
  })
})

describe('RA-4: user-thrown HedgeTimeoutError is not mistaken for the hedge window', () => {
  it('propagates the error and launches no hedge when fn throws before the window closes', async () => {
    let calls = 0
    const r = await act('ra4', async () => {
      calls++
      throw new HedgeTimeoutError({ delayMs: 5 })
    }, { hedge: { delayMs: 60 } })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(HedgeTimeoutError)
      expect((r.error as HedgeTimeoutError).delayMs).toBe(5)
    }
    // the pre-window failure must NOT spawn a second (hedge) call
    expect(calls).toBe(1)
  })

  it('control: a slow primary still launches the hedge and reports the winner', async () => {
    let calls = 0
    const r = await act('ra4b', async () => {
      calls++
      await wait(90)
      return `v${calls}`
    }, { hedge: { delayMs: 20 } })

    expect(r.ok).toBe(true)
    expect(calls).toBe(2) // primary + hedge
  })
})

describe('RA-5: timeoutPolicy validates at construction', () => {
  it('rejects Infinity / 0 / NaN ms (setTimeout would clamp to 1 ms)', () => {
    expect(() => timeoutPolicy({ ms: Number.POSITIVE_INFINITY })).toThrow(/positive finite/)
    expect(() => timeoutPolicy({ ms: 0 })).toThrow(/positive finite/)
    expect(() => timeoutPolicy({ ms: Number.NaN })).toThrow(/positive finite/)
    expect(() => totalTimeoutPolicy({ ms: Number.POSITIVE_INFINITY })).toThrow(/positive finite/)
    expect(() => timeoutPolicy({ ms: 100, strategy: 'sideways' as never })).toThrow(/strategy/)
  })

  it('accepts valid options', () => {
    expect(() => timeoutPolicy({ ms: 100 })).not.toThrow()
    expect(() => totalTimeoutPolicy({ ms: 100, strategy: 'cooperative' })).not.toThrow()
  })
})

describe('RA-6: cachePolicy validates at construction', () => {
  it('rejects ttl 0 / Infinity / negative (store treats them as never-expire)', () => {
    expect(() => cachePolicy({ ttl: 0 })).toThrow(/positive finite/)
    expect(() => cachePolicy({ ttl: Number.POSITIVE_INFINITY })).toThrow(/exceeds limit|positive finite/)
    expect(() => cachePolicy({ ttl: -1 })).toThrow(/positive finite/)
  })

  it('accepts valid ttl', () => {
    expect(() => cachePolicy({ ttl: 1_000 })).not.toThrow()
  })
})

describe('RA-7: standalone policy factories enforce the same rules as act()', () => {
  // Parity: construction-time errors match the act() path message-for-message
  // because both call the same assert*Options.
  const parity = (factory: () => unknown, viaAct: () => unknown) => {
    let factoryMsg = ''
    let actMsg = ''
    try { factory() } catch (e) { factoryMsg = (e as Error).message }
    try { viaAct() } catch (e) { actMsg = (e as Error).message }
    expect(factoryMsg).not.toBe('')
    expect(factoryMsg).toBe(actMsg)
  }

  it('retryPolicy: attempts 0 / negative / NaN throw, matching act()', () => {
    parity(
      () => retryPolicy({ attempts: 0 }),
      () => act('ra7r', async () => 1, { retry: { attempts: 0 } }),
    )
    expect(() => retryPolicy({ attempts: -3, delayMs: 1 })).toThrow(/positive integer/)
    expect(() => retryPolicy({ attempts: 2, backoff: 'wobbly' as never })).toThrow(/backoff/)
  })

  it('rateLimitPolicy: invalid maxCalls / windowMs throw, matching act()', () => {
    parity(
      () => rateLimitPolicy({ maxCalls: 0, windowMs: 1_000 }),
      () => act('ra7l', async () => 1, { rateLimit: { maxCalls: 0, windowMs: 1_000 } }),
    )
    expect(() => rateLimitPolicy({ maxCalls: 5, windowMs: -1 })).toThrow(/positive finite/)
    expect(() => rateLimitPolicy({ maxCalls: 5, windowMs: Number.NaN })).toThrow(/positive finite/)
  })

  it('circuitBreakerPolicy: threshold / cooldown / count fields throw, matching act()', () => {
    parity(
      () => circuitBreakerPolicy({ threshold: 0, cooldownMs: 100 }),
      () => act('ra7c', async () => 1, { circuitBreaker: { threshold: 0, cooldownMs: 100 } }),
    )
    // NaN cooldown: elapsed >= NaN is always false, so an open circuit
    // would never close again
    expect(() => circuitBreakerPolicy({ threshold: 2, cooldownMs: Number.NaN })).toThrow(/positive finite/)
    expect(() => circuitBreakerPolicy({ threshold: 2, cooldownMs: 0 })).toThrow(/positive finite/)
    expect(() => circuitBreakerPolicy({
      threshold: 2, cooldownMs: 100, strategy: 'count', countThreshold: 1.5,
    })).toThrow(/between 0 and 1/)
    expect(() => circuitBreakerPolicy({
      threshold: 2, cooldownMs: 100, strategy: 'count', countThreshold: Number.NaN,
    })).toThrow(/between 0 and 1/)
  })

  it('bulkheadPolicy: invalid concurrency throws, matching act()', () => {
    parity(
      () => bulkheadPolicy({ maxConcurrent: 0 }),
      () => act('ra7b', async () => 1, { bulkhead: { maxConcurrent: 0 } }),
    )
    expect(() => bulkheadPolicy({ maxConcurrent: 1, queueTimeoutMs: Number.NaN })).toThrow(/non-negative finite/)
  })

  it('dedupePolicy: inflightTtl 0 / NaN and non-boolean enabled throw', () => {
    expect(() => dedupePolicy({ enabled: true, inflightTtl: 0 })).toThrow(/inflightTtl/)
    expect(() => dedupePolicy({ enabled: true, inflightTtl: Number.NaN })).toThrow(/non-negative finite/)
    expect(() => dedupePolicy({ enabled: 'yes' as never })).toThrow(/enabled/)
    expect(() => dedupePolicy(null as never)).toThrow(/must be an object/)
    expect(() => dedupePolicy({ enabled: true, inflightTtl: Number.POSITIVE_INFINITY })).not.toThrow()
    expect(() => dedupePolicy()).not.toThrow()
    expect(() => dedupePolicy({ enabled: false })).not.toThrow()
  })
})

describe('RA-8: watchdog validates threshold and hooks', () => {
  it('rejects NaN / Infinity / 0 / negative thresholds (setInterval clamps to 1 ms)', () => {
    expect(() => enableWatchdog(Number.NaN)).toThrow(/positive finite/)
    expect(() => enableWatchdog(Number.POSITIVE_INFINITY)).toThrow(/positive finite/)
    expect(() => enableWatchdog(0)).toThrow(/positive finite/)
    expect(() => enableWatchdog(-1)).toThrow(/positive finite/)
  })

  it('rejects typo\'d / non-function hooks like the act() path does', () => {
    expect(() => enableWatchdog(1_000, { onWatchdogg: () => {} } as never)).toThrow(/unknown observability hook/)
    expect(() => enableWatchdog(1_000, { onWatchdog: 'not-a-fn' as never })).toThrow(/must be a function/)
    expect(() => registerWatchdogHooks({ onWatchdogg: () => {} } as never)).toThrow(/unknown observability hook/)
    expect(() => registerWatchdogHooks({ onWatchdog: 3 as never })).toThrow(/must be a function/)
  })

  it('accepts a valid threshold and hooks; watchdog still works', async () => {
    let fired = 0
    enableWatchdog(80, { onWatchdog: () => { fired++ } })
    let release!: () => void
    const p = act('ra8', () => new Promise<void>((r) => { release = r }))
    await wait(220)
    expect(fired).toBeGreaterThanOrEqual(1)
    release()
    await p
    disableWatchdog()
  })

  it('a full hooks object (not just onWatchdog) is accepted', () => {
    expect(() => registerWatchdogHooks({
      onAttempt: () => {},
      onWatchdog: () => {},
    })).not.toThrow()
    unregisterWatchdogHooks({ onAttempt: () => {}, onWatchdog: () => {} })
  })
})

describe('RA-9: hedge window no longer fabricates "after 0ms" HedgeTimeoutError', () => {
  it('an internal window elapse surfaces no error when the hedge wins', async () => {
    const r = await act('ra9', async () => {
      await wait(70)
      return 'slow-primary'
    }, { hedge: { delayMs: 15 } })
    // hedge (fast copy) wins; no HedgeTimeoutError with delayMs 0 anywhere
    expect(r.ok).toBe(true)
  })

  it('user-constructed HedgeTimeoutError keeps its delayMs in the message', () => {
    const e = new HedgeTimeoutError({ delayMs: 250 })
    expect(e.message).toMatch(/after 250ms/)
    expect(e.message).not.toMatch(/after 0ms/)
  })
})

describe('RA-1 follow-up: warn gate for a broken fallback', () => {
  it('warns via console when the fallback throws in non-production', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await act('ra1c', async () => { throw new Error('boom') }, {
        fallback: { value: () => { throw new Error('fb-down') } },
      })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toContain('fallback threw')
    } finally {
      warn.mockRestore()
    }
  })
})

// The minified bundles mangle error class names (new.target.name).
// Every concrete error class pins its name string in the constructor.
// These tests guard the pinned strings; verify-dist.mjs guards the built
// bundles (instance names + runtime-thrown name in ESM and CJS).
describe('pinned error instance names (minified bundles)', () => {
  it('every concrete error class reports its own name on instances', async () => {
    const mod = await import('../index.js')
    const cases: Array<[unknown, string]> = [
      [new mod.ActlyAbortError(), 'ActlyAbortError'],
      [new mod.TimeoutError(5), 'TimeoutError'],
      [new mod.TotalTimeoutError(5), 'TotalTimeoutError'],
      [new mod.RetryExhaustedError({ attempts: 1, lastError: new Error('x'), errors: [] }), 'RetryExhaustedError'],
      [new mod.ValidationError('m'), 'ValidationError'],
      [new mod.CircuitBreakerOpenError('k', 5), 'CircuitBreakerOpenError'],
      [new mod.BulkheadOverflowError('k', 2), 'BulkheadOverflowError'],
      [new mod.RateLimitError('k', 2, 1000), 'RateLimitError'],
      [new mod.ResourceExhaustedError(1, 100), 'ResourceExhaustedError'],
      [new mod.HedgeTimeoutError({ delayMs: 5 }), 'HedgeTimeoutError'],
    ]
    for (const [err, name] of cases) {
      expect((err as Error).name).toBe(name)
      expect((err as { toJSON: () => { name: string } }).toJSON().name).toBe(name)
    }
  })

  it('a user subclass of ActlyError still inherits its own class name', async () => {
    const { ActlyError } = await import('../index.js')
    class TestErr extends ActlyError {
      readonly code = 'ACTLY_TEST' as const
    }
    expect(new TestErr('m').name).toBe('TestErr')
  })

  it('a runtime timeout error keeps its name through the engine', async () => {
    const r = await act('err-name', () => new Promise((res) => setTimeout(res, 50)), { timeout: { ms: 5 } })
    expect(r.ok).toBe(false)
    expect((r.error as Error).name).toBe('TimeoutError')
    expect((r.error as { toJSON: () => { name: string } }).toJSON().name).toBe('TimeoutError')
  })
})

// v1.4.2: `dedupe: { inflightTtl }` without `enabled: true` was a silent
// no-op in act() — the same object activates dedupePolicy() when used
// standalone, and `cache: { ttl }` activates the cache. The object form now
// enables unless `enabled: false`.
describe('v1.4.2: dedupe object form enables by default', () => {
  const slow = () => new Promise<number>((res) => setTimeout(() => res(42), 25))

  it('act(): { inflightTtl } single-flights without enabled: true', async () => {
    let runs = 0
    const fn = () => { runs++; return slow() }
    const [a, b] = await Promise.all([
      act('d-obj-ttl', fn, { dedupe: { inflightTtl: 5000 } }),
      act('d-obj-ttl', fn, { dedupe: { inflightTtl: 5000 } }),
    ])
    expect(runs).toBe(1)
    expect(a.value).toBe(42)
    expect(b.value).toBe(42)
  })

  it('act(): {} is enabled with default ttl', async () => {
    let runs = 0
    const fn = () => { runs++; return slow() }
    await Promise.all([
      act('d-obj-empty', fn, { dedupe: {} }),
      act('d-obj-empty', fn, { dedupe: {} }),
    ])
    expect(runs).toBe(1)
  })

  it('act(): { enabled: false } stays off', async () => {
    let runs = 0
    const fn = () => { runs++; return slow() }
    await Promise.all([
      act('d-obj-off', fn, { dedupe: { enabled: false, inflightTtl: 5000 } }),
      act('d-obj-off', fn, { dedupe: { enabled: false, inflightTtl: 5000 } }),
    ])
    expect(runs).toBe(2)
  })

  it('scoped act(): object form single-flights too', async () => {
    const { withStore, InMemoryStore } = await import('../index.js')
    const scoped = withStore(new InMemoryStore())
    let runs = 0
    const fn = () => { runs++; return slow() }
    await Promise.all([
      scoped('d-obj-scoped', fn, { dedupe: { inflightTtl: 5000 } }),
      scoped('d-obj-scoped', fn, { dedupe: { inflightTtl: 5000 } }),
    ])
    expect(runs).toBe(1)
  })

  it('parity: dedupePolicy({ inflightTtl }) and act({ dedupe: { inflightTtl } }) agree', async () => {
    const { dedupePolicy, execute, InMemoryStore } = await import('../index.js')
    let standaloneRuns = 0
    const fnStandalone = () => { standaloneRuns++; return slow() }
    const chain = dedupePolicy<number>({ inflightTtl: 5000 })
    const store = new InMemoryStore()
    const mkInput = () => ({
      key: 'd-parity',
      fn: fnStandalone,
      policies: [chain],
      store,
      meta: { attempts: 1, source: 'fresh' as const },
      signal: new AbortController().signal,
    })
    await Promise.all([execute(mkInput()), execute(mkInput())])
    store.destroy()
    let actRuns = 0
    const fnAct = () => { actRuns++; return slow() }
    await Promise.all([
      act('d-parity2', fnAct, { dedupe: { inflightTtl: 5000 } }),
      act('d-parity2', fnAct, { dedupe: { inflightTtl: 5000 } }),
    ])
    expect(standaloneRuns).toBe(1)
    expect(actRuns).toBe(1)
  })
})
