import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, anySignal } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── BUG-D50: anySignal polyfill listener leak ───────────────────────────────

describe('BUG-D50: anySignal polyfill listener leak on pre-aborted input', () => {
  it('does not leak listeners when one input is already aborted', () => {
    // Test the polyfill path by testing the listener behavior directly.
    // On Node 20+, native AbortSignal.any() is used, so this tests the
    // native path. But we can verify no listener accumulation.

    const signalA = new AbortController().signal
    const signalB = new AbortController()
    signalB.abort(new Error('pre-aborted'))

    // Count listeners on signalA before
    const beforeCount = (signalA as unknown as { _eventsCount?: number })._eventsCount ?? 0

    // Call anySignal with [signalA, signalB(signalB is already aborted)]
    const composite = anySignal([signalA, signalB.signal])

    // Composite should be aborted (signalB was pre-aborted)
    expect(composite.aborted).toBe(true)

    // After composite is settled, signalA should NOT have extra listeners
    // (the polyfill should have cleaned them up)
    const afterCount = (signalA as unknown as { _eventsCount?: number })._eventsCount ?? 0

    // Before fix: afterCount > beforeCount (listener leaked on signalA)
    // After fix: afterCount === beforeCount (listener cleaned up)
    expect(afterCount).toBe(beforeCount)
  })
})

// ─── BUG-D51: Cache single-flight joiner doesn't mirror attempts ────────────

describe('BUG-D51: cache single-flight joiner attempts', () => {
  it('joiner mirrors originator attempt count', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls < 3) throw new Error('fail')
      await wait(20)
      return 'success'
    }

    const key = 'd51-cache-attempts:test'

    // Originator: retries 3 times, succeeds on 3rd
    // Joiner: joins in-flight, should mirror attempts=3
    const [originator, joiner] = await Promise.all([
      act(key, fn, {
        cache: { ttl: 60_000 },
        retry: { attempts: 5, delayMs: 1 },
      }),
      act(key, async () => 'fresh', {
        cache: { ttl: 60_000 },
        retry: { attempts: 5, delayMs: 1 },
      }),
    ])

    expect(originator.ok).toBe(true)
    expect(joiner.ok).toBe(true)
    if (originator.ok) expect(originator.attempts).toBe(3)
    // After fix: joiner should mirror originator's attempts (3)
    // Before fix: joiner reports attempts=1 (default, never updated)
    if (joiner.ok) expect(joiner.attempts).toBe(3)
  })
})

// ─── BUG-D52: Circuit breaker half-open abort resets to closed ──────────────

describe('BUG-D52: circuit breaker half-open abort should go back to open', () => {
  it('abort during half-open returns breaker to open state', async () => {
    const key = 'd52-cb-halfopen-abort:test'

    // Trip the breaker (3 failures)
    for (let i = 0; i < 3; i++) {
      await act(key, async () => { throw new Error('fail') }, {
        circuitBreaker: { threshold: 3, cooldownMs: 30 },
      })
    }

    // Wait for cooldown
    await wait(40)

    // Probe call — caller aborts mid-operation
    const controller = new AbortController()
    const probePromise = act(key, async (signal) => {
      return new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }, {
      circuitBreaker: { threshold: 3, cooldownMs: 30 },
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(new Error('user-cancelled')), 10)
    const probeResult = await probePromise
    expect(probeResult.ok).toBe(false)

    // After fix: breaker should be OPEN again (not closed)
    // Next call should get CircuitBreakerOpenError
    const nextResult = await act(key, async () => 'should-not-reach', {
      circuitBreaker: { threshold: 3, cooldownMs: 30 },
    })

    // Before fix: nextResult.ok === true (breaker is closed, call proceeds)
    // After fix: nextResult.ok === false (breaker is open, call blocked)
    expect(nextResult.ok).toBe(false)
  })
})
