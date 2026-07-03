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
export declare function anySignal(signals: ReadonlyArray<AbortSignal>): AbortSignal;
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
export declare function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T>;
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
export declare function linkSignal(parent: AbortSignal, child: AbortController): () => void;
//# sourceMappingURL=abort.d.ts.map