// Tiny AbortController pool. Reusing controllers avoids allocating a fresh
// AbortController + signal per call when many short-lived ones are issued.

const pool: AbortController[] = []
const MAX_POOL_SIZE = 64

export function acquireController(): AbortController {
  while (pool.length > 0) {
    const c = pool.pop()!
    // Skip aborted ones - they're useless to the caller.
    if (!c.signal.aborted) return c
  }
  return new AbortController()
}

export function releaseController(c: AbortController): void {
  // Aborted controllers can't be reused; let them be GC'd.
  if (c.signal.aborted) return
  if (pool.length >= MAX_POOL_SIZE) return
  pool.push(c)
}

export function poolSize(): number {
  return pool.length
}
