// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// Re-timing a scheduled game (backlog 16, 30 September 2026): Humanity's own shortcut where the environment cannot move
// time. A game follows the chain's clock, and an Engine fork's clock is the wall clock, so a game saved 20 minutes
// ahead (the `dim2-registered` fixture) makes a restored scenario wait for its play date. The runtime has no call that
// moves a scheduled game (`schedule_games`, `cancel_game` and `remove_scheduled_game` create or drop one; `game_date` is
// fixed once scheduled), so the games authority, verified as People's `Sudo.Key`, rewrites the game's own dates and its
// prize draws' dates by the same amount through root `System.set_storage`. This changes the game's schedule, never the
// chain's time: every other block, timestamp and pallet is untouched. The rules here are pure; the repository reads and
// writes.

/** The game's dates (unix seconds) as `Game.Game` holds them; the other fields are kept as they are. */
export interface GameDates {
  readonly index: number;
  readonly registration_ends: number;
  readonly shuffle_deadline: number;
  readonly game_date: number;
  readonly report_ends: number;
  readonly state: { readonly type: string };
}

/** The phase durations the shuffle and the margin before play need (`Game.StoredPhaseDurations`, seconds). */
export interface ShufflePhases {
  readonly shuffle: number;
  readonly post_shuffle_margin: number;
}

/** Seconds after the re-time that registration stays open at least, so the players can reopen their apps. */
export const RETIME_MARGIN_S = 60;

/** The earliest a game can be moved to play, in seconds from now: the shuffle and the margin still fit, plus RETIME_MARGIN_S. */
export function earliestPlay(phases: ShufflePhases): number {
  return phases.shuffle + phases.post_shuffle_margin + RETIME_MARGIN_S;
}

/**
 * The game moved to play `playsInSeconds` after `now` (chain seconds): every date shifted earlier by the same amount,
 * so the pallet's own phase relations hold. Refused with the reason: another game, a game no longer registering, a
 * lead the shuffle does not fit in, or a date that would not move earlier.
 */
export function retimedGame<G extends GameDates>(game: G, gameIndex: number, now: number, playsInSeconds: number, phases: ShufflePhases): { game: G; shiftSeconds: number } {
  if (game.index !== gameIndex) throw new Error(`The chain's game is #${game.index}, not #${gameIndex}; nothing re-timed`);
  if (game.state.type !== "Registration")
    throw new Error(`DIM2 game #${game.index} is in ${game.state.type}; only a game still registering can be re-timed (its shuffle has not started)`);
  const earliest = earliestPlay(phases);
  if (!Number.isInteger(playsInSeconds) || playsInSeconds < earliest)
    throw new Error(`A game can be moved to play ${earliest} s from now at the earliest (shuffle ${phases.shuffle} s, margin ${phases.post_shuffle_margin} s, ${RETIME_MARGIN_S} s to reopen the apps), not ${playsInSeconds} s`);
  const date = now + playsInSeconds;
  const shiftSeconds = game.game_date - date;
  if (shiftSeconds <= 0)
    throw new Error(`DIM2 game #${game.index} already plays ${game.game_date - now} s from now, not later than ${playsInSeconds} s; re-timing only moves a game earlier`);
  return {
    game: {
      ...game,
      registration_ends: game.registration_ends - shiftSeconds,
      shuffle_deadline: game.shuffle_deadline - shiftSeconds,
      game_date: date,
      report_ends: game.report_ends - shiftSeconds,
    },
    shiftSeconds,
  };
}

/** A prize draw's dates as `Airdrop.Events` holds them (u64; unit read from the values, see drawUnit). */
export interface DrawDates {
  readonly registration_starts: bigint;
  readonly draw_time: bigint;
  readonly end_time: bigint;
}

/**
 * How many draw time units a second is: 1 when the draw's dates are unix seconds like the game's, 1000 when they are
 * milliseconds. Read from the draw time against the game's play date (a draw runs shortly after its game); anything
 * else is refused rather than guessed.
 */
export function drawUnit(draw: DrawDates, gameDate: number): 1n | 1000n {
  const near = (value: bigint, target: bigint) => (value > target ? value - target : target - value) <= 86_400n * (target > 10n ** 11n ? 1000n : 1n);
  if (near(draw.draw_time, BigInt(gameDate))) return 1n;
  if (near(draw.draw_time, BigInt(gameDate) * 1000n)) return 1000n;
  throw new Error(`A prize draw at ${draw.draw_time} is not within a day of its game's play date ${gameDate} (seconds or milliseconds); nothing re-timed`);
}

/** The draw's dates shifted earlier by `shiftSeconds`, in its own unit. */
export function shiftedDraw<D extends DrawDates>(draw: D, shiftSeconds: number, unit: 1n | 1000n): D {
  const shift = BigInt(shiftSeconds) * unit;
  return { ...draw, registration_starts: draw.registration_starts - shift, draw_time: draw.draw_time - shift, end_time: draw.end_time - shift };
}

/** An 8-byte `ActionSchedule` time key as a number, in the byte order its value shows. */
export function scheduleTime(key: string, order: "be" | "le"): bigint {
  const hex = key.replace(/^0x/, "");
  if (!/^[\da-f]{16}$/i.test(hex)) throw new Error(`An ActionSchedule time key must be 8 bytes, not ${key}`);
  const bytes = hex.match(/../g)!;
  return BigInt(`0x${(order === "be" ? bytes : [...bytes].reverse()).join("")}`);
}

/** `value` as an 8-byte `ActionSchedule` time key in `order`. */
export function scheduleKey(value: bigint, order: "be" | "le"): string {
  if (value < 0n || value >= 1n << 64n) throw new Error(`${value} does not fit an 8-byte time key`);
  const bytes = value.toString(16).padStart(16, "0").match(/../g)!;
  return `0x${(order === "be" ? bytes : [...bytes].reverse()).join("")}`;
}

/**
 * The byte order of a draw's schedule key: the one that reads as one of the draw's own dates. Refused when neither
 * does (the schedule would not be moved with the draw).
 */
export function scheduleOrder(key: string, draw: DrawDates): "be" | "le" {
  const dates = [draw.registration_starts, draw.draw_time, draw.end_time];
  for (const order of ["be", "le"] as const) if (dates.includes(scheduleTime(key, order))) return order;
  throw new Error(`The ActionSchedule key ${key} is none of its draw's dates (${dates.join(", ")}); nothing re-timed`);
}
