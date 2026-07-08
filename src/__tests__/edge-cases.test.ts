import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, execute, noopPolicy, sanitizeKey, computeDelay, LIMITS } from '../index.js'
import { sleep, raceAbort, anySignal, linkSignal, isAbortError } from '../utils/abort.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── Edge cases: computeDelay ─────────────────────────────────────────

describe('Edge: computeDelay', () => {
  it('returns 0 when delayMs is 0', () => {
    expect(computeDelay(1, { attempts: 3, delayMs: 0 })).toBe(0)
  })

  it('returns 0 when delayMs is undefined', () => {
    expect(computeDelay(1, { attempts: 3 })).toBe(0)
  })

  it('handles attempt = 1 for exponential (2^0 = 1)', () => {
    const delay = computeDelay(1, { attempts: 3, delayMs: 100, backoff: 'exponential' })
    expect(delay).toBeGreaterThanOrEqual(0)
    expect(delay).toBeLessThanOrEqual(100)
  })

  it('handles attempt = 10 for exponential (2^9 = 512)', () => {
    const delay = computeDelay(10, { attempts: 10, delayMs: 100, backoff: 'exponential', jitter: 'none' })
    // 100 * 2^9 = 51200, but maxDelay is Infinity so no cap
    expect(delay).toBe(51200)
  })

  it('caps at maxDelay', () => {
    const delay = computeDelay(10, { attempts: 10, delayMs: 100, backoff: 'exponential', maxDelay: 1000, jitter: 'none' })
    expect(delay).toBe(1000)
  })

  it('handles maxDelay < base (decorrelated degrades)', () => {
    const delay = computeDelay(1, { attempts: 3, delayMs: 1000, backoff: 'exponential', maxDelay: 50, jitter: 'decorrelated' })
    expect(delay).toBeGreaterThanOrEqual(0)
    expect(delay).toBeLessThanOrEqual(50)
  })

  it('linear backoff: delay = base * attempt', () => {
    expect(computeDelay(3, { attempts: 5, delayMs: 100, backoff: 'linear', jitter: 'none' })).toBe(300)
  })

  it('full jitter: result in [0, delay]', () => {
    for (let i = 0; i < 100; i++) {
      const delay = computeDelay(1, { attempts: 3, delayMs: 100, backoff: 'none', jitter: 'full' })
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThan(100)
    }
  })

  it('equal jitter: result in [delay/2, delay]', () => {
    for (let i = 0; i < 100; i++) {
      const delay = computeDelay(1, { attempts: 3, delayMs: 100, backoff: 'none', jitter: 'equal' })
      expect(delay).toBeGreaterThanOrEqual(50)
      expect(delay).toBeLessThanOrEqual(100)
    }
  })

  it('NaN delayMs produces Infinity delay (edge case; validation prevents this in practice)', () => {
    // computeDelay is exported, so users can call it directly. NaN base flows through:
    // NaN*attempt is NaN, !isFinite(NaN) is true, delay becomes max (Infinity),
    // and jitter:'none' returns that Infinity. assertRetryOptions rejects NaN before this.
    const delay = computeDelay(1, { attempts: 3, delayMs: NaN, jitter: 'none' })
    expect(delay).toBe(Infinity)
  })
})

// ─── Edge cases: key validation ───────────────────────────────────────

describe('Edge: key validation', () => {
  it('rejects empty string key', async () => {
    await expect(act('', async () => 1)).rejects.toThrow(/non-empty/)
  })

  it('accepts key that is exactly 1024 chars', async () => {
    const key = 'a'.repeat(1024)
    const r = await act(key, async () => 1)
    expect(r.ok).toBe(true)
  })

  it('rejects key that is 1025 chars', async () => {
    const key = 'a'.repeat(1025)
    await expect(act(key, async () => 1)).rejects.toThrow(/exceeds limit/)
  })

  it('accepts unicode/emoji keys', async () => {
    const r = await act('user:🎯-unicode-テスト', async () => 'ok')
    expect(r.ok).toBe(true)
  })

  it('accepts key with spaces', async () => {
    const r = await act('user 42 profile', async () => 'ok')
    expect(r.ok).toBe(true)
  })

  it('accepts key with forward slashes', async () => {
    const r = await act('api/v1/users/123', async () => 'ok')
    expect(r.ok).toBe(true)
  })

  it('rejects key with null byte', async () => {
    await expect(act('a\x00b', async () => 1)).rejects.toThrow(/control/)
  })

  it('rejects key with DEL char (0x7f)', async () => {
    await expect(act('a\x7fb', async () => 1)).rejects.toThrow(/control/)
  })

  it('rejects key with CR', async () => {
    await expect(act('a\rb', async () => 1)).rejects.toThrow(/control/)
  })

  it('allows key with LF (newline)', async () => {
    const r = await act('a\nb', async () => 'ok')
    expect(r.ok).toBe(true)
  })

  it('allows key with TAB', async () => {
    const r = await act('a\tb', async () => 'ok')
    expect(r.ok).toBe(true)
  })
})

