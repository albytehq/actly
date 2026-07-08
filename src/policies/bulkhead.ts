import type { ActFn, PolicyApplier, PolicyContext, BulkheadOptions } from '../types/index.js'
import type { SyncStateStore } from '../stores/base.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { BulkheadOverflowError } from '../errors.js'
import { safeCall } from '../utils/safeCall.js'

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
  const maxQueueSize = opts.maxQueueSize ?? Number.POSITIVE_INFINITY

  const applier = (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> => {
    const syncCtx = ctx as Omit<PolicyContext, 'store'> & { store: SyncStateStore }

    return async (signal: AbortSignal) => {
      const key = syncCtx.key

      const acquireSlot = (): Promise<void> => {
        if (signal.aborted) return Promise.reject(signal.reason)

        const state = getState(syncCtx.store, key)
        if (state.active < maxConcurrent) {
          state.active++
          // persist - getState may have returned a fresh default
          setState(syncCtx.store, key, state)
          return Promise.resolve()
        }

        if (queueTimeoutMs === 0) {
          throw new BulkheadOverflowError(key, maxConcurrent)
        }

        // bound the queue to prevent OOM under stampede - without this a
        // 100k-caller spike against maxConcurrent:10 would queue 99990
        // callers, each holding a resolver + timer + listener closure.
        const currentState = getState(syncCtx.store, key)
        if (currentState.queue.length >= maxQueueSize) {
          throw new BulkheadOverflowError(key, maxConcurrent)
        }

        return new Promise<void>((resolve, reject) => {
          const state2 = getState(syncCtx.store, key)
          // declare all fields up front so V8 sees one hidden class for
          // every queue entry - keeps ICs monomorphic
          const entry: {
            resolve: () => void
            reject: (e: unknown) => void
            timer: ReturnType<typeof setTimeout> | undefined
            onAbort: (() => void) | undefined
            signal: AbortSignal | undefined
          } = {
            resolve,
            reject,
            timer: undefined,
            onAbort: undefined,
            signal,
          }

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

          // emit onBackpressure at most once per 80%-crossing to avoid spam.
          // Checked after pushing so utilization includes this caller.
          const obs = syncCtx.observability
          if (obs && maxQueueSize !== Number.POSITIVE_INFINITY) {
            const utilization = state2.queue.length / maxQueueSize
            const wasOver80 = (state2 as { backpressureEmitted?: boolean }).backpressureEmitted === true
            if (utilization >= 0.8 && !wasOver80) {
              ;(state2 as { backpressureEmitted?: boolean }).backpressureEmitted = true
              safeCall(obs.hooks.onBackpressure, {
                type: 'backpressure',
                key: syncCtx.key,
                traceId: obs.traceId,
                timestamp: Date.now(),
                source: 'bulkhead',
                queueLength: state2.queue.length,
                maxConcurrent,
                maxQueueSize,
                utilization,
              })
            } else if (utilization < 0.8 && wasOver80) {
              ;(state2 as { backpressureEmitted?: boolean }).backpressureEmitted = false
            }
          }

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
          // drop the abort listener from the QUEUED caller's signal, not the releaser's
          if (next.onAbort && next.signal) {
            next.signal.removeEventListener('abort', next.onAbort)
          }
          next.resolve()
        }
        if (state.active < 0) state.active = 0
        // reset the backpressure flag on release too - if the queue drains
        // purely via releases with no new callers, the acquire path never
        // gets a chance to clear it and the next 80%-crossing is dropped.
        if (maxQueueSize !== Number.POSITIVE_INFINITY && (state as { backpressureEmitted?: boolean }).backpressureEmitted === true) {
          if (state.queue.length / maxQueueSize < 0.8) {
            ;(state as { backpressureEmitted?: boolean }).backpressureEmitted = false
          }
        }
        // drop idle state so high-cardinality keys don't accumulate
        if (state.active === 0 && state.queue.length === 0) {
          syncCtx.store.delete(NS + key)
        } else {
          setState(syncCtx.store, key, state)
        }
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
