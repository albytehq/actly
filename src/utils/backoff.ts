import type { RetryOptions } from '../types/index.js'

/**
 * Compute the delay before the next retry attempt.
 *
 * Order: backoff grows the base delay, maxDelay caps it, jitter randomises
 * within [0, delay] to prevent thundering herd. Returns 0 when delayMs is
 * unset so callers can skip the sleep entirely.
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

  // Cap. Guard Infinity/NaN before Math.min - NaN poisons both args.
  const max = opts.maxDelay ?? Number.POSITIVE_INFINITY
  if (!Number.isFinite(delay)) delay = max
  delay = Math.min(delay, max)

  // Jitter. All variants produce a value in [0, delay].
  switch (opts.jitter ?? 'full') {
    case 'none':         return delay
    case 'full':         return Math.random() * delay
    case 'equal':        return delay / 2 + Math.random() * delay / 2
    case 'decorrelated': {
      // When maxDelay caps delay below base, the [base, delay] interval is
      // empty - fall back to full jitter so we still spread the calls.
      if (delay < base) return Math.random() * delay
      const lo = base
      const hi = delay
      const result = lo + Math.random() * (hi - lo)
      return Math.max(0, Math.min(result, delay))
    }
    default:             return delay
  }
}
