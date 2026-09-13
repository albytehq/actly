/**
 * Monotonic clock for durations: `Date.now()` can jump backwards under
 * NTP/DST/VM restores; `performance.now()` cannot.
 */
export function monotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

/**
 * Trace ID for log/metric correlation: `crypto.randomUUID()` when
 * available, otherwise timestamp + random.
 */
export function generateTraceId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `actly-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Scope ID for `withStore()`: collision-free via randomUUID. The
 * Math.random fallback (~4.7e18 ids) only matters for pathological process
 * counts or runtimes without Web Crypto; collisions there would merge two
 * scopes' health/drain state, not user data.
 */
export function generateScopeId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return 'scoped:' + (crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 14))
}
