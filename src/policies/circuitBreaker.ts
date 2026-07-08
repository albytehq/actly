import type { ActFn, PolicyApplier, PolicyContext, CircuitBreakerOptions } from '../types/index.js'
import type { SyncStateStore } from '../stores/base.js'
import { REQUIRES_SYNC_STORE } from '../core/executor.js'
import { CircuitBreakerOpenError } from '../errors.js'
import { isAbortError } from '../utils/abort.js'

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
  /** Ring buffer of recent outcomes (true = success, false = failure). */
  outcomes: boolean[]
  /** Index in the ring buffer to write next (wraps around). */
  index: number
  /** Failure count in the window - kept incrementally to avoid re-counting. */
  failures: number
  /** Number of calls recorded (capped at outcomes.length). */
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
      strategy: 'count',
      outcomes: [],
      index: 0,
      failures: 0,
      filled: 0,
      isOpen: false,
      openedAt: 0,
      halfOpen: false,
      lastFailureTime: 0,
    }
  }
  return {
    strategy: 'consecutive',
    failures: 0,
    lastFailureTime: 0,
    isOpen: false,
    openedAt: 0,
    halfOpen: false,
  }
}

function setState(store: SyncStateStore, key: string, state: BreakerState): void {
  store.set(NS + key, state)
}

/** Record an outcome in the count strategy's ring buffer. */
function recordCountOutcome(state: CountState, success: boolean, windowSize: number): void {
  if (state.outcomes.length < windowSize) {
    state.outcomes.push(success)
    state.filled = state.outcomes.length
    if (!success) state.failures++
    state.index = (state.index + 1) % windowSize
    return
  }
  // buffer full - overwrite oldest, swap failure count if needed
  if (state.outcomes[state.index] === false) state.failures--
  state.outcomes[state.index] = success
  if (!success) state.failures++
  state.index = (state.index + 1) % windowSize
  state.filled = windowSize
}

/** Failure rate in the window (0-1). */
function countFailureRate(state: CountState): number {
  if (state.filled === 0) return 0
  return state.failures / state.filled
}

/** Reset count state to "closed with empty window". */
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

export function circuitBreakerPolicy<T>(opts: CircuitBreakerOptions): PolicyApplier<T> {
  const threshold = Math.max(1, Math.floor(opts.threshold))
  const cooldownMs = opts.cooldownMs
  const resetTimeoutMs = opts.resetTimeoutMs ?? Number.POSITIVE_INFINITY
  const strategy: 'consecutive' | 'count' = opts.strategy ?? 'consecutive'
  const countSize = strategy === 'count' ? Math.max(1, Math.floor(opts.countSize ?? 100)) : 0
  const countThreshold = strategy === 'count'
    ? Math.min(1, Math.max(0, opts.countThreshold ?? 0.5))
    : 0
  const countMinimumCalls = strategy === 'count'
    ? Math.max(1, Math.floor(opts.countMinimumCalls ?? countSize))
    : 0

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
          setState(syncCtx.store, key, state)
        } else {
          throw new CircuitBreakerOpenError(key, cooldownMs - elapsed)
        }
      } else if (state.halfOpen) {
        // a probe is in flight - block this one
        throw new CircuitBreakerOpenError(key, 0)
      }

      if (now - state.lastFailureTime > resetTimeoutMs && state.lastFailureTime > 0) {
        // idle reset back to closed. Guard with !state.halfOpen so an idle
        // reset doesn't fire mid-probe and wipe the half-open flag, which
        // would let concurrent callers bypass the "one probe" invariant.
        // Both strategies fully reset on idle (not just clear failures).
        if (!state.halfOpen) {
          if (state.strategy === 'count') {
            resetCountState(state)
          } else {
            state.failures = 0
            state.isOpen = false
            state.openedAt = 0
            state.halfOpen = false
          }
          setState(syncCtx.store, key, state)
        }
      }

      try {
        const result = await fn(signal)
        // re-read state - it may have changed during the await
        const updated = getState(syncCtx.store, key, strategy)
        const wasHalfOpen = updated.halfOpen
        // on a successful half-open probe, reset the count window so stale
        // failures don't re-trip the breaker on the very next call.
        if (wasHalfOpen && updated.strategy === 'count') {
          resetCountState(updated)
        } else if (updated.strategy === 'count') {
          recordCountOutcome(updated, true, countSize)
        } else {
          updated.failures = 0
        }
        // only close if we were half-open - otherwise a concurrent failure
        // during await could have opened the breaker and this success must
        // not force-close it. The success still counts toward the window.
        if (wasHalfOpen) {
          updated.isOpen = false
          updated.halfOpen = false
        }
        // drop idle state so high-cardinality keys don't accumulate
        const isIdle = updated.failures === 0 && !updated.isOpen && !updated.halfOpen
        if (isIdle) {
          syncCtx.store.delete(NS + key)
        } else {
          setState(syncCtx.store, key, updated)
        }
        return result
      } catch (err) {
        // signal aborts aren't downstream failures - gate on signal.aborted
        // so a manually-thrown AbortError (e.g. a downstream using it to
        // mean "app-cancelled") still counts as a failure. Don't re-open
        // on caller abort: if the half-open probe was aborted, leave
        // halfOpen so the next caller becomes the probe.
        if (signal.aborted && (isAbortError(err) || err === signal.reason)) {
          const updated = getState(syncCtx.store, key, strategy)
          if (updated.failures === 0 && !updated.isOpen && !updated.halfOpen) {
            syncCtx.store.delete(NS + key)
          } else {
            setState(syncCtx.store, key, updated)
          }
          throw err
        }
        const updated = getState(syncCtx.store, key, strategy)
        const wasHalfOpen = updated.halfOpen
        updated.lastFailureTime = Date.now()
        updated.halfOpen = false

        if (updated.strategy === 'count') {
          recordCountOutcome(updated, false, countSize)
          // trip if half-open probe failed, or rate exceeds threshold with
          // enough calls
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
        setState(syncCtx.store, key, updated)
        throw err
      }
    }
  }

  ;(applier as typeof applier & { [REQUIRES_SYNC_STORE]: boolean })[REQUIRES_SYNC_STORE] = true
  return applier
}
