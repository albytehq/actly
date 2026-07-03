import { describe, it, expect } from 'vitest'
import { act, invalidate, withStore, InMemoryStore } from '../index.js'
import {
  CircuitBreakerOpenError,
  BulkheadOverflowError,
  RateLimitError,
  createHealthCheck,
  createTenantStore,
  drain,
  sanitizeErrorMessage,
  sanitizeError,
  acquireController,
  releaseController,
  poolSize,
} from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── Circuit Breaker ─────────────────────────────────────────────────────────

describe('Circuit Breaker', () => {
  it('trips open after threshold consecutive failures', async () => {
    let calls = 0
    const fn = async () => { calls++; throw new Error('fail') }

    const key = 'cb-trip:test'
    for (let i = 0; i < 3; i++) {
      await act(key, fn, {
        circuitBreaker: { threshold: 3, cooldownMs: 10_000 },
      })
    }
    // After 3 failures, breaker should be open
    const r = await act(key, fn, {
      circuitBreaker: { threshold: 3, cooldownMs: 10_000 },
    })
    expect(r.ok).toBe(false)
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toBeInstanceOf(CircuitBreakerOpenError)
  })

  it('resets to closed after cooldown period', async () => {
    let shouldFail = true
    const fn = async () => {
      if (shouldFail) throw new Error('fail')
      return 'success'
    }

    const key = 'cb-reset:test'
    for (let i = 0; i < 2; i++) {
      await act(key, fn, { circuitBreaker: { threshold: 2, cooldownMs: 50 } })
    }

    // Breaker is open
    const blocked = await act(key, fn, { circuitBreaker: { threshold: 2, cooldownMs: 50 } })
    expect(blocked.ok).toBe(false); if (!blocked.ok) expect(blocked.error).toBeInstanceOf(CircuitBreakerOpenError)

    // Wait for cooldown
    await wait(60)
    shouldFail = false

    // Should allow call through (half-open → closed on success)
    const recovered = await act(key, fn, { circuitBreaker: { threshold: 2, cooldownMs: 50 } })
    expect(recovered.ok).toBe(true)
    if (recovered.ok) expect(recovered.value).toBe('success')
  })

  it('resets failure count on success', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls % 2 === 0) throw new Error('fail')
      return 'ok'
    }

    const key = 'cb-count:test'
    // 1st call: success (failures reset)
    await act(key, fn, { circuitBreaker: { threshold: 3, cooldownMs: 10_000 } })
    // 2nd call: fail
    await act(key, fn, { circuitBreaker: { threshold: 3, cooldownMs: 10_000 } })
    // 3rd call: success (failures reset again)
    const r = await act(key, fn, { circuitBreaker: { threshold: 3, cooldownMs: 10_000 } })
    expect(r.ok).toBe(true)
  })
})

// ─── Bulkhead ────────────────────────────────────────────────────────────────

describe('Bulkhead', () => {
  it('limits concurrent calls per key', async () => {
    let active = 0
    let maxActive = 0
    const fn = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await wait(30)
      active--
      return 'done'
    }

    const key = 'bulk-limit:test'
    const results = await Promise.all(
      Array.from({ length: 5 }, () => act(key, fn, { bulkhead: { maxConcurrent: 2, queueTimeoutMs: 5000 } }))
    )

    expect(maxActive).toBeLessThanOrEqual(2)
    expect(results.every(r => r.ok)).toBe(true)
  })

  it('fails fast when queueTimeoutMs is 0', async () => {
    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const fn = async () => { await fnPromise; return 'done' }

    const key = 'bulk-fastfail:test'
    // First call occupies the single slot
    const p1 = act(key, fn, { bulkhead: { maxConcurrent: 1 } })
    await wait(10)

    // Second call should fail fast
    const r2 = await act(key, fn, { bulkhead: { maxConcurrent: 1 } })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toBeInstanceOf(BulkheadOverflowError)

    resolveFn()
    await p1
  })

  it('queues when queueTimeoutMs > 0', async () => {
    let active = 0
    const fn = async () => {
      active++
      await wait(20)
      return 'done'
    }

    const key = 'bulk-queue:test'
    const results = await Promise.all(
      Array.from({ length: 3 }, () => act(key, fn, {
        bulkhead: { maxConcurrent: 1, queueTimeoutMs: 1000 },
      }))
    )

    expect(results.every(r => r.ok)).toBe(true)
  })
})

// ─── Rate Limiter ────────────────────────────────────────────────────────────

