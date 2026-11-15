// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { cautionChip, cautionDeadline } from "@features/card/domain/caution-deadline.ts";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";

/** Local wall-clock instants, so the calendar-day rules hold in any zone. */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).getTime() / 1000;

// Thursday 17 September 2026, 10:00.
const now = at(17, 10);
const game: Extract<CurrentGameResult, { kind: "game" }> = {
  kind: "game",
  nextGame: null,
  liteSignUp: null, gameIndex: 7, gameDateSeconds: now + 3600,
  registrationEndsSeconds: now + 600,
  playEndsSeconds: now + 600 + 300, airdropsScheduled: 0, registered: false,
  phase: { label: "registration", nextDeadlineSeconds: now + 600, secondsRemaining: 600 },
};
const on = (gameDateSeconds: number) => ({ ...game, gameDateSeconds });

describe("caution deadlines", () => {
  it("counts the registration cutoff for an unregistered player", () => {
    expect(cautionDeadline(game, false, false, now)).toEqual({
      gameIndex: 7,
      gameDateSeconds: now + 3600,
      daysLeft: 0,
      urgent: true,
      action: "registration-open",
      registrationCloses: "10 min",
    });
  });
  it("keeps a confirmed player's seat without a registration cutoff", () => {
    const deadline = cautionDeadline({ ...game, registered: true }, false, false, now);
    expect(deadline?.action).toBe("confirmed");
    expect(deadline?.registrationCloses).toBeNull();
  });
  it("hands a registered player the live game once registration closes", () => {
    const deadline = cautionDeadline({ ...game, registered: true }, false, false, now + 601);
    expect(deadline?.action).toBe("play-now");
  });
  it("never invents a playable deadline from stale, cancelled or unknown data", () => {
    expect(cautionDeadline(game, true, false, now)).toBeNull();
    expect(cautionDeadline(game, false, true, now)).toBeNull();
    expect(cautionDeadline(game, false, false, now + 601)).toBeNull();
    expect(cautionDeadline({ ...game, registered: null }, false, false, now)).toBeNull();
    expect(cautionDeadline({ ...game, phase: { ...game.phase, label: "cancelling" } }, false, false, now)).toBeNull();
    expect(cautionDeadline({ kind: "no-game", gameIndex: 7, nextGame: null }, false, false, now)).toBeNull();
  });
  it("counts local calendar days, and opens the urgent sheet only on the game's day", () => {
    const open = (gameDateSeconds: number) => ({
      ...on(gameDateSeconds),
      registrationEndsSeconds: gameDateSeconds - 600,
      playEndsSeconds: gameDateSeconds - 600 + 300,
    });
    expect(cautionDeadline(open(at(17, 23, 30)), false, false, now)).toMatchObject({ daysLeft: 0, urgent: true });
    expect(cautionDeadline(open(at(18, 8)), false, false, now)).toMatchObject({ daysLeft: 1, urgent: false });
    expect(cautionDeadline(open(at(19, 19)), false, false, now)).toMatchObject({ daysLeft: 2, urgent: false });
    expect(cautionDeadline(open(at(21, 9)), false, false, now)?.daysLeft).toBe(4);
  });
});

describe("caution chip", () => {
  const deadline = (gameDateSeconds: number) =>
    cautionDeadline({ ...on(gameDateSeconds), registrationEndsSeconds: gameDateSeconds - 600 }, false, false, now);
  const chip = (gameDateSeconds: number) => {
    const d = deadline(gameDateSeconds);
    if (d == null) throw new Error("expected a deadline");
    return cautionChip(d);
  };

  it("says today and tomorrow by the calendar, not by 24-hour blocks", () => {
    expect(chip(at(17, 23, 30))).toBe("today");
    // 33 hours out, but tomorrow.
    expect(chip(at(18, 19))).toBe("tomorrow");
    // 22 hours out, and still tomorrow rather than today.
    expect(chip(at(18, 8))).toBe("tomorrow");
  });
  it("counts whole days further out", () => {
    expect(chip(at(19, 19))).toBe("2 days left");
    expect(chip(at(21, 9))).toBe("4 days left");
  });
});
