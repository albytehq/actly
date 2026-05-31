/**
 * Example 2 — Timeout
 *
 * Shows three scenarios:
 *   A. A fast call that finishes well before the deadline.
 *   B. A hanging call that never resolves — TimeoutError fires.
 *   C. Retry + timeout combined — each attempt gets its own clock,
 *      so a 2-attempt / 200ms config allows up to 2 × 200ms total.
 */

import { act, TimeoutError } from '../dist/index.js'

// ─── Simulated operations ─────────────────────────────────────────────────────

/** Resolves after `ms` milliseconds with a fake DB row. */
function queryDB(ms) {
  return () => new Promise(resolve =>
    setTimeout(() => resolve({ id: 1, name: 'Alice' }), ms)
  )
}

/** Never resolves. Represents a hung connection. */
function hungConnection() {
  return () => new Promise(() => {}) // intentional void
}

/** Fails on the first attempt, then resolves quickly on the second. */
let slowCallCount = 0
function firstSlowThenFast(slowMs, fastMs) {
  return async () => {
    slowCallCount++
    if (slowCallCount === 1) {
      // Simulate a slow first attempt that will time out
      await sleep(slowMs)
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

const hung = await act('db:reports', hungConnection(), {
  timeout: { ms: 150 },
})

if (!hung.ok) {
  const isTimeout = hung.error instanceof TimeoutError

  console.log(`  ok:        ${hung.ok}`)
  console.log(`  timed out: ${isTimeout}`)

  if (isTimeout) {
    // TimeoutError carries the configured ms so you can log or alert precisely
    console.log(`  after:     ${hung.error.ms}ms`)
  }
}

// ─── C. Retry + timeout: each attempt gets its own clock ─────────────────────

console.log('\nC. Retry + timeout — first attempt hangs (300ms), second is fast (30ms):\n')
console.log('   config: { attempts: 2, timeout: 150ms }')
console.log('   attempt 1: hangs for 300ms → times out at 150ms')
console.log('   attempt 2: fast 30ms → succeeds\n')

const combo = await act('db:orders', firstSlowThenFast(300, 30), {
  retry:   { attempts: 2 },
  timeout: { ms: 150 },
})

if (combo.ok) {
  console.log(`  ✓ value:    "${combo.value}"`)
  console.log(`    attempts: ${combo.attempts}`)  // 2
} else {
  console.log(`  ✗ error: ${combo.error.message}`)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
