import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, createHealthCheck, drain, drainAll, enableWatchdog, disableWatchdog } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── per-scope health state ──────────────────────────────────────

describe('T23: per-scope health state', () => {
  it('default scope tracks act() calls', async () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const health = createHealthCheck(store)

    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const promise = act('t23-default', () => fnPromise)

    await wait(10)
    const status = health()
    expect(status.pendingInflight).toBe(1)

    resolveFn()
    await promise
  })

  it('scoped store has separate health from default', async () => {
    const store1 = new InMemoryStore({ maxSize: 100 })
    const store2 = new InMemoryStore({ maxSize: 100 })
    const scopedAct1 = withStore(store1)

    // scopedAct writes to 'scoped:<uuid>', not 'default'. Read 'default'
    // explicitly so we can confirm the scoped call doesn't leak into it.
    const defaultHealth = createHealthCheck(store1, { scope: 'default' })

    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const promise = scopedAct1('t23-scoped', () => fnPromise)

    await wait(10)
    const status = defaultHealth()
    // default scope should not see the scoped call.
    expect(status.pendingInflight).toBe(0)

    // the scoped store's own health (auto-resolved via WeakMap) does see it.
    const scopedHealth = createHealthCheck(store1)
    const scopedStatus = scopedHealth()
    expect(scopedStatus.pendingInflight).toBe(1)

    resolveFn()
    await promise
    store1.destroy()
    store2.destroy()
  })
})

// ─── drainAll ────────────────────────────────────────────────────

describe('T24: drainAll', () => {
  it('returns true immediately when no in-flight calls', async () => {
    const result = await drainAll(100)
    expect(result).toBe(true)
  })

  it('drains all scopes in parallel', async () => {
    // Start calls in default scope + a scoped store
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)

    let resolveDefault!: () => void
    let resolveScoped!: () => void
    const defaultPromise = new Promise<void>(r => { resolveDefault = r })
    const scopedPromise = new Promise<void>(r => { resolveScoped = r })

    const p1 = act('t24-default', () => defaultPromise)
    const p2 = scopedAct('t24-scoped', () => scopedPromise)

    // start drainAll; should block on both scopes
    const drainPromise = drainAll(5000)

    await wait(20)
    // both still in-flight
    drainPromise.then((result) => {
      expect(result).toBe(true)
    })

    resolveDefault()
    resolveScoped()
    await Promise.all([p1, p2])

    const result = await drainPromise
    expect(result).toBe(true)
    store.destroy()
  })

  it('returns false if any scope times out', async () => {
    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const p = act('t24-timeout', () => fnPromise)

    const result = await drainAll(30)
    expect(result).toBe(false)

    resolveFn()
    await p
  })
})

// ─── resource budget ─────────────────────────────────────────────

describe('T18: resource budget MAX_GLOBAL_INFLIGHT', () => {
  it('default limit is 100000 (from LIMITS)', async () => {
    const { LIMITS } = await import('../index.js')
    expect(LIMITS.MAX_GLOBAL_INFLIGHT).toBe(100_000)
  })

  it('ResourceExhaustedError is exported', async () => {
    const { ResourceExhaustedError } = await import('../index.js')
    const err = new ResourceExhaustedError(100001, 100000)
    expect(err.code).toBe('ACTLY_RESOURCE_EXHAUSTED')
    expect(err.current).toBe(100001)
    expect(err.limit).toBe(100000)
    expect(err.message).toContain('100001')
    expect(err.message).toContain('100000')
  })
})

// ─── createHealthCheck with probeIntervalMs ──────────────────────

describe('T21: createHealthCheck with probeIntervalMs', () => {
  it('accepts probeIntervalMs option without error', () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const health = createHealthCheck(store, { probeIntervalMs: 50 })
    expect(typeof health).toBe('function')
    const status = health()
    expect(status).toBeDefined()
    store.destroy()
  })

  it('accepts scope option', () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const health = createHealthCheck(store, { scope: 'custom-scope' })
    const status = health()
    expect(status.pendingInflight).toBe(0) // custom scope has no calls
    store.destroy()
  })
})