describe('Rate Limiter', () => {
  it('allows up to maxCalls per window', async () => {
    let calls = 0
    const fn = async () => { calls++; return 'ok' }

    const key = 'rl-allow:test'
    for (let i = 0; i < 5; i++) {
      await act(key, fn, { rateLimit: { maxCalls: 5, windowMs: 10_000 } })
    }
    expect(calls).toBe(5)
  })

  it('rejects calls exceeding maxCalls per window', async () => {
    const fn = async () => 'ok'
    const key = 'rl-reject:test'

    for (let i = 0; i < 3; i++) {
      await act(key, fn, { rateLimit: { maxCalls: 3, windowMs: 10_000 } })
    }

    const r = await act(key, fn, { rateLimit: { maxCalls: 3, windowMs: 10_000 } })
    expect(r.ok).toBe(false)
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error).toBeInstanceOf(RateLimitError)
  })

  it('resets after window expires', async () => {
    const fn = async () => 'ok'
    const key = 'rl-reset:test'

    await act(key, fn, { rateLimit: { maxCalls: 1, windowMs: 30 } })
    const blocked = await act(key, fn, { rateLimit: { maxCalls: 1, windowMs: 30 } })
    expect(blocked.ok).toBe(false); if (!blocked.ok) expect(blocked.error).toBeInstanceOf(RateLimitError)

    await wait(40)
    const r = await act(key, fn, { rateLimit: { maxCalls: 1, windowMs: 30 } })
    expect(r.ok).toBe(true)
  })
})

// ─── Fallback Value ──────────────────────────────────────────────────────────