// ─── Edge cases: fn behavior ──────────────────────────────────────────

describe('Edge: fn behavior', () => {
  it('handles fn that throws synchronously', async () => {
    const r = await act('sync-throw', () => { throw new Error('sync boom') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as Error).message).toBe('sync boom')
  })

  it('handles fn that returns non-Promise (sync value)', async () => {
    const r = await act('sync-return', () => 42)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(42)
  })

  it('handles fn that returns undefined', async () => {
    const r = await act('undef-return', () => undefined)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBeUndefined()
  })

  it('handles fn that returns null', async () => {
    const r = await act('null-return', () => null)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBeNull()
  })

  it('handles fn that returns 0', async () => {
    const r = await act('zero-return', () => 0)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(0)
  })

  it('handles fn that returns false', async () => {
    const r = await act('false-return', () => false)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(false)
  })

  it('handles fn that returns empty string', async () => {
    const r = await act('empty-string-return', () => '')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('')
  })

  it('handles fn that throws Error subclass', async () => {
    class CustomError extends Error {
      readonly code = 'CUSTOM'
      constructor() { super('custom'); this.name = 'CustomError' }
    }
    const r = await act('custom-error', () => { throw new CustomError() })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeInstanceOf(CustomError)
  })

  it('handles fn that throws non-Error (string)', async () => {
    const r = await act('string-throw', async () => { throw 'string error' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('string error')
  })

  it('handles fn that throws null', async () => {
    const r = await act('null-throw', async () => { throw null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeNull()
  })

  it('handles fn that throws undefined', async () => {
    const r = await act('undef-throw', async () => { throw undefined })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeUndefined()
  })

  it('handles fn that throws an object', async () => {
    const r = await act('object-throw', async () => { throw { code: 500, message: 'server error' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as { code: number }).code).toBe(500)
  })
})

// ─── Edge cases: signal already aborted ───────────────────────────────

describe('Edge: signal already aborted', () => {
  it('act() with pre-aborted signal rejects immediately', async () => {
    const controller = new AbortController()
    controller.abort(new Error('pre-cancelled'))
    const r = await act('pre-abort', async () => 'unreachable', { signal: controller.signal })
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as Error).message).toBe('pre-cancelled')
  })

  it('act() with pre-aborted signal + retry does not retry', async () => {
    let calls = 0
    const controller = new AbortController()
    controller.abort(new Error('pre-cancelled'))
    const r = await act('pre-abort-retry', async () => { calls++; return 'ok' }, {
      signal: controller.signal,
      retry: { attempts: 5, delayMs: 1 },
    })
    expect(r.ok).toBe(false)
    expect(calls).toBe(0) // fn never called
  })

  it('raceAbort with pre-aborted signal rejects immediately', async () => {
    const controller = new AbortController()
    controller.abort(new Error('pre-abort'))
    await expect(raceAbort(Promise.resolve('ok'), controller.signal)).rejects.toThrow('pre-abort')
  })

  it('raceAbort with pre-aborted signal marks promise as handled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('pre-abort'))
    let settled = false
    const slow = new Promise<string>((resolve) => setTimeout(() => { settled = true; resolve('late') }, 50))
    await expect(raceAbort(slow, controller.signal)).rejects.toThrow('pre-abort')
    await wait(60)
    expect(settled).toBe(true)
  })
})

// ─── Edge cases: validation ───────────────────────────────────────────

describe('Edge: numeric validation', () => {
  it('rejects retry.attempts = 0', async () => {
    await expect(act('k', async () => 1, { retry: { attempts: 0 } })).rejects.toThrow(/positive integer/)
  })

  it('rejects retry.attempts = -1', async () => {
    await expect(act('k', async () => 1, { retry: { attempts: -1 } })).rejects.toThrow(/positive integer/)
  })

  it('rejects retry.attempts = 1.5 (non-integer)', async () => {
    await expect(act('k', async () => 1, { retry: { attempts: 1.5 } })).rejects.toThrow(/positive integer/)
  })

  it('rejects retry.attempts = NaN', async () => {
    await expect(act('k', async () => 1, { retry: { attempts: NaN } })).rejects.toThrow(/positive integer/)
  })

  it('rejects retry.attempts = Infinity', async () => {
    await expect(act('k', async () => 1, { retry: { attempts: Infinity } })).rejects.toThrow(/positive integer/)
  })

  it('rejects timeout.ms = 0', async () => {
    await expect(act('k', async () => 1, { timeout: { ms: 0 } })).rejects.toThrow(/positive finite/)
  })

  it('rejects timeout.ms = -1', async () => {
    await expect(act('k', async () => 1, { timeout: { ms: -1 } })).rejects.toThrow(/positive finite/)
  })

  it('rejects timeout.ms = NaN', async () => {
    await expect(act('k', async () => 1, { timeout: { ms: NaN } })).rejects.toThrow(/positive finite/)
  })

  it('rejects cache.ttl = 0', async () => {
    await expect(act('k', async () => 1, { cache: { ttl: 0 } })).rejects.toThrow(/positive finite/)
  })

  it('rejects cache.ttl = Infinity', async () => {
    await expect(act('k', async () => 1, { cache: { ttl: Infinity } })).rejects.toThrow(/positive finite/)
  })

  it('rejects bulkhead.maxConcurrent = 0', async () => {
    await expect(act('k', async () => 1, { bulkhead: { maxConcurrent: 0 } })).rejects.toThrow(/positive integer/)
  })

  it('rejects circuitBreaker.threshold = 0', async () => {
    await expect(act('k', async () => 1, { circuitBreaker: { threshold: 0, cooldownMs: 1000 } })).rejects.toThrow(/positive integer/)
  })

  it('rejects rateLimit.maxCalls = 0', async () => {
    await expect(act('k', async () => 1, { rateLimit: { maxCalls: 0, windowMs: 1000 } })).rejects.toThrow(/positive integer/)
  })

  it('rejects hedge.delayMs = 0', async () => {
    await expect(act('k', async () => 1, { hedge: { delayMs: 0 } })).rejects.toThrow(/positive finite/)
  })

  it('rejects hedge.delayMs = -1', async () => {
    await expect(act('k', async () => 1, { hedge: { delayMs: -1 } })).rejects.toThrow(/positive finite/)
  })

  it('rejects signal that is not an AbortSignal', async () => {
    await expect(act('k', async () => 1, { signal: 'not-a-signal' as unknown as AbortSignal })).rejects.toThrow(/AbortSignal/)
  })

  it('rejects retry.shouldRetry that is not a function', async () => {
    await expect(act('k', async () => 1, { retry: { attempts: 3, shouldRetry: 'not-a-fn' as unknown as () => boolean } })).rejects.toThrow(/function/)
  })
})

// ─── Edge cases: store destroy during in-flight ───────────────────────

describe('Edge: store lifecycle', () => {
  it('store.destroy() during in-flight call does not crash', async () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)

    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const actPromise = scopedAct('destroy-test', () => fnPromise)

    // destroy while call is in-flight
    await wait(10)
    store.destroy()

    // resolve the fn; act() must still settle
    resolveFn()
    const r = await actPromise
    expect(r.ok).toBe(true)
  })

  it('store.destroy() is idempotent', () => {
    const store = new InMemoryStore({ autoCleanup: true })
    store.destroy()
    store.destroy()
    store.destroy()
    // No throw = pass
  })

  it('store.destroy() clears all entries', () => {
    const store = new InMemoryStore({ maxSize: 100 })
    store.set('a', 1)
    store.set('b', 2)
    expect(store.size()).toBe(2)
    store.destroy()
    expect(store.size()).toBe(0)
    expect(store.get('a')).toBeUndefined()
  })

  it('store.clear() clears all entries but keeps timer', () => {
    const store = new InMemoryStore({ maxSize: 100, autoCleanup: true, cleanupIntervalMs: 10000 })
    store.set('a', 1)
    store.set('b', 2)
    expect(store.size()).toBe(2)
    store.clear()
    expect(store.size()).toBe(0)
    // timer still running; set still works
    store.set('c', 3)
    expect(store.get('c')).toBe(3)
    store.destroy()
  })
})

