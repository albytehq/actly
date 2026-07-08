"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeDelay = computeDelay;
function computeDelay(attempt, opts) {
    const base = opts.delayMs ?? 0;
    if (base === 0)
        return 0;
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
    const max = opts.maxDelay ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(delay))
        delay = max;
    delay = Math.min(delay, max);
    switch (opts.jitter ?? 'full') {
        case 'none': return delay;
        case 'full': return Math.random() * delay;
        case 'equal': return delay / 2 + Math.random() * delay / 2;
        case 'decorrelated': {
            if (delay < base)
                return Math.random() * delay;
            const lo = base;
            const hi = delay;
            const result = lo + Math.random() * (hi - lo);
            return Math.max(0, Math.min(result, delay));
        }
        default: return delay;
    }
}
