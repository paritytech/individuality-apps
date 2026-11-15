// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * LIVE INVARIANTS: the four things that must never be true of a played game,
 * each reported ONCE per session, however many times it happens.
 *
 *   1. payoff-without-join        a payoff for a game this session did not join
 *   2. log-stops-before-payoff    the game log's newest line predates the payoff
 *   3. funnel-out-of-order        a CAUSAL funnel step landed before its cause
 *   4. recovery-hold-never-ends   the self-heal hold outlived two recovery graces
 *
 * DIAGNOSTIC ONLY. Nothing here reads game state, decides an outcome or blocks
 * a flow: the caller has already done the thing, and this records that it
 * happened. Every path is wrapped and never throws.
 *
 * DEDUPE PER SESSION: `seen` is module memory, one page load, exactly like the
 * session id (lib/debug/session-id). The FIRST hit of a kind is sent; every
 * later one is dropped. A reload is a new session and may send it again,
 * which is what a report wants: one line per session per broken invariant.
 * A client-side navigation into the NEXT game is a new session's worth of
 * invariants too, so `beginInvariantSession` clears the set at the join
 * (game-trace's beginJoin): without it a page that plays game N then N+1
 * would lose N+1's line to N's.
 *
 * Aggregate the metric, not the log attribute: `invariant.value_ms` is also a
 * gauge point and `invariant` a count, while Sentry may store the log field as
 * a string (see AGENTS.md on attribute types).
 *
 * The line also lands in the device's debug log (`devLog("invariant", kind)`),
 * so the end-of-game log carries it.
 */
import { devLog } from "./debug/log-store"
import { recordCount, recordGauge } from "./telemetry/metrics"
import { logEvent } from "./telemetry/log-event"
import { pageFreezeThresholdMs } from "./page-lifecycle"
import type { FunnelStage } from "./webrtc/funnel"

export type InvariantKind =
  | "payoff-without-join"
  | "log-stops-before-payoff"
  | "funnel-out-of-order"
  | "recovery-hold-never-ends"

/** Two recovery graces (statement-core's RECOVERY_GRACE_MS is 30 s): the
 *  ladder may hold its verdict for one grace; a hold still open after two is
 *  a hold that never ends. */
export const RECOVERY_HOLD_LIMIT_MS = 60_000

export interface InvariantHit {
  kind: InvariantKind
  /** the measured quantity, when the invariant has one (ms) */
  valueMs?: number
  /** context: which game, which stages, which peers. Numbers stay numbers so
   *  the log carries a typed field, not a `String()` of one. */
  detail?: Record<string, string | number>
}

const seen = new Set<InvariantKind>()

/** A new game is a new invariant session: the join clears the dedupe set, so
 *  a page that plays game N then N+1 still reports N+1's line. */
export function beginInvariantSession(): void {
  seen.clear()
}

/** One broken invariant per kind per session. Returns true when it was sent. */
export function noteInvariant(hit: InvariantHit): boolean {
  try {
    if (seen.has(hit.kind)) return false
    seen.add(hit.kind)
    const detail = hit.detail ?? {}
    const attrs: Record<string, string | number | undefined> = {
      "invariant.kind": hit.kind,
      ...detail,
      // A number here is for filtering/display only; the gauge below is the
      // aggregate transport (log attributes may be stored as strings; see the
      // header).
      ...(hit.valueMs === undefined ? {} : { "invariant.value_ms": Math.round(hit.valueMs) }),
    }
    // The metric is tagged with the KIND ALONE: a detail field here would make
    // one series per occurrence (a stage, a peer pair) and no dashboard could
    // count the kind. The detail rides the log and the gauge instead.
    recordCount("invariant", 1, { "invariant.kind": hit.kind })
    if (hit.valueMs !== undefined)
      recordGauge("invariant.value_ms", Math.max(0, hit.valueMs), "millisecond", { "invariant.kind": hit.kind })
    logEvent(`invariant.${hit.kind}`, "warn", attrs, Object.keys(detail).length === 0 ? undefined : JSON.stringify(detail))
    devLog("invariant", hit.kind, {
      ...detail,
      ...(hit.valueMs === undefined ? {} : { valueMs: Math.round(hit.valueMs) }),
    })
    return true
  } catch {
    return false
  }
}

/** the kinds already reported this session (a debug sheet / a test may ask) */
export function reportedInvariants(): InvariantKind[] {
  return [...seen]
}

export function resetInvariantsForTests(): void {
  seen.clear()
}

// ── the pure checks the four sites call ─────────────────────────────────────

/** A payoff for a game this session did not play. Unknown (no live game, a
 *  relaunch straight onto /chest) is not evidence: it says nothing. */
export function payoffForAnotherGame(playedGame: number | null, payoffGame: number): boolean {
  return playedGame !== null && Number.isInteger(playedGame) && Number.isInteger(payoffGame) && playedGame !== payoffGame
}

/** The newest log line predates the payoff's start: nothing was logged while
 *  the payoff ran. Null (no lines at all) is not evidence either. */
export function logStoppedBeforePayoff(newestLogAt: number | null, payoffStartedAt: number): boolean {
  return (
    newestLogAt !== null &&
    Number.isFinite(newestLogAt) &&
    Number.isFinite(payoffStartedAt) &&
    newestLogAt < payoffStartedAt
  )
}

/**
 * The funnel's CAUSAL pairs, and the only ordering this invariant asserts:
 * a stage cannot be stamped before the stage that must have happened for it
 * to exist at all.
 *
 *  - `connected` cannot precede `offer`: no connection exists without a
 *    description exchanged
 *  - `first_frame` cannot precede `connected`: no video arrives before the
 *    transport is up
 *
 * The list is deliberately NOT the FUNNEL_STAGES order. The mesh stamps in
 * the order events arrive, and the answerer reaches `ice_checking` (from
 * `oniceconnectionstatechange`, mesh.ts) BEFORE `answer`: the remote
 * candidates are already in the offer, so ICE starts checking while the
 * local answer is still gathering, and `answer` is stamped after
 * `setLocalDescription` + `waitIceGathering` + `signal`. The offerer can do
 * the same after `setRemoteDescription`. Treating the funnel as a sequence
 * therefore fires on nearly every real session; only the causal pairs say
 * something is actually wrong.
 */
const FUNNEL_CAUSAL_PAIRS: ReadonlyArray<readonly [FunnelStage, FunnelStage]> = [
  ["offer", "connected"],
  ["connected", "first_frame"],
]

export interface FunnelBreach {
  /** the stage that must have come first */
  cause: FunnelStage
  /** the stage stamped before its cause */
  effect: FunnelStage
  causeMs: number
  effectMs: number
}

/** A stage stamped before a stage that CAUSES it. `stamped` holds the first
 *  stamp of each stage reached so far; `next` is the one arriving now. Stages
 *  outside the causal pairs (offer, answer, ice_checking between themselves)
 *  are ignored — their order is whatever the mesh happened to reach. */
export function funnelOrderBreach(
  stamped: ReadonlyMap<FunnelStage, number>,
  next: { stage: FunnelStage; ms: number },
): FunnelBreach | null {
  // a stage already stamped keeps its FIRST time: a re-stamp (a duplicate
  // offer, a rebuilt link) must not move it and invent or hide a breach
  const msOf = (stage: FunnelStage): number | undefined => stamped.get(stage) ?? (stage === next.stage ? next.ms : undefined)
  for (const [cause, effect] of FUNNEL_CAUSAL_PAIRS) {
    const causeMs = msOf(cause)
    const effectMs = msOf(effect)
    if (causeMs !== undefined && effectMs !== undefined && effectMs < causeMs) return { cause, effect, causeMs, effectMs }
  }
  return null
}

/** The recovery hold has stayed open longer than its own limit. */
export function recoveryHoldExpired(heldForMs: number, limitMs = RECOVERY_HOLD_LIMIT_MS): boolean {
  return Number.isFinite(heldForMs) && heldForMs >= limitMs
}

/** The tick the mesh's ladder runs on (useMesh's `setInterval(tick, 1000)`). */
export const RECOVERY_TICK_MS = 1000

export interface AwakeClock {
  /** the monotonic reading of the last counted tick */
  at: number
  /** ms of VISIBLE, ONLINE, RUNNING time accumulated so far */
  awakeMs: number
}

/**
 * How long a recovery episode has really been running, counting only the time
 * the page was actually awake. `awake` is the caller's pageHidden()/onLine
 * test for THIS tick; a gap longer than one tick plus the freeze slack means
 * the timers did not run (iOS froze the page, Android throttled it), so the
 * gap is not time the hold spent failing to heal — the phone was asleep.
 *
 * A phone backgrounded or offline for a minute comes back with a raw episode
 * age past RECOVERY_HOLD_LIMIT_MS and nothing wrong with the self-heal; the
 * invariant must not fire on the player's own trouble (settleSeats'
 * selfSuspect says the same about the tiles).
 */
export function advanceAwakeClock(prev: AwakeClock | undefined, now: number, awake: boolean): AwakeClock {
  if (!prev || !Number.isFinite(prev.at)) return { at: now, awakeMs: 0 }
  const gap = now - prev.at
  const ran = gap >= 0 && gap <= pageFreezeThresholdMs(RECOVERY_TICK_MS)
  return { at: now, awakeMs: prev.awakeMs + (awake && ran ? gap : 0) }
}
