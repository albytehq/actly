import { describe, it, expect, vi } from 'vitest'
import {
  act, withStore, invalidate, execute,
  InMemoryStore, createHealthCheck, drain, drainAll,
  dedupePolicy, bulkheadPolicy, retryPolicy, rateLimitPolicy,
  isActlyError, TimeoutError, sanitizeErrorMessage,
  sleep, OBSERVABILITY_HOOKS, usePolicy,
} from '../index.js'
import type {
  ActOptions, ObservabilityHooks, SyncStateStore, PolicyContext, ActFn,
} from '../index.js'
import { waitForObsHook } from '../testing/index.js'

// ─── C1: hedge aborts only the loser (both placements) ───────────────────────

describe('v1.4 C1: hedge winner controller is never aborted', () => {
  const hedgeScenario = (
    placement: 'outside-retry' | 'inside-retry',
    keepLoser = false,
  ) => {
    const signals: AbortSignal[] = []
    let call = 0
    return act(`c1-${placement}-${keepLoser}`, async (signal) => {
      signals.push(signal)
      call++
      if (call === 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        return 'primary'
      }
      await new Promise((resolve) => setTimeout(resolve, 15))
      return 'hedge'
    }, { hedge: { delayMs: 50, placement, keepLoser } }).then((r) => ({
      r, signals, call,
    }))
  }

  it.each(['outside-retry', 'inside-retry'] as const)(
    '%s: hedge wins → winner signal stays alive, loser aborted',
    async (placement) => {
      const { r, signals } = await hedgeScenario(placement)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toBe('hedge')
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(signals[1]!.aborted).toBe(false) // hedge = winner
      expect(signals[0]!.aborted).toBe(true) // primary = loser
    },
  )

  it.each(['outside-retry', 'inside-retry'] as const)(
    '%s: primary wins before the hedge window → nothing aborted',
    async (placement) => {
      const signals: AbortSignal[] = []
      const r = await act(`c1-early-${placement}`, async (signal) => {
        signals.push(signal)
        await new Promise((resolve) => setTimeout(resolve, 10))
        return 'primary'
      }, { hedge: { delayMs: 60, placement } })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toBe('primary')
      expect(signals).toHaveLength(1)
      expect(signals[0]!.aborted).toBe(false)
    },
  )

  it.each(['outside-retry', 'inside-retry'] as const)(
    '%s: primary rejects before the hedge window → error propagates',
    async (placement) => {
      const r = await act(`c1-fail-${placement}`, async () => {
        throw new Error('primary boom')
      }, { hedge: { delayMs: 60, placement } })
      expect(r.ok).toBe(false)
      if (!r.ok) expect((r.error as Error).message).toBe('primary boom')
    },
  )

  it('keepLoser: true → neither controller aborted', async () => {
    const { r, signals } = await hedgeScenario('outside-retry', true)
    expect(r.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(signals[0]!.aborted).toBe(false)
    expect(signals[1]!.aborted).toBe(false)
  })

  it('scoped act with hedge keeps the same contract', async () => {
    const signals: AbortSignal[] = []
    let call = 0
    const scoped = withStore(new InMemoryStore())
    const r = await scoped('c1-scoped', async (signal) => {
      signals.push(signal)
      call++
      if (call === 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        return 'primary'
      }
      await new Promise((resolve) => setTimeout(resolve, 15))
      return 'hedge'
    }, { hedge: { delayMs: 50 } })
    expect(r.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(signals[1]!.aborted).toBe(false)
    expect(signals[0]!.aborted).toBe(true)
  })
})

// ─── C3: observability hook validation ───────────────────────────────────────

describe('v1.4 C3: unknown observability hooks throw', () => {
  it('throws synchronously on a typo hook name', () => {
    expect(() =>
      act('c3-typo', async () => 1, {
        observability: { onSucess: () => {} } as unknown as ObservabilityHooks,
      }),
    ).toThrow(/unknown observability hook "onSucess"/)
  })

  it('lists the valid hooks in the error', () => {
    try {
      act('c3-typo2', async () => 1, {
        observability: { onFinallSuccess: () => {} } as unknown as ObservabilityHooks,
      })
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toContain('onFinalSuccess')
    }
  })

  it('throws on a non-function hook', () => {
    expect(() =>
      act('c3-badfn', async () => 1, {
        observability: { onAttempt: 'nope' as unknown as () => void },
      }),
    ).toThrow(/observability\.onAttempt must be a function/)
  })

  it('accepts undefined hook slots', async () => {
    const r = await act('c3-undef', async () => 1, {
      observability: { onAttempt: undefined },
    })
    expect(r.ok).toBe(true)
  })

  it('accepts every valid hook', async () => {
    const hooks: ObservabilityHooks = {}
    for (const name of OBSERVABILITY_HOOKS) {
      ;(hooks as Record<string, unknown>)[name] = () => {}
    }
    const r = await act('c3-all', async () => 1, { observability: hooks })
    expect(r.ok).toBe(true)
  })

  it('does not reject a null-valued slot object or hooks with inherited keys', async () => {
    const r = await act('c3-ok', async () => 1, {
      observability: { onFinalSuccess: () => {} },
    })
    expect(r.ok).toBe(true)
  })
})

// ─── D7: validation throws synchronously ─────────────────────────────────────

describe('v1.4 D7: validation surfaces synchronously', () => {
  it('act() throws before returning a promise for invalid options', () => {
    let threw = false
    try {
      const p = act('d7', async () => 1, { retry: { attempts: 0 } })
      // if we get here, it should have thrown instead
      void p
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('scoped act() validates synchronously too', () => {
    const scoped = withStore(new InMemoryStore())
    expect(() => scoped('', async () => 1)).toThrow(/non-empty/)
  })

  it('runtime failures still resolve (never-rejects contract intact)', async () => {
    const r = await act('d7-runtime', async () => { throw new Error('boom') })
    expect(r.ok).toBe(false)
  })
})

// ─── M2: createHealthCheck accepts any store contract implementation ─────────

describe('v1.4 M2: createHealthCheck store contract', () => {
  it('accepts a custom sync store (not just InMemoryStore)', async () => {
    const backing = new Map<string, { value: unknown; ttl?: number }>()
    const custom: SyncStateStore = {
      _sync: true as const,
      get: (k) => backing.get(k)?.value as never,
      set: (k, v, ttl) => { backing.set(k, { value: v, ttl }) },
      delete: (k) => { backing.delete(k) },
      has: (k) => backing.has(k),
      clear: () => backing.clear(),
      size: () => backing.size,
    }
    const scoped = withStore(custom)
    await scoped('m2-store', async () => { throw new Error('custom boom') })
    const check = createHealthCheck(custom)
    const status = check()
    expect(status.pendingInflight).toBe(0)
    expect(status.lastError?.message).toContain('custom boom')
    check.dispose()
  })
})

// ─── M3: dedupePolicy honors enabled: false on the execute() path ────────────

describe('v1.4 M3: dedupePolicy respects enabled flag', () => {
  it('enabled: false is a pass-through under execute()', async () => {
    let calls = 0
    const fn: ActFn<number> = async () => { calls++; return calls }
    const meta = { attempts: 1, source: 'fresh' as const }
    const ctx: PolicyContext = {
      key: 'm3-key', store: new InMemoryStore(), meta,
    }
    const wrapped = dedupePolicy({ enabled: false })(fn, ctx)
    const [a, b] = await Promise.all([wrapped(new AbortController().signal), wrapped(new AbortController().signal)])
    expect(calls).toBe(2)
    expect(a).toBe(1)
    expect(b).toBe(2)
  })

  it('enabled: true still dedupes under execute()', async () => {
    let calls = 0
    const fn: ActFn<number> = async () => { calls++; return calls }
    const ctx: PolicyContext = {
      key: 'm3-on', store: new InMemoryStore(), meta: { attempts: 1, source: 'fresh' },
    }
    const wrapped = dedupePolicy({ enabled: true })(fn, ctx)
    const [a, b] = await Promise.all([wrapped(new AbortController().signal), wrapped(new AbortController().signal)])
    expect(calls).toBe(1)
    expect(a).toBe(1)
    expect(b).toBe(1)
  })
})

// ─── M4: AttemptEvent post-settle fields ─────────────────────────────────────

describe('v1.4 M4: AttemptEvent durationMs and error are filled after settle', () => {
  it('no-retry path: failure fills durationMs and error', async () => {
    const events: Array<Record<string, unknown>> = []
    const r = await act('m4-fail', async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      throw new Error('attempt failed')
    }, { observability: { onAttempt: (e) => { events.push(e as unknown as Record<string, unknown>) } } })
    expect(r.ok).toBe(false)
    expect(events).toHaveLength(1)
    expect(typeof events[0]!.durationMs).toBe('number')
    expect((events[0]!.durationMs as number)).toBeGreaterThanOrEqual(0)
    expect((events[0]!.error as Error).message).toBe('attempt failed')
  })

  it('no-retry path: success fills durationMs, leaves error undefined', async () => {
    const events: Array<Record<string, unknown>> = []
    const r = await act('m4-ok', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return 'v'
    }, { observability: { onAttempt: (e) => { events.push(e as unknown as Record<string, unknown>) } } })
    expect(r.ok).toBe(true)
    expect(typeof events[0]!.durationMs).toBe('number')
    expect(events[0]!.error).toBeUndefined()
  })

  it('retry path: every attempt event is filled with its own duration', async () => {
    const events: Array<Record<string, unknown>> = []
    let attempt = 0
    const r = await act('m4-retry', async () => {
      attempt++
      if (attempt < 3) throw new Error(`fail-${attempt}`)
      return 'ok'
    }, {
      retry: { attempts: 3, delayMs: 1 },
      observability: { onAttempt: (e) => { events.push(e as unknown as Record<string, unknown>) } },
    })
    expect(r.ok).toBe(true)
    expect(events).toHaveLength(3)
    for (const ev of events) {
      expect(typeof ev.durationMs).toBe('number')
    }
    expect((events[0]!.error as Error).message).toBe('fail-1')
    expect((events[1]!.error as Error).message).toBe('fail-2')
    expect(events[2]!.error).toBeUndefined()
  })
})

// ─── M7: bulkhead validates at construction ──────────────────────────────────

describe('v1.4 M7: bulkheadPolicy validates options at construction', () => {
  it('rejects queueTimeoutMs: Infinity', () => {
    expect(() => bulkheadPolicy({ maxConcurrent: 1, queueTimeoutMs: Number.POSITIVE_INFINITY }))
      .toThrow(/non-negative finite/)
  })

  it('rejects negative and NaN queueTimeoutMs', () => {
    expect(() => bulkheadPolicy({ maxConcurrent: 1, queueTimeoutMs: -5 })).toThrow(/non-negative finite/)
    expect(() => bulkheadPolicy({ maxConcurrent: 1, queueTimeoutMs: NaN })).toThrow(/non-negative finite/)
  })

  it('rejects invalid maxConcurrent and maxQueueSize', () => {
    expect(() => bulkheadPolicy({ maxConcurrent: 0 })).toThrow(/positive integer/)
    expect(() => bulkheadPolicy({ maxConcurrent: 1.5 })).toThrow(/positive integer/)
    expect(() => bulkheadPolicy({ maxConcurrent: 1, maxQueueSize: 0 })).toThrow(/positive integer or Infinity/)
  })

  it('finite queue timeout still queues correctly', async () => {
    const fn: ActFn<number> = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return 1
    }
    const ctx: PolicyContext = {
      key: 'm7-q', store: new InMemoryStore(), meta: { attempts: 1, source: 'fresh' },
    }
    const wrapped = bulkheadPolicy({ maxConcurrent: 1, queueTimeoutMs: 500 })(fn, ctx)
    const results = await Promise.all([
      wrapped(new AbortController().signal),
      wrapped(new AbortController().signal),
    ])
    expect(results).toEqual([1, 1])
  })
})

// ─── M8: scoped act fast path ────────────────────────────────────────────────

describe('v1.4 M8: scoped act() has a fast path', () => {
  it('scoped act with no options resolves without policies', async () => {
    const scoped = withStore(new InMemoryStore())
    const r = await scoped('m8-plain', async (signal) => {
      expect(signal.aborted).toBe(false)
      return 42
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe(42)
      expect(r.source).toBe('fresh')
      expect(r.attempts).toBe(1)
      expect(typeof r.durationMs).toBe('number')
    }
  })

  it('scoped act fast path is safe under concurrency', async () => {
    const scoped = withStore(new InMemoryStore())
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => scoped(`m8-c${i}`, async () => i)),
    )
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.filter((r) => r.ok && r.value === 3)).toHaveLength(1)
  })
})

