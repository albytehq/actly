const NATIVE_ANY: ((signals: ReadonlyArray<AbortSignal>) => AbortSignal) | undefined =
  (AbortSignal as unknown as { any?: (signals: ReadonlyArray<AbortSignal>) => AbortSignal }).any

/**
 * Compose multiple AbortSignals into one. Aborts when any input aborts,
 * with the same reason. Uses native `AbortSignal.any()` when available,
 * otherwise a polyfill that removes all listeners on first abort.
 */
export function anySignal(signals: ReadonlyArray<AbortSignal>): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => s != null)
  if (filtered.length === 0) return new AbortController().signal
  if (filtered.length === 1) return filtered[0]!

  if (NATIVE_ANY) return NATIVE_ANY.call(AbortSignal, filtered)

  const controller = new AbortController()
  const listeners: Array<() => void> = []

  for (const signal of filtered) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const onAbort = () => {
      controller.abort(signal.reason)
      for (const off of listeners) off()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', onAbort))
  }

  if (controller.signal.aborted) {
    for (const off of listeners) off()
  }

  return controller.signal
}

/**
 * Race a promise against an AbortSignal. If the signal is already aborted,
 * rejects immediately. The abort listener is removed on every settle path.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
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
 * expiry, rejects with `signal.reason` if aborted first.
 *
 * The timer keeps the event loop alive by default; pass
 * `{ unref: true }` when pending retries must not block process exit.
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
    const onAbort = () => {
      clearTimeout(timer)
      signal!.removeEventListener('abort', onAbort)
      reject(signal!.reason)
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    if (opts?.unref && typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }

    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * True if `err` looks like an abort: `ACTLY_ABORT` code, `AbortError` name,
 * or a `DOMException` with name `TimeoutError` (what `AbortSignal.timeout`
 * throws). Code checks survive cross-realm boundaries.
 */
export function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  if ((err as { code?: string }).code === 'ACTLY_ABORT') return true
  const name = (err as { name?: unknown }).name
  if (name === 'AbortError') return true
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
 * child aborts with the same reason. Returns an `unlink()` that removes the
 * listener; call it on every settle path or the closure leaks on long-lived
 * parents.
 */
export function linkSignal(parent: AbortSignal, child: AbortController): () => void {
  if (parent.aborted) {
    child.abort(parent.reason)
    return () => {}
  }
  const onAbort = () => child.abort(parent.reason)
  parent.addEventListener('abort', onAbort)
  return () => parent.removeEventListener('abort', onAbort)
}

const pool: AbortController[] = []
const MAX_POOL_SIZE = 64

/**
 * @deprecated Since 1.4. The fast path uses a shared never-aborted signal
 * instead of pooled controllers, so the pool has no internal use. Kept for
 * API compatibility; will be removed in 2.0.
 */
export function acquireController(): AbortController {
  while (pool.length > 0) {
    const c = pool.pop()!
    if (!c.signal.aborted) return c
  }
  return new AbortController()
}

/** @deprecated Since 1.4. See {@link acquireController}. */
export function releaseController(c: AbortController): void {
  if (c.signal.aborted) return
  if (pool.length >= MAX_POOL_SIZE) return
  pool.push(c)
}

/** @deprecated Since 1.4. See {@link acquireController}. */
export function poolSize(): number {
  return pool.length
}
