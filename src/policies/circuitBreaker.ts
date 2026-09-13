import type { ActFn, PolicyApplier, PolicyContext, CircuitBreakerOptions } from '../types.js'
import type { SyncStateStore } from '../stores/contract.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { assertCircuitBreakerOptions } from '../validate.js'
import { CircuitBreakerOpenError } from '../errors.js'
import { isAbortError } from '../abort.js'
import { LIMITS } from '../limits.js'

const NS = 'cb:'

interface ConsecutiveState {
  strategy: 'consecutive'
  failures: number
  lastFailureTime: number
  isOpen: boolean
  openedAt: number
  halfOpen: boolean
}

interface CountState {
  strategy: 'count'
  /** Ring buffer of recent outcomes (true = success). */
  outcomes: boolean[]
  /** Next write position in the ring buffer. */
  index: number
  /** Failure count in the window, kept incrementally. */
  failures: number
  /** Recorded outcomes, capped at windowSize. */
  filled: number
  isOpen: boolean
  openedAt: number
  halfOpen: boolean
  lastFailureTime: number
}

type BreakerState = ConsecutiveState | CountState

function getState(store: SyncStateStore, key: string, strategy: 'consecutive' | 'count'): BreakerState {
  const existing = store.get<BreakerState>(NS + key)
  if (existing) return existing
  if (strategy === 'count') {
    return {
      strategy: 'count', outcomes: [], index: 0, failures: 0, filled: 0,
      isOpen: false, openedAt: 0, halfOpen: false, lastFailureTime: 0,
    }
  }
  return {
    strategy: 'consecutive', failures: 0, lastFailureTime: 0,
    isOpen: false, openedAt: 0, halfOpen: false,
  }
}

// State TTL: bounds how long a dead key's breaker state sticks in the
// store. Must exceed cooldownMs so an open circuit cannot expire closed.
function stateTtlMs(cooldownMs: number, resetTimeoutMs: number): number {
  const reset = Number.isFinite(resetTimeoutMs) ? resetTimeoutMs : 60_000
  return Math.min(cooldownMs + reset, LIMITS.MAX_INFLIGHT_TTL)
}

function setState(store: SyncStateStore, key: string, state: BreakerState, ttlMs: number): void {
  store.set(NS + key, state, ttlMs)
}

function recordCountOutcome(state: CountState, success: boolean, windowSize: number): void {
  if (state.outcomes.length < windowSize) {
    state.outcomes.push(success)
    state.filled = state.outcomes.length
    if (!success) state.failures++
    state.index = (state.index + 1) % windowSize
    return
  }
  if (state.outcomes[state.index] === false) state.failures--
  state.outcomes[state.index] = success
  if (!success) state.failures++
  state.index = (state.index + 1) % windowSize
  state.filled = windowSize
}

function countFailureRate(state: CountState): number {
  if (state.filled === 0) return 0
  return state.failures / state.filled
}

function resetCountState(state: CountState): void {
  state.outcomes = []
  state.index = 0
  state.failures = 0
  state.filled = 0
  state.isOpen = false
  state.openedAt = 0
  state.halfOpen = false
  state.lastFailureTime = 0
}

/**
 * Circuit breaker. `'consecutive'` (default) opens after `threshold`
 * consecutive failures; `'count'` opens when the failure rate over the
 * window exceeds `countThreshold` with at least `countMinimumCalls`.
 * Half-open allows exactly one probe; a successful probe closes, a failed
 * one re-opens. Caller aborts are never counted as downstream failures.
 *
 * Options are validated at construction (since 1.4): `cooldownMs: NaN`
 * would otherwise keep an open circuit throwing forever (`elapsed >= NaN`
 * is always false), and `countThreshold` out of range was silently clamped.
 */
