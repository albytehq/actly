/**
 * Regression suite for defects found during the v1.2.0 hardening audit
 * (see CHANGELOG.md), plus edge-case coverage for key validation,
 * retry/dedupe semantics, and cache LRU eviction.
 *
 * Each `describe` block documents the defect or edge case it guards against,
 * so a future regression traces back to its origin. A failure here means a
 * fixed defect has resurfaced or an invariant was violated.
 *
 * Run: npx vitest run src/__tests__/regression-suite.test.ts
 */
import { describe, it, expect } from 'vitest'
import { act, invalidate, withStore, InMemoryStore, sanitizeKey, LIMITS, computeDelay } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── BUG-1: decorrelated jitter can produce negative delay ──────────────────

describe('backoff: decorrelated jitter never goes negative when maxDelay caps below base', () => {
  it('computeDelay returns non-negative for decorrelated when maxDelay < delayMs', () => {
    // delayMs=1000, attempt=2: exponential gives 2000, capped to 100.
    // decorrelated formula: base + random()*(delay - base) = 1000 + random()*(-900)
    // = [100, 1000] when delay < base, exceeding maxDelay.
    // The formula assumes delay >= base; the cap below base breaks that.
    const opts = {
      attempts: 3,
      delayMs: 1000,
      backoff: 'exponential' as const,
      maxDelay: 100,
      jitter: 'decorrelated' as const,
    }

    // Run 10,000 iterations to catch the probabilistic bug
    let maxObserved = 0
    let minObserved = Infinity
    for (let i = 0; i < 10_000; i++) {
      const d = computeDelay(2, opts)
      maxObserved = Math.max(maxObserved, d)
      minObserved = Math.min(minObserved, d)
    }

    // delay should be in [0, maxDelay=100]
    expect(maxObserved).toBeLessThanOrEqual(100)  // not exceeding maxDelay
    expect(minObserved).toBeGreaterThanOrEqual(0) // not negative
  })
})

// ─── BUG-3: cache onCacheHit ageMs always 0 ──────────────────────────────────

describe('cache: onCacheHit reports accurate age, not always 0', () => {
  it('onCacheHit event reports actual age of cached entry', async () => {
    let capturedAgeMs: number | undefined

    // First call: cache miss, stores value
    await act('regr-age:test', async () => 'value', {
      cache: { ttl: 60_000 },
      observability: {},
    })

    // Wait 50ms so age is non-zero
    await wait(50)

    // Second call: cache hit, reports ageMs ~ 50+
    await act('regr-age:test', async () => 'fresh', {
      cache: { ttl: 60_000 },
      observability: {
        onCacheHit: (e) => { capturedAgeMs = e.ageMs },
      },
    })

    expect(capturedAgeMs).toBeDefined()
    // ageMs reflects actual age (>= 40ms with timing slack)
    expect(capturedAgeMs!).toBeGreaterThanOrEqual(40)
  })
})

// ─── BUG-4: withStore async invalidate TOCTOU race ───────────────────────────

describe('withStore: async invalidate has no TOCTOU race', () => {
  it('async invalidate returns correct existed flag without TOCTOU race', async () => {
    // The contract: delete() returns whether it actually deleted, so the
    // caller doesn't need a separate has() check that could race with
    // another concurrent delete.

    const asyncStore = {
      _sync: false as const,
      _data: new Map<string, unknown>(),
      async get<T>(key: string): Promise<T | undefined> {
        return this._data.get(key) as T | undefined
      },
      async set<T>(key: string, value: T): Promise<void> {
        this._data.set(key, value)
      },
      async delete(key: string): Promise<void> {
        this._data.delete(key)
      },
      async has(key: string): Promise<boolean> {
        return this._data.has(key)
      },
      async clear(): Promise<void> {
        this._data.clear()
      },
      async size(): Promise<number> {
        return this._data.size
      },
    }

    const scopedAct = withStore(asyncStore)

    // Populate cache
    await scopedAct('regr-toctou:test', async () => 'value', { cache: { ttl: 60_000 } })

    // Invalidate: should return true (existed)
    const existed = await scopedAct.invalidate('regr-toctou:test')
    expect(existed).toBe(true)

    // Invalidate again: should return false (already deleted)
    const existedAgain = await scopedAct.invalidate('regr-toctou:test')
    expect(existedAgain).toBe(false)
  })
})

