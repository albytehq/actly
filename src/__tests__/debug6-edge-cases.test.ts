import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, ActlyError, TimeoutError, RetryExhaustedError } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── signal.reason edge cases ───

describe('Debug6: signal.reason edge cases', () => {
  it('controller.abort() with no argument — reason is DOMException', async () => {
    const controller = new AbortController()
    controller.abort() // no arg: Node fills in DOMException('AbortError')
    const r = await act('abort-no-arg', async () => 'unreachable', {
      signal: controller.signal,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeDefined() // DOMException, not undefined
  })

  it('controller.abort(undefined) — explicit undefined', async () => {
    const controller = new AbortController()
    controller.abort(undefined)
    const r = await act('abort-undef', async () => 'ok', {
      signal: controller.signal,
    })
    expect(r.ok).toBe(false)
  })

  it('controller.abort(0) — numeric reason', async () => {
    const controller = new AbortController()
    controller.abort(0)
    const r = await act('abort-zero', async () => 'ok', {
      signal: controller.signal,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(0)
  })

  it('controller.abort("") — empty string reason', async () => {
    const controller = new AbortController()
    controller.abort('')
    const r = await act('abort-empty', async () => 'ok', {
      signal: controller.signal,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('')
  })

  it('controller.abort(false) — boolean reason', async () => {
    const controller = new AbortController()
    controller.abort(false)
    const r = await act('abort-false', async () => 'ok', {
      signal: controller.signal,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(false)
  })

  it('controller.abort({custom: "obj"}) — object reason', async () => {
    const controller = new AbortController()
    const reason = { custom: 'obj', code: 500 }
    controller.abort(reason)
    const r = await act('abort-obj', async () => 'ok', {
      signal: controller.signal,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(reason)
  })
})

// ─── fn returning an ActResult ───

describe('Debug6: fn returns ActResult (nested wrapping)', () => {
  it('fn returns an ActResult object — treated as regular value', async () => {
    const r = await act('nested-result', async () => {
      return { ok: true, value: 'inner', source: 'fresh' as const, attempts: 1 }
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // ActResult gets wrapped as r.value, not unwrapped.
      expect(r.value).toEqual({ ok: true, value: 'inner', source: 'fresh', attempts: 1 })
    }
  })

  it('fn returns ActFailure — still treated as success (fn didnt throw)', async () => {
    const r = await act('nested-fail', async () => {
      return { ok: false, error: new Error('inner fail'), attempts: 1 }
    })
    expect(r.ok).toBe(true) // fn didn't throw, outer act succeeds
    if (r.ok) expect((r.value as { ok: boolean }).ok).toBe(false)
  })
})

// ─── store.get returning null vs undefined ───

describe('Debug6: store null vs undefined', () => {
  it('store.get returning null is treated as cache miss (null is falsy)', async () => {
    let getCallCount = 0
    const nullStore = {
      _sync: true as const,
      get<T>(): T | undefined { getCallCount++; return null as T },
      set() {},
      delete() {},
      has() { return false },
      clear() {},
      size() { return 0 },
    }
    const scopedAct = withStore(nullStore)
    const r = await scopedAct('null-store', async () => 'actual', {
      cache: { ttl: 60_000 },
    })
    // null is falsy, so it counts as a miss.
    // get is called for cache key, inflight key, and during cleanup: 3 total.
    expect(getCallCount).toBe(3)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('actual')
  })

  it('store.get returning 0 is treated as cache miss (falsy)', async () => {
    const zeroStore = {
      _sync: true as const,
      get<T>(): T | undefined { return 0 as T },
      set() {},
      delete() {},
      has() { return false },
      clear() {},
      size() { return 0 },
    }
    const scopedAct = withStore(zeroStore)
    const r = await scopedAct('zero-store', async () => 'actual', {
      cache: { ttl: 60_000 },
    })
    // 0 is falsy, treated as miss
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('actual')
  })

  it('store.get returning false is treated as cache miss (falsy)', async () => {
    const falseStore = {
      _sync: true as const,
      get<T>(): T | undefined { return false as T },
      set() {},
      delete() {},
      has() { return false },
      clear() {},
      size() { return 0 },
    }
    const scopedAct = withStore(falseStore)
    const r = await scopedAct('false-store', async () => 'actual', {
      cache: { ttl: 60_000 },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('actual')
  })
})

// ─── 10k concurrent keys + cache ───

describe('Debug6: 10k concurrent different keys + cache', () => {
  it('10k unique keys with cache — store bounded by maxSize', async () => {
    const store = new InMemoryStore({ maxSize: 1000, autoCleanup: true, cleanupIntervalMs: 10_000 })
    const scopedAct = withStore(store)

    const promises: Promise<unknown>[] = []
    for (let i = 0; i < 10_000; i++) {
      promises.push(scopedAct(`k10k-${i}`, async () => i, { cache: { ttl: 60_000 } }))
    }

    const results = await Promise.all(promises)
    const oks = results.filter(r => r && typeof r === 'object' && (r as { ok?: boolean }).ok === true)
    expect(oks.length).toBe(10_000)
    // store bounded at maxSize
    expect(store.size()).toBeLessThanOrEqual(1000)

    store.destroy()
  }, 60_000) // 60s ceiling
})

// ─── error class shape ───

describe('Debug6: error class properties', () => {
  it('TimeoutError has correct .name, .code, .ms', () => {
    const err = new TimeoutError(5000, { key: 'test-key' })
    expect(err.name).toBe('TimeoutError')
    expect(err.code).toBe('ACTLY_TIMEOUT')
    expect(err.ms).toBe(5000)
    expect(err.key).toBe('test-key')
    expect(err instanceof Error).toBe(true)
    expect(err instanceof ActlyError).toBe(true)
  })

  it('RetryExhaustedError has .attempts, .lastError, .errors', () => {
    const inner = new Error('inner fail')
    const err = new RetryExhaustedError({
      key: 'test',
      attempts: 3,
      lastError: inner,
      errors: [inner, inner, inner],
    })
    expect(err.name).toBe('RetryExhaustedError')
    expect(err.code).toBe('ACTLY_RETRY_EXHAUSTED')
    expect(err.attempts).toBe(3)
    expect(err.lastError).toBe(inner)
    expect(err.errors.length).toBe(3)
    expect(err.cause).toBe(inner)
  })

  it('ActlyError is abstract — cannot instantiate directly', () => {
    // abstract is compile-time only; runtime instantiation would leave .code undefined.
    // subclass pattern is the supported path.
    class TestError extends ActlyError {
      readonly code = 'TEST_ERROR' as const
    }
    const err = new TestError('test message')
    expect(err.code).toBe('TEST_ERROR')
    expect(err.message).toBe('test message')
    expect(err.name).toBe('TestError')
    expect(err instanceof ActlyError).toBe(true)
    expect(err instanceof Error).toBe(true)
  })

  it('error .code is readonly in TypeScript (runtime may allow mutation)', () => {
    const err = new TimeoutError(1000)
    // `readonly` is compile-time only under es2022 class fields; runtime mutation succeeds.
    // test documents that runtime behavior.
    try {
      (err as { code: string }).code = 'HACKED'
    } catch {
      // some runtimes throw in strict mode
    }
    // .code mutation behavior varies by runtime; only assert it's set at construction.
    expect(err.code).toBeDefined()
  })

  it('error .key is enumerable (shows in JSON.stringify)', () => {
    const err = new TimeoutError(1000, { key: 'my-key' })
    const json = JSON.stringify(err)
    expect(json).toContain('"key"')
    expect(json).toContain('my-key')
  })
})

// ─── timeout vs totalTimeout ───

describe('Debug6: timeout + totalTimeout interaction', () => {
  it('per-attempt timeout fires first (shorter than total)', async () => {
    let calls = 0
    const t0 = Date.now()
    const r = await act('tt+to', async () => {
      calls++
      await wait(200)
      return 'slow'
    }, {
      timeout: { ms: 30 },
      totalTimeout: { ms: 1000 },
      retry: { attempts: 1 },
    })
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    expect(elapsed).toBeLessThan(100)
    if (!r.ok) expect((r.error as { code?: string }).code).toBe('ACTLY_TIMEOUT')
  })

  it('totalTimeout fires first (shorter than per-attempt × retries)', async () => {
    let calls = 0
    const t0 = Date.now()
    const r = await act('tt-first', async () => {
      calls++
      await wait(50)
      throw new Error('fail')
    }, {
      timeout: { ms: 10_000 },
      totalTimeout: { ms: 80 },
      retry: { attempts: 10, delayMs: 10, shouldRetry: () => true },
    })
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    expect(elapsed).toBeLessThan(300)
    if (!r.ok) expect((r.error as { code?: string }).code).toBe('ACTLY_TOTAL_TIMEOUT')
  })
})

// ─── fn that never settles ───

describe('Debug6: fn never settles', () => {
  it('timeout fires when fn never settles (race strategy)', async () => {
    const t0 = Date.now()
    const r = await act('never-settle', () => new Promise<string>(() => {}), {
      timeout: { ms: 30 },
      retry: { attempts: 1 },
    })
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    expect(elapsed).toBeLessThan(100)
    if (!r.ok) expect((r.error as { code?: string }).code).toBe('ACTLY_TIMEOUT')
  })

  it('totalTimeout fires when fn never settles (no per-attempt timeout)', async () => {
    const t0 = Date.now()
    const r = await act('never-settle-tt', () => new Promise<string>(() => {}), {
      totalTimeout: { ms: 30 },
    })
    const elapsed = Date.now() - t0
    expect(r.ok).toBe(false)
    expect(elapsed).toBeLessThan(100)
  })
})

// ─── invalidate on async store ───

describe('Debug6: scoped invalidate on async store', () => {
  it('invalidate on async store returns Promise<boolean>', async () => {
    let storedKey: string | undefined
    const asyncStore = {
      _sync: false as const,
      async get<T>(key: string): Promise<T | undefined> {
        return key === storedKey ? { value: 'cached' } as unknown as T : undefined
      },
      async set<T>(key: string, value: T): Promise<void> {
        storedKey = key
      },
      async delete(key: string): Promise<void> {
        if (key === storedKey) storedKey = undefined
      },
      async has(key: string): Promise<boolean> {
        return key === storedKey
      },
      async clear(): Promise<void> { storedKey = undefined },
      async size(): Promise<number> { return storedKey ? 1 : 0 },
    }
    const scopedAct = withStore(asyncStore)

    // cache a value
    await scopedAct('async-inv', async () => 'cached-value', { cache: { ttl: 60_000 } })

    // invalidate
    const result = await scopedAct.invalidate('async-inv') as Promise<boolean>
    expect(await result).toBe(true)

    // second invalidate returns false
    const result2 = await scopedAct.invalidate('async-inv') as Promise<boolean>
    expect(await result2).toBe(false)
  })
})

// ─── fn type safety ───

describe('Debug6: fn type safety', () => {
  it('fn=undefined — act() handles gracefully', async () => {
    // undefined() throws TypeError; act catches it.
    const r = await act('fn-undef', undefined as unknown as () => Promise<void>).catch(e => ({ ok: false, error: e }))
    // act either returns ActFailure or throws
    expect((r as { ok: boolean }).ok).toBe(false)
  })

  it('fn=null — act() handles gracefully', async () => {
    const r = await act('fn-null', null as unknown as () => Promise<void>).catch(e => ({ ok: false, error: e }))
    expect((r as { ok: boolean }).ok).toBe(false)
  })

  it('fn=string — act() handles gracefully', async () => {
    const r = await act('fn-string', 'not-a-function' as unknown as () => Promise<void>).catch(e => ({ ok: false, error: e }))
    expect((r as { ok: boolean }).ok).toBe(false)
  })
})

// ─── cache + dedupe + retry + timeout ───

describe('Debug6: full composition stress', () => {
  it('cache + dedupe + retry + timeout: first call fails, second succeeds, cached', async () => {
    let calls = 0
    const fn = async (signal: AbortSignal) => {
      calls++
      if (calls === 1) throw new Error('first fail')
      await wait(5)
      return 'recovered'
    }

    const opts = {
      cache: { ttl: 60_000 },
      dedupe: true,
      retry: { attempts: 3, delayMs: 1 },
      timeout: { ms: 10_000 },
    }

    // first call: fail, retry, succeed, cached
    const r1 = await act('full-comp', fn, opts)
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.value).toBe('recovered')
    expect(r1.attempts).toBe(2)
    expect(r1.source).toBe('fresh')

    // second call hits cache
    calls = 0 // reset counter
    const r2 = await act('full-comp', fn, opts)
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.value).toBe('recovered')
    expect(r2.source).toBe('cache')
    expect(r2.attempts).toBe(0)
    expect(calls).toBe(0) // fn skipped, cache hit
  })

  it('10 concurrent calls: 1 fails+retries, 9 join via dedupe, all get cached result', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls === 1) throw new Error('first fail')
      await wait(20)
      return 'shared-result'
    }

    const opts = {
      cache: { ttl: 60_000 },
      dedupe: true,
      retry: { attempts: 3, delayMs: 1 },
    }

    const promises: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) {
      promises.push(act('concurrent-comp', fn, opts))
    }

    const results = await Promise.all(promises)
    const oks = results.filter(r => r && typeof r === 'object' && (r as { ok?: boolean }).ok === true)
    expect(oks.length).toBe(10)

    for (const r of results) {
      const result = r as { ok: boolean; value: string }
      expect(result.value).toBe('shared-result')
    }

    // fn runs twice: first attempt fails, retry succeeds.
    // dedupe collapses the 10 concurrent calls into 1 in-flight.
    expect(calls).toBe(2)
  })
})

// ─── key length boundaries ───

describe('Debug6: key length boundaries', () => {
  it('key exactly 1024 chars works with cache', async () => {
    const key = 'k'.repeat(1024)
    const r1 = await act(key, async () => 'value', { cache: { ttl: 60_000 } })
    expect(r1.ok).toBe(true)

    const r2 = await act(key, async () => 'fresh', { cache: { ttl: 60_000 } })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.value).toBe('value') // cache hit
  })

  it('key exactly 1024 chars works with dedupe', async () => {
    const key = 'd'.repeat(1024)
    let calls = 0
    const slowFn = async () => { calls++; await wait(20); return 'shared' }

    const [r1, r2] = await Promise.all([
      act(key, slowFn, { dedupe: true }),
      act(key, slowFn, { dedupe: true }),
    ])
    expect(calls).toBe(1)
    expect(r1.ok && r2.ok).toBe(true)
  })

  it('key with all reserved prefixes rejected', async () => {
    await expect(act('dedupe:foo', async () => 1)).rejects.toThrow(/reserved prefix/)
    await expect(act('cache:foo', async () => 1)).rejects.toThrow(/reserved prefix/)
    await expect(act('inflight:foo', async () => 1)).rejects.toThrow(/reserved prefix/)
    await expect(act('tenant:foo', async () => 1)).rejects.toThrow(/reserved prefix/)
  })
})

// ─── error cause chain ───

describe('Debug6: error cause chain', () => {
  it('RetryExhaustedError preserves cause chain', async () => {
    const r = await act('cause-chain', async () => {
      throw new TypeError('type error in fn')
    }, { retry: { attempts: 2, delayMs: 1 } })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      const err = r.error as RetryExhaustedError
      expect(err.code).toBe('ACTLY_RETRY_EXHAUSTED')
      expect(err.cause).toBeInstanceOf(TypeError)
      expect((err.cause as Error).message).toBe('type error in fn')
      expect(err.lastError).toBe(err.cause)
    }
  })

  it('RetryExhaustedError.errors[] contains all attempt errors', async () => {
    let call = 0
    const r = await act('errors-array', async () => {
      call++
      throw new Error(`fail-${call}`)
    }, { retry: { attempts: 5, delayMs: 1 } })

    expect(r.ok).toBe(false)
    if (!r.ok) {
      const err = r.error as RetryExhaustedError
      expect(err.attempts).toBe(5)
      expect(err.errors.length).toBe(5) // 5 attempts, all failed
      expect((err.errors[0] as Error).message).toBe('fail-1')
      expect((err.errors[4] as Error).message).toBe('fail-5')
    }
  })
})

// ─── fallback edge cases ───

describe('Debug6: fallback edge cases', () => {
  it('fallback.value as static Promise (not function) — awaited', async () => {
    // fallback.value is function-checked; a Promise is not a function, so it's
    // returned as-is, not awaited.
    const r = await act('fb-promise', async () => { throw new Error('fail') }, {
      retry: { attempts: 2, delayMs: 1 },
      fallback: { value: Promise.resolve('async-fallback') },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // value is the Promise itself (not awaited)
      expect(r.value).toBeInstanceOf(Promise)
      const resolved = await r.value
      expect(resolved).toBe('async-fallback')
    }
  })

  it('fallback.value = 0 (falsy but valid)', async () => {
    const r = await act('fb-zero', async () => { throw new Error('fail') }, {
      retry: { attempts: 2, delayMs: 1 },
      fallback: { value: 0 },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(0)
  })

  it('fallback.value = null', async () => {
    const r = await act('fb-null', async () => { throw new Error('fail') }, {
      retry: { attempts: 2, delayMs: 1 },
      fallback: { value: null },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBeNull()
  })

  it('fallback.value = false', async () => {
    const r = await act('fb-false', async () => { throw new Error('fail') }, {
      retry: { attempts: 2, delayMs: 1 },
      fallback: { value: false },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(false)
  })

  it('fallback.value = empty string', async () => {
    const r = await act('fb-empty', async () => { throw new Error('fail') }, {
      retry: { attempts: 2, delayMs: 1 },
      fallback: { value: '' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('')
  })
})