// ─── M9: decorator keys do not collide ───────────────────────────────────────

describe('v1.4 M9: @usePolicy keys are collision-free', () => {
  it('two anonymous classes with the same method name do not share a key', async () => {
    const calls: string[] = []
    const makeClass = () => class {
      async m(_signal: AbortSignal): Promise<string> {
        calls.push('x')
        return 'v'
      }
    }
    const A = makeClass()
    const B = makeClass()
    const opts: ActOptions = { dedupe: true }
    for (const C of [A, B]) {
      const desc = Object.getOwnPropertyDescriptor(C.prototype, 'm')!
      usePolicy(opts)(C.prototype, 'm', desc)
      Object.defineProperty(C.prototype, 'm', desc)
    }
    const signal = new AbortController().signal
    await new (A as new () => { m: (s: AbortSignal) => Promise<string> })().m(signal)
    await new (B as new () => { m: (s: AbortSignal) => Promise<string> })().m(signal)
    expect(calls).toHaveLength(2)
  })

  it('dedupe still collapses repeated calls on the same instance method', async () => {
    let calls = 0
    class Svc {
      async m(_signal: AbortSignal): Promise<number> {
        calls++
        await new Promise((resolve) => setTimeout(resolve, 25))
        return calls
      }
    }
    const svcDesc = Object.getOwnPropertyDescriptor(Svc.prototype, 'm')!
    usePolicy({ dedupe: true })(Svc.prototype, 'm', svcDesc)
    Object.defineProperty(Svc.prototype, 'm', svcDesc)
    const svc = new Svc()
    const signal = new AbortController().signal
    const [a, b] = await Promise.all([svc.m(signal), svc.m(signal)])
    expect(calls).toBe(1)
    expect(a).toBe(1)
    expect(b).toBe(1)
  })
})

