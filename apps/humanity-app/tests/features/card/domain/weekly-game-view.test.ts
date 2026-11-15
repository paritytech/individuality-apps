// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { formatCountdown, formatGameDate, formatRegisteredCountdown } from "@features/card/domain/game-schedule.ts";
import { resolveWeeklyGameView } from "@features/card/domain/weekly-game-view.ts";
import type { GamePhaseView } from "@humanity/shared/chain/game-phase.ts";
import { offersRegister, type CurrentGameResult, type NextGame } from "@features/card/domain/current-game.ts";

const now = 1_800_000_000;
const DAY = 86_400;
const HOUR = 3_600;
const MINUTE = 60;

/** A registration-phase game a week out with registration closing in 3h. */
function game(
  overrides: Partial<{
    phase: GamePhaseView;
    registered: boolean | null;
    registrationEndsSeconds: number;
    playEndsSeconds: number;
    gameDateSeconds: number;
    nextGame: NextGame | null;
  }> = {},
): CurrentGameResult {
  return {
    kind: "game",
    nextGame: null,
    gameIndex: 7,
    gameDateSeconds: now + 7 * DAY,
    registrationEndsSeconds: now + 3 * HOUR,
    playEndsSeconds: now + 3 * HOUR + 300,
    airdropsScheduled: 1,
    phase: {
      label: "registration",
      nextDeadlineSeconds: now + 3 * HOUR,
      secondsRemaining: 3 * HOUR,
    },
    registered: false,
    liteSignUp: null,
    ...overrides,
  };
}

const phase = (label: GamePhaseView["label"]): GamePhaseView => ({
  label,
  nextDeadlineSeconds: null,
  secondsRemaining: null,
});

