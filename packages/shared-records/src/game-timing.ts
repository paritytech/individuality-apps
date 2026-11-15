// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * When the play of a game ends, which the chain does not store: the Reporting
 * phase runs on for minutes after the last turn, and a surface that only reads
 * the phase would keep offering the game while the chat already says the
 * results are pending.
 *
 * Both of Jollity's surfaces and Humanity derive it here, from the same two
 * constants of the game's clock (HOST_FULL_CYCLE and ROUND_GAP of
 * packages/jollity-game-chain/src/game/constants.ts, which gameDuration in its
 * stateMachine.ts adds up the same way), so a player sees one verdict
 * wherever they look.
 */

/** One host turn: introduction, the active minimum and the ending. */
export const TURN_SECONDS = 12

/** The gap between two rounds; the chain knows nothing of it. */
export const ROUND_GAP_SECONDS = 7

/** What the formula needs of a game: its play time, its rounds and its group cap. */
export interface GameClock {
  gamePlayTime: number
  rounds: number
  maxGroupSize: number
}

/** Unix seconds of the end of the last turn of the last round of `game`. */
export function playEndsSeconds(game: GameClock): number {
  return game.gamePlayTime + game.rounds * game.maxGroupSize * TURN_SECONDS + Math.max(0, game.rounds - 1) * ROUND_GAP_SECONDS
}

/** The schedule's projected boundaries for one upcoming game. */
export interface ScheduledWindow {
  registrationStarts: number
  reportingEnds: number
}

/**
 * When each upcoming game takes sign-ups. The chain creates a game, in
 * Registration, as soon as the game before it ends, so the opening is the
 * previous game's end and not the SDK's kickoff-minus-phase projection.
 * `previousGameEnds` is the end of the game before the first entry: 0 when
 * none is running (the next one is about to be created), null when unknown
 * (a cancelled game), which keeps the schedule's own projection.
 */
export function registrationOpensSeconds(upcoming: readonly ScheduledWindow[], previousGameEnds: number | null): number[] {
  return upcoming.map((game, i) => {
    const previous = i === 0 ? previousGameEnds : upcoming[i - 1]!.reportingEnds
    return previous ?? game.registrationStarts
  })
}
