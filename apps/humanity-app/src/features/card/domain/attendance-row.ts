// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The recent games a member-family card can show, read straight off the
 * runtime's rolling attendance byte. Nothing here is dated: the chain keeps
 * no past game dates, so a mark knows only how many games ago it was and,
 * when the streak anchors it, which game index it stands for.
 *
 * The runtime starts every record at `0xFF`, "assumed attended for every
 * prior game", so a set bit is not always a game played. The row tells the
 * two apart where the record allows (`recordedGames`) and draws the rest as
 * before the person started playing, counting only real games.
 */
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

/** The byte holds eight games; the runtime never records more. */
const ATTENDANCE_HISTORY_BITS = 8;

export interface AttendanceMark {
  attended: boolean;
  /** Before the person's record began: a bit the runtime filled in, not a
   *  game they played or missed. */
  before: boolean;
  /** `Score.Participants` game index, when the last attended game anchors it. */
  gameIndex: number | null;
  /** 0 is the most recent game. */
  gamesAgo: number;
  /** False when the mark lies outside the policy window and no longer counts. */
  counts: boolean;
}

export interface AttendanceRow {
  /** Oldest first, newest last — the reading order of a row of marks. */
  marks: AttendanceMark[];
  /** How many of the marks are real games, the most recent ones. */
  recorded: number;
  /** Consecutive attended games ending at the most recent one. */
  streak: number;
}

/** Index of the lowest set bit, or null for 0. */
function lowestSetBit(byte: number): number | null {
  if (byte === 0) return null;
  let bit = 0;
  while (((byte >> bit) & 1) === 0) bit += 1;
  return bit;
}

/**
 * How many of the byte's bits, from the most recent, are games the person
 * was really there for (or missed). Two cases can be proven:
 *
 * - never attended (`lastAttendedGame` null): the misses since the record
 *   began are the zeros at the bottom, and every set bit above is filled in;
 * - on a streak of `n` under eight with bit `n` set: a real game at `n`
 *   would have been attended and made the streak `n + 1`, so bit `n` and
 *   everything older is filled in.
 *
 * Otherwise all eight count. A candidate's cash-out resets the streak and
 * could make the second rule hide real games; cash-out is closed once a
 * person reaches membership, and this row is only for members.
 */
export function recordedGames(
  history: number,
  streak: number,
  lastAttendedGame: number | null,
): number {
  if (lastAttendedGame == null) return lowestSetBit(history) ?? ATTENDANCE_HISTORY_BITS;
  if (streak < ATTENDANCE_HISTORY_BITS && ((history >> streak) & 1) === 1) return streak;
  return ATTENDANCE_HISTORY_BITS;
}

/**
 * Null for states with no attendance to show: not a member, no participant
 * record at all (a person recognised another way), or no game played or
 * missed yet. A `window` of 0 means the runtime keeps no grace window at
 * all; the byte still holds games, so the row shows them all as counting.
 */
export function attendanceRow(state: HumanityCardState): AttendanceRow | null {
  if (
    state.kind !== "member" &&
    state.kind !== "membership-ready" &&
    state.kind !== "caution"
  ) {
    return null;
  }
  if (state.attendanceHistory == null) return null;
  const history = state.attendanceHistory & 0xff;
  const streak = state.activeWeeks;
  const recorded = recordedGames(history, streak, state.lastAttendedGame);
  if (recorded === 0) return null;
  const window =
    state.window > 0
      ? Math.min(state.window, ATTENDANCE_HISTORY_BITS)
      : ATTENDANCE_HISTORY_BITS;
  const anchor = anchorGame(history, state.lastAttendedGame);
  const marks: AttendanceMark[] = [];
  for (let gamesAgo = ATTENDANCE_HISTORY_BITS - 1; gamesAgo >= 0; gamesAgo -= 1) {
    const before = gamesAgo >= recorded;
    marks.push({
      attended: !before && ((history >> gamesAgo) & 1) === 1,
      before,
      gameIndex: before || anchor == null ? null : anchor - gamesAgo,
      gamesAgo,
      counts: !before && gamesAgo < window,
    });
  }
  return { marks, recorded, streak };
}

/**
 * The game index of bit 0, when it can be known: the lowest set bit is the
 * last attended game, so bit 0 is that many games later.
 */
function anchorGame(history: number, lastAttendedGame: number | null): number | null {
  if (lastAttendedGame == null) return null;
  const lowest = lowestSetBit(history);
  return lowest == null ? null : lastAttendedGame + lowest;
}
