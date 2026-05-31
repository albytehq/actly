/**
 * Example 3 — Dedupe
 *
 * Three realistic scenarios:
 *   A. Five concurrent callers share one in-flight Promise — fn runs once.
 *   B. Sequential calls after settlement each trigger fresh executions.
 *   C. Different keys are independent — no cross-key collapse.
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
console.log('A. Five concurrent callers for the same key:\n')

executionLog = []
let fnCallCount = 0

const loader = async () => {
  fnCallCount++
  await sleep(80) // simulate a slow fetch
  return { config: { theme: 'dark', locale: 'en' }, loadedBy: fnCallCount }
}

// Fire five calls at the same moment — identical key, dedupe enabled
const calls = Array.from({ length: 5 }, (_, i) =>
  act('config:global', loader, { dedupe: true })
    .then(r => ({ caller: i + 1, result: r }))
)

const results = await Promise.all(calls)

console.log(`  fn executed: ${fnCallCount} time(s)  ← only 1 despite 5 callers`)
console.log()
results.forEach(({ caller, result }) => {
  if (result.ok) {
    console.log(`  caller ${caller}: ok=${result.ok}  value=${JSON.stringify(result.value)}`)
  }
})

// ─── B. Sequential calls trigger fresh fetches ────────────────────────────────

console.log('\nB. Sequential calls — each one runs fresh after the previous settles:\n')

fnCallCount = 0

for (let i = 0; i < 3; i++) {
  const r = await act('config:global', loader, { dedupe: true })
  console.log(`  call ${i + 1}: ok=${r.ok}  fnCallCount=${fnCallCount}`)
}

console.log(`\n  fn executed: ${fnCallCount} times  ← once per sequential call`)

// ─── C. Different keys stay independent ───────────────────────────────────────

console.log('\nC. Different keys — no cross-key collapse:\n')

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