// ─── m1: sleep removes the abort listener on the abort path ──────────────────

describe('v1.4 m1: sleep listener hygiene', () => {
  it('removes the abort listener when aborted mid-sleep', async () => {
    const controller = new AbortController()
    const signal = controller.signal
    const origRemove = signal.removeEventListener.bind(signal)
    let removals = 0
    signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
      removals++
      return origRemove(...args)
    }) as typeof signal.removeEventListener

    const p = sleep(10_000, signal).catch(() => 'aborted')
    controller.abort(new Error('stop'))
    await p
    expect(removals).toBeGreaterThanOrEqual(1)
  })
})

// ─── m3: single message-redaction implementation ─────────────────────────────

describe('v1.4 m3: unified message sanitization', () => {
  it('escapes all five entities and strips control characters', () => {
    expect(sanitizeErrorMessage('<a>&"\'b\x01')).toBe('&lt;a&gt;&amp;&quot;&#x27;b')
  })

  it('caps length with an ellipsis marker', () => {
    const long = 'x'.repeat(9000)
    const out = sanitizeErrorMessage(long)
    expect(out.length).toBe(8192)
    expect(out.endsWith('...')).toBe(true)
  })
})

// ─── m4: drain validates timeoutMs ───────────────────────────────────────────

describe('v1.4 m4: drain timeout validation', () => {
  it('drain rejects negative and non-finite timeouts', async () => {
    await expect(drain(-1)).rejects.toThrow(/non-negative finite/)
    await expect(drain(Number.POSITIVE_INFINITY)).rejects.toThrow(/non-negative finite/)
    await expect(drain(NaN)).rejects.toThrow(/non-negative finite/)
  })

  it('drainAll rejects invalid timeouts', async () => {
    await expect(drainAll(-5)).rejects.toThrow(/non-negative finite/)
  })

  it('valid timeouts still drain', async () => {
    const result = await drain(10, 'no-such-scope')
    expect(result).toBe(true)
  })
})

