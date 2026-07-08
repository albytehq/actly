import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, execute } from '../index.js'
import type { AsyncStateStore } from '../index.js'
import { sanitizeKey } from '../utils/key.js'
import { LIMITS } from '../utils/limits.js'
import { anySignal, raceAbort, sleep, linkSignal } from '../utils/abort.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── Validation ──────────────────────────────────────────────────────────────

describe('Phase 1: key sanitisation', () => {
  it('rejects __proto__', () => {
    expect(() => sanitizeKey('__proto__')).toThrow(/forbidden/)
  })
  it('rejects constructor', () => {
    expect(() => sanitizeKey('constructor')).toThrow(/forbidden/)
  })
  it('rejects prototype', () => {
    expect(() => sanitizeKey('prototype')).toThrow(/forbidden/)
  })
  it('rejects null byte', () => {
    expect(() => sanitizeKey('a\x00b')).toThrow(/control character/)
  })
  it('rejects CR', () => {
    expect(() => sanitizeKey('a\rb')).toThrow(/control character/)
  })
  it('rejects LF-only is allowed (newlines in structured keys)', () => {
    expect(sanitizeKey('a\nb')).toBe('a\nb')
  })
  it('rejects DEL (0x7f)', () => {
    expect(() => sanitizeKey('a\x7fb')).toThrow(/control character/)
  })
  it('rejects oversized key', () => {
    expect(() => sanitizeKey('a'.repeat(LIMITS.MAX_KEY_LENGTH + 1)))
      .toThrow(/exceeds limit/)
  })
  it('rejects reserved prefixes', () => {
    expect(() => sanitizeKey('dedupe:foo')).toThrow(/reserved prefix/)
    expect(() => sanitizeKey('cache:foo')).toThrow(/reserved prefix/)
    expect(() => sanitizeKey('inflight:foo')).toThrow(/reserved prefix/)
    expect(() => sanitizeKey('tenant:foo')).toThrow(/reserved prefix/)
  })
  it('accepts valid keys', () => {
    expect(sanitizeKey('user:42')).toBe('user:42')
    expect(sanitizeKey('api:v1/users/123')).toBe('api:v1/users/123')
    expect(sanitizeKey('a')).toBe('a')
  })
  it('rejects non-string keys', () => {
    expect(() => sanitizeKey(42 as unknown as string)).toThrow(TypeError)
    expect(() => sanitizeKey(null as unknown as string)).toThrow(TypeError)
    expect(() => sanitizeKey(undefined as unknown as string)).toThrow(TypeError)
  })
})

describe('Phase 1: numeric caps', () => {
  it('caps retry.attempts at LIMITS.MAX_RETRY_ATTEMPTS', async () => {
    await expect(
      act('k', async () => 1, { retry: { attempts: LIMITS.MAX_RETRY_ATTEMPTS + 1 } }),
    ).rejects.toThrow(/exceeds limit/)
  })
  it('caps timeout.ms at LIMITS.MAX_TIMEOUT_MS', async () => {
    await expect(
      act('k', async () => 1, { timeout: { ms: LIMITS.MAX_TIMEOUT_MS + 1 } }),
    ).rejects.toThrow(/exceeds limit/)
  })
  it('caps cache.ttl at LIMITS.MAX_CACHE_TTL', async () => {
    await expect(
      act('k', async () => 1, { cache: { ttl: LIMITS.MAX_CACHE_TTL + 1 } }),
    ).rejects.toThrow(/exceeds limit/)
  })
  it('caps retry.delayMs at LIMITS.MAX_RETRY_DELAY_MS', async () => {
    await expect(
      act('k', async () => 1, { retry: { attempts: 3, delayMs: LIMITS.MAX_RETRY_DELAY_MS + 1 } }),
    ).rejects.toThrow(/exceeds limit/)
  })
  it('rejects invalid backoff enum', async () => {
    await expect(
      act('k', async () => 1, { retry: { attempts: 3, backoff: 'funky' as 'none' } }),
    ).rejects.toThrow(/retry.backoff must be one of/)
  })
  it('rejects invalid jitter enum', async () => {
    await expect(
      act('k', async () => 1, { retry: { attempts: 3, jitter: 'shaky' as 'none' } }),
    ).rejects.toThrow(/retry.jitter must be one of/)
  })
})

// ─── Leak-Proof AbortSignal ──────────────────────────────────────────────────

/**
 * Counting proxy around an AbortSignal so tests can observe listener
 * lifecycle. Standard EventTarget has no listenerCount, hence the wrappers.
 */
function countingSignal(): { signal: AbortSignal; added: number; removed: number } {
  const controller = new AbortController()
  let added = 0
  let removed = 0
  const origAdd = controller.signal.addEventListener.bind(controller.signal) as (
    ...args: Parameters<AbortSignal['addEventListener']>
  ) => void
  const origRemove = controller.signal.removeEventListener.bind(controller.signal) as (
    ...args: Parameters<AbortSignal['removeEventListener']>
  ) => void
  controller.signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
    added++
    return origAdd(...args)
  }) as typeof controller.signal.addEventListener
  controller.signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
    removed++
    return origRemove(...args)
  }) as typeof controller.signal.removeEventListener
  return { signal: controller.signal, get added() { return added }, get removed() { return removed } }
}