describe("resolveWeeklyGameView", () => {
  it("stays in loading while the game query is pending", () => {
    expect(resolveWeeklyGameView(game(), true, false, now)).toEqual({
      mode: "loading",
    });
  });

  it("reports unavailable for a failed or missing game read", () => {
    expect(resolveWeeklyGameView(game(), false, true, now)).toEqual({
      mode: "unavailable",
    });
    expect(resolveWeeklyGameView(null, false, false, now)).toEqual({
      mode: "unavailable",
    });
    expect(
      resolveWeeklyGameView({ kind: "account-unavailable" }, false, false, now),
    ).toEqual({ mode: "unavailable" });
  });

  it("reports no-game without a scheduled game", () => {
    expect(
      resolveWeeklyGameView({ kind: "no-game", gameIndex: 7, nextGame: null }, false, false, now),
    ).toEqual({ mode: "no-game" });
  });

  it("opens registration from the wall clock, not the query snapshot", () => {
    const view = resolveWeeklyGameView(
      game({ registered: false }),
      false,
      false,
      now,
    );
    expect(view).toMatchObject({
      mode: "registration-open",
      chip: "in 7 days",
      eyebrow: "Next game",
      cta: "Register",
    });
    expect(view).not.toHaveProperty("note");
  });

  it("speaks to a first-time player in the registration-open copy", () => {
    const view = resolveWeeklyGameView(
      game({ registered: false }),
      false,
      false,
      now,
      true,
    );
    expect(view).toMatchObject({
      mode: "registration-open",
      eyebrow: "Your first game",
      cta: "Register",
    });
  });

  it("keeps returning-player copy when it is not a first game", () => {
    for (const view of [
      resolveWeeklyGameView(game({ registered: false }), false, false, now),
      resolveWeeklyGameView(game({ registered: false }), false, false, now, false),
    ]) {
      expect(view).toMatchObject({
        mode: "registration-open",
        eyebrow: "Next game",
        cta: "Register",
      });
    }
  });

  it("leaves confirmed copy alone for a first-time player", () => {
    expect(
      resolveWeeklyGameView(game({ registered: true }), false, false, now, true),
    ).toEqual({ mode: "confirmed", value: expect.any(String), chip: expect.any(String) });
  });

  // the host shows its pill over the last five minutes before the join, for
  // a game the player is registered for; the chip then leaves the seconds to it
  it("says game starting soon for a registered player while the pill of the host counts down", () => {
    const join = now + 4 * MINUTE;
    const soon = game({ registered: true, gameDateSeconds: join + MINUTE, registrationEndsSeconds: join - 30 });
    expect(resolveWeeklyGameView(soon, false, false, now)).toMatchObject({ mode: "confirmed", chip: "game starting soon" });
    expect(resolveWeeklyGameView(soon, false, false, join - 10)).toMatchObject({ mode: "play-now", chip: "game starting soon" });
    expect(resolveWeeklyGameView(soon, false, false, join)).toMatchObject({ mode: "play-now", chip: "under way" });
  });

  it("keeps the countdown for a player who is not registered, who gets no pill", () => {
    const join = now + 4 * MINUTE;
    const open = game({ registered: false, gameDateSeconds: join + MINUTE, registrationEndsSeconds: join - 30 });
    expect(resolveWeeklyGameView(open, false, false, now)).toMatchObject({ mode: "registration-open", chip: "in 4 min 00 sec" });
  });

  it("closes registration once the deadline has crossed, even mid-phase", () => {
    const view = resolveWeeklyGameView(
      game({
        registered: false,
        registrationEndsSeconds: now - 1,
        playEndsSeconds: now - 1 + 300,
        phase: {
          label: "registration",
          nextDeadlineSeconds: now - 1,
          secondsRemaining: 0,
        },
      }),
      false,
      false,
      now,
    );
    expect(view).toMatchObject({
      mode: "closed",
      chip: "closed",
      warn: true,
      note: "Registration has just closed for this game.",
    });
  });

  it("lets cancelling win over a stored registered flag", () => {
    const view = resolveWeeklyGameView(
      game({ registered: true, phase: phase("cancelling") }),
      false,
      false,
      now,
    );
    expect(view).toMatchObject({
      mode: "cancelled",
      chip: "called off",
      warn: true,
      note: "This game was called off.",
    });
  });

  it("keeps the confirmed seat only while registration is still open", () => {
    const view = resolveWeeklyGameView(
      game({ registered: true, phase: phase("registration") }),
      false,
      false,
      now,
    );
    expect(view.mode).toBe("confirmed");
  });

  it("hands a registered account the play handoff once registration closes", () => {
    for (const registrationEndsSeconds of [now, now - 1]) {
      const view = resolveWeeklyGameView(
        game({ registered: true, phase: phase("registration"), registrationEndsSeconds }),
        false,
        false,
        now,
      );
      expect(view).toMatchObject({
        mode: "play-now",
        chip: "in 7 days",
        cta: "Play now",
      });
      expect(view).not.toHaveProperty("note");
    }
  });

  it("keeps the play handoff through shuffle and reporting while the game is still played", () => {
    for (const label of ["shuffle", "reporting"] as const) {
      const view = resolveWeeklyGameView(
        game({ registered: true, phase: phase(label), registrationEndsSeconds: now - 1, playEndsSeconds: now + 1 }),
        false,
        false,
        now,
      );
      expect(view).toMatchObject({ mode: "play-now", cta: "Play now" });
    }
  });

  it("says the results are pending, with nothing to tap, once the last turn is over and until the chain has scored the game", () => {
    const pending = { mode: "results-pending", chip: "results pending", cta: "Game results pending", note: "It may take a little while to process." };
    for (const [label, playEndsSeconds] of [
      ["reporting", now],
      ["reporting", now - 600],
      ["processing", now + 600], // processing is after the play whatever the clock says
    ] as const) {
      const view = resolveWeeklyGameView(
        game({ registered: true, phase: phase(label), registrationEndsSeconds: now - 1_000, playEndsSeconds }),
        false,
        false,
        now,
      );
      expect(view, label).toMatchObject(pending);
    }
    // an unregistered account has no results to wait for
    expect(
      resolveWeeklyGameView(game({ registered: false, phase: phase("reporting"), registrationEndsSeconds: now - 1_000, playEndsSeconds: now - 1 }), false, false, now).mode,
    ).toBe("closed");
  });

  it("keeps the wrapped-up card once the game is processing for an account that did not play it", () => {
    const view = resolveWeeklyGameView(
      game({ registered: false, phase: phase("processing"), registrationEndsSeconds: now - 1 }),
      false,
      false,
      now,
    );
    expect(view.mode).toBe("closed");
    expect(view).toMatchObject({
      chip: "wrapping up",
      warn: true,
      note: "This game is being wrapped up.",
    });
  });

  describe("next game points forward in time", () => {
    // the running game started five minutes ago; the next one is in 15 minutes
    const next: NextGame = { gameDateSeconds: now + 15 * MINUTE, registrationStartsSeconds: now + 5 * MINUTE };
    const nextDate = formatGameDate(next.gameDateSeconds, now);
    const over = { gameDateSeconds: now - 5 * MINUTE, registrationEndsSeconds: now - 6 * MINUTE, nextGame: next };

    it("skips results pending and shows the next game to a player whose game is over", () => {
      for (const label of ["reporting", "processing"] as const) {
        const view = resolveWeeklyGameView(
          game({ ...over, registered: true, phase: phase(label), playEndsSeconds: now - 1 }),
          false,
          false,
          now,
        );
        expect(view, label).toMatchObject({ mode: "upcoming", value: nextDate });
      }
    });

    it("shows the next game, not the one behind it, to an account that did not play", () => {
      for (const label of ["reporting", "processing", "cancelling"] as const) {
        const view = resolveWeeklyGameView(game({ ...over, registered: false, phase: phase(label) }), false, false, now);
        expect(view, label).toEqual({
          mode: "upcoming",
          value: nextDate,
          chip: formatCountdown(next.gameDateSeconds, now),
          note: `Registration opens ${formatGameDate(next.registrationStartsSeconds, now)}.`,
        });
      }
      expect(
        resolveWeeklyGameView(game({ ...over, registered: null, phase: phase("processing") }), false, false, now).mode,
      ).toBe("upcoming");
    });

    it("says registration opens soon once its projected start has passed", () => {
      const late = { ...next, registrationStartsSeconds: now - 1 };
      const view = resolveWeeklyGameView(
        game({ ...over, nextGame: late, registered: false, phase: phase("processing") }),
        false,
        false,
        now,
      );
      expect(view).toMatchObject({ mode: "upcoming", note: "Registration opens soon." });
    });

    it("keeps the live game for a player who can still play it", () => {
      const view = resolveWeeklyGameView(
        game({ ...over, registered: true, phase: phase("reporting"), playEndsSeconds: now + MINUTE }),
        false,
        false,
        now,
      );
      expect(view).toMatchObject({ mode: "play-now", value: formatGameDate(over.gameDateSeconds, now) });
    });

    it("keeps the running game while its time is still ahead", () => {
      const view = resolveWeeklyGameView(
        game({
          gameDateSeconds: now + 2 * MINUTE,
          registrationEndsSeconds: now - 1,
          nextGame: next,
          registered: false,
          phase: phase("registration"),
        }),
        false,
        false,
        now,
      );
      expect(view).toMatchObject({ mode: "closed", value: formatGameDate(now + 2 * MINUTE, now) });
    });

    it("shows the scheduled next game between games", () => {
      expect(resolveWeeklyGameView({ kind: "no-game", gameIndex: 7, nextGame: next }, false, false, now)).toMatchObject({
        mode: "upcoming",
        value: nextDate,
      });
    });
  });

  it("keeps known game details without a seat-registration claim", () => {
    const view = resolveWeeklyGameView(
      game({ registered: null }),
      false,
      false,
      now,
    );
    expect(view.mode).toBe("unknown");
    if (view.mode === "unknown") {
      expect(view.chip).toBe("in 7 days");
      expect(view).not.toHaveProperty("note");
    }
  });

  it("does not offer registration while unknown", () => {
    const view = resolveWeeklyGameView(
      game({ registered: null }),
      false,
      false,
      now,
    );
    expect(view.mode).not.toBe("registration-open");
    expect(view.mode).not.toBe("confirmed");
  });
});

