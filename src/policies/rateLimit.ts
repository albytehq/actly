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

function setState(store: SyncStateStore, key: string, state: RateLimitState): void {
  store.set(NS + key, state)
}

export function rateLimitPolicy<T>(opts: RateLimitOptions): PolicyApplier<T> {
  const maxCalls = Math.max(1, Math.floor(opts.maxCalls))
  const windowMs = opts.windowMs

  const applier = (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> => {
    const syncCtx = ctx as Omit<PolicyContext, 'store'> & { store: SyncStateStore }

    return async (signal: AbortSignal) => {
      const key = syncCtx.key
      const now = Date.now()
      const state = getState(syncCtx.store, key)

      const cutoff = now - windowMs
      state.timestamps = state.timestamps.filter(t => t > cutoff)

      if (state.timestamps.length >= maxCalls) {
        setState(syncCtx.store, key, state)
        throw new RateLimitError(key, maxCalls, windowMs)
      }

      state.timestamps.push(now)
      setState(syncCtx.store, key, state)

      return fn(signal)
    }
  }

  ;(applier as typeof applier & { [REQUIRES_SYNC_STORE]: boolean })[REQUIRES_SYNC_STORE] = true
  return applier
}
