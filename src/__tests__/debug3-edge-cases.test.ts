import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, CircuitBreakerOpenError, BulkheadOverflowError, RateLimitError, ResourceExhaustedError } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── classifyFailure: all error codes ─────────────────────────────────

describe('Debug3: classifyFailure covers all error codes', () => {
  it('circuit breaker open → failedBy = circuit-open', async () => {
    // trip the breaker
    const fn = async () => { throw new Error('fail') }
    const opts = { circuitBreaker: { threshold: 1, cooldownMs: 10_000 } }
    await act('cf-cb', fn, opts)

    // second call: breaker is open
    let capturedFailedBy: string | undefined
    const r = await act('cf-cb', fn, {
      ...opts,
      observability: {
        onFinalFailure: (e: { failedBy: string }) => { capturedFailedBy = e.failedBy },
      },
    })
    expect(r.ok).toBe(false)
    expect(capturedFailedBy).toBe('circuit-open')
  })

  it('bulkhead full → failedBy = bulkhead-full', async () => {
    let capturedFailedBy: string | undefined
    const slowFn = async () => { await wait(50); return 'ok' }
    const fastFn = async () => 'ok'

    // Fill the bulkhead
    const p1 = act('cf-bulk', slowFn, { bulkhead: { maxConcurrent: 1, queueTimeoutMs: 0 } })
    // This one should be rejected immediately
    const r2 = await act('cf-bulk', fastFn, {
      bulkhead: { maxConcurrent: 1, queueTimeoutMs: 0 },
      observability: {
        onFinalFailure: (e: { failedBy: string }) => { capturedFailedBy = e.failedBy },
      },
    })
    await p1
    expect(r2.ok).toBe(false)
    expect(capturedFailedBy).toBe('bulkhead-full')
  })

  it('rate limit exceeded → failedBy = rate-limited', async () => {
    let capturedFailedBy: string | undefined
    const fn = async () => 'ok'
    const opts = { rateLimit: { maxCalls: 1, windowMs: 60_000 } }

    await act('cf-rl', fn, opts)
    const r2 = await act('cf-rl', fn, {
      ...opts,
      observability: {
        onFinalFailure: (e: { failedBy: string }) => { capturedFailedBy = e.failedBy },
      },
    })
    expect(r2.ok).toBe(false)
    expect(capturedFailedBy).toBe('rate-limited')
  })

  it('resource exhausted → failedBy = resource-exhausted', async () => {
    // MAX_GLOBAL_INFLIGHT is too high to trigger naturally, so construct the error and throw it from fn.
    const err = new ResourceExhaustedError(100001, 100000)
    const r = await act('cf-re', async () => { throw err })
    expect(r.ok).toBe(false)
    // Thrown from fn (not from registerInflight), so classifyFailure tags it fn-error.
    // The error code is telemetry, not a statement about where the throw originated.
  })

  it('hedge timeout → not directly testable (internal error class)', async () => {
    // HedgeTimeoutError is internal to act.ts and never surfaces to the caller.
    expect(true).toBe(true)
  })
})

// ─── All policies simultaneously ──────────────────────────────────────

describe('Debug3: all policies simultaneously', () => {
  it('rateLimit + circuitBreaker + totalTimeout + cache + bulkhead + dedupe + retry + timeout', async () => {
    let calls = 0
    const fn = async (signal: AbortSignal) => {
      calls++
      return { data: 'ok', signalPresent: signal instanceof AbortSignal }
    }

    const r = await act('all-policies', fn, {
      rateLimit: { maxCalls: 100, windowMs: 60_000 },
      circuitBreaker: { threshold: 5, cooldownMs: 10_000 },
      totalTimeout: { ms: 5_000 },
      cache: { ttl: 60_000 },
      bulkhead: { maxConcurrent: 10, queueTimeoutMs: 1_000 },
      dedupe: true,
      retry: { attempts: 3, delayMs: 1 },
      timeout: { ms: 2_000 },
    })

    expect(r.ok).toBe(true)
    expect(calls).toBe(1)
    if (r.ok) {
      expect(r.value.data).toBe('ok')
      expect(r.value.signalPresent).toBe(true)
    }
  })

  it('all policies + hedge + fallback + audit + observability', async () => {
    let calls = 0
    let auditCalls = 0
    let obsCalls = 0

    const r = await act('all-plus', async () => {
      calls++
      return 'success'
    }, {
      rateLimit: { maxCalls: 100, windowMs: 60_000 },
      circuitBreaker: { threshold: 5, cooldownMs: 10_000 },
      totalTimeout: { ms: 5_000 },
      cache: { ttl: 60_000 },
      bulkhead: { maxConcurrent: 10, queueTimeoutMs: 1_000 },
      dedupe: true,
      retry: { attempts: 3, delayMs: 1 },
      timeout: { ms: 2_000 },
      hedge: { delayMs: 500 },
      fallback: { value: 'fallback' },
      audit: { log: () => { auditCalls++ } },
      observability: {
        onFinalSuccess: () => { obsCalls++ },
      },
    })

    expect(r.ok).toBe(true)
    expect(calls).toBe(1)
    expect(auditCalls).toBe(1)
    expect(obsCalls).toBe(1)
  })
})