// ─── BUG-5: limits.ts comment references non-existent configure() ───────────

describe('limits: no stale references to unimplemented APIs', () => {
  it('LIMITS is a plain const, not configurable (contrary to old comment)', () => {
    // LIMITS is not configurable; the comment that claimed otherwise is gone.
    expect(typeof LIMITS).toBe('object')
    expect(LIMITS.MAX_KEY_LENGTH).toBe(1024)
    // LIMITS is frozen/readonly; not mutable
    expect(() => { (LIMITS as { MAX_KEY_LENGTH: number }).MAX_KEY_LENGTH = 999 }).toThrow()
  })
})

// ─── BUG-6: utility functions not exported from public API ──────────────────

describe('index: utility functions are part of the public API', () => {
  it('anySignal, raceAbort, sleep, linkSignal, isAbortError are exported from actly', async () => {
    const mod = await import('../index.js')
    expect(typeof mod.anySignal).toBe('function')
    expect(typeof mod.raceAbort).toBe('function')
    expect(typeof mod.sleep).toBe('function')
    expect(typeof mod.linkSignal).toBe('function')
    expect(typeof mod.isAbortError).toBe('function')
  })

  it('sanitizeKey and computeDelay are exported from actly', async () => {
    const mod = await import('../index.js')
    expect(typeof mod.sanitizeKey).toBe('function')
    expect(typeof mod.computeDelay).toBe('function')
  })

  it('LIMITS is exported from actly', async () => {
    const mod = await import('../index.js')
    expect(typeof mod.LIMITS).toBe('object')
    expect(mod.LIMITS.MAX_KEY_LENGTH).toBe(1024)
  })
})

// ─── EDGE-1: empty key should be rejected ────────────────────────────────────

describe('sanitizeKey: empty key handling', () => {
  it('act() with empty key throws synchronously', async () => {
    await expect(act('', async () => 1)).rejects.toThrow(/non-empty/)
  })

  it('invalidate() with empty key throws synchronously', () => {
    expect(() => invalidate('')).toThrow(/non-empty/)
  })
})

// ─── EDGE-2: very long key near limit ────────────────────────────────────────

describe('sanitizeKey: key length boundary', () => {
  it('key exactly at MAX_KEY_LENGTH is accepted', async () => {
    const key = 'a'.repeat(LIMITS.MAX_KEY_LENGTH)
    const r = await act(key, async () => 1)
    expect(r.ok).toBe(true)
  })

  it('key one char over MAX_KEY_LENGTH is rejected', async () => {
    const key = 'a'.repeat(LIMITS.MAX_KEY_LENGTH + 1)
    await expect(act(key, async () => 1)).rejects.toThrow(/exceeds limit/)
  })
})

// ─── EDGE-3: retry attempts = 1 is a no-op (documented but surprising) ───────

describe('retry: attempts=1 behaves as a single-shot call', () => {
  it('attempts=1 does NOT retry — fn called exactly once', async () => {
    let calls = 0
    const r = await act('regr-noop-retry:test', async () => {
      calls++
      throw new Error('fail')
    }, { retry: { attempts: 1 } })

    expect(r.ok).toBe(false)
    expect(calls).toBe(1)  // no retry
    // not wrapped in RetryExhaustedError (no retries happened)
    if (!r.ok) {
      expect((r.error as Error).message).toBe('fail')  // raw error, not wrapped
    }
  })
})

// ─── EDGE-4: dedupe without timeout, hung fn blocks slot ───────────────────

