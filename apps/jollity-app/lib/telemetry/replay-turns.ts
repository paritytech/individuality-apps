// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Passive evidence of committed local screens, never evidence from vote replay. */
import type { GameSnapshot, GameTimingInfo } from "@jollity/game-chain"
import {
  HOST_ENDING,
  HOST_FULL_CYCLE,
  HOST_INTRODUCTION,
  ROUND_GAP,
  roundStart,
} from "@jollity/game-chain/game"
import { SESSION_TICK_MS } from "../game-clock"
import { pageFreezeThresholdMs } from "../page-lifecycle"

export interface ReplayTurnCommit {
  gameIndex: number
  timing: GameTimingInfo
  roomKey: string
  meshRound: number | null
  hostId: string | null
  clockReady: boolean
  sourceClockReady: boolean
  snapshot: GameSnapshot | null
  /** Existing render clock read; not an exact timestamp of the snapshot boundary. */
  sourceNowSeconds: number | null
  commitMonotonicMs: number | null
}

function stateOf(commit: ReplayTurnCommit) {
  const snap = commit.snapshot
  return {
    kind: snap?.kind ?? "unresolved",
    round: snap?.kind === "round" ? snap.round : null,
    globalTurn: snap?.kind === "round" ? snap.round * commit.timing.maxGroupSize + snap.hostPosition : null,
    hostPosition: snap?.kind === "round" ? snap.hostPosition : null,
    hostId: commit.hostId,
    stage: snap?.kind === "round" ? snap.stage : null,
    nextRound: snap?.kind === "between-rounds" ? snap.nextRound : null,
    preconnectRound: snap && "preconnectRound" in snap ? snap.preconnectRound : null,
    roomKey: commit.roomKey,
    meshRound: commit.meshRound,
    clockReady: commit.clockReady,
    sourceClockReady: commit.sourceClockReady,
  }
}

function completedBoundary(commit: ReplayTurnCommit): number | null {
  const snap = commit.snapshot
  if (!snap) return null
  if (snap.kind === "round") return snap.round * commit.timing.maxGroupSize + snap.hostPosition
  if (snap.kind === "between-rounds") return snap.nextRound * commit.timing.maxGroupSize
  if (snap.kind === "reporting" || snap.kind === "finished") return commit.timing.rounds * commit.timing.maxGroupSize
  return 0
}

function progress(commit: ReplayTurnCommit): number | null {
  const boundary = completedBoundary(commit)
  if (boundary === null) return null
  // Gaps and reporting sit before the next turn's introduction at this boundary.
  const snap = commit.snapshot
  return boundary * 4 + (snap?.kind === "round"
    ? { introduction: 1, gameplay: 2, ending: 3 }[snap.stage]
    : 0)
}

function planned(commit: ReplayTurnCommit) {
  const snap = commit.snapshot
  if (!snap || snap.kind !== "round") return null
  const roundStartSeconds = commit.timing.gameDate + roundStart(commit.timing, snap.round)
  const turnStartSeconds = roundStartSeconds + snap.hostPosition * snap.turnDuration
  const turnEndSeconds = turnStartSeconds + snap.turnDuration
  const stageStartSeconds = snap.stage === "introduction" ? turnStartSeconds
    : snap.stage === "gameplay" ? turnStartSeconds + HOST_INTRODUCTION
      : turnEndSeconds - HOST_ENDING
  return {
    clock: "game-unix-seconds",
    provenance: "game-timing-and-client-state-machine",
    roundStartSeconds,
    roundEndSeconds: roundStartSeconds + commit.timing.maxGroupSize * HOST_FULL_CYCLE,
    turnStartSeconds,
    turnEndSeconds,
    stageStartSeconds,
    stageEndSeconds: stageStartSeconds + snap.stageDuration,
  }
}

/** Compact ranges contain ONLY turns absent from this observer's committed history. */
function unobservedRanges(from: number, to: number, observed: Set<number>) {
  const ranges: { from: number; toExclusive: number }[] = []
  let cursor = from
  for (const turn of [...observed].filter((turn) => turn >= from && turn < to).sort((a, b) => a - b)) {
    if (cursor < turn) ranges.push({ from: cursor, toExclusive: turn })
    cursor = turn + 1
  }
  if (cursor < to) ranges.push({ from: cursor, toExclusive: to })
  return ranges
}

