// Cached at module load: reading process.env on every hook call caused deopts.
// NODE_ENV changes at runtime are not detected; set ACTLY_LOG_HOOK_ERRORS=1
// before import to force hook-error logging in production.
/**
 * Shared gate for swallowed-error logging: hook throws, async hook
 * rejections, and failed fallbacks all honor the same
 * `ACTLY_LOG_HOOK_ERRORS=1` (or non-production) switch.
 * @internal
 */
export const LOG_HOOK_ERRORS: boolean =
  typeof process !== 'undefined' &&
  typeof process.env === 'object' &&
  process.env !== null &&
  (process.env.ACTLY_LOG_HOOK_ERRORS === '1' ||
    process.env.NODE_ENV !== 'production')

/**
 * Invoke a user-supplied callback (observability hook, audit logger) and
 * swallow any throw or async rejection so a buggy hook can never crash the
 * main path. Errors are logged only when hook-error logging is enabled.
 * @internal
 */
export function safeCall<T extends unknown[]>(
  fn: ((...args: T) => void) | undefined,
  ...args: T
): void {
  if (!fn) return
  try {
    const result = fn(...args) as unknown
    if (result !== null && result !== undefined && typeof (result as { then?: unknown }).then === 'function') {
      Promise.resolve(result as Promise<unknown>).catch((err) => {
        if (LOG_HOOK_ERRORS) {
          console.warn('Actly: async hook rejected (swallowed):', err)
        }
      })
    }
  } catch (err) {
    if (LOG_HOOK_ERRORS) {
      console.warn('Actly: hook threw (swallowed):', err)
    }
  }
}
