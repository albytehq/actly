import type { ActFn, PolicyApplier, PolicyContext, RateLimitOptions } from '../types.js'
import type { SyncStateStore } from '../stores/contract.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { assertRateLimitOptions } from '../validate.js'
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

/**
 * Sliding-window rate limiter: at most `maxCalls` entries within `windowMs`
 * per key. Aborted calls never consume budget. Entry TTL = windowMs so
 * high-cardinality keys cannot leak state.
 *
 * Options are validated at construction (since 1.4): a negative window
 * would otherwise filter out every timestamp and silently disable the
 * limiter.
 */
export function rateLimitPolicy<T>(opts: RateLimitOptions): PolicyApplier<T> {
  assertRateLimitOptions(opts)
  const maxCalls = opts.maxCalls
  const windowMs = opts.windowMs

  const applier = (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> => {
    const syncCtx = ctx as Omit<PolicyContext, 'store'> & { store: SyncStateStore }

    return async (signal: AbortSignal) => {
      if (signal.aborted) return Promise.reject(signal.reason)

      const key = syncCtx.key
      const now = Date.now()
      const state = getState(syncCtx.store, key)

      const cutoff = now - windowMs
      const ts = state.timestamps
      if (ts.length > 0) {
        if (ts[ts.length - 1]! > now) {
          // wall clock jumped backwards: append order no longer implies
          // time order, so the skip-filter shortcut would miscount.
          // Full scan keeps the limiter conservative under NTP steps.
          state.timestamps = ts.filter((t) => t > cutoff)
        } else if (ts[0]! <= cutoff) {
          let i = 0
          while (i < ts.length && ts[i]! <= cutoff) i++
          state.timestamps = i === ts.length ? [] : ts.slice(i)
        }
      }

      if (state.timestamps.length >= maxCalls) {
        setState(syncCtx.store, key, state, windowMs)
        throw new RateLimitError(key, maxCalls, windowMs)
      }

      state.timestamps.push(now)
      setState(syncCtx.store, key, state, windowMs)

      return fn(signal)
    }
  }

  ;(applier as typeof applier & { [REQUIRES_SYNC_STORE]: boolean })[REQUIRES_SYNC_STORE] = true
  return applier
}
