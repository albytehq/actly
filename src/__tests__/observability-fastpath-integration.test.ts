import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, RetryExhaustedError, ActlyError } from '../index.js'
import type { ObservabilityHooks, ActlyEvent } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Capture all observability events into an array for assertion.
 * Returns the hooks object + the events array.
 */
function captureEvents(): { hooks: ObservabilityHooks; events: ActlyEvent[] } {
  const events: ActlyEvent[] = []
  const hooks: ObservabilityHooks = {
    onAttempt: (e) => events.push({ ...e, type: 'attempt' } as ActlyEvent),
    onRetry: (e) => events.push({ ...e, type: 'retry' } as ActlyEvent),
    onCacheHit: (e) => events.push({ ...e, type: 'cache-hit' } as ActlyEvent),
    onCacheMiss: (e) => events.push({ ...e, type: 'cache-miss' } as ActlyEvent),
    onDedupeJoin: (e) => events.push({ ...e, type: 'dedupe-join' } as ActlyEvent),
    onTimeout: (e) => events.push({ ...e, type: 'timeout' } as ActlyEvent),
    onFinalSuccess: (e) => events.push({ ...e, type: 'final-success' } as ActlyEvent),
    onFinalFailure: (e) => events.push({ ...e, type: 'final-failure' } as ActlyEvent),
  }
  return { hooks, events }
}

