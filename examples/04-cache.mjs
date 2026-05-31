/**
 * Example 4 — Cache
 *
 * Four scenarios:
 *   A. Cache miss on first call, hit on second — fn runs only once.
 *   B. result.source tells you where the value came from.
 *   C. TTL expiry — cache evicts and fn runs again.
 *   D. Failures are never cached — next call always retries fn.
 */

import { act } from '../dist/index.js'

// ─── Simulated remote call ────────────────────────────────────────────────────

let fetchCount = 0

async function fetchProductPrice(sku) {
  fetchCount++
  await sleep(30)
  // Prices "change" every call so we can tell hits from misses in the output
  return { sku, priceUsd: 9.99 + fetchCount * 0.01, fetchCount }
}

// ─── A & B. Cache miss then hit ───────────────────────────────────────────────

console.log('=== Cache Demo ===\n')
console.log('A+B. First call is a miss, second is a hit:\n')

fetchCount = 0

const miss = await act('product:ABC123', () => fetchProductPrice('ABC123'), {
  cache: { ttl: 5_000 },
})

const hit = await act('product:ABC123', () => fetchProductPrice('ABC123'), {
  cache: { ttl: 5_000 },
})

console.log(`  1st call → source: "${miss.ok ? miss.source : 'error'}"  fetchCount: ${miss.ok ? miss.value.fetchCount : '—'}`)
console.log(`  2nd call → source: "${hit.ok  ? hit.source  : 'error'}"  fetchCount: ${hit.ok  ? hit.value.fetchCount  : '—'}`)
console.log(`\n  fn called: ${fetchCount} time(s)  ← 1, not 2`)

// ─── C. TTL expiry ────────────────────────────────────────────────────────────

console.log('\nC. TTL expiry — cache evicts after 120ms:\n')

fetchCount = 0

const shortTTL = { cache: { ttl: 120 } }
const key = 'product:XYZ999'

const call1 = await act(key, () => fetchProductPrice('XYZ999'), shortTTL)
console.log(`  call 1 → source: "${call1.ok ? call1.source : 'error'}"  (miss, fn runs)`)

const call2 = await act(key, () => fetchProductPrice('XYZ999'), shortTTL)
console.log(`  call 2 → source: "${call2.ok ? call2.source : 'error'}"  (hit, fn skipped)`)

await sleep(150) // past the 120ms TTL

const call3 = await act(key, () => fetchProductPrice('XYZ999'), shortTTL)
console.log(`  call 3 → source: "${call3.ok ? call3.source : 'error'}"  (miss after expiry, fn runs again)`)

console.log(`\n  fn called: ${fetchCount} time(s)  ← 2 (call 1 + call 3)`)

// ─── D. Failures are never cached ────────────────────────────────────────────

console.log('\nD. Failure not cached — transient error, then success:\n')

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
console.log(`  2nd call → ok: ${successResult.ok}  source: "${successResult.ok ? successResult.source : 'error'}"`)

if (successResult.ok) {
  console.log(`  value: ${JSON.stringify(successResult.value)}`)
}

console.log(`\n  fn called: ${fetchCount} time(s)  ← 2, failure forced a retry`)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
