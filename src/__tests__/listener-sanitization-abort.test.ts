import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── BUG-D30: Hedge second call unhandled rejection ─────────────────────────

describe('BUG-D30: hedge second call unhandled rejection', () => {
  it('second fn call rejection is handled when primary wins race', async () => {
    let unhandledRejection = false
    const handler = () => { unhandledRejection = true }
    process.on('unhandledRejection', handler)

    try {
      let callCount = 0
      const fn = async (signal: AbortSignal) => {
        callCount++
        if (callCount === 1) {
          // Primary: slow but succeeds
          await wait(60)
          return 'primary'
        }
        // Hedge: slow, then rejects AFTER primary wins
        await wait(80)
        throw new Error('hedge-failed-late')
      }

      const r = await act('d30-hedge-unhandled:test', fn, {
        hedge: { delayMs: 20 },
      })

      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toBe('primary')

      // Wait for hedge to eventually reject
      await wait(100)

      // After fix: hedge rejection should be marked as handled
      expect(unhandledRejection).toBe(false)
    } finally {
      process.off('unhandledRejection', handler)
    }
  })
})

// ─── BUG-D32: Bulkhead releaseSlot removes listener from wrong signal ───────

describe('BUG-D32: bulkhead listener leak on wrong signal', () => {
  it('queued caller abort listener is removed from their own signal, not releaser signal', async () => {
    // This test verifies the fix indirectly: if listener leaks on the
    // queued caller's signal, that signal can never be GC'd while the
    // bulkhead state exists. We test by checking that a queued caller
    // who aborts is properly cleaned up.

    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const fn = async () => { await fnPromise; return 'done' }

    const key = 'd32-bulk-listener:test'

    // Caller 1: occupies slot
    const p1 = act(key, fn, { bulkhead: { maxConcurrent: 1, queueTimeoutMs: 10000 } })
    await wait(10)

    // Caller 2: queued with their own signal
    const controller2 = new AbortController()
    const p2 = act(key, fn, {
      bulkhead: { maxConcurrent: 1, queueTimeoutMs: 10000 },
      signal: controller2.signal,
    })
    await wait(10)

    // Caller 3: queued with their own signal
    const controller3 = new AbortController()
    const p3 = act(key, fn, {
      bulkhead: { maxConcurrent: 1, queueTimeoutMs: 10000 },
      signal: controller3.signal,
    })
    await wait(10)

    // Caller 2 aborts — should be removed from queue
    controller2.abort(new Error('c2-cancel'))
    const r2 = await p2
    expect(r2.ok).toBe(false)

    // Release caller 1
    resolveFn()
    await p1

    // Caller 3 should get the slot (not stuck behind caller 2's ghost)
    const r3 = await p3
    expect(r3.ok).toBe(true)
    if (r3.ok) expect(r3.value).toBe('done')
  })
})

// ─── BUG-D33: Circuit breaker counts signal aborts as failures ──────────────

describe('BUG-D33: circuit breaker counts aborts as failures', () => {
  it('signal abort does not increment failure count', async () => {
    const key = 'd33-cb-abort:test'

    // Call 1: caller aborts mid-operation
    const controller1 = new AbortController()
    const p1 = act(key, async (signal) => {
      // Wait for abort
      return new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }, {
      circuitBreaker: { threshold: 3, cooldownMs: 10_000 },
      signal: controller1.signal,
    })
    setTimeout(() => controller1.abort(new Error('user-cancelled')), 20)
    const r1 = await p1
    expect(r1.ok).toBe(false)

    // Call 2: should succeed — breaker should NOT have counted the abort as failure
    const r2 = await act(key, async () => 'success', {
      circuitBreaker: { threshold: 3, cooldownMs: 10_000 },
    })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.value).toBe('success')
  })
})

// ─── BUG-D34: act.ts sanitizeErrorMessage doesn't sanitize ──────────────────

describe('BUG-D34: health check stores unsanitized error messages', () => {
  it('recordError stores sanitized message (HTML escaped)', async () => {
    const { createHealthCheck } = await import('../index.js')
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)
    const health = createHealthCheck(store)

    // Throw error with HTML in message
    await scopedAct('d34-sanitize:test', async () => {
      throw new Error('<script>alert(1)</script>')
    })

    const status = health()
    expect(status.lastError).toBeDefined()
    // After fix: message should be HTML-escaped
    expect(status.lastError!.message).not.toContain('<script>')
    expect(status.lastError!.message).toContain('&lt;script&gt;')
    store.destroy()
  })
})