describe('Phase 11: observability hooks', () => {
  it('zero-cost contract: empty hooks object does NOT trigger observability', async () => {
    // Empty hooks (no actual functions defined) should be treated as
    // "no observability" — no events allocated, no overhead.
    const r = await act('obs-empty:test', async () => 'value', {
      observability: {},
    })
    expect(r.ok).toBe(true)
    // traceId should be undefined because buildObservability returns
    // undefined when no hooks are actually defined.
    expect(r.traceId).toBeUndefined()
  })

  it('emits onAttempt + onFinalSuccess for simple successful call', async () => {
    const { hooks, events } = captureEvents()
    const r = await act('obs-simple:test', async () => 'value', {
      observability: hooks,
    })

    expect(r.ok).toBe(true)
    expect(r.traceId).toBeDefined()
    expect(r.durationMs).toBeDefined()
    expect(events.length).toBe(2)
    expect(events[0]?.type).toBe('attempt')
    expect(events[1]?.type).toBe('final-success')
    expect((events[1] as { attempts: number }).attempts).toBe(1)
  })

  it('emits onAttempt + onRetry + onFinalSuccess for retried success', async () => {
    const { hooks, events } = captureEvents()
    let calls = 0
    const r = await act('obs-retry:test', async () => {
      calls++
      if (calls < 3) throw new Error('fail')
      return 'ok'
    }, {
      retry: { attempts: 5, delayMs: 1 },
      observability: hooks,
    })

    expect(r.ok).toBe(true)
    // Expected: 3 attempts, 2 retries, 1 final-success
    const types = events.map(e => e.type)
    expect(types).toEqual(['attempt', 'retry', 'attempt', 'retry', 'attempt', 'final-success'])
  })

  it('emits onCacheMiss then onCacheHit on second call', async () => {
    const { hooks: hooks1, events: events1 } = captureEvents()
    const { hooks: hooks2, events: events2 } = captureEvents()

    await act('obs-cache:test', async () => 'v1', {
      cache: { ttl: 60_000 },
      observability: hooks1,
    })
    await act('obs-cache:test', async () => 'v2', {
      cache: { ttl: 60_000 },
      observability: hooks2,
    })

    expect(events1.map(e => e.type)).toContain('cache-miss')
    expect(events1.find(e => e.type === 'final-success')).toBeDefined()
    expect(events2.map(e => e.type)).toContain('cache-hit')
    expect(events2.find(e => e.type === 'final-success')).toBeDefined()
  })

  it('emits onFinalFailure with failedBy discriminator on timeout', async () => {
    const { hooks, events } = captureEvents()
    const r = await act('obs-timeout:test', async () => {
      await wait(200)
      return 'unreachable'
    }, {
      timeout: { ms: 50 },
      observability: hooks,
    })

    expect(r.ok).toBe(false)
    const failure = events.find(e => e.type === 'final-failure') as { failedBy: string; error: unknown }
    expect(failure).toBeDefined()
    expect(failure.failedBy).toBe('timeout')
  })

  it('emits onFinalFailure with failedBy=retry-exhausted on retry exhaustion', async () => {
    const { hooks, events } = captureEvents()
    const r = await act('obs-retry-exhaust:test', async () => {
      throw new Error('always')
    }, {
      retry: { attempts: 3, delayMs: 1 },
      observability: hooks,
    })

    expect(r.ok).toBe(false)
    const failure = events.find(e => e.type === 'final-failure') as { failedBy: string }
    expect(failure.failedBy).toBe('retry-exhausted')
  })

  it('emits onFinalFailure with failedBy=abort on caller abort', async () => {
    const { hooks, events } = captureEvents()
    const controller = new AbortController()
    const promise = act('obs-abort:test', async (signal) => {
      // Cooperative: wait for abort
      return new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }, {
      signal: controller.signal,
      observability: hooks,
    })

    setTimeout(() => controller.abort(new Error('user-cancelled')), 20)
    const r = await promise

    expect(r.ok).toBe(false)
    const failure = events.find(e => e.type === 'final-failure') as { failedBy: string }
    expect(failure.failedBy).toBe('abort')
  })

  it('emits onFinalFailure with failedBy=fn-error on non-retried fn error', async () => {
    const { hooks, events } = captureEvents()
    const r = await act('obs-fn-error:test', async () => {
      throw new Error('boom')
    }, {
      observability: hooks,
    })

    expect(r.ok).toBe(false)
    const failure = events.find(e => e.type === 'final-failure') as { failedBy: string }
    expect(failure.failedBy).toBe('fn-error')
  })

  it('all events carry the same traceId', async () => {
    const { hooks, events } = captureEvents()
    await act('obs-traceid:test', async () => 'value', {
      observability: hooks,
    })

    const traceIds = new Set(events.map(e => (e as { traceId: string }).traceId))
    expect(traceIds.size).toBe(1)
  })

  it('user-supplied traceId is used', async () => {
    const { hooks, events } = captureEvents()
    const r = await act('obs-user-traceid:test', async () => 'value', {
      observability: hooks,
      traceId: 'my-trace-123',
    })

    expect(r.traceId).toBe('my-trace-123')
    expect((events[0] as { traceId: string }).traceId).toBe('my-trace-123')
  })

  it('pre-aborted signal emits final-failure with failedBy=abort', async () => {
    const { hooks, events } = captureEvents()
    const controller = new AbortController()
    controller.abort(new Error('pre-aborted'))

    const r = await act('obs-pre-abort:test', async () => 'unreachable', {
      signal: controller.signal,
      observability: hooks,
    })

    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(0)
    const failure = events.find(e => e.type === 'final-failure') as { failedBy: string }
    expect(failure.failedBy).toBe('abort')
  })

  it('observability hooks do not affect zero-hook fast path', async () => {
    // When no observability is supplied, no events are allocated.
    // Run 100 calls — should be fast.
    const t0 = Date.now()
    for (let i = 0; i < 100; i++) {
      await act(`obs-fast-${i}`, async () => i)
    }
    const elapsed = Date.now() - t0
    // 100 calls should take less than 500ms (very conservative).
    // If observability overhead was incurred on the fast path, it would
    // be much slower.
    expect(elapsed).toBeLessThan(500)
  })

  it('ActlyError instanceof chain works across all error classes', async () => {
    const r = await act('obs-instanceof:test', async () => {
      throw new Error('boom')
    }, { retry: { attempts: 2, delayMs: 1 } })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(Error)
      expect(r.error).toBeInstanceOf(ActlyError)
      expect(r.error).toBeInstanceOf(RetryExhaustedError)
      expect((r.error as ActlyError).code).toBe('ACTLY_RETRY_EXHAUSTED')
    }
  })
})

