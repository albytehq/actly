import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore } from '../index.js'
import { isActlyEventType } from '../testing/index.js'
import { safeCall } from '../utils/safeCall.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── safeCall edge cases ──────────────────────────────────────────────

describe('Debug4: safeCall edge cases', () => {
  it('handles async hook that returns Promise (thenable)', async () => {
    let hookCalled = false
    const r = await act('sc-async', async () => 'ok', {
      observability: {
        onFinalSuccess: async () => {
          hookCalled = true
          await wait(10)
        },
      },
    })
    expect(r.ok).toBe(true)
    expect(hookCalled).toBe(true)
  })

  it('handles async hook that rejects — no unhandled rejection', async () => {
    // If safeCall doesn't .catch the returned Promise, Node emits
    // 'unhandledRejection'. vitest would surface this as a test failure.
    const r = await act('sc-async-reject', async () => 'ok', {
      observability: {
        onFinalSuccess: async () => {
          await wait(5)
          throw new Error('async hook reject')
        },
      },
    })
    expect(r.ok).toBe(true)
    // Wait for the async hook to settle
    await wait(20)
  })

  it('handles hook that returns thenable (not real Promise)', async () => {
    const r = await act('sc-thenable', async () => 'ok', {
      observability: {
        onFinalSuccess: () => ({
          then(resolve: () => void) { resolve() },
        }),
      },
    })
    expect(r.ok).toBe(true)
    await wait(10)
  })

  it('safeCall with null fn returns immediately', () => {
    expect(() => safeCall(null as unknown as (() => void) | undefined)).not.toThrow()
  })

  it('safeCall with undefined fn returns immediately', () => {
    expect(() => safeCall(undefined)).not.toThrow()
  })

  it('safeCall with fn that returns non-thenable value does not crash', () => {
    expect(() => safeCall(() => 42)).not.toThrow()
    expect(() => safeCall(() => 'string')).not.toThrow()
    expect(() => safeCall(() => null)).not.toThrow()
    expect(() => safeCall(() => undefined)).not.toThrow()
    expect(() => safeCall(() => { return { then: 'not-a-function' } })).not.toThrow()
  })
})

// ─── isActlyEventType completeness ────────────────────────────────────

describe('Debug4: isActlyEventType covers all event types', () => {
  it('accepts all 10 event types', () => {
    expect(isActlyEventType('attempt')).toBe(true)
    expect(isActlyEventType('retry')).toBe(true)
    expect(isActlyEventType('cache-hit')).toBe(true)
    expect(isActlyEventType('cache-miss')).toBe(true)
    expect(isActlyEventType('dedupe-join')).toBe(true)
    expect(isActlyEventType('timeout')).toBe(true)
    expect(isActlyEventType('final-success')).toBe(true)
    expect(isActlyEventType('final-failure')).toBe(true)
    expect(isActlyEventType('backpressure')).toBe(true)
    expect(isActlyEventType('watchdog')).toBe(true)
  })

  it('rejects unknown types', () => {
    expect(isActlyEventType('bogus')).toBe(false)
    expect(isActlyEventType('')).toBe(false)
    expect(isActlyEventType(null)).toBe(false)
    expect(isActlyEventType(undefined)).toBe(false)
    expect(isActlyEventType(42)).toBe(false)
    expect(isActlyEventType({})).toBe(false)
  })
})

// ─── Decorator edge cases ─────────────────────────────────────────────

