// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { devLog } from "./debug/log-store"
import {
  acceptChainHealthResult,
  armChainLostRecheck,
  armReturnRecheck,
  chainHealthCardAfterReturn,
  confirmTurnProofTimeoutWithProbe,
  consumeTurnChainHealthResult,
  isTurnCredentialTimeout,
  nextChainHealthOrder,
  reduceChainHealthCard,
  shouldWaitForReconnect,
  stampReturnReconnect,
  turnProofTimeoutNeedsProbe,
  type ChainHealthCardState,
  type ChainHealthResult,
  type ChainHealthWhere,
} from "./chain-health"
import { applyRestartProbe, forgetRestartCardTiming, recordRestartCardCleared } from "./chain-restart"
import { lastBackgroundReturnAtMs, watchBackgroundReturns } from "./background-return"
import { noteChainLostStreak } from "./chain-lost-streak"
import {
  lastTurnChainHealthOutcome,
  observeTurnChainHealthOutcome,
  turnOutcomeChainHealthOrder,
  TURN_OUTCOME_REPLAY_MAX_MS,
  type TurnOutcome,
} from "./webrtc/ice"

interface ChainHealthSource {
  nowSeconds(): number
  probeChainHealth?(where: ChainHealthWhere, context?: { registered?: boolean }): Promise<ChainHealthResult>
}

interface RoundLostReappearanceState {
  afterRecovery: boolean
  consecutiveLost: number
}

/**
 * Once healthy evidence clears an in-round bar, require the same two-strike
 * confidence before showing it again. A single stale re-check can finish
 * after the answering evidence that cleared the bar; letting that one result
 * win would make the recovery UI flap. Any non-lost result breaks the streak.
 */
export function gateRoundLostReappearance(
  card: ChainHealthCardState,
  result: ChainHealthResult,
  phase: "pre-game" | "round" | "post-game",
  state: RoundLostReappearanceState,
): { acceptForCard: boolean; state: RoundLostReappearanceState } {
  if (phase !== "round")
    return { acceptForCard: true, state: { afterRecovery: false, consecutiveLost: 0 } }
  if (result.outcome === "healthy")
    return {
      acceptForCard: true,
      state: {
        afterRecovery: state.afterRecovery,
        consecutiveLost: 0,
      },
    }
  if (result.outcome !== "host-chain-lost")
    return {
      acceptForCard: true,
      state: { ...state, consecutiveLost: 0 },
    }
  if (!state.afterRecovery || card.lost)
    return { acceptForCard: true, state }

  const consecutiveLost = state.consecutiveLost + 1
  return consecutiveLost < 2
    ? {
        acceptForCard: false,
        state: { afterRecovery: true, consecutiveLost },
      }
    : {
        acceptForCard: true,
        state: { afterRecovery: false, consecutiveLost: 0 },
      }
}

/** Record recovery from the card state transition rather than from one
 * particular evidence source. A signed transaction (`noteHealthy`), a probe,
 * or any later reducer path that clears an in-round lost card must all arm the
 * same two-strike protection against a stale re-check. */
export function noteRoundLostClear(
  previous: ChainHealthCardState,
  next: ChainHealthCardState,
  phase: "pre-game" | "round" | "post-game",
  state: RoundLostReappearanceState,
): RoundLostReappearanceState {
  if (phase !== "round" || !previous.lost || next.lost) return state
  return { afterRecovery: true, consecutiveLost: 0 }
}

/** Whether one accepted lost result must persist restart advice. A concrete
 * chain error that replaces an already-visible silent-host result is a new
 * advice transition even though the card was already lost. */
export function restartAdviceForLoss(
  previous: ChainHealthCardState,
  result: ChainHealthResult,
  phase: "pre-game" | "round" | "post-game",
  acceptForCard: boolean,
  afterReturn = false,
): boolean | "bar" {
  if (!acceptForCard || result.outcome !== "host-chain-lost") return false
  const reason = result.errorClass === "timeout" ? "host-unanswered" : "chain-lost"
  const newlyStuck = !previous.lost
  const becameConcrete = previous.lost && previous.reason !== "chain-lost" && reason === "chain-lost"
  if (!newlyStuck && !becameConcrete) return false
  if (phase === "pre-game")
    return shouldWaitForReconnect(reason, result.consecutiveLost ?? 0, "card", afterReturn) ? false : true
  return phase === "round" && newlyStuck ? "bar" : false
}

