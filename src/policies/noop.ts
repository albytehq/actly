import type { ActFn, PolicyApplier, PolicyContext } from '../types/index.js'

/**
 * No-op policy. Passes `fn` through unchanged - no retry, no timeout, no
 * state, no overhead beyond a single function call.
 *
 * Useful for substituting a real policy in tests, conditional chains
 * (`policies.push(cond ? realPolicy : noopPolicy())` keeps the chain length
 * stable), and feature-flagging a policy off at config time.
 *
 * Cockatiel exports a `noop` instance for the same use cases; actly's
 * equivalent is this factory returning a passthrough `PolicyApplier`.
 *
 * @example
 * ```ts
 * const retry = process.env.NODE_ENV === 'production'
 *   ? retryPolicy({ attempts: 3, delayMs: 100 })
 *   : noopPolicy()
 * ```
 */
export function noopPolicy<T>(): PolicyApplier<T> {
  return (fn: ActFn<T>, _ctx: PolicyContext): ActFn<T> => fn
}
