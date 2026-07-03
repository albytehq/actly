/**
 * v1.2.0 benchmarks.
 *
 * Run with `npm run bench`.
 *
 * Measures:
 *  - Fast path: act('k', fn) with no options
 *  - Slow path: act('k', fn, fullOptions) — all policies active
 *  - Cache hit: cached value returned
 *  - Cache miss: fn runs, value cached
 *  - Dedupe single-flight: 10 concurrent callers
 *  - InMemoryStore: get/set/has/size
 *  - Listener leak: 1000 act() calls with shared signal
 *
 * Outputs human-readable table. No external deps — uses Node's
 * `performance.now()` and a tiny harness.
 */
import { act, withStore, InMemoryStore } from '../dist/index.js'

const ITERS = 100_000
const WARMUP = 1_000

function bench(name, fn, iters = ITERS) {
  // Warmup
  for (let i = 0; i < WARMUP; i++) fn()

  const t0 = performance.now()
  for (let i = 0; i < iters; i++) fn()
  const t1 = performance.now()

  const totalMs = t1 - t0
  const perOpUs = (totalMs * 1000) / iters
  const opsPerSec = (iters / totalMs) * 1000

  console.log(
    `  ${name.padEnd(40)} ` +
    `${perOpUs.toFixed(3).padStart(8)} µs/op  ` +
    `${Math.round(opsPerSec).toLocaleString().padStart(12)} ops/sec  ` +
    `(${iters.toLocaleString()} iters in ${totalMs.toFixed(1)}ms)`,
  )
}

async function benchAsync(name, fn, iters = ITERS) {
  // Warmup
  for (let i = 0; i < WARMUP; i++) await fn()

  const t0 = performance.now()
  for (let i = 0; i < iters; i++) await fn()
  const t1 = performance.now()

  const totalMs = t1 - t0
  const perOpUs = (totalMs * 1000) / iters
  const opsPerSec = (iters / totalMs) * 1000

  console.log(
    `  ${name.padEnd(40)} ` +
    `${perOpUs.toFixed(3).padStart(8)} µs/op  ` +
    `${Math.round(opsPerSec).toLocaleString().padStart(12)} ops/sec  ` +
    `(${iters.toLocaleString()} iters in ${totalMs.toFixed(1)}ms)`,
  )
}

console.log('=== actly v1.2.0 benchmarks ===\n')

// ─── Synchronous-style ops ───────────────────────────────────────────────────

console.log('— InMemoryStore primitives —')
{
  const store = new InMemoryStore({ maxSize: 100_000 })
  for (let i = 0; i < 1000; i++) store.set(`k${i}`, i)

  bench('store.get() (hit)', () => { store.get('k500') })
  bench('store.get() (miss)', () => { store.get('nope') })
  bench('store.set() (update)', () => { store.set('k500', 999) })
  bench('store.has() (hit)', () => { store.has('k500') })
  bench('store.has() (miss)', () => { store.has('nope') })
  bench('store.size() (O(1))', () => { store.size() })
  bench('store.delete() + set() (churn)', () => {
    store.delete('k500')
    store.set('k500', 1)
  })
}

console.log('\n— Validation primitives —')
{
  // Direct calls to sanitiser — bypasses act() to measure pure validation cost.
  const { sanitizeKey } = await import('../dist/utils/key.js')
  bench('sanitizeKey() (valid)', () => { sanitizeKey('user:42') })
  bench('sanitizeKey() (reject, throws)', () => {
    try { sanitizeKey('__proto__') } catch {}
  })
}

console.log('\n— Async paths —')
{
  // Fast path: no options
  await benchAsync('act() fast path (no options)', async () => {
    await act(`fp:${Math.random()}`, async () => 1)
  })

  // Slow path: full options but everything passes
  await benchAsync('act() slow path (full options)', async () => {
    await act(`sp:${Math.random()}`, async () => 1, {
      retry: { attempts: 1 },
      timeout: { ms: 5000 },
      totalTimeout: { ms: 10000 },
    })
  })

  // Cache hit (very hot path)
  const cacheKey = 'cache-bench'
  await act(cacheKey, async () => 'cached', { cache: { ttl: 600_000 } })
  await benchAsync('act() cache hit', async () => {
    await act(cacheKey, async () => 'fresh', { cache: { ttl: 600_000 } })
  })

  // With signal (verify listener cleanup doesn't add overhead)
  const sig = new AbortController()
  await benchAsync('act() with signal (no abort)', async () => {
    await act(`sig:${Math.random()}`, async () => 1, { signal: sig.signal })
  })

  // With observability hooks (verify zero-cost when no hooks fire)
  await benchAsync('act() with empty observability', async () => {
    await act(`obs:${Math.random()}`, async () => 1, { observability: {} })
  })

  // With active observability (one hook fires)
  let calls = 0
  await benchAsync('act() with active onFinalSuccess', async () => {
    await act(`obs2:${Math.random()}`, async () => 1, {
      observability: { onFinalSuccess: () => { calls++ } },
    })
  })
}

console.log('\n— Listener leak prevention —')
{
  // Run 1000 act() calls with the same long-lived signal.
  // If listeners leak, this would slow down significantly as the
  // signal accumulates 1000 listeners.
  const sig = new AbortController()
  const t0 = performance.now()
  for (let i = 0; i < 10_000; i++) {
    await act(`leak:${i}`, async () => i, { signal: sig.signal })
  }
  const t1 = performance.now()
  console.log(
    `  ${'10k act() with shared signal'.padEnd(40)} ` +
    `${(t1 - t0).toFixed(0).padStart(8)} ms total  ` +
    `${((t1 - t0) / 10).toFixed(3)} µs/op`,
  )
}

console.log('\n=== Done ===')
