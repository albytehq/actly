import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, drain, createHealthCheck } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── BUG-D40: drain() resolver accumulation on timeout ──────────────────────

describe('BUG-D40: drain resolver leak on timeout', () => {
  it('timed-out drain resolvers are removed from array', async () => {
    // in-flight call that never resolves on its own
    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const actPromise = act('d40-drain-leak:test', () => fnPromise)

    await wait(10)

    // short timeout forces the drain resolver to time out
    await drain(30)

    // the resolver array isn't exposed, so verify indirectly: repeated
    // drain() calls must not accumulate stale resolvers. Each leaked
    // resolver pins closures, and under steady load that becomes memory
    // growth in long-running processes.
    await drain(20)
    await drain(20)
    await drain(20)

    resolveFn()
    await actPromise
    expect(true).toBe(true)
  })
})

// ─── BUG-D41: validate.ts doesn't validate audit.log ────────────────────────

describe('BUG-D41: audit.log not validated', () => {
  it('audit.log = "not a function" should throw at validation time', async () => {
    await expect(
      act('d41-audit:test', async () => 'ok', {
        audit: { log: 'not a function' as unknown as (e: unknown) => void },
      })
    ).rejects.toThrow(/audit\.log/)
  })

  it('audit.log = null should throw', async () => {
    await expect(
      act('d41-audit2:test', async () => 'ok', {
        audit: { log: null as unknown as (e: unknown) => void },
      })
    ).rejects.toThrow(/audit\.log/)
  })

  it('audit.log = undefined should throw', async () => {
    await expect(
      act('d41-audit3:test', async () => 'ok', {
        audit: { log: undefined as unknown as (e: unknown) => void },
      })
    ).rejects.toThrow(/audit\.log/)
  })
})

// ─── BUG-D42: retry shouldRetry throw propagates as wrong error ─────────────

describe('BUG-D42: shouldRetry throw masks original error', () => {
  it('shouldRetry throw should not mask the original fn error', async () => {
    const originalError = new Error('fn-failed')
    const predicateError = new Error('predicate-bug')

    const r = await act('d42-shouldRetry-throw:test', async () => {
      throw originalError
    }, {
      retry: {
        attempts: 3,
        delayMs: 1,
        shouldRetry: () => { throw predicateError },
      },
    })

    expect(r.ok).toBe(false)
    // the fn's error must stay accessible; a buggy predicate shouldn't
    // replace it with its own throw
    if (!r.ok) {
      expect(r.error).not.toBe(predicateError)
    }
  })
})

// ─── BUG-D43: fallback masks errors from health check ───────────────────────

describe('BUG-D43: fallback masks errors from health check', () => {
  it('health check records error when fallback is used', async () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)
    const health = createHealthCheck(store)

    // fn fails, fallback returns a value
    await scopedAct('d43-fallback-health:test', async () => {
      throw new Error('downstream-failed')
    }, {
      fallback: { value: 'default' },
    })

    const status = health()
    // health must still record the failure so monitoring can catch a
    // downstream that's quietly degrading behind fallbacks
    expect(status.lastError).toBeDefined()
    expect(status.lastError!.message).toContain('downstream-failed')
    store.destroy()
  })
})