/** Call observe ONLY from a committed React effect. The emitter cannot affect play. */
export function createReplayTurnObserver(emit: (kind: string, payload: Record<string, unknown>) => void) {
  let previous: ReplayTurnCommit | null = null
  let previousKey: string | null = null
  let stopped = false
  let resumePending = false
  const observedTurns = new Set<number>()
  const safeEmit = (kind: string, payload: Record<string, unknown>) => {
    try { emit(kind, payload) } catch { /* telemetry must never affect the session */ }
  }
  return {
    resume() { if (!stopped) resumePending = true },
    observe(input: ReplayTurnCommit) {
      if (stopped) return
      // Retain values, not live references subsequently changed by a caller.
      const current = { ...input, timing: { ...input.timing }, snapshot: input.snapshot ? { ...input.snapshot } : null }
      const newGame = previous !== null && (previous.gameIndex !== current.gameIndex || previous.timing.gameDate !== current.timing.gameDate)
      if (newGame) {
        previous = null
        previousKey = null
        observedTurns.clear()
        resumePending = false
      }
      const state = stateOf(current)
      const key = JSON.stringify([state, current.timing])
      const monotonicGapMs = previous?.commitMonotonicMs != null && current.commitMonotonicMs !== null
        ? current.commitMonotonicMs - previous.commitMonotonicMs : null
      const gapObserved = monotonicGapMs !== null && monotonicGapMs > pageFreezeThresholdMs(SESSION_TICK_MS)
      const fromBoundary = previous ? completedBoundary(previous) : null
      const toBoundary = completedBoundary(current)
      const ranges = fromBoundary !== null && toBoundary !== null && toBoundary > fromBoundary
        ? unobservedRanges(fromBoundary, toBoundary, observedTurns) : []
      const skippedTurnCount = ranges.reduce((count, range) => count + range.toExclusive - range.from, 0)
      const oldProgress = previous ? progress(previous) : null
      const newProgress = progress(current)
      const backward = oldProgress !== null && newProgress !== null && newProgress < oldProgress
      const stageIndex = { introduction: 0, gameplay: 1, ending: 2 }
      const stageSkipped = previous?.snapshot?.kind === "round" && current.snapshot?.kind === "round" &&
        fromBoundary !== null && toBoundary !== null &&
        (toBoundary - fromBoundary) * 3 + stageIndex[current.snapshot.stage] - stageIndex[previous.snapshot.stage] > 1
      const clockResumed = previous !== null && !previous.sourceClockReady && current.sourceClockReady
      const resumed = resumePending || clockResumed
      if (key !== previousKey || resumed || gapObserved) {
        safeEmit("game.snapshot", {
          gameIndex: current.gameIndex,
          gameDate: current.timing.gameDate,
          observation: previous === null ? "initial" : backward ? "backward" : resumed ? "resume"
            : skippedTurnCount > 0 || stageSkipped || gapObserved ? "catch-up" : "transition",
          observedOnly: true,
          previous: previous ? { ...stateOf(previous), roomKey: previous.roomKey !== current.roomKey ? previous.roomKey : undefined } : null,
          current: state,
          snapshot: current.snapshot,
          sourceNowSeconds: current.sourceNowSeconds,
          sourceNowSample: "existing-render-clock-read",
          monotonicGapMs,
          resumed,
          gapObserved,
          skippedTurnCount,
          stageSequenceSkipped: Boolean(stageSkipped),
          unobservedCompletedTurnRanges: ranges,
          intermediateStagesObserved: false,
          planned: planned(current),
          configuration: {
            ...current.timing,
            timingProvenance: "live-game-view",
            turnIndexBase: 0,
            turnIndexStride: current.timing.maxGroupSize,
            hostFullCycleSeconds: HOST_FULL_CYCLE,
            hostIntroductionSeconds: HOST_INTRODUCTION,
            hostEndingSeconds: HOST_ENDING,
            roundGapSeconds: ROUND_GAP,
            constantsProvenance: "@jollity/game-chain/game",
          },
        })
      }
      if (state.globalTurn !== null) observedTurns.add(state.globalTurn)
      previous = current
      previousKey = key
      resumePending = false
    },
    stop() {
      if (stopped) return
      stopped = true
      if (previous) safeEmit("game.snapshot.stop", {
        gameIndex: previous.gameIndex,
        gameDate: previous.timing.gameDate,
        roomKey: previous.roomKey,
        lastObserved: stateOf(previous),
        reason: "observer-cleanup",
        turnEndingObserved: false,
      })
      previous = null
      observedTurns.clear()
    },
  }
}