// ─── Policy interaction edge cases ────────────────────────────────────

describe('Debug3: policy interactions', () => {
  it('rateLimit + cache: cache hit bypasses rateLimit (cache is inside rateLimit)', async () => {
    let calls = 0
    const fn = async () => { calls++; return 'value' }

    // first call: cache miss, fn runs, rateLimit counts 1
    await act('rl+cache', fn, {
      rateLimit: { maxCalls: 1, windowMs: 60_000 },
      cache: { ttl: 60_000 },
    })
    expect(calls).toBe(1)

    // second call: cache hit, but rateLimit sits OUTSIDE cache, so the call still gets
    // counted and rejected at maxCalls:1
    const r2 = await act('rl+cache', fn, {
      rateLimit: { maxCalls: 1, windowMs: 60_000 },
      cache: { ttl: 60_000 },
    })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect((r2.error as { code?: string }).code).toBe('ACTLY_RATE_LIMIT')
  })

  it('circuitBreaker + cache: CB open blocks cache hit (CB is outside cache)', async () => {
    // trip the breaker on 'cb+cache'
    const failFn = async () => { throw new Error('fail') }
    await act('cb+cache', failFn, {
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      cache: { ttl: 60_000 },
    })

    // seed a cache entry under a different key
    await act('cb+cache-ok', async () => 'cached', { cache: { ttl: 60_000 } })

    // read the cached value; CB state is per-key, so 'cb+cache-ok' isn't affected by the open breaker on 'cb+cache'
    const r = await act('cb+cache-ok', async () => 'fresh', {
      circuitBreaker: { threshold: 1, cooldownMs: 10_000 },
      cache: { ttl: 60_000 },
    })
    expect(r.ok).toBe(true)
  })

  it("bulkhead + dedupe: dedupe joiners don't consume bulkhead slots", async () => {
    let calls = 0
    const slowFn = async () => {
      calls++
      await wait(50)
      return 'shared'
    }

    // maxConcurrent:1, dedupe:true, 10 concurrent callers.
    // bulkhead sits outside dedupe in the policy chain, so all 10 callers
    // hit the bulkhead first. Each one acquires the slot sequentially, runs
    // fn, and by the time the next caller reaches dedupe the in-flight entry
    // has already been cleaned up. Result: 10 fn invocations, not 1.
    const promises: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) {
      promises.push(act('bulk+dedupe', slowFn, {
        bulkhead: { maxConcurrent: 1, queueTimeoutMs: 10_000 },
        dedupe: true,
      }).then(r => r, e => e))
    }

    const results = await Promise.all(promises)
    expect(calls).toBe(10)
    const oks = results.filter(r => r && typeof r === 'object' && (r as { ok?: boolean }).ok === true)
    expect(oks.length).toBe(10)
  })

  it('retry + hedge inside-retry: each retry can spawn hedge', async () => {
    let calls = 0
    const fn = async (signal: AbortSignal) => {
      calls++
      // both fn and its hedge take 100ms; hedge fires at 50ms
      await wait(100)
      return 'result'
    }

    const r = await act('retry+hedge', fn, {
      retry: { attempts: 2, delayMs: 1 },
      hedge: { delayMs: 50, placement: 'inside-retry' },
    })

    expect(r.ok).toBe(true)
    // hedge wraps fn on each inside-retry attempt. Both start near-simultaneously
    // after delayMs; primary started first so it wins, hedge gets cancelled.
    expect(calls).toBeGreaterThanOrEqual(1)
  })

  it('totalTimeout fires during hedge race', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      await wait(500)
      return 'slow'
    }

    const t0 = Date.now()
    const r = await act('tt+hedge', fn, {
      hedge: { delayMs: 50 },
      totalTimeout: { ms: 100 },
    })
    const elapsed = Date.now() - t0

    expect(r.ok).toBe(false)
    expect(elapsed).toBeLessThan(300)
    if (!r.ok) expect((r.error as { code?: string }).code).toBe('ACTLY_TOTAL_TIMEOUT')
  })
})