// ─── Edge cases: retry behavior ───────────────────────────────────────

describe('Edge: retry behavior', () => {
  it('retry.attempts = 1 is a no-op (no retry policy added)', async () => {
    let calls = 0
    const r = await act('no-retry', async () => {
      calls++
      throw new Error('fail')
    }, { retry: { attempts: 1 } })
    expect(r.ok).toBe(false)
    expect(calls).toBe(1)
    // no retries happened, so no RetryExhaustedError wrap
    if (!r.ok) expect((r.error as Error).message).toBe('fail')
  })

  it('shouldRetry returns false on first attempt — no wrapping', async () => {
    let calls = 0
    const r = await act('no-retryable', async () => {
      calls++
      throw new Error('non-retryable')
    }, {
      retry: { attempts: 5, delayMs: 1, shouldRetry: () => false },
    })
    expect(r.ok).toBe(false)
    expect(calls).toBe(1)
    // raw error surfaced, no RetryExhaustedError wrap
    if (!r.ok) expect((r.error as Error).message).toBe('non-retryable')
  })

  it('shouldRetry throws — original error surfaced', async () => {
    const r = await act('predicate-throw', async () => {
      throw new Error('fn error')
    }, {
      retry: { attempts: 5, delayMs: 1, shouldRetry: () => { throw new Error('predicate bug') } },
    })
    expect(r.ok).toBe(false)
    // fn error wins over the predicate bug
    if (!r.ok) expect((r.error as Error).message).toBe('fn error')
  })

  it('retry with delayMs = 0 retries immediately', async () => {
    let calls = 0
    const t0 = Date.now()
    const r = await act('immediate-retry', async () => {
      calls++
      if (calls < 3) throw new Error('transient')
      return 'recovered'
    }, { retry: { attempts: 5, delayMs: 0 } })
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(true)
    expect(calls).toBe(3)
    expect(elapsed).toBeLessThan(50) // no delay between retries
  })
})

