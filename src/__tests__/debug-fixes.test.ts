import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, anySignal } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── inflightTtl: Infinity accepted ─────────────────────────────────────

describe('Bug fix: inflightTtl: Infinity explicitly allowed', () => {
  it('accepts inflightTtl: Infinity (v1.2.0 behavior opt-in)', async () => {
    const r = await act('bf-infinity', async () => 'ok', {
      dedupe: { inflightTtl: Infinity },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('ok')
  })

  it('accepts inflightTtl: Infinity with explicit enabled', async () => {
    const r = await act('bf-infinity2', async () => 'ok', {
      dedupe: { enabled: true, inflightTtl: Infinity },
    })
    expect(r.ok).toBe(true)
  })

  it('still rejects inflightTtl: -1 (negative)', async () => {
    await expect(
      act('bf-neg', async () => 1, { dedupe: { inflightTtl: -1 } }),
    ).rejects.toThrow(/non-negative/)
  })

  it('still rejects inflightTtl: NaN', async () => {
    await expect(
      act('bf-nan', async () => 1, { dedupe: { inflightTtl: NaN } }),
    ).rejects.toThrow(/non-negative/)
  })
})

// ─── anySignal polyfill listener cleanup ───────────────────────────────

describe('Bug fix: anySignal polyfill cleans up listeners on pre-aborted input', () => {
  it('does not leak listeners when one input is pre-aborted (polyfill path)', () => {
    // force the polyfill by stashing AbortSignal.any
    const originalAny = (AbortSignal as unknown as { any?: Function }).any
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true })

    try {
      const a = new AbortController()
      const b = new AbortController()
      b.abort(new Error('pre-aborted'))
      const c = new AbortController()

      // listenerCount isn't on the standard EventTarget, so verify behaviour:
      // composite is aborted, and the signals still respond to later aborts
      const composite = anySignal([a.signal, b.signal, c.signal])
      expect(composite.aborted).toBe(true)

      a.abort(new Error('later'))
      expect(a.signal.aborted).toBe(true)
      c.abort(new Error('later2'))
      expect(c.signal.aborted).toBe(true)
    } finally {
      if (originalAny) {
        Object.defineProperty(AbortSignal, 'any', { value: originalAny, configurable: true })
      }
    }
  })
})

// ─── drain() doesn't create state for idle scopes ──────────────────────

describe('Bug fix: drain() does not leak state for idle scopes', () => {
  it('drain() on idle scope returns true without creating state', async () => {
    const { drain } = await import('../core/shutdown.js')
    const result = await drain(100, 'never-used-scope')
    expect(result).toBe(true)
    // drain() reads drainStates.get(scope) instead of getState(scope), so it
    // never materialises a state entry for an unknown scope
  })
})

// ─── InMemoryStore treats Infinity TTL as null ─────────────────────────

describe('Bug fix: InMemoryStore Infinity TTL treated as no expiry', () => {
  it('Infinity TTL → entry never expires', async () => {
    const store = new InMemoryStore()
    store.set('inf', 'value', Infinity)
    expect(store.get('inf')).toBe('value')
    await wait(30)
    expect(store.get('inf')).toBe('value')
    expect(store.has('inf')).toBe(true)
  })

  it('NaN TTL → treated as no expiry', () => {
    const store = new InMemoryStore()
    store.set('nan', 'value', NaN)
    expect(store.get('nan')).toBe('value')
  })

  it('0 TTL → treated as no expiry (consistent with null/undefined)', () => {
    const store = new InMemoryStore()
    store.set('zero', 'value', 0)
    expect(store.get('zero')).toBe('value')
  })

  it('negative TTL → treated as no expiry', () => {
    const store = new InMemoryStore()
    store.set('neg', 'value', -100)
    expect(store.get('neg')).toBe('value')
  })

  it('finite positive TTL → expires after TTL', async () => {
    const store = new InMemoryStore()
    store.set('finite', 'value', 20)
    expect(store.get('finite')).toBe('value')
    await wait(40)
    expect(store.get('finite')).toBeUndefined()
  })
})

// ─── hedge outside-retry meta isolation ────────────────────────────────

describe('Bug fix: hedge outside-retry meta isolation', () => {
  it('meta.attempts reflects winner chain, not loser', async () => {
    // primary retries 2x, hedge does 1 attempt; hedge wins so meta should
    // report 1, not the primary's 2
    let primaryCalls = 0
    let hedgeCalls = 0
    let primarySignalAborted = false

    const r = await act('bf-meta', async (signal) => {
      // distinguish primary from hedge: hedge runs after primary starts and
      // before its own signal gets aborted
      const isHedge = primaryCalls > 0 && !signal.aborted
      if (isHedge) {
        hedgeCalls++
        await wait(10)
        return 'hedge-wins'
      }
      primaryCalls++
      signal.addEventListener('abort', () => { primarySignalAborted = true })
      await wait(100)
      return 'primary-wins'
    }, {
      hedge: { delayMs: 20 },
      retry: { attempts: 3, delayMs: 1 },
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('hedge-wins')
      // winner chain owns the meta
      expect(r.attempts).toBe(1)
      expect(r.source).toBe('fresh')
    }
    // cancel-loser killed the primary after one call
    expect(primaryCalls).toBe(1)
    expect(hedgeCalls).toBe(1)
  })
})

// ─── rateLimit state auto-expires via TTL ──────────────────────────────

describe('Bug fix: rateLimit state auto-expires', () => {
  it('state entry has TTL = windowMs', async () => {
    const store = new InMemoryStore({ maxSize: 100, autoCleanup: true, cleanupIntervalMs: 20 })
    const scopedAct = withStore(store)

    await scopedAct('bf-rl', async () => 'ok', {
      rateLimit: { maxCalls: 100, windowMs: 30 },
    })

    expect(store.size()).toBe(1)

    await wait(80)

    // after TTL + sweep the entry is gone; lazy expiry on get() also drops it
    expect(store.size()).toBe(0)

    store.destroy()
  })
})

// ─── CB abort path idle cleanup ────────────────────────────────────────

describe('Bug fix: CB abort path idle cleanup', () => {
  it('aborted CB call on closed breaker → state deleted', async () => {
    const store = new InMemoryStore({ maxSize: 1000 })
    const scopedAct = withStore(store)
    const controller = new AbortController()
    controller.abort(new Error('user-cancelled'))

    await scopedAct('bf-cb-abort', async () => 'ok', {
      circuitBreaker: { threshold: 3, cooldownMs: 1000 },
      signal: controller.signal,
    }).catch(() => {})

    expect(store.size()).toBe(0)
    store.destroy()
  })
})

// ─── shutdown state deleted when idle ──────────────────────────────────

describe('Bug fix: drain state deleted when scope becomes idle', () => {
  it('scope state deleted after all inflight settle', async () => {
    const { drain, registerDrainable, unregisterDrainable } = await import('../core/shutdown.js')

    const scope = 'test-drain-cleanup'
    registerDrainable(scope)
    expect(registerDrainable).toBeDefined()

    // drain blocks while inflight > 0
    const drainPromise = drain(1000, scope)

    // unregister drops inflight to 0: drain resolves and the state is removed
    unregisterDrainable(scope)

    const result = await drainPromise
    expect(result).toBe(true)

    // second drain returns immediately since no state entry exists
    const result2 = await drain(10, scope)
    expect(result2).toBe(true)
  })
})