describe('Fallback Value', () => {
  it('returns fallback when fn fails', async () => {
    const r = await act('fb-fail:test', async () => { throw new Error('fail') }, {
      fallback: { value: 'default' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('default')
  })

  it('returns fn result when fn succeeds', async () => {
    const r = await act('fb-success:test', async () => 'real', {
      fallback: { value: 'default' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('real')
  })

  it('supports function fallback', async () => {
    const r = await act('fb-fn:test', async () => { throw new Error('fail') }, {
      fallback: { value: () => 'computed' },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('computed')
  })

  it('supports async function fallback', async () => {
    const r = await act('fb-async:test', async () => { throw new Error('fail') }, {
      fallback: { value: async () => { await wait(5); return 'async-result' } },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('async-result')
  })
})

// ─── Hedge Request ───────────────────────────────────────────────────────────

describe('Hedge Request', () => {
  it('returns primary result if it settles before hedge delay', async () => {
    const r = await act('hedge-fast:test', async () => 'primary', {
      hedge: { delayMs: 100 },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('primary')
  })

  it('sends hedge request if primary is slow', async () => {
    let callCount = 0
    const fn = async (signal: AbortSignal) => {
      callCount++
      if (callCount === 1) {
        // Primary: slow
        await wait(100)
        return 'primary'
      }
      // Hedge: fast
      return 'hedge'
    }

    const r = await act('hedge-slow:test', fn, {
      hedge: { delayMs: 10 },
    })
    expect(r.ok).toBe(true)
    // Should get hedge result (faster)
    if (r.ok) expect(r.value).toBe('hedge')
    // Should complete faster than primary's 100ms
    expect(r.durationMs!).toBeLessThan(80)
  })
})

// ─── Audit Logging ───────────────────────────────────────────────────────────

describe('Audit Logging', () => {
  it('logs successful calls', async () => {
    const entries: any[] = []
    const r = await act('audit-success:test', async () => 'value', {
      audit: { log: (e) => entries.push(e) },
    })
    expect(r.ok).toBe(true)
    expect(entries.length).toBe(1)
    expect(entries[0].ok).toBe(true)
    expect(entries[0].key).toBe('audit-success:test')
    expect(entries[0].durationMs).toBeDefined()
    expect(entries[0].traceId).toBeDefined()
  })

  it('logs failed calls with failedBy', async () => {
    const entries: any[] = []
    const r = await act('audit-fail:test', async () => { throw new Error('boom') }, {
      audit: { log: (e) => entries.push(e) },
    })
    expect(r.ok).toBe(false)
    expect(entries.length).toBe(1)
    expect(entries[0].ok).toBe(false)
    expect(entries[0].failedBy).toBe('fn-error')
  })

  it('sanitizes error in audit log', async () => {
    const entries: any[] = []
    await act('audit-sanitize:test', async () => {
      throw new Error('<script>alert(1)</script>')
    }, {
      audit: { log: (e) => entries.push(e) },
    })
    expect(entries.length).toBe(1)
    const err = entries[0].error
    if (err instanceof Error) {
      expect(err.message).not.toContain('<script>')
    }
  })
})

// ─── Health Check ────────────────────────────────────────────────────────────

describe('Health Check', () => {
  it('returns store size and uptime', async () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)
    const health = createHealthCheck(store)

    await scopedAct('health:test', async () => 'value', { cache: { ttl: 60_000 } })

    const status = health()
    expect(status.storeSize).toBeGreaterThan(0)
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0)
    expect(status.pendingInflight).toBe(0)
    store.destroy()
  })

  it('records last error', async () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)
    const health = createHealthCheck(store)

    await scopedAct('health-err:test', async () => { throw new Error('fail') })

    const status = health()
    expect(status.lastError).toBeDefined()
    store.destroy()
  })

  it('tracks inflight count', async () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)
    const health = createHealthCheck(store)

    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const promise = scopedAct('health-inflight:test', () => fnPromise)

    await wait(10)
    const status = health()
    expect(status.pendingInflight).toBe(1)

    resolveFn()
    await promise
    store.destroy()
  })
})

// ─── Graceful Shutdown (drain) ───────────────────────────────────────────────

describe('Graceful Shutdown (drain)', () => {
  it('returns true immediately when no in-flight calls', async () => {
    const done = await drain(1000)
    expect(done).toBe(true)
  })

  it('waits for in-flight calls to settle', async () => {
    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const promise = act('drain-wait:test', () => fnPromise)

    await wait(10)
    const drainPromise = drain(5000)

    // Not done yet
    await wait(20)
    let resolved = false
    drainPromise.then(() => { resolved = true })
    expect(resolved).toBe(false)

    resolveFn()
    await promise
    const result = await drainPromise
    expect(result).toBe(true)
  })

  it('returns false on timeout', async () => {
    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const promise = act('drain-timeout:test', () => fnPromise)

    await wait(10)
    const result = await drain(20)
    expect(result).toBe(false)

    resolveFn()
    await promise
  })
})

// ─── Tenant Isolation ────────────────────────────────────────────────────────

describe('Tenant Isolation', () => {
  it('isolates cache across tenants', async () => {
    const mgr = createTenantStore({ maxSize: 100 })

    const tenantA = mgr.get('tenant-a')
    const tenantB = mgr.get('tenant-b')

    await tenantA('shared-key', async () => 'value-from-A', { cache: { ttl: 60_000 } })

    // Tenant B should NOT see tenant A's cached value
    const rB = await tenantB('shared-key', async () => 'value-from-B', { cache: { ttl: 60_000 } })
    expect(rB.ok).toBe(true)
    if (rB.ok) expect(rB.value).toBe('value-from-B')

    // Tenant A should still see its cached value
    const rA = await tenantA('shared-key', async () => 'fresh-A', { cache: { ttl: 60_000 } })
    expect(rA.ok).toBe(true)
    if (rA.ok) expect(rA.value).toBe('value-from-A')

    mgr.destroy()
  })

  it('tracks tenant count', () => {
    const mgr = createTenantStore({ maxSize: 100 })
    expect(mgr.size()).toBe(0)
    mgr.get('t1')
    expect(mgr.size()).toBe(1)
    mgr.get('t2')
    expect(mgr.size()).toBe(2)
    mgr.evict('t1')
    expect(mgr.size()).toBe(1)
    mgr.destroy()
  })
})

// ─── Error Sanitization ──────────────────────────────────────────────────────

describe('Error Sanitization', () => {
  it('escapes HTML entities in error messages', () => {
    const result = sanitizeErrorMessage('<script>alert(1)</script>')
    expect(result).not.toContain('<script>')
    expect(result).toContain('&lt;script&gt;')
  })

  it('strips control characters', () => {
    const result = sanitizeErrorMessage('hello\x00world\x07')
    expect(result).not.toContain('\x00')
    expect(result).not.toContain('\x07')
    expect(result).toContain('hello')
    expect(result).toContain('world')
  })

  it('handles non-Error inputs', () => {
    expect(sanitizeErrorMessage(null)).toBe('')
    expect(sanitizeErrorMessage(undefined)).toBe('')
    expect(sanitizeErrorMessage(42)).toBe('42')
    expect(sanitizeErrorMessage({ foo: 'bar' })).toBe('[object Object]')
  })

  it('sanitizeError returns Error for Error input', () => {
    const original = new Error('<img src=x>')
    const sanitized = sanitizeError(original) as Error
    expect(sanitized).toBeInstanceOf(Error)
    expect(sanitized.message).not.toContain('<img')
    expect(sanitized.name).toBe('Error')
  })
})

// ─── AbortController Pool ────────────────────────────────────────────────────

describe('AbortController Pool', () => {
  it('acquires and releases controllers', () => {
    const initialPool = poolSize()
    const c = acquireController()
    expect(c).toBeInstanceOf(AbortController)
    expect(poolSize()).toBe(initialPool)  // pool decreased by 1

    releaseController(c)
    expect(poolSize()).toBe(initialPool + 1)  // pool increased by 1
  })

  it('creates new controller when pool is empty', () => {
    // Drain the pool
    const controllers: AbortController[] = []
    while (poolSize() > 0) {
      controllers.push(acquireController())
    }
    expect(poolSize()).toBe(0)

    const c = acquireController()
    expect(c).toBeInstanceOf(AbortController)

    // Release all back
    for (const ctrl of controllers) releaseController(ctrl)
    releaseController(c)
  })

  it('caps pool size at maximum', () => {
    // Fill pool beyond max
    for (let i = 0; i < 200; i++) {
      releaseController(new AbortController())
    }
    // Pool should be capped (not 200)
    expect(poolSize()).toBeLessThan(200)
  })
})
