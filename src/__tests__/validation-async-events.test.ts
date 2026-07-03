import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── BUG-D20: validate.ts doesn't validate hardening options ────────────────

describe('BUG-D20: hardening options not validated', () => {
  it('circuitBreaker.threshold = -5 should throw, not silently coerce', async () => {
    // Without validation: Math.max(1, Math.floor(-5)) = 1, silently coerced
    // With validation: should throw RangeError
    await expect(
      act('d20-cb:test', async () => 'ok', {
        circuitBreaker: { threshold: -5, cooldownMs: 1000 },
      })
    ).rejects.toThrow(/threshold/)
  })

  it('circuitBreaker.cooldownMs = 0 should throw', async () => {
    await expect(
      act('d20-cb2:test', async () => 'ok', {
        circuitBreaker: { threshold: 3, cooldownMs: 0 },
      })
    ).rejects.toThrow(/cooldownMs/)
  })

  it('bulkhead.maxConcurrent = 0 should throw', async () => {
    await expect(
      act('d20-bulk:test', async () => 'ok', {
        bulkhead: { maxConcurrent: 0 },
      })
    ).rejects.toThrow(/maxConcurrent/)
  })

  it('rateLimit.maxCalls = -1 should throw', async () => {
    await expect(
      act('d20-rl:test', async () => 'ok', {
        rateLimit: { maxCalls: -1, windowMs: 1000 },
      })
    ).rejects.toThrow(/maxCalls/)
  })

  it('rateLimit.windowMs = 0 should throw', async () => {
    await expect(
      act('d20-rl2:test', async () => 'ok', {
        rateLimit: { maxCalls: 5, windowMs: 0 },
      })
    ).rejects.toThrow(/windowMs/)
  })

  it('hedge.delayMs = 0 should throw', async () => {
    await expect(
      act('d20-hedge:test', async () => 'ok', {
        hedge: { delayMs: 0 },
      })
    ).rejects.toThrow(/delayMs/)
  })

  it('hedge.delayMs = -10 should throw', async () => {
    await expect(
      act('d20-hedge2:test', async () => 'ok', {
        hedge: { delayMs: -10 },
      })
    ).rejects.toThrow(/delayMs/)
  })
})

// ─── BUG-D21: Cache async store path missing observability events ───────────

describe('BUG-D21: async store cache events', () => {
  it('async store cache hit emits onCacheHit event', async () => {
    const events: string[] = []
    const asyncStore = {
      _sync: false as const,
      _data: new Map<string, { value: unknown; insertedAt: number }>(),
      async get<T>(key: string): Promise<T | undefined> {
        const e = this._data.get(key)
        return e?.value as T | undefined
      },
      async set<T>(key: string, value: T): Promise<void> {
        this._data.set(key, { value, insertedAt: Date.now() })
      },
      async delete(key: string): Promise<void> { this._data.delete(key) },
      async has(key: string): Promise<boolean> { return this._data.has(key) },
      async clear(): Promise<void> { this._data.clear() },
      async size(): Promise<number> { return this._data.size },
    }

    const scopedAct = withStore(asyncStore)

    // First call: cache miss
    await scopedAct('d21-async-cache:test', async () => 'value', {
      cache: { ttl: 60_000 },
      observability: {
        onCacheHit: () => events.push('hit'),
        onCacheMiss: () => events.push('miss'),
      },
    })

    // Second call: should be cache hit
    await scopedAct('d21-async-cache:test', async () => 'fresh', {
      cache: { ttl: 60_000 },
      observability: {
        onCacheHit: () => events.push('hit'),
        onCacheMiss: () => events.push('miss'),
      },
    })

    // After fix: async store should emit cache-miss then cache-hit
    expect(events).toContain('miss')
    expect(events).toContain('hit')
  })
})

// ─── BUG-D22: Bulkhead doesn't respect signal abort ─────────────────────────

describe('BUG-D22: bulkhead signal abort', () => {
  it('queued caller is removed from queue on signal abort', async () => {
    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    let fnCalls = 0
    const fn = async (signal: AbortSignal) => {
      fnCalls++
      await fnPromise
      return 'done'
    }

    const key = 'd22-bulk-abort:test'

    // First call: occupies the single slot
    const p1 = act(key, fn, { bulkhead: { maxConcurrent: 1, queueTimeoutMs: 10000 } })
    await wait(10)

    // Second call: queued, but caller aborts
    const controller = new AbortController()
    const p2 = act(key, fn, {
      bulkhead: { maxConcurrent: 1, queueTimeoutMs: 10000 },
      signal: controller.signal,
    })

    await wait(10)
    controller.abort(new Error('caller-cancelled'))

    const r2 = await p2
    expect(r2.ok).toBe(false)

    // Release the first call
    resolveFn()
    await p1

    // After fix: the queued entry should have been removed on abort.
    // A third call should get a slot immediately (not be stuck behind
    // the aborted entry's ghost in the queue).
    const r3 = await act(key, async () => 'third', {
      bulkhead: { maxConcurrent: 1, queueTimeoutMs: 100 },
    })
    expect(r3.ok).toBe(true)
    if (r3.ok) expect(r3.value).toBe('third')
  })
})