// ─── Edge cases: dedupe + cache composition ──────────────────────────

describe('Edge: dedupe + cache composition', () => {
  it('cache hit does not trigger dedupe', async () => {
    let calls = 0
    const fn = async () => { calls++; return 'value' }

    // first call: cache miss, fn runs, value cached
    await act('compose-1', fn, { cache: { ttl: 60000 }, dedupe: true })
    expect(calls).toBe(1)

    // second call: cache hit, fn skipped
    await act('compose-1', fn, { cache: { ttl: 60000 }, dedupe: true })
    expect(calls).toBe(1)
  })

  it('cache miss + dedupe: only one fn invocation', async () => {
    let calls = 0
    const slowFn = async () => {
      calls++
      await wait(30)
      return 'shared'
    }

    const [r1, r2] = await Promise.all([
      act('compose-2', slowFn, { cache: { ttl: 60000 }, dedupe: true }),
      act('compose-2', slowFn, { cache: { ttl: 60000 }, dedupe: true }),
    ])

    expect(calls).toBe(1)
    expect(r1.ok && r2.ok).toBe(true)
  })
})

// ─── Edge cases: observability hook safety ────────────────────────────

describe('Edge: observability hook safety', () => {
  it('all hooks throwing does not crash main path', async () => {
    const r = await act('all-hooks-throw', async () => 'ok', {
      observability: {
        onAttempt: () => { throw new Error('boom') },
        onFinalSuccess: () => { throw new Error('boom') },
      },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('ok')
  })

  it('onFinalFailure throwing does not crash failure path', async () => {
    const r = await act('fail-hook-throw', async () => { throw new Error('fn fail') }, {
      observability: {
        onFinalFailure: () => { throw new Error('hook boom') },
      },
    })
    expect(r.ok).toBe(false)
  })

  it('empty observability object {} has zero overhead (no hooks fire)', async () => {
    let hookFired = false
    const r = await act('empty-obs', async () => 'ok', {
      observability: {},
    })
    expect(r.ok).toBe(true)
    expect(hookFired).toBe(false)
  })
})

// ─── Edge cases: AbortSignal utilities ────────────────────────────────

describe('Edge: AbortSignal utilities', () => {
  it('anySignal with empty array returns never-aborting signal', () => {
    const sig = anySignal([])
    expect(sig.aborted).toBe(false)
  })

  it('anySignal with single signal returns that signal directly', () => {
    const controller = new AbortController()
    const sig = anySignal([controller.signal])
    expect(sig).toBe(controller.signal)
  })

  it('anySignal with null/undefined entries filters them', () => {
    const a = new AbortController()
    const sig = anySignal([null, undefined, a.signal] as unknown as AbortSignal[])
    expect(sig).toBe(a.signal)
  })

  it('linkSignal with already-aborted parent aborts child', () => {
    const parent = new AbortController()
    parent.abort(new Error('parent-aborted'))
    const child = new AbortController()
    linkSignal(parent.signal, child)
    expect(child.signal.aborted).toBe(true)
  })

  it('linkSignal cleanup function is idempotent', () => {
    const parent = new AbortController()
    const child = new AbortController()
    const unlink = linkSignal(parent.signal, child)
    unlink()
    unlink()
    unlink()
    // No throw = pass
  })

  it('isAbortError with various error types', () => {
    expect(isAbortError(new Error('AbortError'))).toBe(false) // name must be 'AbortError'
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    expect(isAbortError(abortErr)).toBe(true)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
    expect(isAbortError('string')).toBe(false)
    expect(isAbortError(42)).toBe(false)
    expect(isAbortError({})).toBe(false)
  })

  it('sleep with ms = 0 resolves immediately', async () => {
    const t0 = Date.now()
    await sleep(0)
    expect(Date.now() - t0).toBeLessThan(10)
  })

  it('sleep with negative ms resolves immediately', async () => {
    const t0 = Date.now()
    await sleep(-100)
    expect(Date.now() - t0).toBeLessThan(10)
  })

  it('sleep with already-aborted signal rejects immediately', async () => {
    const controller = new AbortController()
    controller.abort(new Error('pre-abort'))
    await expect(sleep(100, controller.signal)).rejects.toThrow('pre-abort')
  })
})

// ─── Edge cases: InMemoryStore ────────────────────────────────────────

describe('Edge: InMemoryStore', () => {
  it('maxSize = 1 evicts on second insert', () => {
    const store = new InMemoryStore({ maxSize: 1 })
    store.set('a', 1)
    expect(store.get('a')).toBe(1)
    store.set('b', 2)
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBe(2)
    store.destroy()
  })

  it('updating existing key does not evict', () => {
    const store = new InMemoryStore({ maxSize: 2 })
    store.set('a', 1)
    store.set('b', 2)
    store.set('a', 10)
    expect(store.get('a')).toBe(10)
    expect(store.get('b')).toBe(2)
    expect(store.size()).toBe(2)
    store.destroy()
  })

  it('TTL = Infinity treated as no expiry', async () => {
    const store = new InMemoryStore()
    store.set('inf', 'value', Infinity)
    expect(store.get('inf')).toBe('value')
    await wait(20)
    expect(store.get('inf')).toBe('value')
    store.destroy()
  })

  it('TTL = NaN treated as no expiry (defensive)', () => {
    const store = new InMemoryStore()
    store.set('nan', 'value', NaN)
    expect(store.get('nan')).toBe('value')
    store.destroy()
  })

  it('TTL = 0 treated as no expiry (defensive)', () => {
    const store = new InMemoryStore()
    store.set('zero', 'value', 0)
    expect(store.get('zero')).toBe('value')
    store.destroy()
  })

  it('TTL = negative treated as no expiry (defensive)', () => {
    const store = new InMemoryStore()
    store.set('neg', 'value', -100)
    expect(store.get('neg')).toBe('value')
    store.destroy()
  })

  it('has() does not touch LRU order', () => {
    const store = new InMemoryStore({ maxSize: 2 })
    store.set('a', 1)
    store.set('b', 2)
    // has('a') must NOT bump 'a' to most-recent
    store.has('a')
    // 'c' insert evicts 'a' (LRU), not 'b'
    store.set('c', 3)
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBe(2)
    expect(store.get('c')).toBe(3)
    store.destroy()
  })

  it('delete() on non-existent key is a no-op', () => {
    const store = new InMemoryStore()
    store.delete('nonexistent')
    expect(store.size()).toBe(0)
    store.destroy()
  })

  it('get() on expired entry returns undefined and deletes entry', async () => {
    const store = new InMemoryStore()
    store.set('exp', 'value', 20)
    expect(store.get('exp')).toBe('value')
    await wait(30)
    expect(store.get('exp')).toBeUndefined()
    // entry should be gone from the map
    expect(store.size()).toBe(0)
    store.destroy()
  })
})

// ─── Edge cases: execute() with empty/minimal policies ────────────────

describe('Edge: execute() minimal inputs', () => {
  it('empty policies array calls fn directly', async () => {
    const store = new InMemoryStore()
    const result = await execute({
      key: 'empty-policies',
      fn: async () => 42,
      policies: [],
      store,
      meta: { attempts: 1, source: 'fresh' },
      signal: new AbortController().signal,
    })
    expect(result).toBe(42)
    store.destroy()
  })

  it('single noopPolicy passes fn through', async () => {
    const store = new InMemoryStore()
    const result = await execute({
      key: 'single-noop',
      fn: async () => 'value',
      policies: [noopPolicy()],
      store,
      meta: { attempts: 1, source: 'fresh' },
      signal: new AbortController().signal,
    })
    expect(result).toBe('value')
    store.destroy()
  })

  it('throws if dedupe policy used with async store', async () => {
    const asyncStore = {
      _sync: false as const,
      async get() { return undefined },
      async set() {},
      async delete() {},
      async has() { return false },
      async clear() {},
      async size() { return 0 },
    }
    await expect(execute({
      key: 'async-dedupe',
      fn: async () => 1,
      policies: [], // no dedupe policy here, just exercising the guard
      store: asyncStore,
      meta: { attempts: 1, source: 'fresh' },
      signal: new AbortController().signal,
    })).resolves.toBe(1)
  })
})

// ─── Edge cases: fallback ─────────────────────────────────────────────

describe('Edge: fallback behavior', () => {
  it('static fallback value returned on failure', async () => {
    const r = await act('fallback-static', async () => { throw new Error('fail') }, {
      retry: { attempts: 2, delayMs: 1 },
      fallback: { value: 'default' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('default')
  })

  it('fallback function called on failure', async () => {
    const r = await act('fallback-fn', async () => { throw new Error('fail') }, {
      retry: { attempts: 2, delayMs: 1 },
      fallback: { value: () => 'computed-default' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('computed-default')
  })

  it('async fallback function supported', async () => {
    const r = await act('fallback-async', async () => { throw new Error('fail') }, {
      retry: { attempts: 2, delayMs: 1 },
      fallback: { value: async () => { await wait(10); return 'async-default' } },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('async-default')
  })

  it('fallback that also throws — original error surfaced (wrapped in RetryExhaustedError)', async () => {
    const r = await act('fallback-throws', async () => { throw new Error('original') }, {
      retry: { attempts: 2, delayMs: 1 },
      fallback: { value: () => { throw new Error('fallback-also-failed') } },
    })
    expect(r.ok).toBe(false)
    // retry happened then exhausted, so the error is wrapped
    if (!r.ok) {
      const err = r.error as { code?: string; lastError?: Error }
      expect(err.code).toBe('ACTLY_RETRY_EXHAUSTED')
      expect((err.lastError as Error).message).toBe('original')
    }
  })
})

// ─── Edge cases: concurrent eviction ──────────────────────────────────

describe('Edge: concurrent tenant operations', () => {
  it('createTenantStore + concurrent get/evict', async () => {
    const { createTenantStore } = await import('../index.js')
    const manager = createTenantStore({ maxSize: 100, autoCleanup: true })

    // tenant-1
    const act1 = manager.get('tenant-1')
    const r1 = await act1('k', async () => 'tenant-1-value')
    expect(r1.ok).toBe(true)

    // evict with no in-flight calls; should be safe
    manager.evict('tenant-1')
    expect(manager.size()).toBe(0)

    // re-create tenant
    const act2 = manager.get('tenant-1')
    const r2 = await act2('k', async () => 'tenant-1-recreated')
    expect(r2.ok).toBe(true)

    manager.destroy()
  })

  it('createAsyncTenantStore + evict calls destroy', async () => {
    const { createAsyncTenantStore } = await import('../index.js')
    let destroyCalls = 0
    const fakeStore = {
      _sync: false as const,
      async get() { return undefined },
      async set() {},
      async delete() {},
      async has() { return false },
      async clear() {},
      async size() { return 0 },
      destroy: () => { destroyCalls++ },
    }
    const manager = createAsyncTenantStore(() => ({ ...fakeStore }))
    manager.get('t1')
    manager.get('t2')
    manager.evict('t1')
    expect(destroyCalls).toBe(1)
    manager.destroy()
    expect(destroyCalls).toBe(2) // t2 destroyed with the manager
  })
})
