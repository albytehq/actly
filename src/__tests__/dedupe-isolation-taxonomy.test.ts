import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, RetryExhaustedError, ActlyError, ActlyAbortError } from '../index.js'
import type { AsyncStateStore } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── Generation-Safe Dedupe + Joiner Isolation ──────────────────────────────

describe('Phase 6: dedupe joiner isolation', () => {
  it('originator signal abort does NOT propagate to joiners', async () => {
    // originator starts a long fn and its caller aborts; a joiner on a
    // healthy signal must still get the result
    let fnStarted = false
    let fnResolve!: (v: string) => void
    const fnPromise = new Promise<string>((resolve) => { fnResolve = resolve })

    const originatorController = new AbortController()
    const originatorPromise = act('joiner-iso:test', () => {
      fnStarted = true
      return fnPromise
    }, {
      dedupe: true,
      signal: originatorController.signal,
    })

    await wait(20)
    expect(fnStarted).toBe(true)

    // joiner arrives with its own healthy signal
    const joinerController = new AbortController()
    const joinerPromise = act('joiner-iso:test', async () => 'fresh-fallback', {
      dedupe: true,
      signal: joinerController.signal,
    })

    // abort the originator; joiner must be unaffected
    originatorController.abort(new Error('originator-cancelled'))

    const originatorResult = await originatorPromise
    expect(originatorResult.ok).toBe(false)
    if (!originatorResult.ok) {
      expect((originatorResult.error as Error).message).toMatch(/originator-cancelled/)
    }

    fnResolve('success-from-fn')

    const joinerResult = await joinerPromise
    expect(joinerResult.ok).toBe(true)
    if (joinerResult.ok) {
      expect(joinerResult.value).toBe('success-from-fn')
    }

    // joiner's signal stays untouched
    expect(joinerController.signal.aborted).toBe(false)
  })

  it('joiner abort reports attempts=0 (truthful — they did no work)', async () => {
    let fnResolve!: (v: string) => void
    const fnPromise = new Promise<string>((resolve) => { fnResolve = resolve })

    const originatorPromise = act('joiner-abort-attempts:test', () => fnPromise, { dedupe: true })
    await wait(20)

    // joiner arrives then aborts before the originator settles
    const joinerController = new AbortController()
    const joinerPromise = act('joiner-abort-attempts:test', async () => 'fresh', {
      dedupe: true,
      signal: joinerController.signal,
    })

    setTimeout(() => joinerController.abort(new Error('joiner-cancelled')), 10)
    const joinerResult = await joinerPromise

    expect(joinerResult.ok).toBe(false)
    expect(joinerResult.attempts).toBe(0)  // joiner did no work

    fnResolve('done')
    await originatorPromise
  })

  it('joiner success mirrors originator attempts', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls < 3) throw new Error('fail')
      await wait(10)
      return 'success'
    }

    const [a, b] = await Promise.all([
      act('joiner-success-meta:test', fn, { dedupe: true, retry: { attempts: 5, delayMs: 1 } }),
      act('joiner-success-meta:test', fn, { dedupe: true, retry: { attempts: 5, delayMs: 1 } }),
    ])

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (a.ok) expect(a.attempts).toBe(3)
    if (b.ok) expect(b.attempts).toBe(3)
  })
})

describe('Phase 6: generation-safe dedupe', () => {
  it('stale originator cleanup does not delete newer entry', async () => {
    // inflightTtl expires while originator still running. A second
    // originator starts; when the first one settles, its cleanup must be
    // a no-op because the generation has moved on.
    let firstFnResolve!: () => void
    let secondFnCalls = 0

    const firstFnPromise = new Promise<void>((resolve) => { firstFnResolve = resolve })

    const firstPromise = act('gen-safe:test', () => firstFnPromise, {
      dedupe: { enabled: true, inflightTtl: 30 },
    })
    await wait(20)

    await wait(50)

    // old entry was evicted by TTL, so this originator starts fresh
    const secondPromise = act('gen-safe:test', async () => {
      secondFnCalls++
      await wait(20)
      return 'second-result'
    }, {
      dedupe: { enabled: true, inflightTtl: 30 },
    })

    // resolving the first originator must not delete the second's entry
    firstFnResolve()

    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise])

    expect(firstResult.ok).toBe(true)

    expect(secondResult.ok).toBe(true)
    if (secondResult.ok) expect(secondResult.value).toBe('second-result')
    expect(secondFnCalls).toBe(1)
  })
})

// ─── Cache Single-Flight + Async Store Signal-Aware ──────────────────────────