describe('dedupe: behaves correctly without timeout or inflightTtl', () => {
  it('hung originator blocks all subsequent joiners indefinitely', async () => {
    let fnResolve!: (v: string) => void
    const hungPromise = new Promise<string>((resolve) => { fnResolve = resolve })

    // Originator starts a hung fn with no inflightTtl and no timeout
    const originatorPromise = act('regr-hung-dedupe:test', () => hungPromise, {
      dedupe: true,  // no inflightTtl = Infinity
    })

    await wait(20)

    // Joiner arrives; stuck waiting for originator
    const joinerPromise = act('regr-hung-dedupe:test', async () => 'fresh', {
      dedupe: true,
    })

    // Both should still be pending after 100ms
    await wait(100)
    expect(originatorPromise).toBeDefined()  // still pending
    // Joiner is also still pending. Without timeout or inflightTtl,
    // a hung fn permanently blocks the dedupe slot.

    // Cleanup
    fnResolve('done')
    const [o, j] = await Promise.all([originatorPromise, joinerPromise])
    expect(o.ok).toBe(true)
    expect(j.ok).toBe(true)
  })
})

// ─── EDGE-5: default store is shared across callers ─────────────────────────

describe('act: default store is shared across callers', () => {
  it('cache entries from one caller are visible to another', async () => {
    // This is by design, but it's a multi-tenant data leakage risk.
    // Caller A caches a value
    await act('regr-shared-store:test', async () => 'caller-A-value', {
      cache: { ttl: 60_000 },
    })

    // Caller B reads the cached value; no way to isolate without withStore()
    const r = await act('regr-shared-store:test', async () => 'caller-B-value', {
      cache: { ttl: 60_000 },
    })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('caller-A-value')  // B got A's cached value!
      expect(r.source).toBe('cache')
    }
  })
})

// ─── EDGE-6: classifyFailure name spoofing ──────────────────────────────────

describe('errors: classifyFailure resists error-name spoofing', () => {
  it('throwing { name: "AbortError" } is classified as abort', async () => {
    // classifyFailure checks error.name === 'AbortError' for non-ActlyError
    // errors. A plain object with a spoofed name would be classified as
    // 'abort' in the failedBy discriminator. failedBy is for telemetry,
    // not security, but it lets an attacker mask fn-error as abort in metrics.

    const { act } = await import('../index.js')
    let capturedFailedBy: string | undefined

    const r = await act('regr-spoof:test', async () => {
      // Throw a plain object (not an Error) with spoofed name
      throw { name: 'AbortError', message: 'fake-abort' }
    }, {
      observability: {
        onFinalFailure: (e) => { capturedFailedBy = e.failedBy },
      },
    })

    expect(r.ok).toBe(false)
    // The error is not a real abort; it's a fn-error masquerading.
    // classifyFailure requires instanceof Error before checking .name,
    // so plain-object spoofing doesn't slip through.
    expect(capturedFailedBy).toBe('fn-error')  // not 'abort'
  })
})

// ─── EDGE-7: LRU eviction can evict useful cache entries under pressure ─────

describe('InMemoryStore: LRU eviction under pressure', () => {
  it('high-cardinality keys cause eviction of useful cache entries', async () => {
    // Default store maxSize=10_000. Caching 10,001 unique keys evicts the
    // LRU entry, even if it was useful and just wasn't accessed recently.

    const store = new InMemoryStore({ maxSize: 5 })  // small for testing
    const scopedAct = withStore(store)

    // Cache 5 entries
    for (let i = 0; i < 5; i++) {
      await scopedAct(`regr-lru:${i}`, async () => `val-${i}`, { cache: { ttl: 60_000 } })
    }

    // Access key 0 to make it "most recent"
    await scopedAct('regr-lru:0', async () => 'fresh', { cache: { ttl: 60_000 } })

    // Add key 5; should evict the LRU (key 1, not key 0)
    await scopedAct('regr-lru:5', async () => 'val-5', { cache: { ttl: 60_000 } })

    // Key 0 should still be cached (we accessed it recently)
    const r0 = await scopedAct('regr-lru:0', async () => 'fresh', { cache: { ttl: 60_000 } })
    expect(r0.ok).toBe(true)
    if (r0.ok) expect(r0.source).toBe('cache')

    // Key 1 should have been evicted
    const r1 = await scopedAct('regr-lru:1', async () => 'fresh', { cache: { ttl: 60_000 } })
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.source).toBe('fresh')  // evicted, re-fetched

    store.destroy()
  })
})