// ─── onBackpressure event ────────────────────────────────────────

describe('T22: onBackpressure event', () => {
  it('fires when bulkhead queue utilization crosses 80%', async () => {
    let backpressureEvents: { queueLength: number; utilization: number }[] = []
    const slowFn = async () => {
      await wait(100)
      return 'ok'
    }
    // maxConcurrent: 1, maxQueueSize: 5; 80% = 4 queued
    const opts = {
      bulkhead: { maxConcurrent: 1, queueTimeoutMs: 5000, maxQueueSize: 5 },
      observability: {
        onBackpressure: (e: { queueLength: number; utilization: number }) => {
          backpressureEvents.push({ queueLength: e.queueLength, utilization: e.utilization })
        },
      },
    }

    // 5 calls: 1 active + 4 queued = 80% utilization
    const promises: Promise<unknown>[] = []
    for (let i = 0; i < 5; i++) {
      promises.push(act('t22-bp', slowFn, opts).then(r => r, e => e))
    }

    await wait(20)
    // should fire at least once when queue hits 4 (80%)
    expect(backpressureEvents.length).toBeGreaterThanOrEqual(1)
    expect(backpressureEvents[0]!.queueLength).toBeGreaterThanOrEqual(4)
    expect(backpressureEvents[0]!.utilization).toBeGreaterThanOrEqual(0.8)

    await Promise.all(promises)
  })

  it('does not fire when maxQueueSize is Infinity (unbounded)', async () => {
    let eventCount = 0
    const slowFn = async () => { await wait(50); return 'ok' }

    const promises: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) {
      promises.push(act('t22-noinfo', slowFn, {
        bulkhead: { maxConcurrent: 1, queueTimeoutMs: 5000 },
        observability: { onBackpressure: () => { eventCount++ } },
      }).then(r => r, e => e))
    }

    await Promise.all(promises)
    expect(eventCount).toBe(0)
  })
})

// ─── watchdog ────────────────────────────────────────────────────

describe('T19: watchdog', () => {
  it('enableWatchdog + disableWatchdog are callable', () => {
    enableWatchdog(1000)
    disableWatchdog()
  })

  it('fires onWatchdog when inflight is stuck', async () => {
    let watchdogEvents: { elapsedMs: number; scope: string }[] = []
    const hooks = {
      onWatchdog: (e: { elapsedMs: number; scope: string }) => {
        watchdogEvents.push({ elapsedMs: e.elapsedMs, scope: e.scope })
      },
    }

    enableWatchdog(100, hooks) // 100ms threshold

    let resolveFn!: () => void
    const fnPromise = new Promise<void>(r => { resolveFn = r })
    const p = act('t19-stuck', () => fnPromise)

    // wait for watchdog to fire (100ms threshold + interval check)
    await wait(200)

    expect(watchdogEvents.length).toBeGreaterThanOrEqual(1)
    expect(watchdogEvents[0]!.elapsedMs).toBeGreaterThanOrEqual(100)

    resolveFn()
    await p
    disableWatchdog()
  })

  it('does not fire when inflight is 0', async () => {
    let eventCount = 0
    enableWatchdog(50, { onWatchdog: () => { eventCount++ } })
    await wait(150)
    expect(eventCount).toBe(0)
    disableWatchdog()
  })
})

// ─── memoryPressureCleanup option ────────────────────────────────

describe('T20: InMemoryStore memoryPressureCleanup option', () => {
  it('accepts memoryPressureCleanup: true without error', () => {
    const store = new InMemoryStore({
      maxSize: 100,
      autoCleanup: true,
      memoryPressureCleanup: true,
    })
    store.set('a', 1)
    expect(store.get('a')).toBe(1)
    store.destroy()
  })

  it('destroy removes the memory listener (no crash on re-destroy)', () => {
    const store = new InMemoryStore({ memoryPressureCleanup: true })
    store.destroy()
    store.destroy() // idempotent
    expect(true).toBe(true)
  })
})
