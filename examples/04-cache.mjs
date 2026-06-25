/**
 * Example 4 — Cache with single-flight and invalidation
 *
 * Five scenarios:
 *   A. Cache miss on first call, hit on second — fn runs only once.
 *   B. result.source tells you where the value came from.
 *   C. result.attempts is 0 on cache hit (v1.1.5 fix).
 *   D. TTL expiry — cache evicts and fn runs again.
 *   E. (v1.1.5) Single-flight: 10 concurrent cache-miss callers run fn ONCE.
 *   F. (v1.1.5) Failures are never cached + invalidate() forces re-fetch.
 *   G. (v1.1.5) Fail-open: store.set() throwing doesn't break act().
 */

import { act, invalidate, withStore, InMemoryStore } from '../dist/index.js'

// ─── Simulated remote call ────────────────────────────────────────────────────

let fetchCount = 0

async function fetchProductPrice(sku) {
  fetchCount++
  await sleep(30)
  // Prices "change" every call so we can tell hits from misses in the output
  return { sku, priceUsd: 9.99 + fetchCount * 0.01, fetchCount }
}

// ─── A & B & C. Cache miss then hit ───────────────────────────────────────────

console.log('=== Cache Demo ===\n')
console.log('A+B+C. First call is a miss, second is a hit:\n')

fetchCount = 0

const miss = await act('product:ABC123', () => fetchProductPrice('ABC123'), {
  cache: { ttl: 5_000 },
})

const hit = await act('product:ABC123', () => fetchProductPrice('ABC123'), {
  cache: { ttl: 5_000 },
})

console.log(`  1st call → source: "${miss.source}"  attempts: ${miss.attempts}  fetchCount: ${miss.value.fetchCount}`)
console.log(`  2nd call → source: "${hit.source}"   attempts: ${hit.attempts}  fetchCount: ${hit.value.fetchCount}`)
console.log(`\n  fn called: ${fetchCount} time(s)  ← 1, not 2`)
console.log(`  attempts=0 on hit, attempts=1 on miss  (v1.1.5 fix)`)

// ─── D. TTL expiry ────────────────────────────────────────────────────────────

console.log('\nD. TTL expiry — cache evicts after 120ms:\n')

fetchCount = 0

const shortTTL = { cache: { ttl: 120 } }
const key = 'product:XYZ999'

const call1 = await act(key, () => fetchProductPrice('XYZ999'), shortTTL)
console.log(`  call 1 → source: "${call1.source}"  (miss, fn runs)`)

const call2 = await act(key, () => fetchProductPrice('XYZ999'), shortTTL)
console.log(`  call 2 → source: "${call2.source}"  (hit, fn skipped)`)

await sleep(150) // past the 120ms TTL

const call3 = await act(key, () => fetchProductPrice('XYZ999'), shortTTL)
console.log(`  call 3 → source: "${call3.source}"  (miss after expiry, fn runs again)`)

console.log(`\n  fn called: ${fetchCount} time(s)  ← 2 (call 1 + call 3)`)

// ─── E. (v1.1.5) Single-flight: concurrent misses run fn once ────────────────

console.log('\nE. Single-flight — 10 concurrent cache-miss callers:\n')

fetchCount = 0
const concurrentKey = 'product:STAMPEDE'

const t0 = Date.now()
const results = await Promise.all(
  Array.from({ length: 10 }, (_, i) =>
    act(concurrentKey, () => fetchProductPrice('STAMPEDE'), { cache: { ttl: 60_000 } })
      .then(r => ({ caller: i + 1, ok: r.ok, source: r.source }))
  )
)
const elapsed = Date.now() - t0

console.log(`  10 concurrent callers, fn called: ${fetchCount} time(s)  ← 1 (was 10 pre-v1.1.5)`)
console.log(`  all got source="${results[0].source}"  (first call)`)
console.log(`  total time: ${elapsed}ms  (vs ${30 * 10}ms if no single-flight)`)

// ─── F. Failures are never cached + invalidate() ─────────────────────────────

console.log('\nF. Failure not cached — transient error, then success:\n')

fetchCount = 0
let shouldFail = true

const flakyFetch = async () => {
  fetchCount++
  await sleep(20)
  if (shouldFail) {
    throw new Error('upstream temporarily unavailable')
  }
  return { status: 'ok', attempt: fetchCount }
}

const failResult = await act('service:health', flakyFetch, { cache: { ttl: 10_000 } })
console.log(`  1st call → ok: ${failResult.ok}  (error not cached)`)

shouldFail = false // "upstream recovers"

const successResult = await act('service:health', flakyFetch, { cache: { ttl: 10_000 } })
console.log(`  2nd call → ok: ${successResult.ok}  source: "${successResult.source}"`)

console.log('\n  Now: invalidate() forces a re-fetch even with a valid cache:')
const beforeInv = await act('service:health', flakyFetch, { cache: { ttl: 10_000 } })
console.log(`  call before invalidate → source: "${beforeInv.source}"`)
const removed = invalidate('service:health')
console.log(`  invalidate('service:health') → ${removed} (entry removed)`)
const afterInv = await act('service:health', flakyFetch, { cache: { ttl: 10_000 } })
console.log(`  call after invalidate  → source: "${afterInv.source}"  (re-fetched)`)

console.log(`\n  fn called: ${fetchCount} time(s) total`)

// ─── G. (v1.1.5) Fail-open: store.set() throwing doesn't break act() ─────────

console.log('\nG. Fail-open — store.set() throwing is swallowed, value still returned:\n')

// Custom store whose set() throws
const flakyStore = new InMemoryStore()
const originalSet = flakyStore.set.bind(flakyStore)
flakyStore.set = () => { throw new Error('redis unavailable') }

const scopedAct = withStore(flakyStore)
const failopenResult = await scopedAct('failopen-test', async () => 'value', {
  cache: { ttl: 60_000 },
})

console.log(`  act result with throwing store: ok=${failopenResult.ok}  value=${failopenResult.value}`)
console.log(`  ← cache write failure was swallowed (v1.1.5 fix)`)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
