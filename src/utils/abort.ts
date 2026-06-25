// ─── AbortSignal helpers ──────────────────────────────────────────────────────
//
// Centralised utilities for composing AbortSignals. These exist because
// Node 18 lacks `AbortSignal.any` (added in Node 20) and we want to keep
// the `engines` floor at 18 for backwards compatibility with existing
// consumers.

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
export function anySignal(signals: ReadonlyArray<AbortSignal>): AbortSignal {
  // Fast path: native implementation (Node 20+, modern browsers, Bun).
  // The cast is safe — the runtime check guards the call.
  const native = (AbortSignal as unknown as {
    any?: (signals: ReadonlyArray<AbortSignal>) => AbortSignal
  }).any
  if (typeof native === 'function') return native.call(AbortSignal, signals)

  // Polyfill for Node 18.
  const controller = new AbortController()

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener(
      'abort',
      () => controller.abort(signal.reason),
      { once: true },
    )
  }

  return controller.signal
}

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
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject<T>(signal.reason)

  return new Promise<T>((resolve, reject) => {
    let settled = false

    const onAbort = () => {
      if (settled) return
      settled = true
      reject(signal.reason)
    }

    signal.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (value) => {
        if (settled) return
        settled = true
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        reject(error)
      },
    )
  })
}

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
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(signal.reason)
    return Promise.resolve()
  }

  if (signal?.aborted) return Promise.reject(signal.reason)

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * True if `err` is an `AbortError` (DOMException name or Error name).
 *
 * The default `shouldRetry` predicate uses this to skip retrying on
 * cancellations — if the caller aborted, retrying would just abort again.
 */
export function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const name = (err as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError' &&
    err instanceof Error &&
    // DOMException with name 'TimeoutError' is what AbortSignal.timeout throws.
    // Distinguish from our own TimeoutError class by checking for DOMException.
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException
}

/**
 * Link a parent signal to a child controller: when the parent aborts, the
 * child is aborted with the same reason. No-op if the parent is already
 * aborted (the caller should check `parent.aborted` separately if it cares
 * about synchronous abort).
 *
 * The listener is `{ once: true }` — no leak.
 */
export function linkSignal(
  parent: AbortSignal,
  child: AbortController,
): void {
  if (parent.aborted) {
    child.abort(parent.reason)
    return
  }
  parent.addEventListener(
    'abort',
    () => child.abort(parent.reason),
    { once: true },
  )
}
