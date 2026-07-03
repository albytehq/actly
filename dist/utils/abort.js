// ─── AbortSignal helpers ──────────────────────────────────────────────────────
//
// Contract: zero listener accumulation on long-lived AbortSignals.
//
// Every `addEventListener('abort', ...)` MUST be paired with a
// `removeEventListener` on the success path, OR use `AbortSignal.any()`
// (Node 20+ native) which handles cleanup automatically.
//
// Long-lived signals (server shutdown, request pool) must not accumulate
// one listener per `act()` call — that would cause
// `MaxListenersExceededWarning` and unbounded closure retention.
/**
 * Compose multiple AbortSignals into one. Aborts when ANY input aborts,
 * with the same reason.
 *
 * Uses native `AbortSignal.any()` on Node 20+ (zero allocations, no
 * listener leaks — the runtime owns the lifecycle). Falls back to a
 * polyfill that explicitly removes listeners on first abort.
 *
 * # Listener safety
 *
 * The polyfill registers `{ once: true }` listeners on each input and
 * manually removes the others when one fires. After settlement, the
 * composite signal holds zero references to the inputs — they may be GC'd.
 */
export function anySignal(signals) {
    // Filter out undefined / null defensively.
    const filtered = signals.filter((s) => s != null);
    if (filtered.length === 0) {
        // No inputs → never-aborting signal. Use a fresh controller so callers
        // get a real AbortSignal, not a hand-rolled mock.
        return new AbortController().signal;
    }
    if (filtered.length === 1)
        return filtered[0];
    // Native path (Node 20+, modern browsers, Bun).
    const native = AbortSignal.any;
    if (typeof native === 'function') {
        return native.call(AbortSignal, filtered);
    }
    // Polyfill: only used when native is missing. Listener-safe.
    const controller = new AbortController();
    const listeners = [];
    for (const signal of filtered) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        const onAbort = () => {
            controller.abort(signal.reason);
            // Remove all other listeners — they hold closures over `signal`
            // and would otherwise keep the inputs alive past settlement.
            for (const off of listeners)
                off();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        listeners.push(() => signal.removeEventListener('abort', onAbort));
    }
    return controller.signal;
}
/**
 * Race a promise against an AbortSignal.
 *
 * - If the signal is already aborted, rejects immediately with `signal.reason`.
 * - If the signal aborts while the promise is pending, rejects with `signal.reason`.
 * - If the promise settles first, returns its value (or rejects with its error).
 *
 * # Listener safety
 *
 * On success path, the abort listener is explicitly removed. A
 * `{ once: true }` listener would stay attached on long-lived signals,
 * leaking one closure per call.
 *
 * # Mark-as-handled
 *
 * When the signal aborts first, the original `promise` may still settle
 * later (success or failure). We attach a no-op `.catch` to it so V8
 * doesn't emit an `unhandledRejection` warning. The error is NOT
 * swallowed from the caller — the caller already received `signal.reason`.
 */
export function raceAbort(promise, signal) {
    if (signal.aborted) {
        // Mark the promise as handled — its eventual rejection won't surface
        // as an unhandled rejection. Its eventual success is dropped silently,
        // which is correct: the caller has already moved on.
        promise.catch(() => { });
        return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason);
        };
        // Not using `{ once: true }` — we want explicit removal on success
        // path so the listener doesn't linger on a long-lived signal.
        signal.addEventListener('abort', onAbort);
        promise.then((value) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
/**
 * Sleep for `ms` milliseconds, but abort early if `signal` fires.
 *
 * Resolves normally on timer expiry. Rejects with `signal.reason` if the
 * signal aborts before the timer fires. If the signal is already aborted
 * when called, rejects synchronously (in microtask).
 *
 * # Timer hygiene
 *
 * The internal `setTimeout` is `unref`'d on Node so it doesn't keep the
 * event loop alive solely for this sleep. On browsers there is no
 * equivalent — the timer is short-lived enough not to matter.
 */
export function sleep(ms, signal) {
    if (ms <= 0) {
        if (signal?.aborted)
            return Promise.reject(signal.reason);
        return Promise.resolve();
    }
    if (signal?.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        // NOTE: do NOT `unref()` this timer. Unlike InMemoryStore's autoCleanup
        // interval (which is a background housekeeping task), `sleep()` IS the
        // operation the caller is awaiting. If we unref'd it, Node could exit
        // the process while a retry delay was pending — silently dropping the
        // operation. The timer is short-lived (cleared in onAbort or after ms),
        // so the cost of keeping the loop alive is bounded.
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal?.addEventListener('abort', onAbort);
    });
}
/**
 * True if `err` is an `AbortError` (DOMException name or Error name).
 *
 * The default `shouldRetry` predicate uses this to skip retrying on
 * cancellations — if the caller aborted, retrying would just abort again.
 */
export function isAbortError(err) {
    if (err == null || typeof err !== 'object')
        return false;
    const name = err.name;
    if (name === 'AbortError')
        return true;
    // DOMException with name 'TimeoutError' is what AbortSignal.timeout throws.
    // Distinguish from our own TimeoutError class by checking for DOMException.
    if (name === 'TimeoutError' &&
        err instanceof Error &&
        typeof DOMException !== 'undefined' &&
        err instanceof DOMException) {
        return true;
    }
    return false;
}
/**
 * Link a parent signal to a child controller: when the parent aborts, the
 * child is aborted with the same reason.
 *
 * # Contract
 *
 * Returns an `unlink()` function that removes the listener. Callers MUST
 * call `unlink()` on success path — otherwise the listener stays attached
 * to the parent forever, leaking one closure per call.
 *
 * If the parent is already aborted, the child is aborted synchronously
 * and `unlink` is a no-op.
 *
 * # Prefer `anySignal()` instead
 *
 * For new code, prefer `anySignal([parent, timeoutSignal])` which uses
 * the native Node 20+ implementation and handles cleanup automatically.
 * This function exists for call sites that need an `AbortController`
 * (not just a signal) — e.g. to layer additional abort sources.
 */
export function linkSignal(parent, child) {
    if (parent.aborted) {
        child.abort(parent.reason);
        return () => { };
    }
    const onAbort = () => child.abort(parent.reason);
    parent.addEventListener('abort', onAbort);
    return () => parent.removeEventListener('abort', onAbort);
}
//# sourceMappingURL=abort.js.map