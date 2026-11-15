// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pure client-side game state calculator — mirrors the game state machine of
 * the native Polkadot apps.
 *
 * Phase progression within a game is wall-clock driven, anchored to the
 * on-chain `game_date` (Unix seconds). Chain state only gates the coarse
 * phase; callers tick this function every second.
 *
 * A round is the game's GROUP CAP, not its sign-up count: `max_group_size`
 * turns of `HOST_FULL_CYCLE`. Every group of every game therefore keeps the
 * same round length and the same turn length. A group smaller than the cap
 * still plays every turn with a host: the turns wrap around its own seats
 * (`hostSeat`), so a group of 4 plays A B C D A B.
 * Two rounds are `ROUND_GAP` apart. The chain knows nothing of the gap.
 */
import {
  CONNECTION_STAGE_DURATION,
  HOST_ENDING,
  HOST_FULL_CYCLE,
  HOST_INTRODUCTION,
  PRE_CONNECTION_TIME,
  ROUND_GAP,
  WAITING_ROOM_AVAILABLE_BEFORE,
} from "./constants"

/** The subset of on-chain GameInfo the calculator needs (Unix seconds) */
export interface GameTimingInfo {
  gameDate: number
  reportEnds: number
  rounds: number
  /** the game's group cap: seats per group, turns per round */
  maxGroupSize: number
}

export type HostingStage = "introduction" | "gameplay" | "ending"

export type GameSnapshot =
  | { kind: "idle"; secondsToWaitingRoom: number }
  | { kind: "waiting-room"; secondsToStart: number; preconnectRound: 0 | null }
  | {
      kind: "round"
      round: number
      /** the current turn inside the round, 0-based. It is the turn, not the
       *  host's seat: `hostSeat(hostPosition, groupSize)` names the seat. */
      hostPosition: number
      stage: HostingStage
      /** seconds remaining in the current stage */
      stageRemaining: number
      /** total seconds of the current stage */
      stageDuration: number
      /** turns in THIS round — one per seat of the group cap */
      turnsThisRound: number
      /** seconds of one turn */
      turnDuration: number
      /** seconds elapsed inside the current turn */
      turnElapsed: number
      /** set when the next round's peers should be pre-connected already */
      preconnectRound: number | null
    }
  | {
      kind: "between-rounds"
      /** the round that starts when the gap ends */
      nextRound: number
      secondsToNextRound: number
      gapDuration: number
      /** always nextRound: the next group connects across the whole gap */
      preconnectRound: number
    }
  | { kind: "reporting"; secondsToReportEnd: number }
  | { kind: "finished" }

export function roundDuration(info: GameTimingInfo): number {
  return HOST_FULL_CYCLE * Math.max(0, info.maxGroupSize)
}

/** Seconds from game_date to the start of round `r` */
export function roundStart(info: GameTimingInfo, r: number): number {
  return r * (roundDuration(info) + ROUND_GAP)
}

export function gameDuration(info: GameTimingInfo): number {
  return roundDuration(info) * info.rounds + Math.max(0, info.rounds - 1) * ROUND_GAP
}

/** Turns in one round: one per seat of the group, the same in every round. */
export function turnsInRound(info: GameTimingInfo): number {
  return Math.max(0, info.maxGroupSize)
}

/** Turns per round, one entry per round in game order. */
export function turnsPerRound(info: GameTimingInfo): number[] {
  return Array.from({ length: Math.max(0, info.rounds) }, () => turnsInRound(info))
}

/**
 * THE SEAT THAT HOSTS a turn. For a group of `groupSize` players, turn `turn`
 * (0-based inside its round) is hosted by seat `turn mod groupSize`. A round
 * has `maxGroupSize` turns, so a group smaller than the cap wraps around its
 * own seat order: a group of 4 plays A B C D A B, a group of 5 A B C D E A,
 * and groups of 2 and 3 cycle.
 *
 * The order is the chain's, so it needs no new randomness and every phone
 * agrees. Seats follow the shuffle index (recognized people first, each set
 * ordered by `blake2_256(parent_hash, player, round)`), and the held seats
 * are always 0..n-1. For n >= 2 a host is never followed by itself.
 *
 * WHY WRAP-AROUND. The host is not judged in its own turn, so the extra
 * unjudged turns fall on the lowest seats: the recognized players, when the
 * group has any, never the candidates.
 *
 * A group of one (or none) keeps seat `turn`: the player hosts turn 0 and
 * the empty chairs the rest, so one player never hosts every turn. The solo
 * case gets its own screen.
 */
export function hostSeat(turn: number, groupSize: number): number {
  return groupSize >= 2 ? turn % groupSize : turn
}

/** Where the game stands at `nowUnixSeconds`: idle, waiting room, a round's turn and stage, between rounds, reporting or finished, from the on-chain timing. */
export function calculateSnapshot(
  nowUnixSeconds: number,
  info: GameTimingInfo,
): GameSnapshot {
  const elapsed = nowUnixSeconds - info.gameDate

  if (elapsed < -WAITING_ROOM_AVAILABLE_BEFORE) {
    return {
      kind: "idle",
      secondsToWaitingRoom: -elapsed - WAITING_ROOM_AVAILABLE_BEFORE,
    }
  }

  if (elapsed < 0) {
    return {
      kind: "waiting-room",
      secondsToStart: -elapsed,
      // round 0 pre-connects across the whole connection stage, not the
      // between-round PRE_CONNECTION_TIME — see constants.ts
      preconnectRound: elapsed >= -CONNECTION_STAGE_DURATION ? 0 : null,
    }
  }

  const perRound = roundDuration(info)
  if (perRound <= 0 || info.rounds <= 0) return { kind: "finished" }

  if (elapsed >= gameDuration(info)) {
    return nowUnixSeconds < info.reportEnds
      ? { kind: "reporting", secondsToReportEnd: info.reportEnds - nowUnixSeconds }
      : { kind: "finished" }
  }

  const round = Math.floor(elapsed / (perRound + ROUND_GAP))
  const inRound = elapsed - roundStart(info, round)
  if (inRound >= perRound) {
    return {
      kind: "between-rounds",
      nextRound: round + 1,
      secondsToNextRound: roundStart(info, round + 1) - elapsed,
      gapDuration: ROUND_GAP,
      preconnectRound: round + 1,
    }
  }
  const seats = turnsInRound(info)
  const slot = HOST_FULL_CYCLE
  const hostPosition = Math.min(Math.floor(inRound / slot), seats - 1)
  const inSlot = inRound - hostPosition * slot

  // Mobile resolves "ending" before "introduction" — keep that order.
  const stage: HostingStage =
    slot - inSlot <= HOST_ENDING
      ? "ending"
      : inSlot < HOST_INTRODUCTION
        ? "introduction"
        : "gameplay"
  const stageRemaining =
    stage === "introduction"
      ? HOST_INTRODUCTION - inSlot
      : stage === "gameplay"
        ? slot - HOST_ENDING - inSlot
        : slot - inSlot
  const stageDuration =
    stage === "introduction"
      ? HOST_INTRODUCTION
      : stage === "gameplay"
        ? slot - HOST_INTRODUCTION - HOST_ENDING
        : HOST_ENDING

  const nextRound = round + 1
  const preconnectRound =
    nextRound < info.rounds && perRound - inRound <= PRE_CONNECTION_TIME
      ? nextRound
      : null

  return {
    kind: "round",
    round,
    hostPosition,
    stage,
    stageRemaining,
    stageDuration,
    turnsThisRound: seats,
    turnDuration: slot,
    turnElapsed: inSlot,
    preconnectRound,
  }
}
