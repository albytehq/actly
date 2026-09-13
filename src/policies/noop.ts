import type { ActFn, PolicyApplier, PolicyContext } from '../types.js'

/**
 * Pass-through policy: no retry, no timeout, no state, no overhead beyond
 * one function call. Useful for substituting a real policy in tests,
 * conditional chains, and feature flags.
 *
 * @example
 * ```ts
 * import { retryPolicy, noopPolicy } from 'actly'
 *
 * const retry = process.env.NODE_ENV === 'production'
 *   ? retryPolicy({ attempts: 3, delayMs: 100 })
 *   : noopPolicy()
 * ```
 */
export function noopPolicy<T>(): PolicyApplier<T> {
  return (fn: ActFn<T>, _ctx: PolicyContext): ActFn<T> => fn
}
