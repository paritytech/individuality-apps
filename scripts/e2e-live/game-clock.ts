// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { calculateSnapshot, type GameSnapshot, type GameTimingInfo } from "@jollity/game-chain/game"

export interface AppClockReading {
  /** Exact GameSource clock. Scheduling and cross-player comparisons retain
   * its sub-second precision. */
  nowMs: number
  nowSeconds: number
  offset: number
  block: number | null
  /** #1060's live clock-sync state. This is evidence only; scheduling uses nowMs. */
  sync?: { offsetMs: number; method: string; peers: number } | null
  /** Runner wall time immediately after the page returned the reading. */
  readAtMs: number
}

export interface AppGameMoment {
  clock: AppClockReading
  snapshot: GameSnapshot
  /** Whole-game, one-based turn. Null outside a round. */
  turn: number | null
  turnsInGame: number
  /** Harness vocabulary, derived from the package snapshot. */
  stage: "idle" | "waiting-room" | "intro" | "play" | "ending" | "between-rounds" | "confirm" | "finished"
}

const stageOf = (snapshot: GameSnapshot): AppGameMoment["stage"] => {
  if (snapshot.kind === "round") {
    if (snapshot.stage === "introduction") return "intro"
    if (snapshot.stage === "gameplay") return "play"
    return "ending"
  }
  if (snapshot.kind === "reporting") return "confirm"
  return snapshot.kind
}

/** Canonical game position from the app's own clock and the shared game
 * package. No harness timing constants or block-arrival estimates. */
export function appGameMoment(clock: AppClockReading, game: GameTimingInfo): AppGameMoment {
  const snapshot = calculateSnapshot(Math.floor(clock.nowMs / 1000), game)
  return {
    clock,
    snapshot,
    turn: snapshot.kind === "round" ? snapshot.round * Math.max(0, game.maxGroupSize) + snapshot.hostPosition + 1 : null,
    turnsInGame: Math.max(0, game.rounds) * Math.max(0, game.maxGroupSize),
    stage: stageOf(snapshot),
  }
}

export const appClockSecondAt = (clock: AppClockReading, wallMs: number): number =>
  clock.nowMs / 1000 + (wallMs - clock.readAtMs) / 1000

export const appClockWallMsFor = (clock: AppClockReading, targetSeconds: number): number =>
  clock.readAtMs + (targetSeconds * 1000 - clock.nowMs)

/** Timestamp a page evaluation at the centre of its runner-side observation
 * interval, avoiding a systematic post-evaluate bias in cross-runner reads. */
export const observationMidpointMs = (beforeMs: number, afterMs: number): number =>
  beforeMs + (afterMs - beforeMs) / 2

export interface TurnEntryAgreement {
  turn: number
  participants: number
  spreadMs: number
  ok: boolean
}

/** Compare only turns observed by at least two pages. Late joiners and
 * one-bot jobs therefore do not manufacture missing-clock failures. */
export function turnEntryAgreements(entries: ReadonlyMap<number, ReadonlyMap<number, number>>, toleranceMs: number): TurnEntryAgreement[] {
  return [...entries.entries()].flatMap(([turn, byPlayer]) => {
    const times = [...byPlayer.values()]
    if (times.length < 2) return []
    const spreadMs = Math.max(...times) - Math.min(...times)
    return [{ turn, participants: times.length, spreadMs, ok: spreadMs <= toleranceMs }]
  })
}