describe('Phase 12: performance fast path', () => {
  it('fast path returns the same shape as slow path', async () => {
    const fast = await act('perf-fast:test', async () => 42)
    const slow = await act('perf-slow:test', async () => 42, {
      retry: { attempts: 1 },
    })

    // Both should have the same shape (ok, value, source, attempts)
    expect(fast.ok).toBe(true)
    expect(slow.ok).toBe(true)
    if (fast.ok && slow.ok) {
      expect(fast.value).toBe(42)
      expect(slow.value).toBe(42)
      expect(fast.source).toBe('fresh')
      expect(slow.source).toBe('fresh')
      expect(fast.attempts).toBe(1)
      expect(slow.attempts).toBe(1)
      // Fast path: no traceId (no observability). Slow path: same (no obs).
      expect(fast.traceId).toBeUndefined()
      expect(slow.traceId).toBeUndefined()
      // Both have durationMs (always set now)
      expect(typeof fast.durationMs).toBe('number')
      expect(typeof slow.durationMs).toBe('number')
    }
  })

  it('fast path handles fn errors', async () => {
    const r = await act('perf-fast-err:test', async () => { throw new Error('boom') })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect((r.error as Error).message).toBe('boom')
      expect(r.attempts).toBe(1)
    }
  })

  it('fast path validates key (programmer errors still throw)', async () => {
    await expect(act('__proto__', async () => 1)).rejects.toThrow(/forbidden/)
    await expect(act('', async () => 1)).rejects.toThrow(/non-empty/)
  })
})

describe('Phase 13: end-to-end integration', () => {
  it('full policy stack with observability + scoped store', async () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)
    const { hooks, events } = captureEvents()
    const controller = new AbortController()

    let calls = 0
    const r = await scopedAct('e2e:full-stack', async (signal) => {
      calls++
      if (calls < 2) throw new Error('transient')
      return { result: 'success', call: calls }
    }, {
      retry: { attempts: 3, delayMs: 1 },
      timeout: { ms: 1000 },
      totalTimeout: { ms: 5000 },
      cache: { ttl: 60_000 },
      dedupe: true,
      signal: controller.signal,
      observability: hooks,
      traceId: 'e2e-trace',
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toEqual({ result: 'success', call: 2 })
      expect(r.attempts).toBe(2)
      expect(r.traceId).toBe('e2e-trace')
    }

    // Events should include: attempt, retry, attempt, final-success
    // (no cache-hit because first call, no cache-miss because dedupe first caller is originator not joiner)
    const types = events.map(e => e.type)
    expect(types).toContain('attempt')
    expect(types).toContain('retry')
    expect(types).toContain('final-success')

    // All events should have the user-supplied traceId
    const traceIds = new Set(events.map(e => (e as { traceId: string }).traceId))
    expect(traceIds.has('e2e-trace')).toBe(true)

    store.destroy()
  })

  it('cache hit on second call returns cached value with source=cache', async () => {
    const { hooks: hooks1, events: events1 } = captureEvents()
    const { hooks: hooks2, events: events2 } = captureEvents()

    let calls = 0
    const fn = async () => { calls++; return `v${calls}` }

    const r1 = await act('e2e:cache-hit', fn, { cache: { ttl: 60_000 }, observability: hooks1 })
    const r2 = await act('e2e:cache-hit', fn, { cache: { ttl: 60_000 }, observability: hooks2 })

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(calls).toBe(1)  // fn ran once
    if (r1.ok && r2.ok) {
      expect(r1.source).toBe('fresh')
      expect(r2.source).toBe('cache')
      expect(r1.attempts).toBe(1)
      expect(r2.attempts).toBe(0)  // cache hit reports 0 attempts
    }

    expect(events1.some(e => e.type === 'cache-miss')).toBe(true)
    expect(events2.some(e => e.type === 'cache-hit')).toBe(true)
  })
})