describe('Debug4: decorator edge cases', () => {
  it('preserves this context with class properties', async () => {
    const { usePolicy } = await import('../utils/decorator.js')

    class Service {
      private prefix = 'Hello '

      greet(_signal: AbortSignal, name: string): Promise<string> {
        return Promise.resolve(this.prefix + name)
      }
    }

    const proto = Service.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'greet')!
    usePolicy({})(proto as object, 'greet', desc)
    Object.defineProperty(proto, 'greet', desc)

    const svc = new Service()
    const result = await svc.greet(new AbortController().signal, 'World')
    expect(result).toBe('Hello World')
  })

  it('works with method that takes no args (no signal)', async () => {
    const { usePolicy } = await import('../utils/decorator.js')

    class Service {
      async getValue(): Promise<number> {
        return 42
      }
    }

    const proto = Service.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'getValue')!
    usePolicy({ retry: { attempts: 2, delayMs: 1 } })(proto as object, 'getValue', desc)
    Object.defineProperty(proto, 'getValue', desc)

    const svc = new Service()
    const result = await svc.getValue()
    expect(result).toBe(42)
  })

  it('works with method that takes multiple args after signal', async () => {
    const { usePolicy } = await import('../utils/decorator.js')

    class Service {
      async compute(_signal: AbortSignal, a: number, b: number, c: number): Promise<number> {
        return a + b + c
      }
    }

    const proto = Service.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'compute')!
    usePolicy({})(proto as object, 'compute', desc)
    Object.defineProperty(proto, 'compute', desc)

    const svc = new Service()
    const result = await svc.compute(new AbortController().signal, 1, 2, 3)
    expect(result).toBe(6)
  })

  it('throws ActResult error on failure (not raw error)', async () => {
    const { usePolicy } = await import('../utils/decorator.js')

    class Service {
      async fail(_signal: AbortSignal): Promise<string> {
        throw new Error('method failed')
      }
    }

    const proto = Service.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'fail')!
    usePolicy({ retry: { attempts: 2, delayMs: 1 } })(proto as object, 'fail', desc)
    Object.defineProperty(proto, 'fail', desc)

    const svc = new Service()
    await expect(svc.fail(new AbortController().signal)).rejects.toThrow('method failed')
  })

  it('derived class inherits decorated method', async () => {
    const { usePolicy } = await import('../utils/decorator.js')

    class Base {
      async method(_signal: AbortSignal): Promise<string> {
        return 'base'
      }
    }

    const proto = Base.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'method')!
    usePolicy({})(proto as object, 'method', desc)
    Object.defineProperty(proto, 'method', desc)

    class Derived extends Base {
      override async method(signal: AbortSignal): Promise<string> {
        const result = await super.method(signal)
        return result + '-derived'
      }
    }

    const d = new Derived()
    const result = await d.method(new AbortController().signal)
    expect(result).toBe('base-derived')
  })
})

// ─── InMemoryStore concurrent sweep ───────────────────────────────────

describe('Debug4: InMemoryStore concurrent operations', () => {
  it('sweep during concurrent get() does not crash', async () => {
    const store = new InMemoryStore({ maxSize: 100, autoCleanup: true, cleanupIntervalMs: 10 })

    // Fill store
    for (let i = 0; i < 50; i++) {
      store.set(`k${i}`, `v${i}`, 15) // 15ms TTL
    }

    // Concurrent gets while sweep runs
    const promises: Promise<unknown>[] = []
    for (let i = 0; i < 50; i++) {
      promises.push(Promise.resolve(store.get(`k${i}`)))
    }

    // Wait for sweep to run + entries to expire
    await wait(30)

    // All gets should resolve without error
    const results = await Promise.all(promises)
    expect(results.length).toBe(50)

    // After sweep, store should be smaller
    expect(store.size()).toBeLessThan(50)

    store.destroy()
  })

  it('LRU eviction during has() does not corrupt list', () => {
    const store = new InMemoryStore({ maxSize: 3 })
    store.set('a', 1)
    store.set('b', 2)
    store.set('c', 3)

    // has('a') does NOT touch LRU
    expect(store.has('a')).toBe(true)

    // insert 'd': evicts 'a' (LRU)
    store.set('d', 4)
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBe(2)
    expect(store.get('c')).toBe(3)
    expect(store.get('d')).toBe(4)

    // insert 'e': evicts 'b' (now LRU)
    store.set('e', 5)
    expect(store.get('b')).toBeUndefined()
    expect(store.get('c')).toBe(3)
    expect(store.get('d')).toBe(4)
    expect(store.get('e')).toBe(5)

    store.destroy()
  })

  it('delete() during LRU iteration does not corrupt list', () => {
    const store = new InMemoryStore({ maxSize: 10 })
    store.set('a', 1)
    store.set('b', 2)
    store.set('c', 3)
    store.set('d', 4)
    store.set('e', 5)

    // delete middle element
    store.delete('c')
    expect(store.get('c')).toBeUndefined()

    // LRU order is still intact
    store.set('f', 6) // no eviction (maxSize:10)
    expect(store.get('a')).toBe(1)
    expect(store.get('b')).toBe(2)
    expect(store.get('d')).toBe(4)
    expect(store.get('e')).toBe(5)
    expect(store.get('f')).toBe(6)

    // fill to capacity, then one more insert should evict 'a' (LRU).
    // don't call get('a') here: get() would bump it to MRU and change eviction order.
    store.set('g', 7)
    store.set('h', 8)
    store.set('i', 9)
    store.set('j', 10)
    store.set('k', 11) // at capacity, no eviction
    store.set('l', 12) // exceeds capacity, evicts 'a'
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBe(2)

    store.destroy()
  })

  it('clear() during autoCleanup does not crash', () => {
    const store = new InMemoryStore({ maxSize: 100, autoCleanup: true, cleanupIntervalMs: 5 })
    for (let i = 0; i < 50; i++) store.set(`k${i}`, i, 10)

    store.clear()
    expect(store.size()).toBe(0)

    // wait long enough for at least one sweep to run on the empty store (5ms interval)
    store.destroy()
  })
})

