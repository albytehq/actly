import type { RetryOptions } from './types.js'

/**
 * Compute the delay before the next retry attempt: backoff grows the base
 * delay, `maxDelay` caps it, jitter randomises within `[0, delay]`.
 * Returns 0 when `delayMs` is unset so callers can skip the sleep.
 */
export function computeDelay(attempt: number, opts: RetryOptions): number {
  const base = opts.delayMs ?? 0
  if (base === 0) return 0

  let delay: number
  switch (opts.backoff ?? 'none') {
    case 'linear':      delay = base * attempt; break
    case 'exponential': delay = base * 2 ** (attempt - 1); break
    default:            delay = base
  }

  const max = opts.maxDelay ?? Number.POSITIVE_INFINITY
  if (!Number.isFinite(delay)) delay = max
  delay = Math.min(delay, max)

  switch (opts.jitter ?? 'full') {
    case 'none':         return delay
    case 'full':         return Math.random() * delay
    case 'equal':        return delay / 2 + Math.random() * delay / 2
    case 'decorrelated': {
      if (delay < base) return Math.random() * delay
      return Math.max(0, Math.min(base + Math.random() * (delay - base), delay))
    }
    default:             return delay
  }
}
