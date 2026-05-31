import type { ActFn, PolicyApplier, PolicyContext, RetryOptions } from '../types/index.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeDelay(attempt: number, opts: RetryOptions): number {
  const base = opts.delayMs ?? 0
  if (base === 0) return 0

  switch (opts.backoff ?? 'none') {
    case 'linear':      return base * attempt
    case 'exponential': return base * 2 ** (attempt - 1)
    default:            return base
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ─── Policy ──────────────────────────────────────────────────────────────────

/**
 * Retries fn up to opts.attempts times on any thrown error.
 * Writes the live attempt count into ctx.meta.attempts.
 */
export function retryPolicy<T>(opts: RetryOptions): PolicyApplier<T> {
  const max = Math.max(1, opts.attempts)

  return (fn: ActFn<T>, ctx: PolicyContext): ActFn<T> =>
    async () => {
      let lastErr: unknown

      for (let attempt = 1; attempt <= max; attempt++) {
        ctx.meta.attempts = attempt
        try {
          return await fn()
        } catch (err) {
          lastErr = err

          if (attempt < max) {
            // Non-retryable error — bail immediately without consuming
            // remaining attempts. The error surfaces exactly as-is.
            if (opts.shouldRetry && !opts.shouldRetry(err, attempt)) {
              throw err
            }

            const delay = computeDelay(attempt, opts)
            if (delay > 0) await sleep(delay)
          }
        }
      }

      // Every attempt failed — surface the last error upstream
      throw lastErr
    }
}
