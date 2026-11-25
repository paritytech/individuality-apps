// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { chainVerdict, classifyHostFailure, type HostFailureClass } from "@individuality/people-chain"
import { describeError } from "./host/error-detail"
import { withTimeout } from "./with-timeout"
import type { TurnOutcome } from "./webrtc/ice"

/** A host transaction-build probe's call site. */
export type ChainHealthWhere = "open" | "registered" | "waiting" | "handover" | "confirm" | "signup" | "recheck"

type ChainHealthErrorClass = HostFailureClass

export type ChainHealthResult =
  | { outcome: "healthy"; latencyMs: number; order?: number; consecutiveLost?: number }
  | { outcome: "declined"; latencyMs: number; error: string; order?: number; consecutiveLost?: number }
  | {
      outcome: "host-chain-lost" | "unknown"
      latencyMs: number
      errorClass: ChainHealthErrorClass
      error: string
      order?: number
      /** app opens in a row that found the chain lost, as the doorway
       *  counted it with this probe (lib/chain-lost-streak) */
      consecutiveLost?: number
    }

let chainHealthOrder = 0
let latestAppliedChainHealthOrder = 0
const consumedTurnHealthOutcomes = new WeakSet<object>()

/** A session-wide ordering shared by explicit probes and TURN proof builds. */
export function nextChainHealthOrder(): number {
  chainHealthOrder += 1
  return chainHealthOrder
}

/** Prevent an older async result from undoing newer chain-health state. */
export function acceptChainHealthResult(result: ChainHealthResult): boolean {
  const verdict = acceptChainHealthOrder(latestAppliedChainHealthOrder, result.order)
  latestAppliedChainHealthOrder = verdict.latest
  return verdict.accepted
}

/** The pure step behind acceptChainHealthResult: an unordered result always
 *  applies, an ordered one only when newer than the latest applied. */
export function acceptChainHealthOrder(
  latest: number,
  order: number | undefined,
): { accepted: boolean; latest: number } {
  if (order === undefined) return { accepted: true, latest }
  if (order <= latest) return { accepted: false, latest }
  return { accepted: true, latest: order }
}

/** Building the TURN proof asks the signing host to answer. A timeout there
 * requests a bounded host probe; it is not enough to diagnose a stuck host by
 * itself. An issue-stage timeout happens only after the proof succeeded, so it
 * is player-network evidence for #724 instead. */
export function isTurnCredentialTimeout(outcome: TurnOutcome): boolean {
  return (
    outcome.received === "false" &&
    outcome.stage === "proof" &&
    outcome.cause === "timeout" &&
    /turn\/proof: no answer in \d+ms/i.test(outcome.reason)
  )
}

export const CHAIN_HEALTH_TIMEOUT_MS = 5000
const RECENT_HEALTHY_PROBE_MS = 30_000

/** A slow TURN proof must not override a host probe that just answered. */
export function turnProofTimeoutNeedsProbe(
  outcome: TurnOutcome,
  lastHealthyAtMs: number | null,
  nowMs: number,
): boolean {
  if (!isTurnCredentialTimeout(outcome)) return false
  return lastHealthyAtMs === null || nowMs - lastHealthyAtMs > RECENT_HEALTHY_PROBE_MS
}

/** A TURN proof timeout is only the first signal. The immediate bounded probe
 * must time out too before restart advice is justified. */
export function confirmTurnProofTimeoutWithProbe(result: ChainHealthResult): ChainHealthResult {
  if (result.outcome !== "unknown" || result.errorClass !== "timeout") return result
  return {
    ...result,
    outcome: "host-chain-lost",
    error: "TURN proof and chain health probe timed out",
  }
}