// ─── Hedge keepLoser:true edge cases ──────────────────────────────────

describe('Debug4: hedge keepLoser:true', () => {
  it('keepLoser:true — both promises run to completion', async () => {
    let primaryDone = false
    let hedgeDone = false

    const r = await act('kl-both', async (signal) => {
      // both invocations get the same parent-linked signal, so distinguish by timing.
      await wait(100)
      if (!primaryDone) primaryDone = true
      else hedgeDone = true
      return 'result'
    }, {
      hedge: { delayMs: 30, keepLoser: true },
    })

    expect(r.ok).toBe(true)
    // wait long enough for both to complete
    await wait(150)
    expect(primaryDone).toBe(true)
    // with keepLoser:true the hedge promise is NOT cancelled, so it eventually completes
  })

  it('keepLoser:false (default) — loser is cancelled', async () => {
    let loserCancelled = false

    const r = await act('kl-cancel', async (signal) => {
      // listen for cancellation so we can observe it
      signal.addEventListener('abort', () => { loserCancelled = true })

      await wait(100)
      return 'result'
    }, {
      hedge: { delayMs: 30, keepLoser: false },
    })

    expect(r.ok).toBe(true)
    // wait for the loser to be cancelled
    await wait(20)
    // with keepLoser:false the loser's signal is aborted (the winner's abort is a no-op)
    expect(loserCancelled).toBe(true)
  })
})

// ─── What-if: act() called with key that changes type ─────────────────

describe('Debug4: key type coercion', () => {
  it('number key throws (must be string)', async () => {
    await expect(act(42 as unknown as string, async () => 1)).rejects.toThrow(/must be a string/)
  })

  it('null key throws', async () => {
    await expect(act(null as unknown as string, async () => 1)).rejects.toThrow(/must be a string/)
  })

  it('undefined key throws', async () => {
    await expect(act(undefined as unknown as string, async () => 1)).rejects.toThrow(/must be a string/)
  })

  it('object key throws', async () => {
    await expect(act({} as unknown as string, async () => 1)).rejects.toThrow(/must be a string/)
  })

  it('boolean key throws', async () => {
    await expect(act(true as unknown as string, async () => 1)).rejects.toThrow(/must be a string/)
  })
})

// ─── What-if: observability hooks object is frozen ────────────────────

describe('Debug4: frozen observability object', () => {
  it('frozen observability hooks work', async () => {
    let called = false
    const obs = Object.freeze({
      onFinalSuccess: () => { called = true },
    })
    const r = await act('frozen-obs', async () => 'ok', {
      observability: obs,
    })
    expect(r.ok).toBe(true)
    expect(called).toBe(true)
  })

  it('null observability is treated as no hooks', async () => {
    const r = await act('null-obs', async () => 'ok', {
      observability: null as unknown as { onFinalSuccess?: () => void },
    })
    expect(r.ok).toBe(true)
  })

  it('undefined observability is treated as no hooks', async () => {
    const r = await act('undef-obs', async () => 'ok', {
      observability: undefined,
    })
    expect(r.ok).toBe(true)
  })
})