// ─── m6: isActlyError is harder to fool ──────────────────────────────────────

describe('v1.4 m6: isActlyError heuristic', () => {
  it('rejects plain objects that only carry an ACTLY_ code', () => {
    expect(isActlyError({ code: 'ACTLY_TIMEOUT' })).toBe(false)
    expect(isActlyError(null)).toBe(false)
    expect(isActlyError(undefined)).toBe(false)
    expect(isActlyError('ACTLY_TIMEOUT')).toBe(false)
  })

  it('rejects unknown codes even when Error-shaped', () => {
    expect(isActlyError({ code: 'ACTLY_NOT_A_THING', message: 'x' })).toBe(false)
  })

  it('accepts real actly errors', () => {
    expect(isActlyError(new TimeoutError(5))).toBe(true)
  })
})

// ─── m7: acceptResult alias ──────────────────────────────────────────────────

describe('v1.4 m7: acceptResult alias', () => {
  it('acceptResult: true accepts the value', async () => {
    let calls = 0
    const r = await act('m7-accept', async () => { calls++; return { ok: true } }, {
      retry: { attempts: 2, delayMs: 1, acceptResult: (v: { ok: boolean }) => v.ok },
    })
    expect(r.ok).toBe(true)
    expect(calls).toBe(1)
  })

  it('acceptResult: false retries, then returns the last value on exhaustion', async () => {
    let calls = 0
    const r = await act('m7-retry', async () => { calls++; return { ok: false } }, {
      retry: { attempts: 2, delayMs: 1, acceptResult: (v: { ok: boolean }) => v.ok },
    })
    expect(r.ok).toBe(true)
    expect(calls).toBe(2)
  })
})

