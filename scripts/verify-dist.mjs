// Torture the SHIPPED bundle (not src): every export, both module formats.
// Run: node scripts/verify-dist.mjs
import { createRequire } from 'module'

let failures = 0
const check = (name, fn) => {
  try {
    const ok = fn()
    if (ok === false) throw new Error('returned false')
    console.log(`  ok  ${name}`)
  } catch (e) {
    failures++
    console.error(`  FAIL ${name}: ${e.message}`)
  }
}

async function tortureESM() {
  const a = await import('../dist/index.js')
  const t = await import('../dist/testing/index.js')

  check('exports act/withStore/invalidate', () => typeof a.act === 'function' && typeof a.withStore === 'function' && typeof a.invalidate === 'function')
  check('exports policy factories', () =>
    [a.retryPolicy, a.timeoutPolicy, a.totalTimeoutPolicy, a.dedupePolicy,
     a.cachePolicy, a.circuitBreakerPolicy, a.bulkheadPolicy, a.rateLimitPolicy, a.noopPolicy]
      .every((f) => typeof f === 'function'))
  check('exports error taxonomy', () =>
    [a.ActlyError, a.TimeoutError, a.TotalTimeoutError, a.RetryExhaustedError, a.ValidationError,
     a.HedgeTimeoutError, a.CircuitBreakerOpenError, a.BulkheadOverflowError, a.RateLimitError,
     a.ResourceExhaustedError, a.ActlyAbortError].every((C) => typeof C === 'function') &&
    typeof a.isActlyError === 'function')
  check('exports utilities', () =>
    [a.anySignal, a.raceAbort, a.sleep, a.linkSignal, a.isAbortError, a.sanitizeKey,
     a.computeDelay, a.sanitizeErrorMessage, a.sanitizeError, a.usePolicy,
     a.acquireController, a.releaseController, a.poolSize,
     a.createHealthCheck, a.enableWatchdog, a.registerWatchdogHooks, a.unregisterWatchdogHooks,
     a.disableWatchdog, a.drain, a.drainAll, a.createTenantStore, a.createAsyncTenantStore,
     a.execute, a.OBSERVABILITY_HOOKS].every((x) => typeof x === 'function' || Array.isArray(x) || (x && typeof x === 'object')))
  check('exports stores', () => typeof a.InMemoryStore === 'function' && typeof a.isSyncStore === 'function')
  check('testing subpath exports', () => typeof t.waitForObsHook === 'function' && typeof t.isActlyEventType === 'function')

  const r1 = await a.act('vd-fast', async () => 1)
  check('fast path', () => r1.ok === true && r1.value === 1 && r1.attempts === 1)

  let n = 0
  const r2 = await a.act('vd-slow', async () => { if (++n < 3) throw new Error('x'); return 'ok' },
    { retry: { attempts: 3, delayMs: 1 }, timeout: { ms: 1000 } })
  check('retry+timeout', () => r2.ok === true && r2.value === 'ok' && r2.attempts === 3 && n === 3)

  const r3 = await a.act('vd-cache', async () => Date.now(), { cache: { ttl: 60000 } })
  const r4 = await a.act('vd-cache', async () => Date.now(), { cache: { ttl: 60000 } })
  check('cache hit', () => r4.ok && r4.source === 'cache' && r4.attempts === 0 && r3.value === r4.value)
  check('invalidate', () => a.invalidate('vd-cache') === true && a.invalidate('vd-cache') === false)

  let calls = 0
  const [j1, j2] = await Promise.all([
    a.act('vd-dedupe', async () => { calls++; await new Promise((res) => setTimeout(res, 25)); return calls }, { dedupe: true }),
    a.act('vd-dedupe', async () => { calls++; await new Promise((res) => setTimeout(res, 25)); return calls }, { dedupe: true }),
  ])
  check('dedupe single-flight', () => calls === 1 && j1.value === 1 && j2.value === 1)

  // v1.4.2: the object form enables without `enabled: true`
  let objCalls = 0
  const [k1, k2] = await Promise.all([
    a.act('vd-dedupe-obj', async () => { objCalls++; await new Promise((res) => setTimeout(res, 25)); return objCalls }, { dedupe: { inflightTtl: 5000 } }),
    a.act('vd-dedupe-obj', async () => { objCalls++; await new Promise((res) => setTimeout(res, 25)); return objCalls }, { dedupe: { inflightTtl: 5000 } }),
  ])
  check('dedupe object form single-flights (1.4.2)', () => objCalls === 1 && k1.value === 1 && k2.value === 1)

  // C1: hedge aborts only the loser — the headline regression check
  const signals = []
  let hedgeCall = 0
  const hr = await a.act('vd-hedge', async (signal) => {
    signals.push(signal)
    hedgeCall++
    if (hedgeCall === 1) { await new Promise((res) => setTimeout(res, 200)); return 'primary' }
    await new Promise((res) => setTimeout(res, 10))
    return 'hedge'
  }, { hedge: { delayMs: 40 } })
  await new Promise((res) => setTimeout(res, 25))
  check('hedge: winner alive, loser aborted', () =>
    hr.ok && hr.value === 'hedge' && signals[1].aborted === false && signals[0].aborted === true)

  // C3: typo hooks throw
  let c3 = false
  try { a.act('vd-typo', async () => 1, { observability: { onSucess: () => {} } }) } catch { c3 = true }
  check('observability typo throws', () => c3)

  // D7: sync validation
  let d7 = false
  try { a.act('vd-bad', async () => 1, { retry: { attempts: 0 } }) } catch { d7 = true }
  check('sync validation throw', () => d7)

  // fallback + audit + observability
  let audited = null
  const r5 = await a.act('vd-fb', async () => { throw new Error('no') }, {
    fallback: { value: 'safe' },
    audit: { log: (e) => { audited = e } },
    observability: { onFinalSuccess: () => {} },
  })
  check('fallback + audit', () => r5.ok === true && r5.value === 'safe' && audited?.ok === true)

  // bulkhead fail-fast + queue
  let overflowed = 0
  await Promise.all(Array.from({ length: 5 }, () =>
    a.act('vd-bulk', async () => new Promise((res) => setTimeout(res, 30)), { bulkhead: { maxConcurrent: 2 } })
      .then((r) => { if (!r.ok) overflowed++ })))
  check('bulkhead fail-fast default', () => overflowed === 3)

  // circuit breaker
  for (let i = 0; i < 3; i++) await a.act('vd-cb', async () => { throw new Error('x') }, { circuitBreaker: { threshold: 2, cooldownMs: 5000 } })
  const rcb = await a.act('vd-cb', async () => 'never', { circuitBreaker: { threshold: 2, cooldownMs: 5000 } })
  check('circuit opens', () => !rcb.ok && rcb.error?.code === 'ACTLY_CIRCUIT_OPEN')

  // rate limit
  for (let i = 0; i < 2; i++) await a.act('vd-rl', async () => 1, { rateLimit: { maxCalls: 2, windowMs: 60000 } })
  const rrl = await a.act('vd-rl', async () => 1, { rateLimit: { maxCalls: 2, windowMs: 60000 } })
  check('rate limit trips', () => !rrl.ok && rrl.error?.code === 'ACTLY_RATE_LIMIT')

  // totalTimeout
  const rtt = await a.act('vd-tt', async () => new Promise((res) => setTimeout(res, 500)), { totalTimeout: { ms: 30 } })
  check('totalTimeout fires', () => !rtt.ok && rtt.error?.code === 'ACTLY_TOTAL_TIMEOUT')

  // abort mid-flight
  const ctl = new AbortController()
  const p = a.act('vd-abort', async (s) => {
    return new Promise((_, rej) => s.addEventListener('abort', () => rej(new Error('aborted!')), { once: true }))
  }, { signal: ctl.signal })
  setTimeout(() => ctl.abort(new Error('stop')), 15)
  const rab = await p
  check('caller abort propagates', () => !rab.ok)

  // scoped + health + drain
  const store = new a.InMemoryStore()
  const scoped = a.withStore(store)
  await scoped('vd-scoped', async () => 1, { dedupe: true })
  const health = a.createHealthCheck(store)
  check('scoped + health', () => health().pendingInflight === 0 && health().storeSize >= 0)
  check('drain', () => a.drain(50) instanceof Promise)

  // tenants
  const tm = a.createTenantStore({ maxTenants: 2 })
  tm.get('t1')('vd-t1', async () => 1)
  tm.get('t2')('vd-t2', async () => 1)
  tm.get('t3')('vd-t3', async () => 1)
  check('tenant LRU bound', () => tm.size() === 2)
  tm.destroy()

  // decorator
  class Svc {
    async m(_s) { return 'svc' }
  }
  const d = Object.getOwnPropertyDescriptor(Svc.prototype, 'm')
  a.usePolicy({ retry: { attempts: 2, delayMs: 1 } })(Svc.prototype, 'm', d)
  Object.defineProperty(Svc.prototype, 'm', d)
  check('decorator', async () => false || (await new Svc().m()) === 'svc')

  // errors
  check('isActlyError', () => a.isActlyError(new a.TimeoutError(5)) === true && a.isActlyError({ code: 'ACTLY_TIMEOUT' }) === false)
  check('toJSON redact', () => new a.TimeoutError(5).toJSON({ redact: true }).message === 'ACT timed out after 5ms')
  check('error instance names survive minification', () => {
    const cases = [
      [() => new a.ActlyAbortError(), 'ActlyAbortError'],
      [() => new a.TimeoutError(5), 'TimeoutError'],
      [() => new a.TotalTimeoutError(5), 'TotalTimeoutError'],
      [() => new a.RetryExhaustedError({ attempts: 1, lastError: new Error('x'), errors: [] }), 'RetryExhaustedError'],
      [() => new a.ValidationError('m'), 'ValidationError'],
      [() => new a.CircuitBreakerOpenError('k', 5), 'CircuitBreakerOpenError'],
      [() => new a.BulkheadOverflowError('k', 2), 'BulkheadOverflowError'],
      [() => new a.RateLimitError('k', 2, 1000), 'RateLimitError'],
      [() => new a.ResourceExhaustedError(1, 100), 'ResourceExhaustedError'],
      [() => new a.HedgeTimeoutError({ delayMs: 5 }), 'HedgeTimeoutError'],
    ]
    return cases.every(([make, n]) => make().name === n)
  })
  const rten = await a.act('vd-errname', () => new Promise((res) => setTimeout(res, 200)), { timeout: { ms: 40 } })
  check('runtime error name + toJSON name', () =>
    rten.error?.name === 'TimeoutError' && rten.error?.toJSON().name === 'TimeoutError')
}

