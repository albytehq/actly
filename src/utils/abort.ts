// AbortSignal helpers. Every addEventListener('abort', ...) must be paired
// with a removeEventListener on the success path, otherwise long-lived
// signals accumulate listeners and trip MaxListenersExceededWarning.

// Hoisted once so anySignal() does a single boolean check per call.
const NATIVE_ANY: ((signals: ReadonlyArray<AbortSignal>) => AbortSignal) | undefined =
  (AbortSignal as unknown as { any?: (signals: ReadonlyArray<AbortSignal>) => AbortSignal }).any

/**
 * Compose multiple AbortSignals into one. Aborts when any input aborts,
 * with the same reason. Uses native AbortSignal.any() on Node 20+, falls
 * back to a polyfill that removes all listeners on first abort.
 */
export function anySignal(signals: ReadonlyArray<AbortSignal>): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => s != null)
  if (filtered.length === 0) return new AbortController().signal
  if (filtered.length === 1) return filtered[0]!

  if (NATIVE_ANY) return NATIVE_ANY.call(AbortSignal, filtered)

  // Polyfill path.
  const controller = new AbortController()
  const listeners: Array<() => void> = []

  for (const signal of filtered) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const onAbort = () => {
      controller.abort(signal.reason)
      // Drop the other listeners so inputs can be GC'd after settlement.
      for (const off of listeners) off()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', onAbort))
  }

  // If a pre-aborted input broke the loop, the listeners we already added
  // are still attached. Tear them down now.
  if (controller.signal.aborted) {
    for (const off of listeners) off()
  }

  return controller.signal
}

/**
 * Race a promise against an AbortSignal. If the signal is already aborted,
 * rejects immediately. If the signal aborts first, rejects with signal.reason.
 * The abort listener is explicitly removed on the success path.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    // Swallow the eventual rejection so V8 doesn't fire unhandledRejection.
    promise.catch(() => {})
    return Promise.reject<T>(signal.reason)
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false

    const onAbort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }

    // No { once: true } - we want explicit removal on every path.
    signal.addEventListener('abort', onAbort)

    promise.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Sleep for `ms` milliseconds, abortable via `signal`. Resolves on timer
 * expiry, rejects with signal.reason if aborted first.
 *
 * By default the timer keeps the event loop alive - `sleep()` is usually
 * the operation the caller is awaiting, and unref'ing it would let Node
 * exit mid-retry. Pass `opts.unref: true` for CLI/scripts/tests where
 * pending retry timers should not block process exit.
 */
export function sleep(
  ms: number,
  signal?: AbortSignal,
  opts?: { unref?: boolean },
): Promise<void> {
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

    if (opts?.unref && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref()
    }

    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }

    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * True if `err` looks like an AbortError. The default shouldRetry predicate
 * uses this to skip retrying cancellations. Also recognizes actly's own
 * `ACTLY_ABORT` code, which survives cross-realm boundaries better than
 * `instanceof`.
 */
export function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  if ((err as { code?: string }).code === 'ACTLY_ABORT') return true
  const name = (err as { name?: unknown }).name
  if (name === 'AbortError') return true
  // DOMException with name 'TimeoutError' is what AbortSignal.timeout throws.
  if (
    name === 'TimeoutError' &&
    err instanceof Error &&
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException
  ) {
    return true
  }
  return false
}

/**
 * Link a parent signal to a child controller: when the parent aborts, the
 * child is aborted with the same reason. Returns an `unlink()` that removes
 * the listener - call it on the success path or you leak one closure per
 * call on long-lived parents. For new code, prefer anySignal() which
 * handles cleanup natively on Node 20+.
 */
export function linkSignal(
  parent: AbortSignal,
  child: AbortController,
): () => void {
  if (parent.aborted) {
    child.abort(parent.reason)
    return () => {}
  }
  const onAbort = () => child.abort(parent.reason)
  parent.addEventListener('abort', onAbort)
  return () => parent.removeEventListener('abort', onAbort)
}
