// Verification script — same tests as the review, run against v1.1.5 build
import { act, InMemoryStore, TimeoutError, TotalTimeoutError, execute, isSyncStore, isAsyncStore, withStore, invalidate } from './dist/index.js'

let passed = 0, failed = 0
const ok = (name, cond) => { if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name} FAILED`) } }

console.log('=== v1.1.5 verification: all critical fixes from the review ===\n')

console.log('--- A-1: README exports actually exist ---')
ok('isSyncStore exported', typeof isSyncStore === 'function')
ok('isAsyncStore exported', typeof isAsyncStore === 'function')
ok('execute exported', typeof execute === 'function')

console.log('\n--- A-2: execute() usable directly ---')
ok('execute is callable', typeof execute === 'function')

console.log('\n--- C-1: totalTimeout cancels inner retry loop ---')
{
  let attemptCount = 0
  const t0 = Date.now()
  await act('verify-c1', async () => {
    attemptCount++
    await new Promise(r => setTimeout(r, 300))
    return 'done'
  }, {
    retry: { attempts: 5, delayMs: 100 },
    totalTimeout: { ms: 100 },
  })
  await new Promise(r => setTimeout(r, 1500))
  ok('only 1 attempt fired after totalTimeout', attemptCount === 1)
}

console.log('\n--- C-2: timeout race returns promptly even if fn ignores signal ---')
{
  const t0 = Date.now()
  await act('verify-c2', async () => {
    await new Promise(r => setTimeout(r, 500))  // ignores signal
    return 'late'
  }, { timeout: { ms: 50 } })
  ok('act() returned < 200ms despite fn sleeping 500ms', Date.now() - t0 < 200)
}

console.log('\n--- C-3: dedupe joiner can abort without blocking on hung originator ---')
{
  let originatorResolve
  const hungPromise = new Promise(r => { originatorResolve = r })
  const originatorP = act('verify-c3', () => hungPromise, { dedupe: true })
  await new Promise(r => setTimeout(r, 20))
  
  const joinerController = new AbortController()
  const joinerP = act('verify-c3', async () => 'fresh', {
    dedupe: true,
    signal: joinerController.signal,
  })
  setTimeout(() => joinerController.abort(new Error('joiner-cancel')), 50)
  const t0 = Date.now()
  const joinerResult = await joinerP
  ok('joiner returned < 300ms (not blocked by hung originator)', Date.now() - t0 < 300)
  ok('joiner got failure', !joinerResult.ok)
  
  originatorResolve('finally')
  await originatorP
}

console.log('\n--- C-4: cache stampede prevention (single-flight) ---')
{
  let stampedeCount = 0
  await Promise.all(Array.from({length: 10}, () =>
    act('verify-c4', async () => {
      stampedeCount++
      await new Promise(r => setTimeout(r, 30))
      return 'v'
    }, { cache: { ttl: 60_000 } })
  ))
  ok('fn called only 1 time (was 10 in v1.1.0)', stampedeCount === 1)
}

console.log('\n--- C-5: dedupe joiners see originator attempt count ---')
{
  let calls = 0
  const fn = async () => {
    calls++
    if (calls < 3) throw new Error('fail')
    await new Promise(r => setTimeout(r, 20))
    return 'success'
  }
  const [a, b] = await Promise.all([
    act('verify-c5', fn, { dedupe: true, retry: { attempts: 5, delayMs: 1 } }),
    act('verify-c5', fn, { dedupe: true, retry: { attempts: 5, delayMs: 1 } }),
  ])
  ok('originator attempts = 3', a.attempts === 3)
  ok('joiner attempts = 3 (was 1 in v1.1.0)', b.attempts === 3)
}

console.log('\n--- C-6: cache hit reports attempts = 0 ---')
{
  await act('verify-c6', async () => 'v1', { cache: { ttl: 60_000 } })
  const hit = await act('verify-c6', async () => 'v2', { cache: { ttl: 60_000 } })
  ok('cache hit attempts = 0 (was 1 in v1.1.0)', hit.attempts === 0)
  ok('cache hit source = "cache"', hit.source === 'cache')
  ok('cache hit value still v1', hit.value === 'v1')
}

console.log('\n--- M-7: exponential backoff capped by maxDelay ---')
{
  const t0 = Date.now()
  let calls = 0
  await act('verify-m7', async () => {
    calls++
    if (calls < 4) throw new Error('fail')
    return 'ok'
  }, {
    retry: {
      attempts: 4,
      delayMs: 1000,
      backoff: 'exponential',
      maxDelay: 50,
      jitter: 'none',
    },
  })
  // Without maxDelay: 1000 + 2000 + 4000 = 7000ms
  // With maxDelay=50: 50 + 50 + 50 = 150ms
  ok(`total time < 500ms (was 7000ms uncapped)`, Date.now() - t0 < 500)
}

console.log('\n--- M-3: empty key validation ---')
{
  try {
    await act('', async () => 1)
    ok('empty key throws', false)
  } catch (e) {
    ok('empty key throws RangeError', e instanceof RangeError)
  }
}

console.log('\n--- M-4: retry attempts validation ---')
{
  try {
    await act('k', async () => 1, { retry: { attempts: -3 } })
    ok('negative attempts throws', false)
  } catch (e) {
    ok('negative attempts throws RangeError', e instanceof RangeError)
  }
  try {
    await act('k', async () => 1, { retry: { attempts: 1.5 } })
    ok('fractional attempts throws', false)
  } catch (e) {
    ok('fractional attempts throws RangeError', e instanceof RangeError)
  }
}

console.log('\n--- P-3: InMemoryStore LRU + maxSize ---')
{
  const store = new InMemoryStore({ maxSize: 3 })
  store.set('a', 1); store.set('b', 2); store.set('c', 3)
  store.set('d', 4)  // should evict 'a'
  ok('LRU evicts oldest (a)', store.get('a') === undefined)
  ok('LRU keeps recent (b, c, d)', store.get('b') === 2 && store.get('c') === 3 && store.get('d') === 4)
}

console.log('\n--- Signal: cooperative cancellation ---')
{
  const controller = new AbortController()
  let fnGotAborted = false
  const promise = act('verify-signal', async (signal) => {
    signal.addEventListener('abort', () => { fnGotAborted = true }, { once: true })
    await new Promise((_, reject) => 
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    )
    return 'unreachable'
  }, { signal: controller.signal, timeout: { ms: 5000 } })
  
  setTimeout(() => controller.abort(new Error('user-cancelled')), 30)
  const r = await promise
  ok('fn signal aborted', fnGotAborted)
  ok('act returned failure', !r.ok)
  ok('error is user-cancelled', r.error.message === 'user-cancelled')
}

console.log('\n--- withStore + invalidate: full store isolation ---')
{
  const store1 = new InMemoryStore()
  const store2 = new InMemoryStore()
  const act1 = withStore(store1)
  const act2 = withStore(store2)
  
  let calls = 0
  const fn = async () => { calls++; return `v${calls}` }
  
  await act1('verify-ws', fn, { cache: { ttl: 60_000 } })
  await act1('verify-ws', fn, { cache: { ttl: 60_000 } })  // hit
  await act2('verify-ws', fn, { cache: { ttl: 60_000 } })  // different store, miss
  
  ok('store1 + store2 isolation: 2 calls total', calls === 2)
  
  const invResult = act1.invalidate('verify-ws')
  ok('invalidate returns true when key existed', invResult === true)
  
  await act1('verify-ws', fn, { cache: { ttl: 60_000 } })  // miss after invalidate
  ok('after invalidate, fn called again', calls === 3)
  
  store1.destroy(); store2.destroy()
}

console.log(`\n=== Verification complete: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exit(1)