/** One accepted result's effect on the card: the next card state, stamped
 * when the loss follows a return from the background, and whether it is
 * restart advice to persist now. A stamped loss is not: its reconnecting
 * minute decides, and the reconnect window records the advice if it ends. */
export function chainHealthCardStep(options: {
  previous: ChainHealthCardState
  result: ChainHealthResult
  phase: "pre-game" | "round" | "post-game"
  acceptForCard: boolean
  returnedAtMs: number | null
  nowMs: number
}): { next: ChainHealthCardState; advice: boolean | "bar" } {
  const { previous, result, phase, acceptForCard, returnedAtMs, nowMs } = options
  const next = acceptForCard
    ? stampReturnReconnect(previous, reduceChainHealthCard(previous, result), returnedAtMs, nowMs)
    : previous
  const advice = restartAdviceForLoss(previous, result, phase, acceptForCard, next.reconnectingSince !== undefined)
  return { next, advice }
}

export const REGISTERED_HEALTH_START_SECONDS = 15 * 60
const REGISTERED_HEALTH_FAST_SECONDS = 5 * 60
export const PRE_GAME_HEALTH_STOP_SECONDS = 30
export const REGISTERED_HEALTH_SLOW_MS = 60_000
export const REGISTERED_HEALTH_FAST_MS = 20_000

/** Elapsed-time decisions must not inherit wall-clock corrections. */
export function chainHealthElapsedNowMs(): number {
  return performance.now()
}

/** Compare TURN evidence with recent health on the same monotonic clock. */
export function turnProofTimeoutNeedsProbeNow(
  outcome: TurnOutcome,
  lastHealthyAtMs: number | null,
): boolean {
  return turnProofTimeoutNeedsProbe(outcome, lastHealthyAtMs, chainHealthElapsedNowMs())
}

/**
 * Keep a registered player's signing host under observation before the
 * waiting-room handover. A normal probe runs once a minute, then every 20 s
 * from T-5 minutes. A timeout gets one 20 s confirmation even in the slow
 * band: the source's two-timeout verdict intentionally expires after 30 s,
 * and weakening that verdict would make unrelated slow answers look stuck.
 *
 * Scheduling happens only after the previous probe settles, so a slow host
 * can never accumulate transaction builds. A due probe waits while the page
 * is hidden and resumes immediately when it becomes visible.
 */
export function armPreGameChainHealthProbes(options: {
  nowSeconds: () => number
  gameAt: number
  waiting: boolean
  probe: (where: ChainHealthWhere) => Promise<ChainHealthResult | undefined>
  hidden: () => boolean
  onVisibility: (listener: () => void) => () => void
}): () => void {
  const { nowSeconds, gameAt, waiting, probe, hidden, onVisibility } = options
  let stopped = false
  let due = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const secondsUntilGame = () => gameAt - nowSeconds()
  const schedule = (delayMs: number) => {
    if (stopped) return
    timer = setTimeout(fire, delayMs)
  }
  const scheduleNext = (result: ChainHealthResult | undefined) => {
    const remaining = secondsUntilGame()
    if (remaining <= PRE_GAME_HEALTH_STOP_SECONDS) return
    const timedOut = result?.outcome === "unknown" && result.errorClass === "timeout"
    schedule(
      timedOut || remaining <= REGISTERED_HEALTH_FAST_SECONDS
        ? REGISTERED_HEALTH_FAST_MS
        : REGISTERED_HEALTH_SLOW_MS,
    )
  }
  function fire() {
    timer = undefined
    if (stopped) return
    const remaining = secondsUntilGame()
    if (remaining <= PRE_GAME_HEALTH_STOP_SECONDS) return
    if (remaining > REGISTERED_HEALTH_START_SECONDS) {
      schedule((remaining - REGISTERED_HEALTH_START_SECONDS) * 1000)
      return
    }
    if (hidden()) {
      due = true
      return
    }
    due = false
    void probe(waiting ? "waiting" : "registered")
      .catch(() => undefined)
      .then((result) => {
        if (!stopped) scheduleNext(result)
      })
  }
  const stopVisibility = onVisibility(() => {
    if (!stopped && due && !hidden()) fire()
  })
  fire()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    stopVisibility()
  }
}