/** Translate TURN proof-building into the shared restart-card contract. */
export function turnProofChainHealthResult(
  outcome: TurnOutcome,
  order?: number,
): ChainHealthResult | null {
  // #750: a TURN proof timeout alone is ambiguous on a slow network. The UI
  // observer either ignores it after recent health or confirms it with an
  // immediate bounded host probe.
  if (outcome.received === "false" && isTurnCredentialTimeout(outcome)) return null
  if (
    order !== undefined &&
    (outcome.received === "true" || (outcome.received === "false" && outcome.stage === "issue"))
  )
    return { outcome: "healthy", latencyMs: 0, order }
  if (outcome.received !== "false" || outcome.stage !== "proof-chain") return null
  const error = outcome.reason ?? "TURN proof failed after the host chain was lost"
  return {
    outcome: "host-chain-lost",
    latencyMs: 0,
    errorClass: classifyHostFailure(error),
    error,
    ...(order !== undefined ? { order } : {}),
  }
}

/** Two bounded explicit probe timeouts count only when they are consecutive
 * and close enough to describe one stall. Any other evidence breaks the run.
 * TURN proof timeouts are confirmed separately by an immediate probe. */
const HOST_STUCK_TIMEOUT_WINDOW_MS = 30_000
export interface HostStuckEvidenceState {
  lastTimeoutAtMs: number | null
}

/** A timeout from before the page last came back from the background never
 * joins one after it: the host was frozen with the page, and a timeout then
 * says nothing about whether it answers now. */
export function resetHostStuckEvidenceOnReturn(
  state: HostStuckEvidenceState,
  returnedAtMs: number | null,
): HostStuckEvidenceState {
  if (state.lastTimeoutAtMs === null || returnedAtMs === null || state.lastTimeoutAtMs >= returnedAtMs) return state
  return { lastTimeoutAtMs: null }
}

export function reduceHostStuckEvidence(
  state: HostStuckEvidenceState,
  result: ChainHealthResult,
  nowMs: number,
): { state: HostStuckEvidenceState; result: ChainHealthResult } {
  if (result.outcome !== "unknown" || result.errorClass !== "timeout")
    return { state: { lastTimeoutAtMs: null }, result }
  const consecutive =
    state.lastTimeoutAtMs !== null && nowMs - state.lastTimeoutAtMs <= HOST_STUCK_TIMEOUT_WINDOW_MS
  if (!consecutive) return { state: { lastTimeoutAtMs: nowMs }, result }
  return {
    state: { lastTimeoutAtMs: nowMs },
    result: {
      ...result,
      outcome: "host-chain-lost",
      error: "two chain health probes timed out in a row",
    },
  }
}

/** Consume each TURN outcome once, including replay after a route remount. */
export function consumeTurnChainHealthResult(
  outcome: TurnOutcome,
  order?: number,
): ChainHealthResult | null {
  if (consumedTurnHealthOutcomes.has(outcome)) return null
  consumedTurnHealthOutcomes.add(outcome)
  return turnProofChainHealthResult(outcome, order)
}

export async function runChainHealthProbe(
  buildTransaction: () => Promise<void>,
  nowMs: () => number = () => performance.now(),
): Promise<ChainHealthResult> {
  const started = nowMs()
  try {
    const built = await withTimeout(buildTransaction(), CHAIN_HEALTH_TIMEOUT_MS)
    if (built === null)
      // the host did not answer within the bound: diagnostic like any unknown
      // (it may be slow, not cut), and named so no caller reads error text
      return {
        outcome: "unknown",
        latencyMs: Math.max(0, nowMs() - started),
        errorClass: "timeout",
        error: "chain health probe timed out",
        order: nextChainHealthOrder(),
      }
    return {
      outcome: "healthy",
      latencyMs: Math.max(0, nowMs() - started),
      order: nextChainHealthOrder(),
    }
  } catch (error) {
    const failureClass = classifyHostFailure(error)
    const verdict = chainVerdict(failureClass)
    if (verdict === "declined")
      return {
        outcome: "declined",
        latencyMs: Math.max(0, nowMs() - started),
        error: describeError(error),
        order: nextChainHealthOrder(),
      }
    return {
      outcome: verdict === "lost" ? "host-chain-lost" : "unknown",
      latencyMs: Math.max(0, nowMs() - started),
      // the bound above is the only timeout the stuck-host rule may count
      errorClass: verdict === "unanswered" ? "unknown" : failureClass,
      error: describeError(error),
      order: nextChainHealthOrder(),
    }
  }
}

