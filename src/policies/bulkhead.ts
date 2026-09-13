import type { ActFn, PolicyApplier, PolicyContext, BulkheadOptions } from '../types.js'
import type { SyncStateStore } from '../stores/contract.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { assertBulkheadOptions } from '../validate.js'
import { BulkheadOverflowError } from '../errors.js'
import { safeCall } from '../safeCall.js'

const NS = 'bulk:'
interface QueueEntry {
  resolve: () => void
  reject: (e: unknown) => void
  timer: ReturnType<typeof setTimeout> | undefined
  onAbort: (() => void) | undefined
  signal: AbortSignal | undefined
}

interface BulkheadState {
  active: number
  queue: QueueEntry[]
  backpressureEmitted?: boolean
}

function getState(store: SyncStateStore, key: string): BulkheadState {
  return store.get<BulkheadState>(NS + key) ?? { active: 0, queue: [] }
}

function setState(store: SyncStateStore, key: string, state: BulkheadState): void {
  store.set(NS + key, state)
}

/**
 * Bulkhead: caps concurrent in-flight calls per key. Excess callers reject
 * immediately when `queueTimeoutMs` is 0 (the default, fail-fast) or queue
 * up to `maxQueueSize` waiting for a slot until the queue timeout fires.
 *
 * Options are validated at construction (since 1.4) via the same
 * `assertBulkheadOptions` the `act()` path uses, so direct `execute()`
 * users get identical guarantees: non-finite `queueTimeoutMs` no longer
 * reaches `setTimeout`, which would clamp it to a 1 ms fire.
 */
export function bulkheadPolicy<T>(opts: BulkheadOptions): PolicyApplier<T> {
  assertBulkheadOptions(opts)

  const maxConcurrent = opts.maxConcurrent
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
          setState(syncCtx.store, key, state)
          return Promise.resolve()
        }

        if (queueTimeoutMs === 0) {
          throw new BulkheadOverflowError(key, maxConcurrent)
        }

        const currentState = getState(syncCtx.store, key)
        if (currentState.queue.length >= maxQueueSize) {
          throw new BulkheadOverflowError(key, maxConcurrent)
        }

        return new Promise<void>((resolve, reject) => {
          const state2 = getState(syncCtx.store, key)
          // all fields up front: one hidden class for every queue entry
          const entry: QueueEntry = {
            resolve, reject, timer: undefined, onAbort: undefined, signal,
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

          // onBackpressure fires at most once per 80%-crossing
          const obs = syncCtx.observability
          if (obs && maxQueueSize !== Number.POSITIVE_INFINITY) {
            const utilization = state2.queue.length / maxQueueSize
            const wasOver80 = state2.backpressureEmitted === true
            if (utilization >= 0.8 && !wasOver80) {
              state2.backpressureEmitted = true
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
              state2.backpressureEmitted = false
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
          if (next.onAbort && next.signal) {
            next.signal.removeEventListener('abort', next.onAbort)
          }
          next.resolve()
        }
        if (state.active < 0) state.active = 0
        // clear the flag on release too: a queue draining purely via
        // releases never re-enters acquire, so the next crossing must arm
        if (state.backpressureEmitted === true && state.queue.length / maxQueueSize < 0.8) {
          state.backpressureEmitted = false
        }
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
