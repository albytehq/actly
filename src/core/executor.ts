import type {
  ActFn,
  PolicyApplier,
  PolicyContext,
  AnyStateStore,
  RunMeta,
  ObservabilityContext,
} from '../types/index.js'
import { isSyncStore } from '../stores/base.js'

/**
 * Symbol stamped onto `PolicyApplier` functions by `dedupePolicy`.
 * Lets `execute()` detect a dedupe policy without importing the policy
 * module (circular dep) or doing fragile name-sniffing.
 */
export const REQUIRES_SYNC_STORE = Symbol('actly.requiresSyncStore')

export interface ExecutorInput<T> {
  key:      string
  fn:       ActFn<T>
  /**
   * Policies ordered outermost -> innermost. `policies[0]` intercepts
   * first; `policies[last]` is closest to `fn`.
   *
   * Canonical order: `[totalTimeout, cache, dedupe, retry, timeout]`
   *   totalTimeout -> hard wall-clock budget over the entire operation
   *   cache        -> a hit skips everything below it
   *   dedupe       -> collapses concurrent callers before retry fires
   *   retry        -> owns the attempt loop
   *   timeout      -> each individual attempt races against the clock
   */
  policies: ReadonlyArray<PolicyApplier<T>>
  store:    AnyStateStore
  meta:     RunMeta
  /**
   * Root AbortSignal for the operation. Propagated inward through the
   * policy chain: each policy receives it as the `signal` argument to
   * its wrapped `ActFn`. The outermost policy may layer its own signal
   * (e.g. `totalTimeoutPolicy` arms a timer) and pass the composite inward.
   */
  signal:   AbortSignal
  /**
   * Observability context. When present, policies emit events via the
   * hooks. When absent (the common case), zero overhead.
   */
  observability?: ObservabilityContext
}

/**
 * Pure execution engine. Imports nothing from `/policies`; it operates on
 * the `PolicyApplier<T>` type alias defined in `/types`. Policy
 * implementations live in `/policies` and are wired in `core/act.ts`.
 *
 * Exported so consumers can build custom policy chains with explicit stores
 * (SSR request isolation, multi-tenant scenarios where the module-level
 * default store is wrong).
 */
export async function execute<T>(input: ExecutorInput<T>): Promise<T> {
  // If any policy needs a sync store, the provided store must be sync.
  // An async store + dedupePolicy is a silent correctness failure; catch
  // it here rather than letting it produce subtly wrong dedupe behaviour.
  const needsSync = input.policies.some(
    p => (p as PolicyApplier<T> & { [REQUIRES_SYNC_STORE]?: boolean })[REQUIRES_SYNC_STORE],
  )
  if (needsSync && !isSyncStore(input.store)) {
    throw new Error(
      'Actly: dedupePolicy requires a SyncStateStore (store._sync === true). ' +
      'The provided store does not satisfy this constraint. ' +
      'Either remove dedupe from the policy chain or use InMemoryStore.',
    )
  }

  const ctx: PolicyContext = {
    key:   input.key,
    store: input.store,
    meta:  input.meta,
    // Policies read this lazily.
    observability: input.observability,
  }

  // Build the call chain from inside out. reduceRight makes policies[0]
  // the outermost wrapper (runs first).
  const wrapped = input.policies.reduceRight<ActFn<T>>(
    (inner, applyPolicy) => applyPolicy(inner, ctx),
    input.fn,
  )

  return wrapped(input.signal)
}
