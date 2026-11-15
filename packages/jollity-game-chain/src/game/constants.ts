// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Round/host timing constants. All values in seconds.
 *
 * The STAGE LENGTHS of one turn (2 intro + 8 play + 2 ending) match the
 * native Polkadot apps' game timings exactly.
 *
 * The TURN COUNT does not. Mobile plays one turn per player of the own group
 * and stretches each turn to fill the round. The web plays one turn per SEAT
 * of the group cap, so a round is always `HOST_FULL_CYCLE * max_group_size`
 * and a turn is always `HOST_FULL_CYCLE`. A web player and a native player in
 * one group would disagree on who hosts when.
 */
export const HOST_INTRODUCTION = 2
export const HOST_ACTIVE_MINIMUM = 8
export const HOST_ENDING = 2
export const HOST_FULL_CYCLE = HOST_INTRODUCTION + HOST_ACTIVE_MINIMUM + HOST_ENDING
/** Open WebRTC connections to the (next) round's group this early */
export const PRE_CONNECTION_TIME = 10
/**
 * How long before game start the round state machine (stateMachine.ts) reports
 * the waiting room. The app's own screens decide when the waiting room and the
 * camera open; this is not a wire value, and peers still connect at
 * PRE_CONNECTION_TIME regardless.
 */
export const WAITING_ROOM_AVAILABLE_BEFORE = 75
/**
 * The seconds between two rounds. The screen counts the next group in, and the
 * mesh connects to that group across the whole gap. The last round has no gap.
 */
export const ROUND_GAP = 7
/** One full turn of the final-minute dial, in seconds. It reaches 00 at
 *  `game_date - DIAL_ENDS_BEFORE`. */
export const DIAL_WINDOW = 60
/** The tiles move in from the sides over the last seconds before game_date */
export const TILES_ENTER_SECONDS = 2
/** the dial reaches 00 this long before game_date: it shows 00 for one second, then the tiles start to move in */
export const DIAL_ENDS_BEFORE = 1 + TILES_ENTER_SECONDS
/**
 * THE CONNECTION STAGE: the waiting room hands the player to /game this long
 * before game_date, and the mesh pre-connects to round 0's group across it.
 * It is one dial turn, plus the 00 second and the tiles move-in, plus the 1 s
 * a whole-second handover can lose. `lib/joined.ts` `handoverAt()` is its only caller.
 */
export const CONNECTION_STAGE_DURATION = DIAL_WINDOW + DIAL_ENDS_BEFORE + 1
