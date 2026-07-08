import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, anySignal } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── BUG-D50: anySignal polyfill listener leak ───────────────────────────────

describe('BUG-D50: anySignal polyfill listener leak on pre-aborted input', () => {
  it('does not leak listeners when one input is already aborted', () => {
    // native AbortSignal.any() runs on Node 20+; we still verify no listener buildup

    const signalA = new AbortController().signal
    const signalB = new AbortController()
    signalB.abort(new Error('pre-aborted'))

    const beforeCount = (signalA as unknown as { _eventsCount?: number })._eventsCount ?? 0

    const composite = anySignal([signalA, signalB.signal])

    expect(composite.aborted).toBe(true)

    // once the composite settles, signalA must not retain the probe listener
    const afterCount = (signalA as unknown as { _eventsCount?: number })._eventsCount ?? 0

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

    // originator retries 3x then succeeds; joiner rides the in-flight promise
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
    // joiner must mirror the originator's attempts, not report a stale default
    if (joiner.ok) expect(joiner.attempts).toBe(3)
  })
})

// ─── BUG-D52: Circuit breaker half-open abort resets to closed ──────────────

describe('BUG-D52: circuit breaker half-open abort should go back to open', () => {
  it('abort during half-open returns breaker to open state', async () => {
    const key = 'd52-cb-halfopen-abort:test'

    // trip the breaker
    for (let i = 0; i < 3; i++) {
      await act(key, async () => { throw new Error('fail') }, {
        circuitBreaker: { threshold: 3, cooldownMs: 30 },
      })
    }

    await wait(40)

    // half-open probe: caller aborts mid-flight
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

    // breaker should be OPEN again, so the next call is rejected
    const nextResult = await act(key, async () => 'should-not-reach', {
      circuitBreaker: { threshold: 3, cooldownMs: 30 },
    })

    expect(nextResult.ok).toBe(false)
  })
})