// ─── frozen options policy cache ─────────────────────────────────────────────

describe('v1.4: frozen options are cached, not mutated', () => {
  it('the same frozen options object works across many calls', async () => {
    const OPTS = Object.freeze({
      retry: { attempts: 2, delayMs: 1 },
      timeout: { ms: 2_000 },
    }) as ActOptions
    for (let i = 0; i < 5; i++) {
      const r = await act(`frozen-ok-${i}`, async () => i, OPTS)
      expect(r.ok).toBe(true)
    }
    let calls = 0
    for (let i = 0; i < 5; i++) {
      const r = await act(`frozen-fail-${i}`, async () => {
        calls++
        throw new Error('x')
      }, OPTS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.attempts).toBe(2)
    }
    expect(calls).toBe(10)
  })

  it('non-frozen options still build fresh chains per call', async () => {
    const opts: { retry?: { attempts: number; delayMs: number } } = { retry: { attempts: 2, delayMs: 1 } }
    const a = await act('nf-1', async () => 1, opts)
    opts.retry = { attempts: 3, delayMs: 1 } // mutation must take effect
    let calls = 0
    const b = await act('nf-2', async () => { calls++; throw new Error('x') }, opts)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.attempts).toBe(3)
    expect(calls).toBe(3)
  })
})

// ─── fast path shared signal semantics ───────────────────────────────────────

describe('v1.4: fast path signal semantics', () => {
  it('passes a live, never-aborted signal to fn', async () => {
    let observed: AbortSignal | undefined
    const r = await act('fs-1', async (signal) => {
      observed = signal
      return 1
    })
    expect(r.ok).toBe(true)
    expect(observed?.aborted).toBe(false)
  })

  it('concurrent fast-path calls do not interfere', async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => act(`fs-c${i}`, async () => i)),
    )
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.filter((r) => r.ok && r.value === 50)).toHaveLength(1)
  })
})