export function circuitBreakerPolicy<T>(opts: CircuitBreakerOptions): PolicyApplier<T> {
  assertCircuitBreakerOptions(opts)
  const threshold = opts.threshold
  const cooldownMs = opts.cooldownMs
  const resetTimeoutMs = opts.resetTimeoutMs ?? Number.POSITIVE_INFINITY
  const strategy: 'consecutive' | 'count' = opts.strategy ?? 'consecutive'
  const countSize = strategy === 'count' ? (opts.countSize ?? 100) : 0
  const countThreshold = strategy === 'count' ? (opts.countThreshold ?? 0.5) : 0
  const countMinimumCalls = strategy === 'count'
    ? (opts.countMinimumCalls ?? countSize)
    : 0
  const ttl = stateTtlMs(cooldownMs, resetTimeoutMs)

  const applier = (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> => {
    const syncCtx = ctx as Omit<PolicyContext, 'store'> & { store: SyncStateStore }

    return async (signal: AbortSignal) => {
      const key = syncCtx.key
      const now = Date.now()

      const state = getState(syncCtx.store, key, strategy)

      if (state.isOpen) {
        const elapsed = now - state.openedAt
        if (elapsed >= cooldownMs) {
          // half-open: allow one probe
          state.isOpen = false
          state.halfOpen = true
          setState(syncCtx.store, key, state, ttl)
        } else {
          throw new CircuitBreakerOpenError(key, cooldownMs - elapsed)
        }
      } else if (state.halfOpen) {
        // a probe is already in flight
        throw new CircuitBreakerOpenError(key, 0)
      }

      if (now - state.lastFailureTime > resetTimeoutMs && state.lastFailureTime > 0) {
        // idle reset; the !halfOpen guard keeps a mid-probe reset from
        // wiping the half-open flag (which would break one-probe-only)
        if (!state.halfOpen) {
          if (state.strategy === 'count') {
            resetCountState(state)
          } else {
            state.failures = 0
            state.isOpen = false
            state.openedAt = 0
            state.halfOpen = false
          }
          setState(syncCtx.store, key, state, ttl)
        }
      }

      try {
        const result = await fn(signal)
        // re-read: state may have changed during the await
        const updated = getState(syncCtx.store, key, strategy)
        const wasHalfOpen = updated.halfOpen
        // a successful half-open probe resets the window so stale failures
        // cannot re-trip the breaker on the next call
        if (wasHalfOpen && updated.strategy === 'count') {
          resetCountState(updated)
        } else if (updated.strategy === 'count') {
          recordCountOutcome(updated, true, countSize)
        } else {
          updated.failures = 0
        }
        // close only when we were half-open: a concurrent failure during
        // the await may have opened the breaker; this success must not
        // force-close it (it still counts toward the window)
        if (wasHalfOpen) {
          updated.isOpen = false
          updated.halfOpen = false
        }
        const isIdle = updated.failures === 0 && !updated.isOpen && !updated.halfOpen
        if (isIdle) {
          syncCtx.store.delete(NS + key)
        } else {
          setState(syncCtx.store, key, updated, ttl)
        }
        return result
      } catch (err) {
        // caller aborts are not downstream failures, but a manually thrown
        // AbortError still is: gate on signal.aborted
        if (signal.aborted && (isAbortError(err) || err === signal.reason)) {
          const updated = getState(syncCtx.store, key, strategy)
          if (updated.failures === 0 && !updated.isOpen && !updated.halfOpen) {
            syncCtx.store.delete(NS + key)
          } else {
            setState(syncCtx.store, key, updated, ttl)
          }
          throw err
        }
        const updated = getState(syncCtx.store, key, strategy)
        const wasHalfOpen = updated.halfOpen
        updated.lastFailureTime = Date.now()
        updated.halfOpen = false

        if (updated.strategy === 'count') {
          recordCountOutcome(updated, false, countSize)
          const rate = countFailureRate(updated)
          const enoughCalls = updated.filled >= countMinimumCalls
          if (wasHalfOpen || (enoughCalls && rate > countThreshold)) {
            updated.isOpen = true
            updated.openedAt = Date.now()
          }
        } else {
          updated.failures++
          if (updated.failures >= threshold || wasHalfOpen) {
            updated.isOpen = true
            updated.openedAt = Date.now()
          }
        }
        setState(syncCtx.store, key, updated, ttl)
        throw err
      }
    }
  }

  ;(applier as typeof applier & { [REQUIRES_SYNC_STORE]: boolean })[REQUIRES_SYNC_STORE] = true
  return applier
}
