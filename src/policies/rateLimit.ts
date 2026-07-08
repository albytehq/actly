import type { ActFn, PolicyApplier, PolicyContext, RateLimitOptions } from '../types/index.js'
import type { SyncStateStore } from '../stores/base.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { RateLimitError } from '../errors.js'

const NS = 'rl:'

interface RateLimitState {
  timestamps: number[]
}

function getState(store: SyncStateStore, key: string): RateLimitState {
  return store.get<RateLimitState>(NS + key) ?? { timestamps: [] }
}

function setState(store: SyncStateStore, key: string, state: RateLimitState, ttlMs?: number): void {
  store.set(NS + key, state, ttlMs)
}

export function rateLimitPolicy<T>(opts: RateLimitOptions): PolicyApplier<T> {
  const maxCalls = Math.max(1, Math.floor(opts.maxCalls))
  const windowMs = opts.windowMs

  const applier = (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> => {
    const syncCtx = ctx as Omit<PolicyContext, 'store'> & { store: SyncStateStore }

    return async (signal: AbortSignal) => {
      // aborted calls don't consume budget - otherwise a burst of aborts
      // would starve non-aborted callers
      if (signal.aborted) return Promise.reject(signal.reason)

      const key = syncCtx.key
      const now = Date.now()
      const state = getState(syncCtx.store, key)

      const cutoff = now - windowMs
      // timestamps are appended in time order, so oldest is at index 0.
      // If the oldest is still in-window, all are - skip the filter.
      const ts = state.timestamps
      if (ts.length > 0 && ts[0]! <= cutoff) {
        let i = 0
        while (i < ts.length && ts[i]! <= cutoff) i++
        if (i > 0) {
          state.timestamps = i === ts.length ? [] : ts.slice(i)
        }
      }

      if (state.timestamps.length >= maxCalls) {
        // keep state with a TTL so it auto-expires even with no further calls
        setState(syncCtx.store, key, state, windowMs)
        throw new RateLimitError(key, maxCalls, windowMs)
      }

      state.timestamps.push(now)
      // TTL = windowMs so the entry auto-expires after inactivity - without
      // this, high-cardinality keys would leak state forever.
      setState(syncCtx.store, key, state, windowMs)

      return fn(signal)
    }
  }

  ;(applier as typeof applier & { [REQUIRES_SYNC_STORE]: boolean })[REQUIRES_SYNC_STORE] = true
  return applier
}
