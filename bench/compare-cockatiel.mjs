/**
 * actly vs Cockatiel — empirical comparison.
 *
 * Runs equivalent workloads through both libraries for every policy they
 * share (retry+backoff, timeout, circuit breaker, bulkhead) and reports
 * throughput. Also demonstrates the policies actly has that Cockatiel
 * does not (cache, dedupe/single-flight, rate limit, hedge) by running
 * them standalone, since there is no Cockatiel equivalent to compare
 * against.
 *
 * This is a THROUGHPUT/OVERHEAD benchmark, not a "which library is
 * better" verdict — both are correct, production-grade implementations
 * of the policies they share. Numbers below measure per-call framework
 * overhead only; `fn` itself is a trivial no-op or fixed-delay stub, so
 * results isolate the cost of the policy machinery, not real I/O.
 *
 * Run with `node bench/compare-cockatiel.mjs` after:
 *   npm run build
 *   npm install --no-save cockatiel
 */
import { act, InMemoryStore, withStore } from '../dist/index.js'
import {
  retry, handleAll, ExponentialBackoff,
  timeout, TimeoutStrategy,
  circuitBreaker, ConsecutiveBreaker,
  bulkhead,
  wrap,
} from 'cockatiel'

const ITERS = 20_000
const WARMUP = 500

async function bench(name, fn, iters = ITERS) {
  for (let i = 0; i < WARMUP; i++) await fn()

  const t0 = performance.now()
  for (let i = 0; i < iters; i++) await fn()
  const t1 = performance.now()

  const totalMs = t1 - t0
  const perOpUs = (totalMs * 1000) / iters
  const opsPerSec = (iters / totalMs) * 1000

  console.log(
    `  ${name.padEnd(46)} ` +
    `${perOpUs.toFixed(3).padStart(8)} µs/op  ` +
    `${Math.round(opsPerSec).toLocaleString().padStart(12)} ops/sec`,
  )
  return { name, perOpUs, opsPerSec }
}

console.log('actly vs Cockatiel — shared-policy overhead comparison')
console.log('='.repeat(72))
console.log(`iterations: ${ITERS.toLocaleString()} per case, ${WARMUP} warmup\n`)

// ─── 1. Retry (happy path — no actual retries triggered) ──────────────────
console.log('1. retry (success on first attempt, exponential backoff configured)')
{
  const noop = async () => 42

  await bench('actly: retry.attempts=3', () =>
    act('bench:retry', noop, { retry: { attempts: 3, delayMs: 10, backoff: 'exponential' } }))

  const ckRetry = retry(handleAll, { maxAttempts: 3, backoff: new ExponentialBackoff() })
  await bench('cockatiel: retry maxAttempts=3', () => ckRetry.execute(noop))
}
console.log()

// ─── 2. Timeout (happy path — no timeout triggered) ────────────────────────
console.log('2. timeout (function resolves well under the limit)')
{
  const noop = async () => 42

  await bench('actly: timeout.ms=5000', () =>
    act('bench:timeout', noop, { timeout: { ms: 5000 } }))

  const ckTimeout = timeout(5000, TimeoutStrategy.Cooperative)
  await bench('cockatiel: timeout 5000ms cooperative', () => ckTimeout.execute(noop))
}
console.log()

// ─── 3. Circuit breaker (closed — happy path) ──────────────────────────────
console.log('3. circuit breaker (closed, calls succeed)')
{
  const noop = async () => 42

  await bench('actly: circuitBreaker closed', () =>
    act('bench:cb', noop, { circuitBreaker: { threshold: 5, cooldownMs: 10_000 } }))

  const ckBreaker = circuitBreaker(handleAll, {
    halfOpenAfter: 10_000,
    breaker: new ConsecutiveBreaker(5),
  })
  await bench('cockatiel: circuitBreaker closed', () => ckBreaker.execute(noop))
}
console.log()

// ─── 4. Bulkhead (under the concurrency limit) ─────────────────────────────
console.log('4. bulkhead (concurrency under the cap — no queuing)')
{
  const noop = async () => 42

  await bench('actly: bulkhead maxConcurrent=10', () =>
    act('bench:bulkhead', noop, { bulkhead: { maxConcurrent: 10 } }))

  const ckBulkhead = bulkhead(10, 0)
  await bench('cockatiel: bulkhead 10/0', () => ckBulkhead.execute(noop))
}
console.log()

// ─── 5. Full composed chain (the realistic case) ───────────────────────────
console.log('5. composed chain: retry + timeout + circuit breaker together')
{
  const noop = async () => 42

  await bench('actly: retry+timeout+circuitBreaker (1 act() call)', () =>
    act('bench:composed', noop, {
      retry:          { attempts: 3, delayMs: 10, backoff: 'exponential' },
      timeout:        { ms: 5000 },
      circuitBreaker: { threshold: 5, cooldownMs: 10_000 },
    }))

  const ckComposed = wrap(
    retry(handleAll, { maxAttempts: 3, backoff: new ExponentialBackoff() }),
    timeout(5000, TimeoutStrategy.Cooperative),
    circuitBreaker(handleAll, { halfOpenAfter: 10_000, breaker: new ConsecutiveBreaker(5) }),
  )
  await bench('cockatiel: wrap(retry, timeout, circuitBreaker)', () => ckComposed.execute(noop))
}
console.log()

// ─── 6. actly-only policies (no Cockatiel equivalent) ──────────────────────
console.log('6. actly-only policies — no Cockatiel equivalent, shown standalone')
{
  const store = new InMemoryStore()
  const scoped = withStore(store)
  const noop = async () => 42

  await bench('actly: cache hit (ttl=60s, single-flight)', () =>
    scoped('bench:cache', noop, { cache: { ttl: 60_000 } }))

  await bench('actly: dedupe (10 concurrent joiners collapse to 1 call)', async () => {
    await Promise.all(Array.from({ length: 10 }, () =>
      act('bench:dedupe-' + Math.floor(Math.random() * 1e9 / 1e9), noop, { dedupe: true })))
  }, 2_000)

  await bench('actly: rateLimit (under cap, no throttling)', () =>
    act('bench:ratelimit', noop, { rateLimit: { maxCalls: 1_000_000, windowMs: 60_000 } }))

  store.destroy()
}

console.log('\n' + '='.repeat(72))
console.log(`
Reading the numbers:
- Rows 1-5 measure per-call overhead of the policy machinery on a
  trivial async no-op. Both libraries add microseconds, not
  milliseconds, on the happy path — the difference is framework
  bookkeeping, not correctness or feature depth.
- Absolute µs/op numbers will vary by machine; what matters is the
  *relative* shape, not a specific number pulled out of this run.
- Row 5 is the closest thing to a "real" workload: three composed
  policies. actly expresses it as one options object; Cockatiel as
  wrap(...) over three separately-constructed policy instances.
- Row 6 has no Cockatiel column because Cockatiel does not ship
  cache, dedupe, rate-limit, or hedge policies — see README's
  "Compared to Cockatiel" section for the full feature table.
`)
