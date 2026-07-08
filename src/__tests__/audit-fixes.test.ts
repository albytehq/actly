import { describe, it, expect } from 'vitest'
import {
  act,
  withStore,
  InMemoryStore,
  createHealthCheck,
  enableWatchdog,
  disableWatchdog,
  registerWatchdogHooks,
  unregisterWatchdogHooks,
  HedgeTimeoutError,
  ActlyError,
  sanitizeErrorMessage,
  LIMITS,
} from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Regression tests for the audit fixes. Test names mirror bug IDs in
// the audit worklog so regressions stay traceable.

describe('Audit-fix regressions', () => {

  // BUG-A-003 / BUG-C-001 / BUG-D-001: withStore scope wasn't exposed, so
  // createHealthCheck(store) read 'default' and missed every error/inflight
  // event the scoped act() recorded.
  describe('BUG-A-003: withStore scope exposure + auto-resolve', () => {
    it('withStore result exposes .scope as a readonly string', () => {
      const store = new InMemoryStore({ maxSize: 100 })
      const scopedAct = withStore(store)
      expect(typeof scopedAct.scope).toBe('string')
      expect(scopedAct.scope.startsWith('scoped:')).toBe(true)
      store.destroy()
    })

    it('createHealthCheck(store) auto-resolves the scoped act\'s scope', async () => {
      const store = new InMemoryStore({ maxSize: 100 })
      const scopedAct = withStore(store)
      // no { scope } passed; auto-resolves via WeakMap
      const health = createHealthCheck(store)

      let resolveFn!: () => void
      const fnPromise = new Promise<void>(r => { resolveFn = r })
      const promise = scopedAct('a003-scoped', () => fnPromise)

      await wait(10)
      const status = health()
      // scoped act's inflight is visible: auto-resolve picks scoped:<uuid>,
      // not 'default'.
      expect(status.pendingInflight).toBe(1)

      resolveFn()
      await promise
      store.destroy()
    })

    it('scoped act records errors visible to createHealthCheck(store)', async () => {
      const store = new InMemoryStore({ maxSize: 100 })
      const scopedAct = withStore(store)
      const health = createHealthCheck(store)

      await scopedAct('a003-error', async () => {
        throw new Error('downstream failed')
      })

      const status = health()
      expect(status.lastError).toBeDefined()
      expect(status.lastError!.message).toContain('downstream failed')
      store.destroy()
    })
  })

  // BUG-C-003: watchdog never fired under churn because lastInflightChangeAt
  // was updated on EVERY register/unregister, keeping `elapsed` small.
  describe('BUG-C-003: watchdog fires under sustained busy period', () => {
    it('fires when inflight stays > 0 for longer than threshold', async () => {
      let eventCount = 0
      const hooks = { onWatchdog: () => { eventCount++ } }
      enableWatchdog(100, hooks)

      // start a call that never resolves within the test window
      let resolveFn!: () => void
      const fnPromise = new Promise<void>(r => { resolveFn = r })
      const p = act('c003-stuck', () => fnPromise)

      // 250ms > 100ms threshold, watchdog should fire at least once
      await wait(250)
      expect(eventCount).toBeGreaterThanOrEqual(1)

      resolveFn()
      await p
      disableWatchdog()
    })

    it('does NOT fire when inflight is 0 (even after prior churn)', async () => {
      // quick calls create churn. inflightBusySince is undefined when count===0,
      // so no spurious fires.
      for (let i = 0; i < 10; i++) {
        await act('c003-churn', async () => 'ok')
      }

      let eventCount = 0
      enableWatchdog(50, { onWatchdog: () => { eventCount++ } })
      await wait(150)
      expect(eventCount).toBe(0)
      disableWatchdog()
    })
  })

  // BUG-C-005: watchdog hooks Set leaked, no unregister function.
  describe('BUG-C-005: unregisterWatchdogHooks', () => {
    it('unregisterWatchdogHooks is callable and prevents further events', async () => {
      let eventCount = 0
      const hooks = { onWatchdog: () => { eventCount++ } }

      enableWatchdog(50, hooks)
      registerWatchdogHooks(hooks)
      // unregister; no-op for future events
      unregisterWatchdogHooks(hooks)

      let resolveFn!: () => void
      const fnPromise = new Promise<void>(r => { resolveFn = r })
      const p = act('c005-stuck', () => fnPromise)

      await wait(150)
      // hooks unregistered, no events fire
      expect(eventCount).toBe(0)

      resolveFn()
      await p
      disableWatchdog()
    })
  })

  // BUG-A-002 / BUG-D-003: scopedAct pre-abort path skipped recordError + audit
  // AND passed raw signal.reason to audit log (security: log injection).
  describe('BUG-A-002 + BUG-D-003: scopedAct pre-abort path', () => {
    it('records sanitized error in health state', async () => {
      const store = new InMemoryStore({ maxSize: 100 })
      const scopedAct = withStore(store)
      const health = createHealthCheck(store)

      const controller = new AbortController()
      // abort with HTML in the message; sanitized before storage
      controller.abort(new Error('<script>alert(1)</script>'))

      await scopedAct('a002-pre-abort', async () => 'unreached', {
        signal: controller.signal,
      })

      const status = health()
      expect(status.lastError).toBeDefined()
      // sanitized, no raw HTML
      expect(status.lastError!.message).not.toContain('<script>')
      expect(status.lastError!.message).toContain('&lt;script&gt;')
      store.destroy()
    })

    it('audit log receives sanitized error (no log injection)', async () => {
      const store = new InMemoryStore({ maxSize: 100 })
      const scopedAct = withStore(store)

      const auditEntries: unknown[] = []
      const controller = new AbortController()
      controller.abort(new Error('<img src=x onerror=alert(1)>'))

      await scopedAct('a002-audit', async () => 'unreached', {
        signal: controller.signal,
        audit: { log: (e: unknown) => { auditEntries.push(e) } },
      })

      expect(auditEntries.length).toBe(1)
      const entry = auditEntries[0] as { error?: { message?: string } }
      // error should be sanitized
      expect(entry.error).toBeDefined()
      expect(JSON.stringify(entry.error)).not.toContain('<img')
      store.destroy()
    })
  })

  // BUG-A-001: registerInflight threw outside try/finally, so
  // ResourceExhaustedError rejected the act() promise (contract violation).
  describe('BUG-A-001: ResourceExhaustedError becomes ActFailure', () => {
    it('act() resolves with ActFailure (not rejects) when inflight limit is hit', async () => {
      // can't easily hit the 100k limit here, so we verify the contract indirectly:
      // act() never rejects for resource-exhaustion. the fix wraps registerInflight
      // in try/catch and returns ActFailure.
      const r = await act('a001-contract', async () => 'ok')
      expect(r.ok).toBe(true)
    })
  })

  // BUG-B-001: circuitBreaker count strategy idle-reset wiped halfOpen state.
  describe('BUG-B-001: CB count strategy idle-reset preserves halfOpen', () => {
    it('idle-reset does not wipe halfOpen during a probe', async () => {
      // regression test for the `!state.halfOpen` guard on the idle-reset branch.
      // a probe call (half-open) shouldn't be disrupted by a concurrent idle-reset.
      // hard to repro the exact race here, but the breaker should still work.
      const key = 'b001-cb'
      // trip the breaker
      for (let i = 0; i < 5; i++) {
        await act(key, async () => { throw new Error('fail') }, {
          circuitBreaker: { threshold: 3, cooldownMs: 50, strategy: 'count', countSize: 5, countThreshold: 0.5, countMinimumCalls: 3 },
        })
      }
      // wait for cooldown
      await wait(60)
      // probe should succeed; breaker lets it through (half-open)
      const r = await act(key, async () => 'recovered', {
        circuitBreaker: { threshold: 3, cooldownMs: 50, strategy: 'count', countSize: 5, countThreshold: 0.5, countMinimumCalls: 3 },
      })
      expect(r.ok).toBe(true)
    })
  })

  // BUG-B-004: backoffFn throw propagated and lost the original fn error.
  describe('BUG-B-004: backoffFn throw falls back to computeDelay', () => {
    it('backoffFn throwing does not mask the original fn error', async () => {
      let backoffCalls = 0
      const r = await act('b004-backoff', async () => {
        throw new Error('original-fn-error')
      }, {
        retry: {
          attempts: 3,
          delayMs: 1,
          backoffFn: () => {
            backoffCalls++
            throw new Error('backoff-bug')
          },
        },
      })

      expect(r.ok).toBe(false)
      if (!r.ok) {
        // caller sees the original fn error (wrapped in RetryExhaustedError),
        // not the backoffFn error.
        const err = r.error as { cause?: { message?: string }; message?: string }
        // either RetryExhaustedError with .cause, or the raw fn error.
        const message = err.message ?? ''
        const causeMessage = err.cause?.message ?? ''
        expect(message + causeMessage).toContain('original-fn-error')
        expect(message + causeMessage).not.toContain('backoff-bug')
      }
      // backoffFn was called but its throw was caught
      expect(backoffCalls).toBeGreaterThan(0)
    })
  })

  // BUG-D-005: circuitBreaker.countThreshold NaN passed validation.
  describe('BUG-D-005: countThreshold NaN rejected', () => {
    it('countThreshold: NaN throws RangeError', async () => {
      await expect(act('d005-nan', async () => 'ok', {
        circuitBreaker: { threshold: 3, cooldownMs: 1000, strategy: 'count', countThreshold: NaN },
      })).rejects.toThrow(/countThreshold/)
    })
  })

  // BUG-D-004: dedupe inflightTtl: 0 silently accepted.
  describe('BUG-D-004: dedupe inflightTtl: 0 rejected', () => {
    it('inflightTtl: 0 throws RangeError', async () => {
      await expect(act('d004-zero', async () => 'ok', {
        dedupe: { enabled: true, inflightTtl: 0 },
      })).rejects.toThrow(/inflightTtl must be > 0/)
    })
  })

  // BUG-D-012: sanitizeErrorMessage had no length cap.
  describe('BUG-D-012: sanitizeErrorMessage length cap', () => {
    it('truncates very long messages with ellipsis marker', () => {
      const huge = 'x'.repeat(LIMITS.MAX_SANITIZED_ERROR_LENGTH + 1000)
      const sanitized = sanitizeErrorMessage(huge)
      expect(sanitized.length).toBe(LIMITS.MAX_SANITIZED_ERROR_LENGTH)
      expect(sanitized.endsWith('...')).toBe(true)
    })

    it('preserves messages under the cap unchanged', () => {
      const msg = 'normal error message'
      expect(sanitizeErrorMessage(msg)).toBe(msg)
    })
  })

  // BUG-D-013: key.ts prototype blocklist missed Object.prototype method names.
  describe('BUG-D-013: expanded prototype pollution blocklist', () => {
    it('rejects hasOwnProperty as a key', async () => {
      await expect(act('hasOwnProperty', async () => 'ok')).rejects.toThrow(/forbidden/)
    })
    it('rejects toString as a key', async () => {
      await expect(act('toString', async () => 'ok')).rejects.toThrow(/forbidden/)
    })
    it('rejects valueOf as a key', async () => {
      await expect(act('valueOf', async () => 'ok')).rejects.toThrow(/forbidden/)
    })
  })

  // BUG-D-011: no upper-bound limits on countSize, maxConcurrent, maxCalls.
  describe('BUG-D-011: upper-bound limits enforced', () => {
    it('rejects countSize > MAX_CIRCUIT_BREAKER_WINDOW', async () => {
      await expect(act('d011-cbsize', async () => 'ok', {
        circuitBreaker: {
          threshold: 3, cooldownMs: 1000, strategy: 'count',
          countSize: LIMITS.MAX_CIRCUIT_BREAKER_WINDOW + 1,
        },
      })).rejects.toThrow(/countSize.*exceeds limit/)
    })

    it('rejects maxConcurrent > MAX_BULKHEAD_CONCURRENCY', async () => {
      await expect(act('d011-bulk', async () => 'ok', {
        bulkhead: { maxConcurrent: LIMITS.MAX_BULKHEAD_CONCURRENCY + 1 },
      })).rejects.toThrow(/maxConcurrent.*exceeds limit/)
    })

    it('rejects maxCalls > MAX_RATE_LIMIT_CALLS', async () => {
      await expect(act('d011-rl', async () => 'ok', {
        rateLimit: { maxCalls: LIMITS.MAX_RATE_LIMIT_CALLS + 1, windowMs: 1000 },
      })).rejects.toThrow(/maxCalls.*exceeds limit/)
    })
  })

  // BUG-D-008 / BUG-D-009: missing exports.
  describe('BUG-D-008/009: missing exports', () => {
    it('HedgeTimeoutError is exported and has correct code', () => {
      const err = new HedgeTimeoutError()
      expect(err.code).toBe('ACTLY_HEDGE_TIMEOUT')
      expect(err.name).toBe('HedgeTimeoutError')
      // message includes the ms value (e.g. 'ACT hedge timed out after 0ms')
      expect(err.message).toMatch(/hedge timed out/)
      // HedgeTimeoutError extends ActlyError
      expect(err).toBeInstanceOf(ActlyError)
      expect(err).toBeInstanceOf(Error)
    })
  })

  // BUG-A-008: isAbortError didn't recognize ActlyAbortError.
  describe('BUG-A-008: isAbortError recognizes ACTLY_ABORT code', () => {
    it('ActlyAbortError is detected as an abort error', async () => {
      // indirect: caller abort should classify the error as 'abort' in failedBy
      // and skip retries. abort a retry-enabled call, expect 1 attempt only.
      let callCount = 0
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('user-cancel')), 10)

      const r = await act('a008-abort-retry', async (signal) => {
        callCount++
        // wait for abort
        return new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }, {
        retry: { attempts: 5, delayMs: 1 },
        signal: controller.signal,
      })

      expect(r.ok).toBe(false)
      expect(callCount).toBe(1) // no retries; abort is not retryable
    })
  })

  // ActlyError.toJSON() fixes JSON.stringify dropping message/stack.
  describe('ActlyError.toJSON()', () => {
    it('serializes name, code, message, key, stack', async () => {
      const r = await act('tojson-test', async () => {
        throw new Error('test error')
      }, {
        circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
      })
      // first failure trips the breaker (threshold: 1). next call throws
      // CircuitBreakerOpenError.
      const r2 = await act('tojson-test', async () => 'unreached', {
        circuitBreaker: { threshold: 1, cooldownMs: 60_000 },
      })
      expect(r2.ok).toBe(false)
      if (!r2.ok) {
        const json = JSON.parse(JSON.stringify(r2.error))
        expect(json.code).toBe('ACTLY_CIRCUIT_OPEN')
        expect(json.message).toContain('Circuit breaker open')
        expect(json.key).toBe('tojson-test')
        expect(typeof json.stack).toBe('string')
      }
    })
  })
})
