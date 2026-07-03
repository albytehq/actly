"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeDelay = computeDelay;
/**
 * Compute the delay before the next retry attempt, applying backoff, cap, and
 * jitter in that order.
 *
 * Order matters:
 *  1. `backoff` grows the base delay geometrically/linearly.
 *  2. `maxDelay` caps the result (prevents exponential blowup).
 *  3. `jitter` randomises within `[0, delay]` (prevents thundering herd).
 *
 * Returns 0 if `delayMs` is 0 or undefined — skipping the sleep entirely.
 */
function computeDelay(attempt, opts) {
    const base = opts.delayMs ?? 0;
    if (base === 0)
        return 0;
    // Step 1: backoff
    let delay;
    switch (opts.backoff ?? 'none') {
        case 'linear':
            delay = base * attempt;
            break;
        case 'exponential':
            delay = base * 2 ** (attempt - 1);
            break;
        default: delay = base;
    }
    // Step 2: cap (guard against Infinity and NaN before Math.min)
    const max = opts.maxDelay ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(delay))
        delay = max;
    delay = Math.min(delay, max);
    // Step 3: jitter
    // All jitter variants produce a delay in [0, delay].
    // The `decorrelated` formula `base + random() * (delay - base)` assumes
    // delay >= base, which can be violated when maxDelay caps below base.
    // Fix: clamp the final result to [0, delay] to guarantee the cap holds.
    switch (opts.jitter ?? 'full') {
        case 'none': return delay;
        case 'full': return Math.random() * delay;
        case 'equal': return delay / 2 + Math.random() * delay / 2;
        case 'decorrelated': {
            // If delay < base (maxDelay capped below base), decorrelated degrades
            // to full jitter — the formula would otherwise produce values > delay.
            const lo = Math.min(base, delay);
            const hi = delay;
            const result = lo + Math.random() * (hi - lo);
            return Math.max(0, Math.min(result, delay));
        }
        default: return delay;
    }
}
