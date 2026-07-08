/**
 * Safe invocation helper for user-supplied callbacks (observability hooks,
 * audit log functions, etc.). A buggy hook must never crash the main path.
 *
 * Errors are swallowed. In dev (NODE_ENV !== 'production') they're logged
 * to console.warn so the broken hook gets noticed during testing.
 *
 * @internal
 */

// Cache the dev-mode flag at module load - avoids process.env on every call
// and guards against environments where `process` is undefined.
const IS_DEV: boolean =
  typeof process !== 'undefined' &&
  typeof process.env === 'object' &&
  process.env !== null &&
  process.env.NODE_ENV !== 'production'

export function safeCall<T extends unknown[]>(
  fn: ((...args: T) => void) | undefined,
  ...args: T
): void {
  if (!fn) return
  try {
    const result = fn(...args) as unknown
    // If the hook returned a thenable, attach a .catch so an async hook
    // rejecting doesn't fire unhandledRejection. Promise.resolve() adopts
    // the thenable properly - direct .catch would miss non-Promise thenables.
    if (result !== null && result !== undefined && typeof (result as { then?: unknown }).then === 'function') {
      Promise.resolve(result as Promise<unknown>).catch((err) => {
        if (IS_DEV) {
          console.warn(
            'Actly: async observability hook rejected — error swallowed to protect main path. ' +
            'Fix the hook to prevent silent observability loss.',
            err,
          )
        }
      })
    }
  } catch (err) {
    if (IS_DEV) {
      console.warn(
        'Actly: observability hook threw — error swallowed to protect main path. ' +
        'Fix the hook to prevent silent observability loss.',
        err,
      )
    }
  }
}
