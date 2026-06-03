import type {
  ActFn,
  PolicyApplier,
  PolicyContext,
  AnyStateStore,
  RunMeta,
} from '../types/index.js'
import { isSyncStore } from '../stores/base.js'

// Symbol stamped onto PolicyApplier functions by dedupePolicy.
// Lets execute() detect a dedupe policy without importing the policy module
// (which would create a circular dep) or doing fragile name-sniffing.
export const REQUIRES_SYNC_STORE = Symbol('actly.requiresSyncStore')

export interface ExecutorInput<T> {
  key:      string
  fn:       ActFn<T>
  /**
   * Policies ordered outermost -> innermost.
   * policies[0] intercepts first; policies[last] is closest to fn.
   *
   * Canonical order: [totalTimeout, cache, dedupe, retry, timeout]
   *   totalTimeout -> hard wall-clock budget over the entire operation
   *   cache        -> a hit skips everything below it
   *   dedupe       -> collapses concurrent callers before retry fires
   *   retry        -> owns the attempt loop
   *   timeout      -> each individual attempt races against the clock
   */
  policies: ReadonlyArray<PolicyApplier<T>>
  store:    AnyStateStore
  meta:     RunMeta
}

/**
 * Pure execution engine.
 *
 * This file imports nothing from /policies.
 * It operates on PolicyApplier<T> — a type alias defined in /types.
 * Policy implementations live in /policies and are wired in core/act.ts.
 */
export async function execute<T>(input: ExecutorInput<T>): Promise<T> {
  // Guard: if any policy in the chain requires a sync store, the provided
  // store must be synchronous. An async store + dedupePolicy is a silent
  // correctness failure, not just a performance issue — catch it here rather
  // than letting it produce subtly wrong dedupe behaviour at runtime.
  const needsSync = input.policies.some(
    p => (p as PolicyApplier<T> & { [REQUIRES_SYNC_STORE]?: boolean })[REQUIRES_SYNC_STORE]
  )
  if (needsSync && !isSyncStore(input.store)) {
    throw new Error(
      'Actly: dedupePolicy requires a SyncStateStore (store._sync === true). ' +
      'The provided store does not satisfy this constraint. ' +
      'Either remove dedupe from the policy chain or use InMemoryStore.'
    )
  }

  const ctx: PolicyContext = {
    key:   input.key,
    store: input.store,
    meta:  input.meta,
  }

  // Build the call chain from inside out.
  // reduceRight ensures policies[0] becomes the outermost wrapper (runs first).
  const wrapped = input.policies.reduceRight<ActFn<T>>(
    (inner, applyPolicy) => applyPolicy(inner, ctx),
    input.fn
  )

  return wrapped()
}