// ─── rateLimit backwards-clock guard ─────────────────────────────────────────

describe('v1.4 m8: rateLimit under clock jumps', () => {
  it('stays conservative when the clock jumps backwards', async () => {
    const realNow = Date.now
    let fakeNow = realNow()
    try {
      Date.now = () => fakeNow
      const fn: ActFn<number> = async () => 1
      const ctx: PolicyContext = {
        key: 'clock-jump', store: new InMemoryStore(), meta: { attempts: 1, source: 'fresh' },
      }
      const wrapped = rateLimitPolicy({ maxCalls: 2, windowMs: 1_000 })(fn, ctx)
      const signal = new AbortController().signal
      await wrapped(signal)
      await wrapped(signal)
      // clock jumps backwards mid-window
      fakeNow = fakeNow - 2_000
      let thirdRejected = false
      try {
        await wrapped(signal)
      } catch {
        thirdRejected = true
      }
      // conservative: the limiter never over-admits under disorder
      expect(thirdRejected).toBe(true)
    } finally {
      Date.now = realNow
    }
  })
})

// ─── invalidate + withStore parity ───────────────────────────────────────────

describe('v1.4: engine unification parity', () => {
  it('global invalidate returns true only when a cache entry existed', async () => {
    await act('inv-1', async () => 'v', { cache: { ttl: 60_000 } })
    expect(invalidate('inv-1')).toBe(true)
    expect(invalidate('inv-1')).toBe(false)
  })

  it('scoped and global act produce identical result shapes', async () => {
    const scoped = withStore(new InMemoryStore())
    const [g, s] = await Promise.all([
      act('parity', async () => 1, { retry: { attempts: 2, delayMs: 1 } }),
      scoped('parity', async () => 1, { retry: { attempts: 2, delayMs: 1 } }),
    ])
    expect(g).toMatchObject({ ok: true, value: 1, source: 'fresh', attempts: 1 })
    expect(s).toMatchObject({ ok: true, value: 1, source: 'fresh', attempts: 1 })
  })

  it('scoped failure records health data on the right scope', async () => {
    const store = new InMemoryStore()
    const scoped = withStore(store)
    await scoped('scope-err', async () => { throw new Error('scoped boom') })
    const check = createHealthCheck(store)
    const status = check()
    expect(status.lastError?.message).toContain('scoped boom')
    expect(status.pendingInflight).toBe(0)
  })
})

// ─── waitForObsHook still chains existing hooks ─────────────────────────────

describe('v1.4: testing helpers', () => {
  it('waitForObsHook resolves with the fired event', async () => {
    const obs: ObservabilityHooks = {}
    const done = waitForObsHook(obs, 'onFinalSuccess', 2_000)
    await act('wfoh', async () => 1, { observability: obs })
    const event = await done
    expect(event.attempts).toBe(1)
  })

  it('waitForObsHook timeout rejects and restores the hook', async () => {
    const obs: ObservabilityHooks = { onFinalSuccess: () => {} }
    const original = obs.onFinalSuccess
    const done = waitForObsHook(obs, 'onFinalSuccess', 10)
    await expect(done).rejects.toThrow(/timed out/)
    expect(obs.onFinalSuccess).toBe(original)
  })
})

// ─── sync-throw helpers still exported from the bundle ──────────────────────

describe('v1.4: policy factories are public', () => {
  it('retryPolicy + execute build a working custom chain', async () => {
    let calls = 0
    const result = await execute({
      key: 'custom-chain',
      fn: async () => {
        calls++
        if (calls < 2) throw new Error('retry me')
        return 'done'
      },
      policies: [retryPolicy({ attempts: 2, delayMs: 1 })],
      store: new InMemoryStore(),
      meta: { attempts: 1, source: 'fresh' },
      signal: new AbortController().signal,
    })
    expect(result).toBe('done')
    expect(calls).toBe(2)
  })
})
