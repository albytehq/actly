import type { ActFn, PolicyApplier, PolicyContext, BulkheadOptions } from '../types/index.js'
import type { SyncStateStore } from '../stores/base.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { BulkheadOverflowError } from '../errors.js'

const NS = 'bulk:'

interface BulkheadState {
  active: number
  queue: Array<{
    resolve: () => void
    reject: (e: unknown) => void
    timer?: ReturnType<typeof setTimeout>
    onAbort?: () => void
    signal?: AbortSignal
  }>
}

function getState(store: SyncStateStore, key: string): BulkheadState {
  return store.get<BulkheadState>(NS + key) ?? { active: 0, queue: [] }
}

function setState(store: SyncStateStore, key: string, state: BulkheadState): void {
  store.set(NS + key, state)
}

export function bulkheadPolicy<T>(opts: BulkheadOptions): PolicyApplier<T> {
  const maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent))
  const queueTimeoutMs = opts.queueTimeoutMs ?? 0

  const applier = (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> => {
    const syncCtx = ctx as Omit<PolicyContext, 'store'> & { store: SyncStateStore }

    return async (signal: AbortSignal) => {
      const key = syncCtx.key

      const acquireSlot = (): Promise<void> => {
        // If signal already aborted, reject immediately
        if (signal.aborted) return Promise.reject(signal.reason)

        const state = getState(syncCtx.store, key)
        if (state.active < maxConcurrent) {
          state.active++
          setState(syncCtx.store, key, state)
          return Promise.resolve()
        }

        if (queueTimeoutMs === 0) {
          throw new BulkheadOverflowError(key, maxConcurrent)
        }

        return new Promise<void>((resolve, reject) => {
          const state2 = getState(syncCtx.store, key)
          const entry: { resolve: () => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setTimeout>; onAbort?: () => void; signal?: AbortSignal } = {
            resolve,
            reject,
            signal,
          }

          // Remove entry from queue on signal abort
          entry.onAbort = () => {
            const s = getState(syncCtx.store, key)
            const idx = s.queue.indexOf(entry)
            if (idx >= 0) {
              s.queue.splice(idx, 1)
              setState(syncCtx.store, key, s)
            }
            if (entry.timer) clearTimeout(entry.timer)
            reject(signal.reason)
          }

          if (queueTimeoutMs > 0) {
            entry.timer = setTimeout(() => {
              const s = getState(syncCtx.store, key)
              const idx = s.queue.indexOf(entry)
              if (idx >= 0) s.queue.splice(idx, 1)
              setState(syncCtx.store, key, s)
              signal.removeEventListener('abort', entry.onAbort!)
              reject(new BulkheadOverflowError(key, maxConcurrent))
            }, queueTimeoutMs)
          }

          signal.addEventListener('abort', entry.onAbort!, { once: true })
          state2.queue.push(entry)
          setState(syncCtx.store, key, state2)
        })
      }

      const releaseSlot = (): void => {
        const state = getState(syncCtx.store, key)
        state.active--
        if (state.queue.length > 0) {
          const next = state.queue.shift()!
          state.active++
          if (next.timer) clearTimeout(next.timer)
          // Remove abort listener from the QUEUED caller's signal (not releaser's)
          if (next.onAbort && next.signal) {
            next.signal.removeEventListener('abort', next.onAbort)
          }
          next.resolve()
        }
        if (state.active < 0) state.active = 0
        setState(syncCtx.store, key, state)
      }

      await acquireSlot()
      try {
        return await fn(signal)
      } finally {
        releaseSlot()
      }
    }
  }

  ;(applier as typeof applier & { [REQUIRES_SYNC_STORE]: boolean })[REQUIRES_SYNC_STORE] = true
  return applier
}