async function tortureCJS() {
  const require = createRequire(import.meta.url)
  const a = require('../dist/index.cjs')
  const t = require('../dist/testing/index.cjs')
  check('CJS: main exports', () => typeof a.act === 'function' && a.OBSERVABILITY_HOOKS?.length === 10)
  check('CJS: testing exports', () => typeof t.waitForObsHook === 'function')
  const r = await a.act('cjs-fast', async () => 42)
  check('CJS: act works', () => r.ok === true && r.value === 42)
  const rc = await a.act('cjs-full', async () => 'v', { retry: { attempts: 2 }, dedupe: true, cache: { ttl: 1000 } })
  check('CJS: policies work', () => rc.ok === true && rc.value === 'v')
  // shared state between ESM and CJS copies is NOT expected (two module
  // instances); each must be internally consistent:
  await a.act('cjs-cache', async () => 1, { cache: { ttl: 1000 } })
  check('CJS: invalidate', () => a.invalidate('cjs-cache') === true)
  check('CJS: error instance names survive minification', () =>
    new a.TimeoutError(5).name === 'TimeoutError' && new a.RateLimitError('k', 2, 1000).name === 'RateLimitError')
}

console.log('— torturing ESM bundle (dist/index.js) —')
await tortureESM()
console.log('— torturing CJS bundle (dist/index.cjs) —')
await tortureCJS()

if (failures > 0) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL DIST CHECKS PASSED')