/** Own the pre-game probe/card lifecycle. The page only supplies its current
 * source and waiting-room timing; all probe de-duplication, durable follow-up
 * attribution and recovery checks stay in one place. */
export function useChainHealthCard(options: {
  source: ChainHealthSource | null | undefined
  waiting: boolean
  gameAt?: number
  /** where the page is: the card shows (and re-checks) before the game only */
  phase: "pre-game" | "round" | "post-game"
  /** the player holds a seat in the upcoming game;
   *  undefined until the status has loaded */
  registered: boolean | undefined
  /** /game owns its handover probe; home uses the default opening probe. */
  probeOnOpen?: boolean
  /** TURN evidence belongs to the current screen phase. */
  turnWhere?: ChainHealthWhere
}): {
  card: ChainHealthCardState
  /** app opens in a row that found the chain lost (lib/chain-lost-streak) */
  consecutiveLost: number
  /** run the probe now (de-duplicated with one already running); undefined when there is nothing to probe */
  probe: (where: ChainHealthWhere) => Promise<ChainHealthResult | undefined>
  /** A completed signed transaction is the same host-answering proof as a
   * successful probe, without asking the host to build another transaction. */
  noteHealthy: (where: ChainHealthWhere) => Promise<void>
} {
  const { source, waiting, gameAt, phase, registered, probeOnOpen = true, turnWhere } = options
  const [card, setCard] = useState<ChainHealthCardState>({ lost: false })
  const [consecutiveLost, setConsecutiveLost] = useState(0)
  const registeredRef = useRef(registered)
  useEffect(() => {
    registeredRef.current = registered
  }, [registered])
  const cardRef = useRef(card)
  const runningRef = useRef<Promise<ChainHealthResult> | undefined>(undefined)
  const turnTimeoutPendingProbeRef = useRef(false)
  const lastHealthyAtRef = useRef<number | null>(null)
  const resultQueueRef = useRef<Promise<void>>(Promise.resolve())
  const roundLostReappearanceRef = useRef<RoundLostReappearanceState>({
    afterRecovery: false,
    consecutiveLost: 0,
  })
  const mountedRef = useRef(false)
  /** monotonic time when the card went up, for the time it held the player */
  const shownAtRef = useRef<number | null>(null)
  const generationRef = useRef(0)

  // A probe belongs to the exact source/page generation that started it.
  // Route handover and source replacement must not persist a card that the
  // player could never have seen, nor let an old source own the new UI.
  useEffect(() => {
    mountedRef.current = true
    generationRef.current += 1
    runningRef.current = undefined
    turnTimeoutPendingProbeRef.current = false
    lastHealthyAtRef.current = null
    resultQueueRef.current = Promise.resolve()
    roundLostReappearanceRef.current = { afterRecovery: false, consecutiveLost: 0 }
    cardRef.current = { lost: false }
    shownAtRef.current = null
    setCard(cardRef.current)
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      runningRef.current = undefined
      turnTimeoutPendingProbeRef.current = false
    }
  }, [source])

  const accept = useCallback(async (where: ChainHealthWhere, incoming: ChainHealthResult) => {
    let result = incoming
    if (!acceptChainHealthResult(result)) return
    const generation = generationRef.current
    const handled = resultQueueRef.current.then(async () => {
      if (!mountedRef.current || generationRef.current !== generation) return
      if (result.outcome === "healthy") lastHealthyAtRef.current = chainHealthElapsedNowMs()
      const gated = gateRoundLostReappearance(cardRef.current, result, phase, roundLostReappearanceRef.current)
      roundLostReappearanceRef.current = gated.state
      const previous = cardRef.current
      // Explicit probes are counted by the doorway. A TURN timeout or proof
      // result bypasses that doorway, so count it here exactly once; the
      // streak module is session-idempotent if both paths meet.
      if (result.outcome === "host-chain-lost" && result.consecutiveLost === undefined) {
        const count = await noteChainLostStreak(result).catch(() => undefined)
        if (count !== undefined) result = { ...result, consecutiveLost: count }
      }
      if (result.consecutiveLost !== undefined) setConsecutiveLost(result.consecutiveLost)
      // a return from the background while the streak was read discards
      // this result before it can leave a restart marker or count
      if (!mountedRef.current || generationRef.current !== generation) return
      const { next, advice } = chainHealthCardStep({
        previous,
        result,
        phase,
        acceptForCard: gated.acceptForCard,
        // the in-round bar keeps its own minute, return or not
        returnedAtMs: phase === "round" ? null : lastBackgroundReturnAtMs(),
        nowMs: chainHealthElapsedNowMs(),
      })
      await applyRestartProbe(where, result, advice)
      if (!mountedRef.current || generationRef.current !== generation) return
      roundLostReappearanceRef.current = noteRoundLostClear(
        previous,
        next,
        phase,
        roundLostReappearanceRef.current,
      )
      if (advice) shownAtRef.current = chainHealthElapsedNowMs()
      else if (cardRef.current.lost && !next.lost) {
        // Immediate advice is timed here. Delayed escalation has no local
        // stamp, so chain-restart uses recordRestartCardShown's timestamp.
        recordRestartCardCleared(
          where,
          shownAtRef.current === null ? undefined : chainHealthElapsedNowMs() - shownAtRef.current,
        )
        shownAtRef.current = null
      }
      cardRef.current = next
      setCard(next)
      if (advice === true) devLog("chain", "restart card shown", { where }, "warn")
      else if (advice === "bar") devLog("chain", "restart bar shown", { where }, "warn")
      else if (result.outcome === "healthy" && !next.lost)
        devLog("chain", "restart card cleared after a healthy probe", { where })
    })
    resultQueueRef.current = handled.catch(() => {})
    await handled
  }, [phase])

  const probe = useCallback(
    async (where: ChainHealthWhere) => {
      if (!source?.probeChainHealth) return undefined
      const running = runningRef.current
      if (running) return running
      const generation = generationRef.current
      const registeredNow = registeredRef.current
      // Order the attempt when it STARTS, not when the host eventually
      // answers. A transaction build can outlive a recovered statement-store
      // or TURN proof; its stale failure must not put the bar back after that
      // newer evidence cleared it.
      const order = nextChainHealthOrder()
      const pending = source.probeChainHealth(where, registeredNow === undefined ? {} : { registered: registeredNow })
      runningRef.current = pending
      try {
        let result: ChainHealthResult = { ...(await pending), order }
        if (!mountedRef.current || generationRef.current !== generation) return result
        if (turnTimeoutPendingProbeRef.current) {
          turnTimeoutPendingProbeRef.current = false
          result = confirmTurnProofTimeoutWithProbe(result)
        }
        await accept(where, result)
        return result
      } catch (error) {
        turnTimeoutPendingProbeRef.current = false
        throw error
      } finally {
        if (runningRef.current === pending) runningRef.current = undefined
      }
    },
    [source, accept],
  )

  const noteHealthy = useCallback(
    async (where: ChainHealthWhere) => {
      await accept(where, { outcome: "healthy", latencyMs: 0, order: nextChainHealthOrder() })
    },
    [accept],
  )

  useEffect(() => {
    const where: ChainHealthWhere = turnWhere ?? (waiting ? "waiting" : "open")
    const handle = (outcome: TurnOutcome) => {
      if (isTurnCredentialTimeout(outcome)) {
        // Consume replay even when recent health suppresses the timeout.
        consumeTurnChainHealthResult(outcome, turnOutcomeChainHealthOrder(outcome))
        if (turnProofTimeoutNeedsProbeNow(outcome, lastHealthyAtRef.current)) {
          if (!source?.probeChainHealth) return
          turnTimeoutPendingProbeRef.current = true
          void probe(where)
        }
        return
      }
      const result = consumeTurnChainHealthResult(outcome, turnOutcomeChainHealthOrder(outcome))
      if (result) void accept(where, result)
    }
    const stop = observeTurnChainHealthOutcome(handle)
    const latest = lastTurnChainHealthOutcome(TURN_OUTCOME_REPLAY_MAX_MS)
    if (latest) handle(latest)
    return stop
  }, [waiting, turnWhere, source, accept, probe])

  useEffect(() => {
    if (probeOnOpen) void probe("open")
  }, [probeOnOpen, probe])

  // Back from the background, the host reconnects its chain by itself, so
  // nothing gathered before or during the spell may count toward the card's
  // restart advice: the card and the TURN-timeout confirmation start over,
  // and a probe or result still in flight from before is dropped (a new
  // generation). The open streak stays: it counts app opens, which a return
  // is not, and it already counts at most one loss per open. The in-round
  // bar is left alone: it blocks nothing and already waits its own minute.
  //
  // Wiping the evidence must never hide a dead host, and some surfaces run
  // no periodic probe, so the hook probes at once and keeps probing until a
  // result is a verdict: the host answers, declines, or the card is up again
  // (its own re-check takes over from there).
  const returnRecheckRef = useRef<(() => void) | undefined>(undefined)
  useEffect(() => {
    if (phase === "round") return
    const stopReturns = watchBackgroundReturns(() => {
      generationRef.current += 1
      runningRef.current = undefined
      resultQueueRef.current = Promise.resolve()
      turnTimeoutPendingProbeRef.current = false
      forgetRestartCardTiming()
      const next = chainHealthCardAfterReturn(cardRef.current)
      if (next !== cardRef.current) {
        shownAtRef.current = null
        cardRef.current = next
        setCard(next)
        devLog("chain", "restart card reset on return from the background")
      }
      returnRecheckRef.current?.()
      returnRecheckRef.current = armReturnRecheck({
        probe: () => probe("recheck"),
        done: (result) =>
          result === undefined || result.outcome === "healthy" || result.outcome === "declined" || cardRef.current.lost,
        hidden: () => document.hidden,
        onVisibility: (listener) => {
          document.addEventListener("visibilitychange", listener)
          return () => document.removeEventListener("visibilitychange", listener)
        },
      })
    })
    return () => {
      stopReturns()
      returnRecheckRef.current?.()
      returnRecheckRef.current = undefined
    }
  }, [probe, phase])

  useEffect(() => {
    if (!registered || gameAt === undefined || !source?.probeChainHealth) return
    return armPreGameChainHealthProbes({
      nowSeconds: () => source.nowSeconds(),
      gameAt,
      waiting,
      probe,
      hidden: () => document.hidden,
      onVisibility: (listener) => {
        document.addEventListener("visibilitychange", listener)
        return () => document.removeEventListener("visibilitychange", listener)
      },
    })
  }, [registered, waiting, gameAt, source, probe])

  // Keep checking while either the blocking card OR the in-game bar is up,
  // including confirm/report after the final round. That is precisely when
  // ordinary round polling may have stopped, but recovered host evidence must
  // still clear stale advice. Each source probe owns its five-second bound.
  useEffect(() => {
    if (!card.lost) return
    return armChainLostRecheck({
      probe: () => probe("recheck"),
      hidden: () => document.hidden,
      onVisibility: (listener) => {
        document.addEventListener("visibilitychange", listener)
        return () => document.removeEventListener("visibilitychange", listener)
      },
    })
  }, [card.lost, probe])

  return { card, consecutiveLost, probe, noteHealthy }
}
