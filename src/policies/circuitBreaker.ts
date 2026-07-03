import type { ActFn, PolicyApplier, PolicyContext, CircuitBreakerOptions } from '../types/index.js'
import type { SyncStateStore } from '../stores/base.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { CircuitBreakerOpenError } from '../errors.js'
import { isAbortError } from '../utils/abort.js'

const NS = 'cb:'

interface BreakerState {
  failures: number
  lastFailureTime: number
  isOpen: boolean
  openedAt: number
  halfOpen: boolean
}

function getState(store: SyncStateStore, key: string): BreakerState {
  return store.get<BreakerState>(NS + key) ?? { failures: 0, lastFailureTime: 0, isOpen: false, openedAt: 0, halfOpen: false }
}

function setState(store: SyncStateStore, key: string, state: BreakerState): void {
  store.set(NS + key, state)
}

export function circuitBreakerPolicy<T>(opts: CircuitBreakerOptions): PolicyApplier<T> {
  const threshold = Math.max(1, Math.floor(opts.threshold))
  const cooldownMs = opts.cooldownMs
  const resetTimeoutMs = opts.resetTimeoutMs ?? Number.POSITIVE_INFINITY

  const applier = (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> => {
    const syncCtx = ctx as Omit<PolicyContext, 'store'> & { store: SyncStateStore }

    return async (signal: AbortSignal) => {
      const key = syncCtx.key
      const now = Date.now()

      // Read state synchronously and make decisions atomically
      const state = getState(syncCtx.store, key)

      if (state.isOpen) {
        const elapsed = now - state.openedAt
        if (elapsed >= cooldownMs) {
          // Transition to half-open: allow only ONE probe call
          state.isOpen = false
          state.halfOpen = true
          setState(syncCtx.store, key, state)
        } else {
          throw new CircuitBreakerOpenError(key, cooldownMs - elapsed)
        }
      } else if (state.halfOpen) {
        // Another call is already probing — block this one
        throw new CircuitBreakerOpenError(key, 0)
      }

      if (now - state.lastFailureTime > resetTimeoutMs && state.failures > 0) {
        state.failures = 0
        setState(syncCtx.store, key, state)
      }

      try {
        const result = await fn(signal)
        // Re-read state (it may have changed during await) and update atomically
        const updated = getState(syncCtx.store, key)
        updated.failures = 0
        updated.isOpen = false
        updated.halfOpen = false
        setState(syncCtx.store, key, updated)
        return result
      } catch (err) {
        // Signal aborts are not downstream failures — don't count them
        if (isAbortError(err) || (signal.aborted && err === signal.reason)) {
          const updated = getState(syncCtx.store, key)
          if (updated.halfOpen) {
            // Abort during half-open: probe didn't succeed or fail —
            // downstream health is still unknown. Go back to OPEN with
            // fresh cooldown so next call waits before probing again.
            updated.isOpen = true
            updated.openedAt = Date.now()
            updated.halfOpen = false
          }
          setState(syncCtx.store, key, updated)
          throw err
        }
        const updated = getState(syncCtx.store, key)
        updated.failures++
        updated.lastFailureTime = Date.now()
        updated.halfOpen = false
        if (updated.failures >= threshold) {
          updated.isOpen = true
          updated.openedAt = Date.now()
        }
        setState(syncCtx.store, key, updated)
        throw err
      }
    }
  }

  ;(applier as typeof applier & { [REQUIRES_SYNC_STORE]: boolean })[REQUIRES_SYNC_STORE] = true
  return applier
}
