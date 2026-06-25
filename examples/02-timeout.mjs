/**
 * Example 2 — Timeout with cooperative cancellation
 *
 * Shows three scenarios:
 *   A. A fast call that finishes well before the deadline.
 *   B. A hanging call that never resolves — TimeoutError fires promptly
 *      even though fn ignores the signal.
 *   C. Retry + timeout combined — each attempt gets its own clock,
 *      so a 2-attempt / 200ms config allows up to 2 × 200ms total.
 *   D. (new in v1.1.5) totalTimeout cancels the inner retry loop —
 *      no more attempts fire after the budget exhausts.
 */

import { act, TimeoutError, TotalTimeoutError } from '../dist/index.js'

// ─── Simulated operations ─────────────────────────────────────────────────────

/** Resolves after `ms` milliseconds with a fake DB row. */
function queryDB(ms) {
  return (signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ id: 1, name: 'Alice' }), ms)
    // Cooperative: abort early if the signal fires.
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

/** Never resolves. Represents a hung connection. */
function hungConnection() {
  return () => new Promise(() => {}) // intentional void
}

/** Fails on the first attempt, then resolves quickly on the second. */
let slowCallCount = 0
function firstSlowThenFast(slowMs, fastMs) {
  return async (signal) => {
    slowCallCount++
    if (slowCallCount === 1) {
      await sleep(slowMs)
      if (signal.aborted) throw signal.reason
      return 'should not reach here'
    }
    await sleep(fastMs)
    return 'recovered on attempt 2'
  }
}

// ─── A. Fast call ─────────────────────────────────────────────────────────────

console.log('=== Timeout Demo ===\n')
console.log('A. Fast query (50ms) with a 500ms deadline:\n')

const fast = await act('db:user', queryDB(50), {
  timeout: { ms: 500 },
})

console.log(`  ok:       ${fast.ok}`)
console.log(`  value:    ${JSON.stringify(fast.ok ? fast.value : null)}`)
console.log(`  attempts: ${fast.attempts}`)

// ─── B. Hanging call ─────────────────────────────────────────────────────────

console.log('\nB. Hung connection with a 150ms deadline:\n')

const t0 = Date.now()
const hung = await act('db:reports', hungConnection(), {
  timeout: { ms: 150 },
})
console.log(`  (returned in ${Date.now() - t0}ms — race fallback works even when fn ignores signal)`)

if (!hung.ok) {
  const isTimeout = hung.error instanceof TimeoutError
  console.log(`  ok:        ${hung.ok}`)
  console.log(`  timed out: ${isTimeout}`)

  if (isTimeout) {
    console.log(`  after:     ${hung.error.ms}ms`)
  }
}

// ─── C. Retry + timeout: each attempt gets its own clock ─────────────────────

console.log('\nC. Retry + timeout — first attempt hangs (300ms), second is fast (30ms):\n')
console.log('   config: { attempts: 2, timeout: 150ms }')
console.log('   attempt 1: hangs for 300ms → times out at 150ms')
console.log('   attempt 2: fast 30ms → succeeds\n')

const combo = await act('db:orders', firstSlowThenFast(300, 30), {
  retry:   { attempts: 2, delayMs: 1, jitter: 'none' },
  timeout: { ms: 150 },
})

if (combo.ok) {
  console.log(`  ✓ value:    "${combo.value}"`)
  console.log(`    attempts: ${combo.attempts}`)  // 2
} else {
  console.log(`  ✗ error: ${combo.error.message}`)
}

// ─── D. (v1.1.5) totalTimeout cancels the inner retry loop ───────────────────

console.log('\nD. totalTimeout cancels inner retry — no more attempts after budget fires:\n')
console.log('   config: { retry: 5 attempts × 300ms fn, totalTimeout: 100ms }')
console.log('   pre-v1.1.5: act() returns TotalTimeoutError but fn keeps firing in background')
console.log('   v1.1.5:     abort propagates, only 1 attempt fires\n')

let attemptCount = 0
const totalResult = await act('db:slow-loop', async () => {
  attemptCount++
  await sleep(300)
  return 'unreachable'
}, {
  retry:        { attempts: 5, delayMs: 50, jitter: 'none' },
  totalTimeout: { ms: 100 },
})

console.log(`  act result: ok=${totalResult.ok}, error=${totalResult.error?.constructor.name}`)
await sleep(1000)  // wait long enough that pre-fix would have fired more attempts
console.log(`  fn attempts: ${attemptCount} (v1.1.5: 1, pre-v1.1.5: 2-3)`)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
