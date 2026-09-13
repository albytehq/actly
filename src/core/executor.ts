import type {
  ActFn,
  PolicyApplier,
  PolicyContext,
  AnyStateStore,
  RunMeta,
  ObservabilityContext,
} from '../types.js'
import { isSyncStore } from '../stores/contract.js'

/**
 * Symbol stamped onto `PolicyApplier` functions by sync-store policies.
 * Lets `execute()` detect them without importing the policy modules
 * (circular dependency) or name-sniffing.
 */
export const REQUIRES_SYNC_STORE = Symbol('actly.requiresSyncStore')

export interface ExecutorInput<T> {
  key: string
  fn: ActFn<T>
  /**
   * Policies ordered outermost -> innermost: `policies[0]` intercepts first,
   * `policies[last]` is closest to `fn`.
   */
  policies: ReadonlyArray<PolicyApplier<T>>
  store: AnyStateStore
  meta: RunMeta
  /**
   * Root signal for the operation, propagated inward through the chain.
   * The outermost policy may layer its own signal and pass the composite
   * inward.
   */
  signal: AbortSignal
  /** Present when the caller registered hooks; zero overhead otherwise. */
  observability?: ObservabilityContext
}

/**
 * Pure execution engine: builds the wrapped call chain from inside out
 * (`reduceRight` makes `policies[0]` the outermost wrapper) and invokes it.
 * Imports no concrete policy.
 *
 * Exported so consumers can run custom policy chains with explicit stores.
 */
export async function execute<T>(input: ExecutorInput<T>): Promise<T> {
  const needsSync = input.policies.some(
    (p) => (p as PolicyApplier<T> & { [REQUIRES_SYNC_STORE]?: boolean })[REQUIRES_SYNC_STORE],
  )
  if (needsSync && !isSyncStore(input.store)) {
    throw new Error(
      'Actly: dedupePolicy requires a SyncStateStore (store._sync === true). ' +
      'The provided store does not satisfy this constraint. ' +
      'Either remove dedupe from the policy chain or use InMemoryStore.',
    )
  }

  const ctx: PolicyContext = {
    key: input.key,
    store: input.store,
    meta: input.meta,
    observability: input.observability,
  }

  const wrapped = input.policies.reduceRight<ActFn<T>>(
    (inner, applyPolicy) => applyPolicy(inner, ctx),
    input.fn,
  )

  return wrapped(input.signal)
}