export interface ChainHealthCardState {
  lost: boolean
  /** true only after the signing host has completed a transaction build. */
  answering?: boolean
  /** Copy follows the evidence: a known subscription loss is different from
   * a host that simply stopped answering. */
  reason?: RestartCardReason
  /** When the page came back from the background, if this loss was first
   * seen within RECONNECTING_BEFORE_RESTART_MS of that return
   * (lib/background-return's performance.now() clock). The host drops its
   * subscription while backgrounded and reconnects by itself, so the card
   * reads "reconnecting" until the window, measured from the return, ends. */
  reconnectingSince?: number
}

/** Unknown failures are diagnostic only. A known loss blocks pre-game
 * screens; the first successful probe after it clears the card. */
export function reduceChainHealthCard(
  state: ChainHealthCardState,
  result: ChainHealthResult,
): ChainHealthCardState {
  if (result.outcome === "host-chain-lost") {
    if (state.lost && state.reason === "chain-lost" && result.errorClass === "timeout") return state
    return {
      lost: true,
      reason: result.errorClass === "timeout" ? "host-unanswered" : "chain-lost",
    }
  }
  if (result.outcome === "healthy") return { lost: false, answering: true }
  return state
}

/** The page is back from the background: what the card knew before is about
 * a host that was frozen with the page, so a lost card goes down and needs
 * fresh evidence. It does not claim the host answers; only a probe can. */
export function chainHealthCardAfterReturn(state: ChainHealthCardState): ChainHealthCardState {
  return state.lost ? { lost: false } : state
}

/** Stamp a loss first seen soon after a return from the background, and keep
 * the stamp while that loss lasts. Any other loss keeps the usual rules. */
export function stampReturnReconnect(
  previous: ChainHealthCardState,
  next: ChainHealthCardState,
  returnedAtMs: number | null,
  nowMs: number,
): ChainHealthCardState {
  if (!next.lost) return next
  if (previous.lost) {
    if (previous.reconnectingSince === undefined || next.reconnectingSince === previous.reconnectingSince) return next
    return { ...next, reconnectingSince: previous.reconnectingSince }
  }
  if (returnedAtMs === null) return next
  const sinceReturn = nowMs - returnedAtMs
  if (sinceReturn < 0 || sinceReturn >= RECONNECTING_BEFORE_RESTART_MS) return next
  return { ...next, reconnectingSince: returnedAtMs }
}

export function chainHealthCardVisible(
  state: ChainHealthCardState,
  phase: "pre-game" | "round" | "post-game",
): boolean {
  return state.lost && phase === "pre-game"
}

/** What the sign-up takes from one probe while its attempt is slow: a known
 * loss is immediate, a timeout is a hint that needs a second one in a row. */
export function signupHostChainVerdict(
  result: ChainHealthResult,
): "lost" | "healthy" | "timeout" | "unknown" {
  if (result.outcome === "host-chain-lost") return "lost"
  if (result.outcome === "healthy") return "healthy"
  if (result.outcome === "unknown" && result.errorClass === "timeout") return "timeout"
  return "unknown"
}

/** The card's re-check: the first one this soon after the card goes up,
 *  then doubling to the cap. A host that repairs itself lets the player
 *  through in seconds, without another restart; one that stays lost is not
 *  asked to build a transaction every few seconds for the rest of the wait. */
export const CHAIN_LOST_RECHECK_FIRST_MS = 5000
export const CHAIN_LOST_RECHECK_CAP_MS = 30_000

