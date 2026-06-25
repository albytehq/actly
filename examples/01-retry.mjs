/**
 * Example 1 — Retry with cooperative cancellation
 *
 * Simulates a flaky upstream endpoint that fails the first two attempts
 * before succeeding. Shows retry recovery, attempt counting, backoff
 * with jitter, and how `fn` receives an AbortSignal for cooperative
 * cancellation.
 */

import { act } from '../dist/index.js'

// ─── Simulated network ────────────────────────────────────────────────────────

let callCount = 0

/**
 * Pretends to be a remote API.
 * Fails with a 503 twice, then returns data on the third try.
 *
 * Note the `signal` parameter — in real code you'd pass it to `fetch`:
 *   fetch(url, { signal })
 */
async function fetchWeather(city, signal) {
  callCount++
  const attempt = callCount

  // Simulate ~40ms network latency every time. In real code, fetch() would
  // respect the signal and abort mid-flight; here we just check it after.
  await sleep(40)
  if (signal.aborted) throw signal.reason

  if (attempt < 3) {
    console.log(`  [network] attempt ${attempt} → 503 Service Unavailable`)
    throw new Error('503 Service Unavailable')
  }

  console.log(`  [network] attempt ${attempt} → 200 OK`)
  return { city, tempC: 22, condition: 'partly cloudy', fetchedAt: Date.now() }
}

// ─── Demo ─────────────────────────────────────────────────────────────────────

console.log('=== Retry Demo ===\n')
console.log('Fetching weather for "London" — endpoint fails twice before succeeding.\n')

const result = await act('weather:london', (signal) => fetchWeather('London', signal), {
  retry: {
    attempts: 3,
    delayMs: 50,
    backoff: 'exponential', // 50ms, 100ms — fast enough for a demo
    jitter: 'full',         // randomised to [0, delay] — default
    maxDelay: 1000,         // cap (irrelevant here, but shown for completeness)
  },
})

console.log()

if (result.ok) {
  console.log('✓ Recovered successfully')
  console.log(`  value:    ${JSON.stringify(result.value)}`)
  console.log(`  attempts: ${result.attempts}`)   // 3 — retried all the way through
  console.log(`  source:   ${result.source}`)      // 'fresh'
} else {
  console.log('✗ All attempts exhausted')
  console.log(`  error:    ${result.error.message}`)
  console.log(`  attempts: ${result.attempts}`)
}

// ─── What happens when ALL attempts fail ─────────────────────────────────────

console.log('\n--- Now: endpoint never recovers ---\n')

const alwaysFails = await act('weather:mars', async (signal) => {
  await sleep(10)
  if (signal.aborted) throw signal.reason
  throw new Error('ECONNREFUSED')
}, {
  retry: { attempts: 3, delayMs: 20, jitter: 'none' },
})

if (!alwaysFails.ok) {
  console.log('✓ Failure surfaced cleanly — act() did not throw')
  console.log(`  error:    ${alwaysFails.error.message}`)
  console.log(`  attempts: ${alwaysFails.attempts}`)  // 3
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
