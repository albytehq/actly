/**
 * Example 3 — Dedupe with shared meta and abort safety
 *
 * Three realistic scenarios:
 *   A. Five concurrent callers share one in-flight Promise — fn runs once.
 *      All callers see the same attempts count (v1.1.5 fix).
 *   B. Sequential calls after settlement each trigger fresh executions.
 *   C. (v1.1.5) Joiner can abort independently — doesn't block on hung originator.
 */

import { act } from '../dist/index.js'

// ─── Simulated expensive operation ───────────────────────────────────────────

let executionLog = []

function makeExpensiveLoader(name, latencyMs) {
  return async () => {
    executionLog.push({ fn: name, startedAt: Date.now() })
    await sleep(latencyMs)
    const result = { data: `${name}-result`, loadedAt: Date.now() }
    executionLog.push({ fn: name, completedAt: Date.now() })
    return result
  }
}

// ─── A. Five concurrent callers, one execution ───────────────────────────────

console.log('=== Dedupe Demo ===\n')
console.log('A. Five concurrent callers for the same key (with shared attempts):\n')

executionLog = []
let fnCallCount = 0
let innerAttempts = 0

// Simulate an originator that retries internally
const loader = async () => {
  fnCallCount++
  innerAttempts++
  if (innerAttempts < 3) throw new Error(`fail-${innerAttempts}`)
  await sleep(80)
  return { config: { theme: 'dark', locale: 'en' }, loadedBy: fnCallCount }
}

// Fire five calls at the same moment — identical key, dedupe enabled
const calls = Array.from({ length: 5 }, (_, i) =>
  act('config:global', loader, {
    dedupe: true,
    retry: { attempts: 5, delayMs: 1, jitter: 'none' },
  }).then(r => ({ caller: i + 1, result: r }))
)

const results = await Promise.all(calls)

console.log(`  fn executed: ${fnCallCount} time(s)  ← only 1 despite 5 callers`)
console.log(`  inner attempts: ${innerAttempts}  ← retried twice before success`)
console.log()
results.forEach(({ caller, result }) => {
  if (result.ok) {
    console.log(`  caller ${caller}: ok=${result.ok}  attempts=${result.attempts}  value=${JSON.stringify(result.value)}`)
  }
})
console.log(`\n  ← all callers see attempts=3 (shared meta, v1.1.5 fix)`)

// ─── B. Sequential calls trigger fresh fetches ────────────────────────────────

console.log('\nB. Sequential calls — each one runs fresh after the previous settles:\n')

fnCallCount = 0
innerAttempts = 0

for (let i = 0; i < 3; i++) {
  const r = await act('config:global', loader, { dedupe: true, retry: { attempts: 5, delayMs: 1 } })
  console.log(`  call ${i + 1}: ok=${r.ok}  fnCallCount=${fnCallCount}  attempts=${r.attempts}`)
}

console.log(`\n  fn executed: ${fnCallCount} times  ← once per sequential call`)

// ─── C. (v1.1.5) Joiner aborts without blocking on hung originator ──────────

console.log('\nC. Joiner aborts independently — originator keeps running:\n')

let originatorResolve
const hungPromise = new Promise(r => { originatorResolve = r })

// Originator starts a hung fn
const originatorP = act('hung:resource', () => hungPromise, { dedupe: true })
  .then(r => console.log(`  originator settled: ok=${r.ok}`))

await sleep(20)  // let originator register the in-flight promise

// Joiner arrives with their own abort signal
const joinerController = new AbortController()
const t0 = Date.now()
const joinerP = act('hung:resource', async () => 'fresh', {
  dedupe: true,
  signal: joinerController.signal,
}).then(r => {
  console.log(`  joiner settled in ${Date.now() - t0}ms: ok=${r.ok}  error=${r.error?.message}`)
  return r
})

setTimeout(() => joinerController.abort(new Error('joiner-cancelled')), 50)
await joinerP

// Cleanup: resolve originator so process can exit
originatorResolve('finally')
await originatorP

console.log('\n  ← joiner did NOT block on the hung originator (v1.1.5 fix)')

// ─── D. Different keys are independent ───────────────────────────────────────

console.log('\nD. Different keys — no cross-key collapse:\n')

const userLoader   = makeExpensiveLoader('user:1',   60)
const reportLoader = makeExpensiveLoader('reports:q3', 60)

executionLog = []

const [userResult, reportResult] = await Promise.all([
  act('user:1',      userLoader,   { dedupe: true }),
  act('reports:q3',  reportLoader, { dedupe: true }),
])

console.log(`  user:1      ok=${userResult.ok}    value=${JSON.stringify(userResult.ok ? userResult.value : null)}`)
console.log(`  reports:q3  ok=${reportResult.ok}  value=${JSON.stringify(reportResult.ok ? reportResult.value : null)}`)
console.log(`\n  fn executions logged: ${executionLog.filter(e => e.startedAt).length}  ← 2, one per key`)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}