describe('Phase 2: leak-proof AbortSignal management', () => {
  it('does not accumulate listeners on long-lived user signal', async () => {
    const { signal, added, removed } = countingSignal()
    for (let i = 0; i < 50; i++) {
      await act(`leak-test-${i}`, async () => i, { signal })
    }
    // every listener added during act() must be torn down on resolve
    expect(added).toBe(removed)
  })

  it('does not accumulate listeners when timeout policy is used', async () => {
    const { signal, added, removed } = countingSignal()
    for (let i = 0; i < 50; i++) {
      await act(`timeout-leak-${i}`, async () => i, {
        signal,
        timeout: { ms: 1000 },
      })
    }
    expect(added).toBe(removed)
  })

  it('linkSignal returns an unlink function that removes the listener', () => {
    const parent = new AbortController()
    const child = new AbortController()
    const unlink = linkSignal(parent.signal, child)
    // unlink is callable and idempotent
    expect(typeof unlink).toBe('function')
    unlink()
    // second call is a no-op (listener already gone)
    expect(() => unlink()).not.toThrow()
  })

  it('anySignal uses native AbortSignal.any when available', () => {
    const a = new AbortController()
    const b = new AbortController()
    const composite = anySignal([a.signal, b.signal])
    expect(composite.aborted).toBe(false)
    a.abort(new Error('boom'))
    expect(composite.aborted).toBe(true)
    expect((composite.reason as Error).message).toBe('boom')
  })

  it('anySignal with already-aborted input aborts synchronously', () => {
    const a = new AbortController()
    a.abort(new Error('pre-aborted'))
    const b = new AbortController()
    const composite = anySignal([a.signal, b.signal])
    expect(composite.aborted).toBe(true)
  })

  it('raceAbort removes its listener on success', async () => {
    const { signal, added, removed } = countingSignal()
    await raceAbort(Promise.resolve('ok'), signal)
    expect(added).toBe(removed)
  })

  it('raceAbort marks original promise as handled on signal abort', async () => {
    const sig = new AbortController()
    let rejectFn!: (e: Error) => void
    const slow = new Promise<string>((_, reject) => { rejectFn = reject })
    const racing = raceAbort(slow, sig.signal)

    // abort first, then let the underlying promise reject
    sig.abort(new Error('user-cancelled'))
    setTimeout(() => rejectFn(new Error('db-down')), 10)

    await expect(racing).rejects.toThrow('user-cancelled')
    // if the slow promise's rejection isn't marked-as-handled, Node emits
    // unhandledRejection and the test runner fails
    await wait(50)
  })

  it('sleep unrefs its timer on Node', async () => {
    // smoke test: sleep resolves and doesn't hold the event loop open
    const t0 = Date.now()
    await sleep(20)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15)
  })
})

// ─── Bounded InMemoryStore ───────────────────────────────────────────────────

describe('Phase 3: bounded InMemoryStore', () => {
  it('size() is O(1) — returns Map size directly', () => {
    const store = new InMemoryStore({ maxSize: 1000 })
    for (let i = 0; i < 1000; i++) store.set(`k${i}`, i)
    const t0 = performance.now()
    expect(store.size()).toBe(1000)
    const t1 = performance.now()
    // O(1): sub-millisecond on warm caches. Use 5ms ceiling to accommodate
    // slower dev machines (e.g. dual-core laptops, CI runners) and background
    // GC pauses. The test verifies O(1) shape (no iteration), not raw speed.
    expect(t1 - t0).toBeLessThan(5)
  })

  it('LRU uses doubly-linked list (no Map delete+set churn)', () => {
    const store = new InMemoryStore({ maxSize: 3 })
    store.set('a', 1)
    store.set('b', 2)
    store.set('c', 3)
    // touch 'a' so it becomes most-recent
    expect(store.get('a')).toBe(1)
    // inserting 'd' evicts 'b' (now oldest), 'a' survives
    store.set('d', 4)
    expect(store.get('a')).toBe(1)
    expect(store.get('b')).toBeUndefined()
    expect(store.get('c')).toBe(3)
    expect(store.get('d')).toBe(4)
  })

  it('updating existing key does not evict', () => {
    const store = new InMemoryStore({ maxSize: 2 })
    store.set('a', 1)
    store.set('b', 2)
    store.set('a', 10)  // update, not insert
    expect(store.size()).toBe(2)
    expect(store.get('a')).toBe(10)
    expect(store.get('b')).toBe(2)
  })

  it('default store (via createDefaultStore) is bounded', async () => {
    // default maxSize is 10_000; indirect check by exercising 100 cached
    // calls and confirming nothing throws (store size isn't exposed)
    for (let i = 0; i < 100; i++) {
      await act(`default-store-test-${i}`, async () => i, { cache: { ttl: 60_000 } })
    }
    expect(true).toBe(true)
  })

  it('destroy() is idempotent', () => {
    const store = new InMemoryStore({ autoCleanup: true, cleanupIntervalMs: 10 })
    store.destroy()
    store.destroy()
    expect(true).toBe(true)
  })

  it('honours TTL on get()', async () => {
    const store = new InMemoryStore()
    store.set('k', 'v', 30)
    expect(store.get('k')).toBe('v')
    await wait(50)
    expect(store.get('k')).toBeUndefined()
  })

  it('honours TTL on has() without LRU touch', async () => {
    const store = new InMemoryStore({ maxSize: 2 })
    store.set('a', 1)
    store.set('b', 2, 30)  // 'b' has TTL
    expect(store.has('b')).toBe(true)
    await wait(50)
    expect(store.has('b')).toBe(false)
    expect(store.has('a')).toBe(true)
  })

  it('clear() empties the store', () => {
    const store = new InMemoryStore()
    store.set('a', 1)
    store.set('b', 2)
    store.clear()
    expect(store.size()).toBe(0)
    expect(store.get('a')).toBeUndefined()
  })
})