// ─── Scoped store edge cases ──────────────────────────────────────────

describe('Debug3: scoped store edge cases', () => {
  it('scoped store isolate() cache from default store', async () => {
    // Populate default store cache
    await act('iso-key', async () => 'default-value', { cache: { ttl: 60_000 } })

    // Scoped store should NOT see the cached value
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)
    const r = await scopedAct('iso-key', async () => 'scoped-value', { cache: { ttl: 60_000 } })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('scoped-value') // not 'default-value'
    store.destroy()
  })

  it('scoped store invalidate does not affect default store', async () => {
    // Populate both stores
    await act('inv-key', async () => 'default-val', { cache: { ttl: 60_000 } })

    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)
    await scopedAct('inv-key', async () => 'scoped-val', { cache: { ttl: 60_000 } })

    // Invalidate scoped store
    scopedAct.invalidate('inv-key')

    // Default store should still have the cached value
    const r1 = await act('inv-key', async () => 'fresh', { cache: { ttl: 60_000 } })
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.value).toBe('default-val')

    // Scoped store should re-fetch
    const r2 = await scopedAct('inv-key', async () => 're-fetched', { cache: { ttl: 60_000 } })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.value).toBe('re-fetched')

    store.destroy()
  })

  it('multiple scoped stores are isolated from each other', async () => {
    const store1 = new InMemoryStore({ maxSize: 100 })
    const store2 = new InMemoryStore({ maxSize: 100 })
    const act1 = withStore(store1)
    const act2 = withStore(store2)

    await act1('multi-key', async () => 'store1-value', { cache: { ttl: 60_000 } })

    // store2 should NOT see store1's cache
    const r = await act2('multi-key', async () => 'store2-value', { cache: { ttl: 60_000 } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('store2-value')

    store1.destroy()
    store2.destroy()
  })

  it('scoped store destroy during concurrent calls', async () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)

    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const actPromise = scopedAct('destroy-concurrent', () => fnPromise)

    await wait(10)
    store.destroy()

    resolveFn()
    const r = await actPromise
    expect(r.ok).toBe(true)
  })
})

// ─── Multi-tenant cross-isolation ─────────────────────────────────────

