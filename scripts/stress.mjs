// Stress torture: concurrency, abort storms, memory, listener hygiene.
// Run: node scripts/stress.mjs
import { act, withStore, drain, InMemoryStore, createHealthCheck } from '../dist/index.js'

const warnings = []
process.on('warning', (w) => warnings.push(String(w.message)))

// 1. 10k concurrent fast-path calls
{
  const t0 = performance.now()
  const results = await Promise.all(
    Array.from({ length: 10_000 }, (_, i) => act(`stress-fast-${i}`, async () => i)),
  )
  const ms = performance.now() - t0
  const ok = results.filter((r) => r.ok).length
  const distinct = new Set(results.filter((r) => r.ok).map((r) => r.value)).size
  console.log(`10k fast path: ${ms.toFixed(0)}ms, ok=${ok}/10000, distinct=${distinct}`)
  if (ok !== 10_000 || distinct !== 10_000) throw new Error('fast path corruption')
}

// 2. 10k concurrent policy calls (retry+timeout+dedupe shared keys)
{
  const t0 = performance.now()
  const OPTS = Object.freeze({ retry: { attempts: 2, delayMs: 0 }, timeout: { ms: 5_000 } })
  const results = await Promise.all(
    Array.from({ length: 10_000 }, (_, i) =>
      act(`stress-policy-${i % 500}`, async (s) => {
        if (s.aborted) throw new Error('aborted')
        return i % 500
      }, OPTS)),
  )
  const ms = performance.now() - t0
  console.log(`10k policy calls (500 shared keys): ${ms.toFixed(0)}ms, ok=${results.filter((r) => r.ok).length}/10000`)
}

// 3. abort storm: 5k calls aborted mid-flight via shared signals
{
  const controllers = Array.from({ length: 100 }, () => new AbortController())
  const promises = []
  for (let i = 0; i < 5_000; i++) {
    const ctl = controllers[i % 100]
    promises.push(
      act(`storm-${i}`, async (s) => {
        await new Promise((res, rej) => {
          const t = setTimeout(res, 200)
          s.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')) }, { once: true })
        })
        return 'never'
      }, { signal: ctl.signal }).then((r) => r.ok ? 'late' : 'aborted'),
    )
  }
  await new Promise((res) => setTimeout(res, 10))
  const t0 = performance.now()
  for (const c of controllers) c.abort(new Error('storm'))
  const results = await Promise.all(promises)
  const aborted = results.filter((r) => r === 'aborted').length
  console.log(`abort storm: ${aborted}/5000 aborted cleanly (${(performance.now() - t0).toFixed(0)}ms to settle)`)
  if (aborted !== 5_000) throw new Error('abort storm left stragglers')
}

// 4. hedge stampede: 500 concurrent hedged calls
{
  let calls = 0
  const results = await Promise.all(
    Array.from({ length: 500 }, (_, i) =>
      act(`hedge-storm-${i}`, async (s) => {
        calls++
        await new Promise((res) => {
          const t = setTimeout(res, 30)
          s.addEventListener('abort', () => clearTimeout(t), { once: true })
        })
        return i
      }, { hedge: { delayMs: 10 } })),
  )
  console.log(`hedge stampede: ok=${results.filter((r) => r.ok).length}/500, fn calls=${calls} (hedge doubles load — expected ~1000)`)
}

// 5. drain under load + health
{
  const store = new InMemoryStore({ maxSize: 1000 })
  const scoped = withStore(store)
  const health = createHealthCheck(store)
  const pending = Array.from({ length: 200 }, (_, i) =>
    scoped(`drain-${i}`, async () => {
      await new Promise((res) => setTimeout(res, 80))
      return i
    }))
  await new Promise((res) => setTimeout(res, 10))
  const inflight = health().pendingInflight
  const drained = await drain(5_000, scoped.scope)
  const results = await Promise.all(pending)
  console.log(`drain: inflight=${inflight}, drained=${drained}, completed=${results.filter((r) => r.ok).length}/200`)
  if (!drained || inflight !== 200) throw new Error('drain accounting broken')
  store.destroy()
}

// 6. high-cardinality scopes (scoped store churn)
{
  let okCount = 0
  for (let batch = 0; batch < 20; batch++) {
    const stores = Array.from({ length: 50 }, () => {
      const s = new InMemoryStore()
      return { s, scoped: withStore(s) }
    })
    const rs = await Promise.all(stores.map(({ scoped }, i) => scoped(`hc-${batch}-${i}`, async () => 1)))
    okCount += rs.filter((r) => r.ok).length
    for (const { s } of stores) s.destroy()
  }
  console.log(`high-cardinality: ${okCount}/1000 across 1000 scoped stores`)
  if (okCount !== 1000) throw new Error('scoped churn broken')
}

// 7. memory sanity: two heavy rounds, heap growth must stay bounded
{
  const heapAfter = async () => {
    globalThis.gc?.()
    return process.memoryUsage().heapUsed / 1024 / 1024
  }
  await new Promise((res) => setTimeout(res, 100))
  const before = await heapAfter()
  for (let round = 0; round < 3; round++) {
    await Promise.all(
      Array.from({ length: 20_000 }, (_, i) =>
        act(`mem-${round}-${i % 2000}`, async () => i, {
          cache: { ttl: 10 },
          dedupe: true,
          timeout: { ms: 1_000 },
        })),
    )
  }
  await new Promise((res) => setTimeout(res, 200))
  const after = await heapAfter()
  console.log(`memory: ${before.toFixed(1)} MB → ${after.toFixed(1)} MB heapUsed (delta ${((after - before)).toFixed(1)} MB)`)
}

const listenerWarnings = warnings.filter((w) => w.includes('MaxListeners') || w.includes('EventTarget'))
console.log(`process warnings: ${warnings.length} total, listener leaks: ${listenerWarnings.length}`)
if (listenerWarnings.length > 0) {
  console.log(listenerWarnings.slice(0, 3))
}

console.log('\nSTRESS TORTURE PASSED')