/** The wait before re-check number `attempt` (0-based). A probe that timed
 *  out may still have its build pending in the host, so the next one waits
 *  the cap rather than stacking another build on top of it. */
export function chainLostRecheckDelayMs(attempt: number, lastTimedOut: boolean): number {
  if (lastTimedOut) return CHAIN_LOST_RECHECK_CAP_MS
  return Math.min(CHAIN_LOST_RECHECK_FIRST_MS * 2 ** Math.max(0, attempt), CHAIN_LOST_RECHECK_CAP_MS)
}

/** Re-check a shown card until it is cancelled (framework-free: the card's
 *  hook arms it while the card is visible). Each re-check is armed only once
 *  the last one SETTLED, so they never overlap, and none runs while the page
 *  is hidden: a re-check due then waits for the page to show again. */
export function armChainLostRecheck(options: {
  probe: () => Promise<ChainHealthResult | undefined>
  hidden: () => boolean
  /** subscribe to visibility changes; returns the unsubscribe */
  onVisibility: (listener: () => void) => () => void
}): () => void {
  const { probe, hidden, onVisibility } = options
  let attempt = 0
  let lastTimedOut = false
  let stopped = false
  let due = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    timer = setTimeout(fire, chainLostRecheckDelayMs(attempt, lastTimedOut))
  }
  function fire() {
    timer = undefined
    if (stopped) return
    if (hidden()) {
      due = true
      return
    }
    void probe()
      .catch(() => undefined)
      .then((result) => {
        if (stopped) return
        attempt += 1
        lastTimedOut = result?.outcome === "unknown" && result.errorClass === "timeout"
        schedule()
      })
  }
  const unsubscribe = onVisibility(() => {
    if (!due || hidden()) return
    due = false
    fire()
  })
  schedule()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    unsubscribe()
  }
}

/** After a timeout the return re-check confirms within the stuck-host window:
 *  this wait plus the probe's own bound stays inside it, so two timeouts in
 *  a row after a return pair the way the doorway counts them. */
const RETURN_TIMEOUT_CONFIRM_MS = HOST_STUCK_TIMEOUT_WINDOW_MS - CHAIN_HEALTH_TIMEOUT_MS - 5000

/** Back from the background the card holds no evidence, and some surfaces
 *  run no periodic probe of their own. Probe at once, then keep probing on
 *  the card's re-check cadence until `done` says a result is a verdict.
 *  Like the card's re-check, probes never overlap and none runs while the
 *  page is hidden. */
export function armReturnRecheck(options: {
  probe: () => Promise<ChainHealthResult | undefined>
  done: (result: ChainHealthResult | undefined) => boolean
  hidden: () => boolean
  onVisibility: (listener: () => void) => () => void
}): () => void {
  const { probe, done, hidden, onVisibility } = options
  let attempt = 0
  let stopped = false
  let due = false
  let timer: ReturnType<typeof setTimeout> | undefined
  function fire() {
    timer = undefined
    if (stopped) return
    if (hidden()) {
      due = true
      return
    }
    void probe()
      .catch(() => undefined)
      .then((result) => {
        if (stopped || done(result)) return
        const timedOut = result?.outcome === "unknown" && result.errorClass === "timeout"
        timer = setTimeout(fire, timedOut ? RETURN_TIMEOUT_CONFIRM_MS : chainLostRecheckDelayMs(attempt, false))
        attempt += 1
      })
  }
  const unsubscribe = onVisibility(() => {
    if (!due || hidden()) return
    due = false
    fire()
  })
  fire()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    unsubscribe()
  }
}

/** From this many app opens in a row with the chain lost, restarting has
 *  shown it does not help, and the card stops prescribing it. */
const CHAIN_LOST_ESCALATE_AT = 2
export const RECONNECTING_BEFORE_RESTART_MS = 60_000

