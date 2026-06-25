/**
 * Polyfill for `AbortSignal.any(signals)` (Node 20+).
 *
 * Returns a single signal that aborts when ANY of the input signals aborts,
 * with the same reason. If any input is already aborted, the returned signal
 * is aborted synchronously.
 *
 * Listener registration is `{ once: true }` — once any signal fires, we stop
 * listening on the others. The composite signal cannot be "un-aborted".
 */
export declare function anySignal(signals: ReadonlyArray<AbortSignal>): AbortSignal;
/**
 * Race a promise against an AbortSignal.
 *
 * - If the signal is already aborted, rejects immediately with `signal.reason`.
 * - If the signal aborts while the promise is pending, rejects with `signal.reason`.
 * - If the promise settles first, returns its value (or rejects with its error).
 *
 * The listener is registered with `{ once: true }` and never leaks: either
 * the signal fires (listener auto-removed) or the promise settles (the
 * signal will eventually be GC'd along with the listener).
 *
 * Used by `dedupePolicy` so joiners can cancel their own `await` even if the
 * originator's `fn` is still running.
 */
export declare function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
/**
 * Sleep for `ms` milliseconds, but abort early if `signal` fires.
 *
 * Resolves normally on timer expiry. Rejects with `signal.reason` if the
 * signal aborts before the timer fires. If the signal is already aborted
 * when called, rejects synchronously (in microtask).
 *
 * Used by `retryPolicy` to make backoff delays interruptible: when an outer
 * `totalTimeout` fires mid-delay, the delay rejects immediately instead of
 * blocking the retry loop until the timer would have elapsed.
 */
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
/**
 * True if `err` is an `AbortError` (DOMException name or Error name).
 *
 * The default `shouldRetry` predicate uses this to skip retrying on
 * cancellations — if the caller aborted, retrying would just abort again.
 */
export declare function isAbortError(err: unknown): boolean;
/**
 * Link a parent signal to a child controller: when the parent aborts, the
 * child is aborted with the same reason. No-op if the parent is already
 * aborted (the caller should check `parent.aborted` separately if it cares
 * about synchronous abort).
 *
 * The listener is `{ once: true }` — no leak.
 */
export declare function linkSignal(parent: AbortSignal, child: AbortController): void;
//# sourceMappingURL=abort.d.ts.map