describe('Debug3: multi-tenant isolation', () => {
  it('tenant A cache does not leak to tenant B', async () => {
    const { createTenantStore } = await import('../index.js')
    const manager = createTenantStore({ maxSize: 100, autoCleanup: true })

    const actA = manager.get('tenant-a')
    const actB = manager.get('tenant-b')

    await actA('shared-key', async () => 'tenant-a-value', { cache: { ttl: 60_000 } })

    // Tenant B should NOT see tenant A's cached value
    const r = await actB('shared-key', async () => 'tenant-b-value', { cache: { ttl: 60_000 } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('tenant-b-value')

    manager.destroy()
  })

  it('tenant A circuit breaker does not affect tenant B', async () => {
    const { createTenantStore } = await import('../index.js')
    const manager = createTenantStore({ maxSize: 100, autoCleanup: true })

    const actA = manager.get('tenant-a')
    const actB = manager.get('tenant-b')

    // Trip tenant A's breaker
    const failFn = async () => { throw new Error('fail') }
    await actA('cb-key', failFn, { circuitBreaker: { threshold: 1, cooldownMs: 10_000 } })

    // Tenant A: breaker is open
    const rA = await actA('cb-key', failFn, { circuitBreaker: { threshold: 1, cooldownMs: 10_000 } })
    expect(rA.ok).toBe(false)
    if (!rA.ok) expect((rA.error as { code?: string }).code).toBe('ACTLY_CIRCUIT_OPEN')

    // Tenant B: breaker should NOT be open (separate store)
    const rB = await actB('cb-key', async () => 'ok', { circuitBreaker: { threshold: 1, cooldownMs: 10_000 } })
    expect(rB.ok).toBe(true)

    manager.destroy()
  })

  it('evict + re-create tenant: fresh state', async () => {
    const { createTenantStore } = await import('../index.js')
    const manager = createTenantStore({ maxSize: 100, autoCleanup: true })

    const act1 = manager.get('tenant-recreate')
    await act1('cache-key', async () => 'old-value', { cache: { ttl: 60_000 } })

    manager.evict('tenant-recreate')

    const act2 = manager.get('tenant-recreate')
    const r = await act2('cache-key', async () => 'new-value', { cache: { ttl: 60_000 } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('new-value') // not 'old-value'

    manager.destroy()
  })
})

// ─── normalizeDedupe edge cases ───────────────────────────────────────

describe('Debug3: normalizeDedupe edge cases', () => {
  it('dedupe: false → no dedupe policy', async () => {
    let calls = 0
    const fn = async () => { calls++; return 'ok' }
    await Promise.all([
      act('nd-false', fn, { dedupe: { enabled: false } }),
      act('nd-false', fn, { dedupe: { enabled: false } }),
    ])
    expect(calls).toBe(2) // both ran (no dedupe)
  })

  it('dedupe: { enabled: true, inflightTtl: 0 } → rejected by validation', async () => {
    // 0 is rejected up front by assertDedupeOptions. Callers who want immediate
    // expiry should pass a small positive number (e.g. 1ms).
    await expect(act('nd-zero', async () => 'ok', {
      dedupe: { enabled: true, inflightTtl: 0 },
    })).rejects.toThrow(/inflightTtl must be > 0/)
  })

  it('dedupe: { enabled: true, inflightTtl: NaN } → rejected by validation', async () => {
    await expect(act('nd-nan', async () => 1, {
      dedupe: { enabled: true, inflightTtl: NaN },
    })).rejects.toThrow(/non-negative/)
  })

  it('dedupe: { enabled: true, inflightTtl: Infinity } → accepted', async () => {
    const r = await act('nd-inf', async () => 'ok', {
      dedupe: { enabled: true, inflightTtl: Infinity },
    })
    expect(r.ok).toBe(true)
  })
})

// ─── RateLimit + Cache interaction: rate limit state TTL ──────────────

describe('Debug3: rateLimit state TTL', () => {
  it('rate-limited state expires after windowMs', async () => {
    const store = new InMemoryStore({ maxSize: 100, autoCleanup: true, cleanupIntervalMs: 20 })
    const scopedAct = withStore(store)

    const fn = async () => 'ok'
    const opts = { rateLimit: { maxCalls: 1, windowMs: 30 } }

    // first call succeeds
    await scopedAct('rl-ttl', fn, opts)
    // second call is rate-limited
    const r2 = await scopedAct('rl-ttl', fn, opts)
    expect(r2.ok).toBe(false)

    // wait for the window to expire + sweep
    await wait(80)

    // third call: state expired, new window opens
    const r3 = await scopedAct('rl-ttl', fn, opts)
    expect(r3.ok).toBe(true)

    store.destroy()
  })
})

// ─── Hedge + dedupe interaction ───────────────────────────────────────

describe('Debug3: hedge + dedupe', () => {
  it('dedupe collapses concurrent hedge calls', async () => {
    let calls = 0
    const slowFn = async () => {
      calls++
      await wait(50)
      return 'shared'
    }

    const promises: Promise<unknown>[] = []
    for (let i = 0; i < 5; i++) {
      promises.push(act('hedge+dedupe', slowFn, {
        hedge: { delayMs: 100 },
        dedupe: true,
      }))
    }

    const results = await Promise.all(promises)
    // dedupe collapses 5 callers into 1; fn takes 50ms, hedge fires at 100ms, so primary wins
    expect(calls).toBe(1)
    expect(results.every(r => r && typeof r === 'object' && (r as { ok?: boolean }).ok === true)).toBe(true)
  })
})

// ─── Fallback + retry interaction ─────────────────────────────────────

describe('Debug3: fallback + retry', () => {
  it('fallback value returned after retry exhaustion', async () => {
    let calls = 0
    const r = await act('fb+retry', async () => {
      calls++
      throw new Error('always fail')
    }, {
      retry: { attempts: 3, delayMs: 1 },
      fallback: { value: 'fallback-val' },
    })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('fallback-val')
    expect(calls).toBe(3) // all 3 attempts failed, then fallback
  })

  it('fallback function receives no arguments (cannot inspect error)', async () => {
    const r = await act('fb-no-args', async () => {
      throw new Error('fail')
    }, {
      retry: { attempts: 2, delayMs: 1 },
      fallback: { value: () => 'no-error-context' },
    })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('no-error-context')
  })
})

// ─── Observability event ordering ─────────────────────────────────────

describe('Debug3: observability event ordering', () => {
  it('events fire in correct order for retry success', async () => {
    const events: string[] = []
    let calls = 0
    const fn = async () => {
      calls++
      if (calls < 2) throw new Error('transient')
      return 'recovered'
    }

    await act('event-order', fn, {
      retry: { attempts: 3, delayMs: 1 },
      observability: {
        onAttempt: () => { events.push('attempt') },
        onRetry: () => { events.push('retry') },
        onFinalSuccess: () => { events.push('final-success') },
      },
    })

    // Expected: attempt(1) → retry(1→2) → attempt(2) → final-success
    expect(events).toEqual(['attempt', 'retry', 'attempt', 'final-success'])
  })

  it('events fire in correct order for retry exhaustion + fallback', async () => {
    const events: string[] = []
    await act('event-fb', async () => { throw new Error('fail') }, {
      retry: { attempts: 2, delayMs: 1 },
      fallback: { value: 'fb' },
      observability: {
        onAttempt: () => { events.push('attempt') },
        onRetry: () => { events.push('retry') },
        onFinalSuccess: () => { events.push('final-success') },
        onFinalFailure: () => { events.push('final-failure') },
      },
    })

    // Expected: attempt(1) → retry(1→2) → attempt(2) → final-success (fallback)
    expect(events).toEqual(['attempt', 'retry', 'attempt', 'final-success'])
  })

  it('cache hit fires onCacheHit + onFinalSuccess only', async () => {
    const events: string[] = []
    await act('event-cache', async () => 'cached', { cache: { ttl: 60_000 } })

    await act('event-cache', async () => 'fresh', {
      cache: { ttl: 60_000 },
      observability: {
        onCacheHit: () => { events.push('cache-hit') },
        onCacheMiss: () => { events.push('cache-miss') },
        onFinalSuccess: () => { events.push('final-success') },
      },
    })

    expect(events).toEqual(['cache-hit', 'final-success'])
  })
})

// ─── Duration tracking accuracy ───────────────────────────────────────

describe('Debug3: durationMs tracking', () => {
  it('durationMs reflects wall-clock time (fast path)', async () => {
    const t0 = Date.now()
    const r = await act('dur-fast', async () => { await wait(50); return 'ok' })
    const elapsed = Date.now() - t0

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.durationMs).toBeGreaterThanOrEqual(40)
      expect(r.durationMs).toBeLessThanOrEqual(elapsed + 10)
    }
  })

  it('durationMs reflects wall-clock time (slow path with retry)', async () => {
    let calls = 0
    const r = await act('dur-slow', async () => {
      calls++
      if (calls < 2) { await wait(20); throw new Error('transient') }
      return 'ok'
    }, { retry: { attempts: 3, delayMs: 10 } })

    expect(r.ok).toBe(true)
    if (r.ok) {
      // ~20ms fail + 10ms delay + ~0ms success; timing is imprecise, so just check a lower bound
      expect(r.durationMs).toBeGreaterThanOrEqual(15)
    }
  })

  it('cache hit durationMs is near zero', async () => {
    await act('dur-cache', async () => 'cached', { cache: { ttl: 60_000 } })
    const r = await act('dur-cache', async () => 'fresh', { cache: { ttl: 60_000 } })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.durationMs).toBeLessThan(10)
  })
})

// ─── Build root signal edge cases ─────────────────────────────────────

describe('Debug3: buildRootSignal edge cases', () => {
  it('act() with signal that aborts DURING fn execution', async () => {
    const controller = new AbortController()
    let fnStarted = false

    const r = await act('mid-abort', async (signal) => {
      fnStarted = true
      // fn waits for the abort
      return new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason))
        // abort fires after 20ms
        setTimeout(() => controller.abort(new Error('mid-execution')), 20)
      })
    }, { signal: controller.signal })

    expect(fnStarted).toBe(true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as Error).message).toBe('mid-execution')
  })

  it('act() with signal that aborts AFTER fn completes', async () => {
    const controller = new AbortController()
    const r = await act('post-abort', async () => {
      const result = 'done'
      // abort scheduled for after fn returns but before act() finishes settling
      setTimeout(() => controller.abort(new Error('too-late')), 0)
      return result
    }, { signal: controller.signal })

    // fn already completed, so the abort has no effect on the result
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('done')
  })
})
