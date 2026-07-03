"use strict";
/**
 * Observability hooks.
 *
 * Eight event types covering the entire lifecycle of an `act()` call.
 *
 * # Contract
 *
 * When `options.observability` is `null`/`undefined` (the common case),
 * no event objects are allocated and no function calls are made. The
 * hot path is a single null-check per policy decision.
 *
 * When hooks ARE registered, events are allocated lazily — only when the
 * corresponding event actually fires. A cache hit doesn't allocate an
 * `onRetry` event, for example.
 *
 * # Event shape
 *
 * Every event carries `key`, `traceId`, and `timestamp` for correlation.
 * Event-specific fields are on the same object (no nesting) for flat
 * destructuring in user code.
 *
 * # Ordering
 *
 * For a successful fresh call with retries:
 *   onAttempt (1) → onAttempt (2) → onRetry (1→2) → onAttempt (3) → onFinalSuccess
 *
 * For a cache hit:
 *   onCacheHit → onFinalSuccess
 *
 * For a dedupe joiner:
 *   onDedupeJoin → onFinalSuccess (or onFinalFailure)
 *
 * For a timeout:
 *   onAttempt → onTimeout → onFinalFailure
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasObservers = hasObservers;
/**
 * Quick null-check helper. Policies call this once at decision points; if
 * it returns false, no further observability work is done.
 */
function hasObservers(ctx) {
    return ctx.observability != null;
}
