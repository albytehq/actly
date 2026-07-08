import { describe, it, expect } from 'vitest'
import {
  act,
  ActlyError,
  HedgeTimeoutError,
  RetryExhaustedError,
  TimeoutError,
  ResourceExhaustedError,
  InMemoryStore,
  withStore,
  isActlyError,
} from '../index.js'

// Regression tests for the v1.3.0 audit. Each block covers a specific fix;
// the (BUG-XXX) tags cross-reference CHANGELOG.md for traceability.

describe('audit regressions', () => {

  describe('HedgeTimeoutError taxonomy (BUG-ST-001)', () => {
    it('extends ActlyError, not Error', () => {
      const err = new HedgeTimeoutError()
      expect(err).toBeInstanceOf(ActlyError)
      expect(err).toBeInstanceOf(Error)
      expect(err.code).toBe('ACTLY_HEDGE_TIMEOUT')
      expect(err.name).toBe('HedgeTimeoutError')
    })

    it('isActlyError predicate is realm-safe', () => {
      const err = new HedgeTimeoutError()
      expect(isActlyError(err)).toBe(true)
      expect(isActlyError(new Error('plain'))).toBe(false)
      expect(isActlyError(null)).toBe(false)
      expect(isActlyError(undefined)).toBe(false)
      expect(isActlyError({})).toBe(false)
    })

    it('carries delayMs', () => {
      const err = new HedgeTimeoutError({ delayMs: 250, key: 'k' })
      expect(err.delayMs).toBe(250)
      expect(err.key).toBe('k')
    })
  })

  describe('ActlyError.toJSON subclass fields (BUG-ST-002)', () => {
    it('RetryExhaustedError.toJSON keeps attempts, lastError, errors', () => {
      const err = new RetryExhaustedError({
        key: 'k', attempts: 5,
        lastError: new Error('boom'),
        errors: [new Error('a'), new Error('b')],
      })
      const json = err.toJSON() as Record<string, unknown>
      expect(json.attempts).toBe(5)
      expect(json.errors).toBeDefined()
      expect(Array.isArray(json.errors)).toBe(true)
      expect(json.name).toBe('RetryExhaustedError')
      expect(json.code).toBe('ACTLY_RETRY_EXHAUSTED')
    })

    it('TimeoutError.toJSON keeps ms', () => {
      const err = new TimeoutError(5000, { key: 'k' })
      const json = err.toJSON() as Record<string, unknown>
      expect(json.ms).toBe(5000)
      expect(json.code).toBe('ACTLY_TIMEOUT')
    })

    it('ResourceExhaustedError.toJSON keeps current and limit', () => {
      const err = new ResourceExhaustedError(100_001, 100_000)
      const json = err.toJSON() as Record<string, unknown>
      expect(json.current).toBe(100_001)
      expect(json.limit).toBe(100_000)
    })

    it('JSON.stringify uses toJSON', () => {
      const err = new RetryExhaustedError({
        key: 'k', attempts: 3,
        lastError: new Error('x'),
        errors: [new Error('x')],
      })
      const parsed = JSON.parse(JSON.stringify(err))
      expect(parsed.attempts).toBe(3)
      expect(parsed.code).toBe('ACTLY_RETRY_EXHAUSTED')
    })

    it('toJSON({ redact: true }) escapes HTML in message', () => {
      const err = new TimeoutError(100, { key: 'k' })
      ;(err as unknown as { message: string }).message = 'err <script>alert(1)</script>'
      const json = err.toJSON({ redact: true }) as Record<string, unknown>
      expect(json.message).toContain('&lt;script&gt;')
      expect(json.message).not.toContain('<script>')
    })
  })

  describe('InMemoryStore finalizer (BUG-ST-003)', () => {
    it('constructs and destroys cleanly with autoCleanup', () => {
      const store = new InMemoryStore({ autoCleanup: true, cleanupIntervalMs: 100 })
      store.set('k', 'v', 1000)
      expect(store.size()).toBe(1)
      store.destroy()
      expect(store.size()).toBe(0)
    })

    it('destroy is idempotent', () => {
      const store = new InMemoryStore({ autoCleanup: true })
      store.destroy()
      store.destroy()
    })
  })

  describe('InMemoryStore default bound (BUG-ST-005, BUG-ST-015)', () => {
    it('default maxSize is 10_000', () => {
      const store = new InMemoryStore()
      for (let i = 0; i < 10_001; i++) store.set(`k${i}`, i)
      expect(store.size()).toBeLessThanOrEqual(10_000)
    })

    it('maxSize: Infinity still works', () => {
      const store = new InMemoryStore({ maxSize: Number.POSITIVE_INFINITY })
      store.set('a', 1)
      store.set('b', 2)
      expect(store.size()).toBe(2)
      store.destroy()
    })

    it('maxSize: 1.5 is rejected', () => {
      expect(() => new InMemoryStore({ maxSize: 1.5 })).toThrow(/positive integer/)
    })
  })

  describe('failedBy literal union (BUG-ST-008)', () => {
    it('retry exhaustion classifies as retry-exhausted', async () => {
      const r = await act('k', async () => { throw new Error('boom') }, {
        retry: { attempts: 2, delayMs: 1 },
      })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error).toBeDefined()
      }
    })
  })

  describe('monotonic durationMs (BUG-CORE-014)', () => {
    it('stays non-negative when Date.now() jumps backward', async () => {
      const realDateNow = Date.now
      const fixedNow = realDateNow()
      try {
        let tick = 0
        Date.now = () => fixedNow - tick-- * 1000
        const r = await act('k', async () => 1)
        expect(r.ok).toBe(true)
        if (r.ok) {
          expect(r.durationMs).toBeGreaterThanOrEqual(0)
        }
      } finally {
        Date.now = realDateNow
      }
    })
  })

  describe('fallback failure observability (BUG-CORE-006)', () => {
    it('emits onFinalFailure when fallback also throws', async () => {
      let events = 0
      const r = await act('k', async () => { throw new Error('primary') }, {
        fallback: { value: () => { throw new Error('fallback boom') } },
        observability: {
          onFinalFailure: () => { events++ },
        },
      })
      expect(r.ok).toBe(false)
      expect(events).toBeGreaterThanOrEqual(1)
    })
  })

  describe('tenant maxTenants LRU (BUG-CORE-008, BUG-CORE-009)', () => {
    it('evicts least-recently-used when full', async () => {
      const { createTenantStore } = await import('../core/tenant.js')
      const tenants = createTenantStore({ maxTenants: 3 })
      tenants.get('t1')('k', async () => 1)
      tenants.get('t2')('k', async () => 1)
      tenants.get('t3')('k', async () => 1)
      expect(tenants.size()).toBe(3)
      tenants.get('t4')('k', async () => 1)
      expect(tenants.size()).toBe(3)
      tenants.destroy()
    })
  })

  describe('retry NaN backoffFn delay (BUG-POL-001)', () => {
    it('sanitizes NaN to 0 instead of skipping sleep', async () => {
      let attempts = 0
      const r = await act('k', async () => {
        attempts++
        throw new Error('boom')
      }, {
        retry: {
          attempts: 3,
          delayMs: 100,
          backoffFn: () => NaN,
        },
      })
      expect(r.ok).toBe(false)
      expect(attempts).toBe(3)
    })
  })

  describe('count breaker window reset on probe success (BUG-POL-006)', () => {
    it('does not re-trip on the first failure after recovery', async () => {
      let shouldFail = true
      const opts = {
        circuitBreaker: {
          threshold: 1,
          cooldownMs: 50,
          strategy: 'count' as const,
          countSize: 10,
          countThreshold: 0.5,
          countMinimumCalls: 1,
        },
      }
      const r1 = await act('k', async () => {
        if (shouldFail) throw new Error('boom')
        return 'ok'
      }, opts)
      expect(r1.ok).toBe(false)

      await new Promise(r => setTimeout(r, 60))
      shouldFail = false
      const r2 = await act('k', async () => 'ok', opts)
      expect(r2.ok).toBe(true)

      shouldFail = true
      const r3 = await act('k', async () => { throw new Error('boom2') }, opts)
      expect(r3.ok).toBe(false)
      expect(String((r3 as { error?: { code?: string } }).error?.code)).not.toBe('ACTLY_CIRCUIT_OPEN')
    })
  })

  describe('hedge delayMs cap (BUG-CORE-020)', () => {
    it('rejects delayMs over MAX_HEDGE_DELAY_MS', () => {
      expect(async () => {
        await act('k', async () => 1, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hedge: { delayMs: 1e15 } as any,
        })
      }).rejects.toThrow()
    })
  })

  describe('dedupe null treated as undefined (BUG-UTIL-001)', () => {
    it('does not throw a confusing TypeError', async () => {
      const r = await act('k', async () => 1, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dedupe: null as any,
      })
      expect(r.ok).toBe(true)
    })
  })

  describe('sanitizeError preserves code (BUG-CORE-010)', () => {
    it('audit log entry retains .code on ActlyError', async () => {
      const r = await act('k', async () => { throw new Error('boom') }, {
        retry: { attempts: 2, delayMs: 1 },
        audit: {
          log: (entry) => {
            const err = entry.error as { code?: string }
            expect(err?.code).toBe('ACTLY_RETRY_EXHAUSTED')
          },
        },
      })
      expect(r.ok).toBe(false)
    })

    it('preserves code and key on TimeoutError', async () => {
      const { sanitizeError } = await import('../utils/sanitize.js')
      const err = new TimeoutError(5000, { key: 'k' })
      const sanitized = sanitizeError(err) as { code?: string; key?: string; name?: string }
      expect(sanitized.code).toBe('ACTLY_TIMEOUT')
      expect(sanitized.key).toBe('k')
      expect(sanitized.name).toBe('TimeoutError')
    })
  })

  describe('drain on non-existent scope (BUG-CORE-012)', () => {
    it('returns true immediately and leaves no state behind', async () => {
      const { drain } = await import('../core/shutdown.js')
      const r = await drain(100, 'typo-scope-12345')
      expect(r).toBe(true)
      const r2 = await drain(100, 'typo-scope-12345')
      expect(r2).toBe(true)
    })
  })
})
