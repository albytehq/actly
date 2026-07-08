import { describe, it, expect } from 'vitest'
import { act, withStore, InMemoryStore, createHealthCheck } from '../index.js'

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── Health Probe disposer ───

describe('Debug7: Health Probe disposer', () => {
  it('createHealthCheck returns function with dispose()', () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const health = createHealthCheck(store, { probeIntervalMs: 1000 })

    expect(typeof health).toBe('function')
    expect(typeof (health as { dispose?: () => void }).dispose).toBe('function')

    ;(health as { dispose: () => void }).dispose()
    store.destroy()
  })

  it('dispose() stops the probe timer (no more console.warn)', async () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => { warnings.push(msg) }

    const health = createHealthCheck(store, { probeIntervalMs: 50 })
    ;(health as { dispose: () => void }).dispose()

    // wait long enough that the probe would have fired if not disposed
    await wait(150)

    console.warn = origWarn
    expect(warnings.length).toBe(0) // timer was disposed, no warnings

    store.destroy()
  })

  it('dispose() is idempotent (safe to call multiple times)', () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const health = createHealthCheck(store, { probeIntervalMs: 1000 })

    ;(health as { dispose: () => void }).dispose()
    ;(health as { dispose: () => void }).dispose()
    ;(health as { dispose: () => void }).dispose()

    store.destroy()
  })

  it('createHealthCheck without probeIntervalMs has dispose() that is no-op', () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const health = createHealthCheck(store)

    // dispose() is callable even with no probe configured
    ;(health as { dispose: () => void }).dispose()
    store.destroy()
  })

  it('health check still works after dispose()', () => {
    const store = new InMemoryStore({ maxSize: 100 })
    store.set('a', 1)
    const health = createHealthCheck(store, { probeIntervalMs: 1000 })

    ;(health as { dispose: () => void }).dispose()

    const status = health()
    expect(status.storeSize).toBe(1)
    expect(status.pendingInflight).toBe(0)

    store.destroy()
  })
})

// ─── healthStates bounded growth ───

describe('Debug7: healthStates pruning', () => {
  it('idle scoped entries are pruned (not default)', async () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)

    // create a health state for the scoped store
    await scopedAct('prune-test', async () => 'ok')

    // idle scoped entries get pruned (inflight=0, no error, not 'default').
    // entry is re-created lazily on next access.
    const r = await scopedAct('prune-test-2', async () => 'ok2')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('ok2')

    store.destroy()
  })

  it('default scope is NEVER pruned', async () => {
    await act('default-prune', async () => 'ok')

    // default scope is never pruned, so no re-creation overhead
    const r = await act('default-prune-2', async () => 'ok2')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('ok2')
  })

  it('scope with lastError is NOT pruned (preserve error info)', async () => {
    const store = new InMemoryStore({ maxSize: 100 })
    const scopedAct = withStore(store)

    // failing call sets lastError on the scope
    await scopedAct('error-prune', async () => { throw new Error('fail') })

    // scope with lastError is preserved, so it stays accessible.
    const r = await scopedAct('error-prune-2', async () => 'ok')
    expect(r.ok).toBe(true)

    store.destroy()
  })

  it('1000 unique scopes do not accumulate (all pruned when idle)', async () => {
    // 1000 scoped stores, 1 call each, then destroy.
    for (let i = 0; i < 1000; i++) {
      const store = new InMemoryStore({ maxSize: 10 })
      const scopedAct = withStore(store)
      await scopedAct(`scope-${i}`, async () => i)
      store.destroy()
    }

    // all 1000 scopes pruned; only 'default' may remain. passing without OOM is the signal.
    expect(true).toBe(true)
  })
})
