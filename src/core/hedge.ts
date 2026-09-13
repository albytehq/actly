import type { ActFn, RunMeta } from '../types.js'
import { linkSignal } from '../abort.js'

/** Which side won the hedge race. */
export type HedgeSide = 'primary' | 'hedge'

/**
 * Module-private marker for "the hedge window elapsed". Deliberately NOT
 * `HedgeTimeoutError`: a user fn that throws that class before the window
 * closes must propagate as a real failure (per the semantics below), not
 * silently launch a hedge. An identity check also stays correct across
 * realms and duplicate bundle copies, unlike `instanceof`.
 */
const HEDGE_WINDOW_ELAPSED = Symbol('hedge window elapsed')

export interface HedgeRaceResult<T> {
  value: T
  winner: HedgeSide
}

/**
 * The one hedge race implementation, shared by both placements.
 *
 * Semantics:
 *  - primary settles before `delayMs` → primary wins, no hedge is launched;
 *  - primary FAILS before `delayMs` → its error propagates, the (unstarted)
 *    hedge controller is aborted — even when that error is itself a
 *    `HedgeTimeoutError` (e.g. rethrown from a nested actly call);
 *  - `delayMs` elapses → the hedge launches and both race to settle;
 *  - one settles first → it wins and ONLY THE LOSER'S controller is
 *    aborted, so the winner's downstream side-effects (streaming bodies,
 *    cursor cleanup) run to completion;
 *  - one rejects first → its error propagates and both controllers are
 *    aborted (both chains are dead at that point; aborting is cleanup).
 *
 * `keepLoser: true` skips every abort. Parent aborts propagate to both
 * controllers via `linkSignal`.
 *
 * Both `wrapHedge` (inside-retry) and `runWithHedge` (outside-retry)
 * delegate here: the v1.3 regression where one copy aborted the winner and
 * the other did not is structurally impossible now.
 */
async function hedgeRace<T>(
  primaryFactory: (signal: AbortSignal) => Promise<T>,
  hedgeFactory: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  delayMs: number,
  keepLoser: boolean,
): Promise<HedgeRaceResult<T>> {
  const primaryCtl = new AbortController()
  const hedgeCtl = new AbortController()
  const unlinkPrimary = linkSignal(parentSignal, primaryCtl)
  const unlinkHedge = linkSignal(parentSignal, hedgeCtl)

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const primary = Promise.resolve(primaryFactory(primaryCtl.signal))

    const hedgeWindow = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(HEDGE_WINDOW_ELAPSED), delayMs)
    })

    try {
      const value = await Promise.race([primary, hedgeWindow])
      return { value, winner: 'primary' }
    } catch (e) {
      if (e !== HEDGE_WINDOW_ELAPSED) {
        // primary failed before the hedge window closed
        if (!keepLoser) hedgeCtl.abort(new Error('hedge cancelled: primary rejected'))
        throw e
      }
    }

    // Hedge window elapsed; launch the hedge and race both to settle.
    const hedge = Promise.resolve(hedgeFactory(hedgeCtl.signal))
    primary.catch(() => { /* loser rejections must not go unhandled */ })
    hedge.catch(() => { /* same */ })

    const primaryTagged = primary.then((value) => ({ value, winner: 'primary' as const }))
    const hedgeTagged = hedge.then((value) => ({ value, winner: 'hedge' as const }))

    try {
      const winner = await Promise.race([primaryTagged, hedgeTagged])
      if (!keepLoser) {
        // Only the loser: aborting the winner would cancel downstream
        // side-effects that are still running after the value was produced.
        if (winner.winner === 'primary') {
          hedgeCtl.abort(new Error('hedge cancelled: loser'))
        } else {
          primaryCtl.abort(new Error('hedge cancelled: loser'))
        }
      }
      return winner
    } catch (err) {
      // First rejection ends the race; both chains are dead — abort both.
      if (!keepLoser) {
        primaryCtl.abort(new Error('hedge cancelled: loser rejected'))
        hedgeCtl.abort(new Error('hedge cancelled: loser rejected'))
      }
      throw err
    }
  } finally {
    if (timer) clearTimeout(timer)
    unlinkPrimary()
    unlinkHedge()
  }
}

/**
 * Hedge placement `inside-retry`: wraps `fn` directly, so each retry
 * attempt can spawn its own hedge. The returned `ActFn` resolves with the
 * winning value.
 */
export function wrapHedge<T>(
  fn: ActFn<T>,
  delayMs: number,
  keepLoser: boolean,
): ActFn<T> {
  return async (parentSignal: AbortSignal) => {
    const race = await hedgeRace(
      (signal) => Promise.resolve(fn(signal)),
      (signal) => Promise.resolve(fn(signal)),
      parentSignal,
      delayMs,
      keepLoser,
    )
    return race.value
  }
}

/**
 * Hedge placement `outside-retry` (the default): wraps the whole policy
 * chain. Each chain gets its own `RunMeta` so primary and hedge do not
 * race on `attempts`/`source`; the winner's meta is returned.
 */
export async function runWithHedge<T>(
  chainFactory: (signal: AbortSignal, meta: RunMeta) => Promise<T>,
  primaryMeta: RunMeta,
  hedgeMeta: RunMeta,
  parentSignal: AbortSignal,
  delayMs: number,
  keepLoser: boolean,
): Promise<{ value: T; winnerMeta: RunMeta }> {
  const race = await hedgeRace(
    (signal) => chainFactory(signal, primaryMeta),
    (signal) => chainFactory(signal, hedgeMeta),
    parentSignal,
    delayMs,
    keepLoser,
  )
  return { value: race.value, winnerMeta: race.winner === 'primary' ? primaryMeta : hedgeMeta }
}