/** Why the restart card is up: the host's chain is lost, or (a launch stall,
 *  lib/launch-stall) the host or its reads never answered. */
export type RestartCardReason = "chain-lost" | "host-unanswered" | "read-unanswered"

/** The sole eligibility rule shared by card persistence and the timed UI.
 *  The in-round "bar" waits for a chain loss too: a network switch drops the
 *  host's connection ("subscription dropped", "TrUAPI host connection
 *  interrupted"), and the bar blocks nothing while the host reconnects.
 *  A loss right after a return from the background (`afterReturn`) waits on
 *  every surface and whatever the open streak: backgrounding drops the
 *  subscription the same way, and the streak counts app opens, not returns. */
export function shouldWaitForReconnect(
  reason: RestartCardReason | undefined,
  consecutiveLost: number,
  surface: "card" | "bar" = "card",
  afterReturn = false,
): boolean {
  if (reason === undefined) return false
  if (afterReturn) return true
  return (surface === "bar" || reason !== "chain-lost") && consecutiveLost < CHAIN_LOST_ESCALATE_AT
}

export interface RestartCardCopy {
  eyebrow: string
  heading: string
  body: string
  /** the advice has moved past "restart" (consecutive losses) */
  escalated: boolean
}

const RESTART_HEADING = "Restart the Polkadot app"
const RESTART_ADVICE = "Close it fully (swipe it away) and open it again."

/** The collectables screen uses the shared stuck-host verdict and restart treatment, but its
 * kept-on-chain consequence is the last sentence instead of a game place. */
const RECONNECTING_HEADING = "Getting the connection back"

function reconnectingCopy(kept: string, timeLeft = ""): RestartCardCopy {
  return {
    eyebrow: "Reconnecting…",
    heading: RECONNECTING_HEADING,
    body: `The Polkadot app lost its chain connection and is reconnecting. This usually takes under a minute. ${kept}${timeLeft}`,
    escalated: false,
  }
}

export function collectablesRestartCardCopy(reconnecting = false): RestartCardCopy {
  if (reconnecting) return reconnectingCopy("Your collectables are kept.")
  return {
    eyebrow: "No answer",
    heading: RESTART_HEADING,
    body: `Your Polkadot app is not answering. ${RESTART_ADVICE} Your collectables are kept.`,
    escalated: false,
  }
}

/** The card's words. A silent host keeps the restart advice ("No answer").
 *  A lost chain prescribes a restart once; from the second app open in a row
 *  that finds it lost, the restart has been tried, so the card says what is
 *  left: switch to mobile data, then close the app fully and reopen it (the
 *  restart alone does not clear the host's dropped chain subscription,
 *  lib/chain-lost-streak.ts). */
export function restartCardCopy(
  reason: RestartCardReason,
  consecutiveLost: number,
  timeLeft: string,
  reconnecting = false,
): RestartCardCopy {
  // the window decides: a reconnecting card never prescribes anything yet
  if (reconnecting) return reconnectingCopy("Your place in the game is kept.", timeLeft)
  if (consecutiveLost >= CHAIN_LOST_ESCALATE_AT)
    return {
      eyebrow: "Still no answer",
      heading: "Switch to mobile data, then reopen",
      body: `The Polkadot app is still not answering. Switch to mobile data, close it fully (swipe it away), then open it again. Your place in the game is kept.${timeLeft}`,
      escalated: true,
    }
  if (reason !== "chain-lost")
    return {
      eyebrow: "No answer",
      heading: RESTART_HEADING,
      body: `Your Polkadot app is not answering. ${RESTART_ADVICE} Your place in the game is kept.${timeLeft}`,
      escalated: false,
    }
  return {
    eyebrow: "Connection lost",
    heading: RESTART_HEADING,
    body: `Your Polkadot app lost its connection to the network. ${RESTART_ADVICE} Your place in the game is kept.${timeLeft}`,
    escalated: false,
  }
}
