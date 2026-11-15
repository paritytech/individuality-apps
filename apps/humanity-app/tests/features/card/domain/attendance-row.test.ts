// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The attendance row reads the runtime's byte oldest-first, anchors game
 *  indices off the last attended game when it can, tells the runtime's
 *  `0xFF` fill apart from games played where the record allows, carries a
 *  cautioned member's real streak, and only exists for member-family states
 *  with a record and at least one game. */
import { describe, expect, it } from "vitest";

import { attendanceRow, recordedGames } from "@features/card/domain/attendance-row.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

const member = (overrides: Partial<Extract<HumanityCardState, { kind: "member" }>> = {}): HumanityCardState => ({
  kind: "member",
  activeWeeks: 3,
  lastAttendedGame: 42,
  attendanceHistory: 0b1111_0111,
  window: 8,
  ...overrides,
});

const bits = (state: HumanityCardState) =>
  attendanceRow(state)!.marks.map((mark) => (mark.before ? "." : mark.attended ? "1" : "0")).join("");

describe("attendanceRow", () => {
  it("is absent for states with no attendance byte", () => {
    for (const state of [
      { kind: "not-enrolled" },
      { kind: "devicehood" },
      { kind: "candidate", score: 2, personhoodThreshold: 5, gamesRemaining: 2 },
      { kind: "suspended", reason: "attendance" },
    ] as HumanityCardState[]) {
      expect(attendanceRow(state), state.kind).toBeNull();
    }
  });

  it("is absent for a member with no participant record", () => {
    expect(attendanceRow(member({ attendanceHistory: null, lastAttendedGame: null, activeWeeks: 0 }))).toBeNull();
  });

  it("lays the eight games out oldest first with bit 0 last", () => {
    const row = attendanceRow(member())!;
    expect(bits(member())).toBe("11110111");
    expect(row.marks.map((mark) => mark.gamesAgo)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(row.streak).toBe(3);
    expect(row.recorded).toBe(8);
  });

  it("anchors game indices off the last attended game", () => {
    // Bit 0 is attended, so it is game 42 and the oldest bit is game 35.
    expect(attendanceRow(member())!.marks.map((mark) => mark.gameIndex)).toEqual([
      35, 36, 37, 38, 39, 40, 41, 42,
    ]);
    // Bit 0 is a miss: the last attended game is bit 1, so bit 0 is game 43.
    const missedLast = attendanceRow(member({ activeWeeks: 0, attendanceHistory: 0b1111_1110 }))!;
    expect(missedLast.marks.at(-1)).toMatchObject({ attended: false, gameIndex: 43 });
    expect(missedLast.marks.at(-2)).toMatchObject({ attended: true, gameIndex: 42 });
  });

  it("marks games outside the policy window as not counting", () => {
    const row = attendanceRow(member({ window: 4, activeWeeks: 2, attendanceHistory: 0b0000_1011 }))!;
    expect(row.marks.map((mark) => mark.counts)).toEqual([false, false, false, false, true, true, true, true]);
  });

  it("treats a zero window as every game counting", () => {
    const row = attendanceRow(member({ window: 0, activeWeeks: 0, attendanceHistory: 0b1010_1010 }))!;
    expect(row.marks.every((mark) => mark.counts)).toBe(true);
  });

  it("carries a cautioned member's streak, which Caution does not end", () => {
    // Missed three games back, attended the last two: still under caution.
    const row = attendanceRow({
      kind: "caution",
      activeWeeks: 2,
      misses: 1,
      allowedMisses: 1,
      window: 4,
      lastAttendedGame: 42,
      attendanceHistory: 0b1111_1011,
    })!;
    expect(row.streak).toBe(2);
    expect(row.marks.at(-1)).toMatchObject({ attended: true, gameIndex: 42 });
  });
});

describe("the runtime's 0xFF fill", () => {
  it("draws the slots before a new member's first game apart, and never as played", () => {
    // Joined three games ago and played all three: the byte is still 0xFF.
    expect(bits(member({ activeWeeks: 3, attendanceHistory: 0xff }))).toBe(".....111");
    expect(attendanceRow(member({ activeWeeks: 3, attendanceHistory: 0xff }))!.recorded).toBe(3);
  });

  it("counts every game for a streak of eight or more", () => {
    expect(bits(member({ activeWeeks: 9, attendanceHistory: 0xff }))).toBe("11111111");
  });

  it("reads someone who has never played as misses since joining", () => {
    // Recognised another way, then missed two games.
    expect(bits(member({ activeWeeks: 0, lastAttendedGame: null, attendanceHistory: 0b1111_1100 }))).toBe(
      "......00",
    );
  });

  it("shows no row before any game has been played or missed", () => {
    expect(attendanceRow(member({ activeWeeks: 0, lastAttendedGame: null, attendanceHistory: 0xff }))).toBeNull();
  });

  it("keeps a real miss inside the record", () => {
    // Streak of two, a miss before it: bit 2 is 0, so all eight are real.
    expect(recordedGames(0b1111_1011, 2, 42)).toBe(8);
  });
});
