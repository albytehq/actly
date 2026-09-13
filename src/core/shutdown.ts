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
    if (s.resolvers.length > 0) {
      for (const r of s.resolvers) r()
      s.resolvers.length = 0
    }
    // prune scoped entries when idle; 'default' is reused on every act()
    // call, so delete+recreate would double the Map ops per call
    if (scope !== 'default') {
      drainStates.delete(scope)
    }
  }
}

function assertTimeoutMs(timeoutMs: number): void {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(
      `Actly: drain timeoutMs must be a non-negative finite number, got ${timeoutMs}`,
    )
  }
}

/**
 * Wait for all in-flight act() calls in this scope to settle.
 * @returns true if all settled within `timeoutMs`, false on timeout.
 */
export async function drain(timeoutMs: number, scope = 'default'): Promise<boolean> {
  assertTimeoutMs(timeoutMs)
  const s = drainStates.get(scope)
  if (!s) return true // scope never registered - nothing to drain
  if (s.inflight === 0) {
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
 *
 * @example
 * // K8s preStop hook
 * process.on('SIGTERM', async () => {
 *   const allSettled = await drainAll(10_000)
 *   process.exit(allSettled ? 0 : 1)
 * })
 *
 * @param timeoutMs Max wait per scope; scopes drain in parallel.
 * @returns true if every scope settled within `timeoutMs`.
 */
export async function drainAll(timeoutMs: number): Promise<boolean> {
  assertTimeoutMs(timeoutMs)
  const scopes = Array.from(drainStates.keys())
  if (scopes.length === 0) return true

  const results = await Promise.all(
    scopes.map((scope) => drain(timeoutMs, scope)),
  )
  return results.every((r) => r === true)
}
