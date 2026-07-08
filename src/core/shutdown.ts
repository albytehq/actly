const drainStates = new Map<string, { inflight: number; resolvers: Array<() => void> }>()

function getState(scope: string) {
  let s = drainStates.get(scope)
  if (!s) {
    s = { inflight: 0, resolvers: [] }
    drainStates.set(scope, s)
  }
  return s
}

export function registerDrainable(scope = 'default'): void {
  getState(scope).inflight++
}

export function unregisterDrainable(scope = 'default'): void {
  const s = getState(scope)
  s.inflight = Math.max(0, s.inflight - 1)
  if (s.inflight === 0) {
    for (const r of s.resolvers) r()
    s.resolvers = []
    // prune scoped drain state when idle so high-cardinality scenarios
    // (per-request SSR, per-tenant stores, dynamic tenant lifecycle) don't
    // grow the Map unbounded. The 'default' scope is reused on every act()
    // call, so deleting and re-creating it would double the Map ops per
    // call (~30% fast-path regression). Scoped entries are NOT reused;
    // once idle they're dead weight until GC.
    if (scope !== 'default') {
      drainStates.delete(scope)
    }
  }
}

/**
 * Wait for all in-flight act() calls in this scope to settle.
 * Returns true if all settled within timeoutMs, false if timed out.
 *
 * Uses `drainStates.get` directly (no create-on-read) so drain-only access
 * on a never-registered scope (e.g. a typo'd tenant ID) doesn't leave an
 * empty entry in the Map forever.
 */
export async function drain(timeoutMs: number, scope = 'default'): Promise<boolean> {
  const s = drainStates.get(scope)
  if (!s) return true // scope never registered - nothing to drain.
  if (s.inflight === 0) {
    // if the scope is non-default and has no resolvers, prune it (mirror
    // the unregisterDrainable idle-prune so drain-only access doesn't
    // accumulate stale entries).
    if (scope !== 'default' && s.resolvers.length === 0) {
      drainStates.delete(scope)
    }
    return true
  }

  return new Promise<boolean>((resolve) => {
    let resolved = false
    const resolver = () => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      const idx = s.resolvers.indexOf(resolver)
      if (idx >= 0) s.resolvers.splice(idx, 1)
      resolve(true)
    }
    const timer = setTimeout(() => {
      if (resolved) return
      resolved = true
      const idx = s.resolvers.indexOf(resolver)
      if (idx >= 0) s.resolvers.splice(idx, 1)
      resolve(false)
    }, timeoutMs)

    s.resolvers.push(resolver)
  })
}

/**
 * Wait for all in-flight act() calls across ALL scopes to settle.
 * Returns true if all settled within timeoutMs, false if any timed out.
 *
 * @example
 * // K8s preStop hook
 * process.on('SIGTERM', async () => {
 *   const allSettled = await drainAll(10_000)
 *   if (!allSettled) {
 *     console.warn('Actly: drain timed out, force-exiting with in-flight calls')
 *   }
 *   process.exit(allSettled ? 0 : 1)
 * })
 *
 * @param timeoutMs Max time to wait across all scopes (each scope gets
 *                  the full `timeoutMs`; they drain in parallel, not
 *                  sequentially).
 * @returns true if ALL scopes settled within `timeoutMs`, false if any
 *          timed out.
 */
export async function drainAll(timeoutMs: number): Promise<boolean> {
  // Snapshot the scope keys. drain() on a scope that doesn't exist is a
  // no-op (returns true immediately), so new scopes created during
  // iteration don't cause issues.
  const scopes = Array.from(drainStates.keys())
  if (scopes.length === 0) return true

  const results = await Promise.all(
    scopes.map(scope => drain(timeoutMs, scope)),
  )
  return results.every(r => r === true)
}