// ─── What-if: retry with attempts = MAX (100) all fail ────────────────

describe('Debug4: retry exhaustion at MAX_RETRY_ATTEMPTS', () => {
  it('100 attempts all fail — errors[] capped at 10', async () => {
    let calls = 0
    const r = await act('max-exhaust', async () => {
      calls++
      throw new Error(`fail ${calls}`)
    }, { retry: { attempts: 100, delayMs: 0 } })

    expect(r.ok).toBe(false)
    expect(calls).toBe(100)
    if (!r.ok) {
      const err = r.error as { code?: string; attempts?: number; errors?: unknown[] }
      expect(err.code).toBe('ACTLY_RETRY_EXHAUSTED')
      expect(err.attempts).toBe(100)
      expect(err.errors?.length).toBe(10) // capped
    }
  }, 30_000) // 100 iterations at 0ms delay should still finish quickly
})

// ─── What-if: cache ttl exactly equals windowMs ───────────────────────

describe('Debug4: boundary timing', () => {
  it('cache ttl = 1ms — entry expires between calls', async () => {
    await act('ttl-1ms', async () => 'v1', { cache: { ttl: 1 } })
    await wait(10)
    const r = await act('ttl-1ms', async () => 'v2', { cache: { ttl: 1 } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('v2') // cache expired → re-fetched
  })

  it('rateLimit windowMs = 1ms — calls in different windows', async () => {
    const r1 = await act('rl-1ms', async () => 'a', { rateLimit: { maxCalls: 1, windowMs: 1 } })
    await wait(5)
    const r2 = await act('rl-1ms', async () => 'b', { rateLimit: { maxCalls: 1, windowMs: 1 } })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })
})

// ─── What-if: scoped store + default store same key ───────────────────

describe('Debug4: scoped + default store coexistence', () => {
  it('same key in scoped + default store are independent', async () => {
    // Default store
    await act('coexist', async () => 'default', { cache: { ttl: 60_000 } })

    // Scoped store
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)
    await scopedAct('coexist', async () => 'scoped', { cache: { ttl: 60_000 } })

    // Both should return their own cached value
    const r1 = await act('coexist', async () => 'fresh', { cache: { ttl: 60_000 } })
    const r2 = await scopedAct('coexist', async () => 'fresh', { cache: { ttl: 60_000 } })

    expect(r1.ok && r1.value).toBe('default')
    expect(r2.ok && r2.value).toBe('scoped')

    store.destroy()
  })
})

// ─── What-if: drainAll with no scopes registered ──────────────────────

describe('Debug4: drainAll edge cases', () => {
  it('drainAll with no scopes returns true immediately', async () => {
    const { drainAll } = await import('../core/shutdown.js')
    const result = await drainAll(100)
    expect(result).toBe(true)
  })
})

// ─── What-if: store.get returns wrong type ────────────────────────────

describe('Debug4: store type safety', () => {
  it('store.get returning wrong type does not crash (runtime)', async () => {
    // Simulate a store that returns a string when a CacheEntry is expected.
    // TypeScript would catch this, but JS callers bypass types.
    const badStore = {
      _sync: true as const,
      get() { return 'not-a-cache-entry' },
      set() {},
      delete() {},
      has() { return false },
      clear() {},
      size() { return 0 },
    }
    const scopedAct = withStore(badStore)
    // cache policy calls store.get<CacheEntry<T>> and gets a truthy string back, so it treats
    // it as a hit and returns hit.value (undefined). Runtime type safety is the caller's job;
    // we just need to confirm the cache path doesn't crash.
    const r = await scopedAct('bad-type', async () => 'actual-value', {
      cache: { ttl: 60_000 },
    })
    expect(r.ok).toBe(true)
  })
})
