import type { ObservabilityHooks, ActlyEventType } from '../observability.js'

/**
 * Wait for the next observability hook event of a specific type.
 *
 * Resolves with the event payload when the hook fires, rejects when the
 * timeout elapses. Saves test code from wiring manual listeners.
 *
 * @example
 * ```ts
 * import { waitForObsHook } from 'actly/testing'
 *
 * const obs: ObservabilityHooks = {}
 * const timeoutPromise = waitForObsHook(obs, 'onFinalSuccess', 1000)
 * await act('k', async () => 1, { observability: obs })
 * const event = await timeoutPromise
 * expect(event.attempts).toBe(1)
 * ```
 *
 * @param hooks The ObservabilityHooks object passed to act(). The helper
 *              installs a temporary listener for the specified hook.
 * @param hookName Which hook to wait for.
 * @param timeoutMs Max time to wait (default 5000ms).
 * @returns Promise that resolves with the event payload.
 */
export function waitForObsHook<K extends keyof ObservabilityHooks>(
  hooks: ObservabilityHooks,
  hookName: K,
  timeoutMs = 5000,
): Promise<Parameters<NonNullable<ObservabilityHooks[K]>>[0]> & { cancel: () => void } {
  let resolveFn!: (value: Parameters<NonNullable<ObservabilityHooks[K]>>[0]) => void
  let rejectFn!: (err: Error) => void
  const promise = new Promise<Parameters<NonNullable<ObservabilityHooks[K]>>[0]>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  let settled = false

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    // Restore any pre-existing hook.
    ;(hooks as Record<string, unknown>)[hookName as string] = previousHook
    rejectFn(new Error(
      `Actly: waitForObsHook timed out after ${timeoutMs}ms waiting for "${String(hookName)}".`,
    ))
  }, timeoutMs)
  // unref so a missed hook doesn't keep the event loop alive (vitest/jest
  // otherwise emit "open handle" warnings or hang).
  const unrefable = timer as unknown as { unref?: () => void }
  if (typeof unrefable.unref === 'function') unrefable.unref()

  // Chain to any pre-existing hook instead of clobbering it.
  const previousHook = hooks[hookName]

  const cleanup = (): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    ;(hooks as Record<string, unknown>)[hookName as string] = previousHook
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(hooks as Record<string, any>)[hookName as string] = (event: any) => {
    // Chain to previous hook if present.
    if (typeof previousHook === 'function') {
      try { previousHook(event) } catch { /* swallow */ }
    }
    if (settled) return
    cleanup()
    resolveFn(event)
  }

  // `cancel()` lets test frameworks clean up explicitly in `afterEach`
  // (clears the timer + restores the original hook).
  return Object.assign(promise, { cancel: cleanup })
}

/**
 * Type guard: is this ActlyEventType one of the known event types?
 * Useful for narrowing in switch statements when consuming events.
 */
export function isActlyEventType(value: unknown): value is ActlyEventType {
  return (
    value === 'attempt' ||
    value === 'retry' ||
    value === 'cache-hit' ||
    value === 'cache-miss' ||
    value === 'dedupe-join' ||
    value === 'timeout' ||
    value === 'final-success' ||
    value === 'final-failure' ||
    value === 'backpressure' ||
    value === 'watchdog'
  )
}
