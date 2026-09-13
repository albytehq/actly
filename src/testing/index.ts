import type { ObservabilityHooks, ActlyEventType } from '../observability.js'

/**
 * Wait for the next observability hook event of a specific type.
 * Resolves with the event payload when the hook fires, rejects when the
 * timeout elapses. The timer is unref'd and any pre-existing hook is
 * chained rather than clobbered.
 *
 * @example
 * ```ts
 * import { waitForObsHook } from 'actly/testing'
 *
 * const obs: ObservabilityHooks = {}
 * const done = waitForObsHook(obs, 'onFinalSuccess', 1000)
 * await act('k', async () => 1, { observability: obs })
 * const event = await done
 * ```
 *
 * @param hooks      The ObservabilityHooks object passed to act().
 * @param hookName   Which hook to wait for.
 * @param timeoutMs  Max wait in ms (default 5000).
 * @returns Promise resolving with the event payload; `cancel()` cleans up.
 */
export function waitForObsHook<K extends keyof ObservabilityHooks>(
  hooks: ObservabilityHooks,
  hookName: K,
  timeoutMs = 5000,
): Promise<Parameters<NonNullable<ObservabilityHooks[K]>>[0]> & { cancel: () => void } {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      `Actly: waitForObsHook timeoutMs must be a non-negative finite number, got ${timeoutMs}`,
    )
  }
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
    ;(hooks as Record<string, unknown>)[hookName as string] = previousHook
    rejectFn(new Error(
      `Actly: waitForObsHook timed out after ${timeoutMs}ms waiting for "${String(hookName)}".`,
    ))
  }, timeoutMs)
  const unrefable = timer as unknown as { unref?: () => void }
  if (typeof unrefable.unref === 'function') unrefable.unref()

  const previousHook = hooks[hookName]

  const cleanup = (): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    ;(hooks as Record<string, unknown>)[hookName as string] = previousHook
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(hooks as Record<string, any>)[hookName as string] = (event: any) => {
    if (typeof previousHook === 'function') {
      try { previousHook(event) } catch { /* chain, not crash */ }
    }
    if (settled) return
    cleanup()
    resolveFn(event)
  }

  return Object.assign(promise, { cancel: cleanup })
}

/** Type guard for the known ActlyEventType literals. */
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