describe("formatCountdown", () => {
  it("keeps the coarse day/hour copy at an hour or more out", () => {
    expect(formatCountdown(now + 2 * DAY + 4 * HOUR, now)).toBe("in 2 days 4 hrs");
    expect(formatCountdown(now + 4 * HOUR + 10 * MINUTE, now)).toBe("in 4 hrs 10 min");
    expect(formatCountdown(now + HOUR, now)).toBe("in 1 hr");
  });

  // within the final hour it counts to the join, a minute ahead of the start,
  // as the pill of the host and the chat card do
  it("shows minutes and two-digit seconds to the join within the final hour", () => {
    expect(formatCountdown(now + MINUTE + 10 * MINUTE + 37, now)).toBe("in 10 min 37 sec");
    expect(formatCountdown(now + MINUTE + MINUTE + 1, now)).toBe("in 1 min 01 sec");
    expect(formatCountdown(now + MINUTE + 2 * MINUTE, now)).toBe("in 2 min 00 sec");
    expect(formatCountdown(now + HOUR - 1, now)).toBe("in 58 min 59 sec");
  });

  it("shows only two-digit seconds within the final minute before the join", () => {
    expect(formatCountdown(now + MINUTE + 59, now)).toBe("in 59 sec");
    expect(formatCountdown(now + MINUTE + 1, now)).toBe("in 01 sec");
  });

  it("says under way from the join, a minute ahead of the start", () => {
    expect(formatCountdown(now + MINUTE, now)).toBe("under way");
    expect(formatCountdown(now, now)).toBe("under way");
    expect(formatCountdown(now - 1, now)).toBe("under way");
  });
});

describe("formatRegisteredCountdown", () => {
  it("counts down until the pill of the host comes up, five minutes before the join", () => {
    const start = now + HOUR - 1;
    expect(formatRegisteredCountdown(start, now)).toBe("in 58 min 59 sec");
    expect(formatRegisteredCountdown(start, start - MINUTE - 5 * MINUTE - 1)).toBe("in 5 min 01 sec");
    expect(formatRegisteredCountdown(start, start - MINUTE - 5 * MINUTE)).toBe("game starting soon");
    expect(formatRegisteredCountdown(start, start - MINUTE - 1)).toBe("game starting soon");
    expect(formatRegisteredCountdown(start, start - MINUTE)).toBe("under way");
  });
});

describe("offersRegister", () => {
  it("is true only for a game the account is not registered for", () => {
    expect(offersRegister(game({ registered: false }))).toBe(true);
    expect(offersRegister(game({ registered: true }))).toBe(false);
    expect(offersRegister(game({ registered: null }))).toBe(false);
    expect(offersRegister({ kind: "no-game", gameIndex: 1, nextGame: null })).toBe(false);
    expect(offersRegister(undefined)).toBe(false);
  });
});