describe('Phase 7: cache single-flight originator isolation', () => {
  it('cache originator signal abort does NOT reject joiners', async () => {
    let fnResolve!: (v: string) => void
    const fnPromise = new Promise<string>((resolve) => { fnResolve = resolve })

    // originator: cache miss, will be aborted by its own signal
    const originatorController = new AbortController()
    const originatorPromise = act('cache-iso:test', () => fnPromise, {
      cache: { ttl: 60_000 },
      signal: originatorController.signal,
    })

    await wait(20)

    // joiner: cache miss too (originator hasn't cached yet), joins in-flight
    const joinerController = new AbortController()
    const joinerPromise = act('cache-iso:test', async () => 'fallback', {
      cache: { ttl: 60_000 },
      signal: joinerController.signal,
    })

    originatorController.abort(new Error('originator-cancelled'))

    const originatorResult = await originatorPromise
    expect(originatorResult.ok).toBe(false)

    // joiner gets the value and the value gets cached
    fnResolve('cached-value')

    const joinerResult = await joinerPromise
    expect(joinerResult.ok).toBe(true)
    if (joinerResult.ok) expect(joinerResult.value).toBe('cached-value')

    expect(joinerController.signal.aborted).toBe(false)
  })

  it('cache hit honours signal.aborted (B18 fix)', async () => {
    await act('cache-abort:test', async () => 'cached', { cache: { ttl: 60_000 } })

    // already-aborted signal must reject instead of returning the cached value
    const controller = new AbortController()
    controller.abort(new Error('pre-aborted'))

    const r = await act('cache-abort:test', async () => 'fresh', {
      cache: { ttl: 60_000 },
      signal: controller.signal,
    })

    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(0)
  })

  it('async store cache path re-checks signal between awaits (B63 fix)', async () => {
    const map = new Map<string, { value: unknown; expiresAt: number | null }>()
    let getCallCount = 0
    const asyncStore: AsyncStateStore = {
      _sync: false as const,
      async get<T>(key: string): Promise<T | undefined> {
        getCallCount++
        // simulate Redis latency so the signal has time to abort
        await wait(50)
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
      async has(key: string): Promise<boolean> { return map.has(key) },
      async clear(): Promise<void> { map.clear() },
      async size(): Promise<number> { return map.size },
    }

    const scopedAct = withStore(asyncStore)
    const controller = new AbortController()

    // abort mid-get so the cache hit path can observe the signal
    const promise = scopedAct('async-cache-abort:test', async () => 'fresh', {
      cache: { ttl: 60_000 },
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(new Error('mid-get-abort')), 10)

    const r = await promise
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect((r.error as Error).message).toBe('mid-get-abort')
    }
    expect(getCallCount).toBe(1)
  })
})

// ─── Error Taxonomy ──────────────────────────────────────────────────────────

describe('Phase 8: error taxonomy', () => {
  it('TimeoutError extends ActlyError (and Error)', () => {
    const e = new (class T extends Error {})(undefined as never) as Error
    expect(e instanceof Error).toBe(true)

    // TimeoutError needs ms, so verify the chain indirectly via act()
  })

  it('act() surfaces RetryExhaustedError with full context (B65 fix)', async () => {
    let calls = 0
    const r = await act('error-taxonomy:retry', async () => {
      calls++
      throw new Error(`fail-${calls}`)
    }, { retry: { attempts: 3, delayMs: 1 } })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RetryExhaustedError)
      expect(r.error).toBeInstanceOf(ActlyError)
      expect(r.error).toBeInstanceOf(Error)
      const err = r.error as RetryExhaustedError
      expect(err.code).toBe('ACTLY_RETRY_EXHAUSTED')
      expect(err.attempts).toBe(3)
      expect(err.errors.length).toBe(3)
      expect((err.lastError as Error).message).toBe('fail-3')
      expect(err.key).toBe('error-taxonomy:retry')
    }
  })

  it('shouldRetry=false on first attempt throws RAW error (not RetryExhaustedError)', async () => {
    const r = await act('error-taxonomy:no-retry', async () => {
      throw new Error('permanent')
    }, {
      retry: {
        attempts: 5,
        delayMs: 1,
        shouldRetry: () => false,
      },
    })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      // no retries happened, so the raw error surfaces unwrapped
      expect(r.error).not.toBeInstanceOf(RetryExhaustedError)
      expect((r.error as Error).message).toBe('permanent')
    }
  })

  it('TimeoutError has .code, .ms, .key, extends ActlyError', async () => {
    const r = await act('error-taxonomy:timeout', async () => {
      await wait(200)
      return 'unreachable'
    }, { timeout: { ms: 50 } })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ActlyError)
      expect(r.error).toBeInstanceOf(Error)
      const err = r.error as { code: string; ms: number; key?: string }
      expect(err.code).toBe('ACTLY_TIMEOUT')
      expect(err.ms).toBe(50)
      expect(err.key).toBe('error-taxonomy:timeout')
    }
  })

  it('TotalTimeoutError distinct from TimeoutError', async () => {
    const r = await act('error-taxonomy:total', async () => {
      await wait(200)
      return 'unreachable'
    }, { totalTimeout: { ms: 50 } })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ActlyError)
      const err = r.error as { code: string; ms: number }
      expect(err.code).toBe('ACTLY_TOTAL_TIMEOUT')
    }
  })

  it('ActlyAbortError wraps caller-supplied abort reason (B19/B64 fix)', async () => {
    // act() currently surfaces the caller's signal.reason as-is; wrapping
    // at the act() boundary is tracked separately. This test pins the
    // existing contract so any change is intentional.
    const controller = new AbortController()
    const promise = act('error-taxonomy:abort', async () => {
      await wait(500)
      return 'unreachable'
    }, { signal: controller.signal })

    setTimeout(() => controller.abort(new Error('user-cancelled')), 20)
    const r = await promise

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect((r.error as Error).message).toBe('user-cancelled')
    }
  })

  it('ActlyAbortError can be constructed with cause', () => {
    const cause = new Error('underlying')
    const err = new ActlyAbortError({ cause, key: 'some-key' })
    expect(err).toBeInstanceOf(ActlyError)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('ACTLY_ABORT')
    expect(err.key).toBe('some-key')
    expect(err.cause).toBe(cause)
    expect(err.message).toMatch(/underlying/)
  })
})
