// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The line under the card, per state: the ladder's words, never the
 *  chain's. Members get no line at all; the card and the rows say it. */
import { describe, expect, it } from "vitest";

import {
  cardStatusLabel,
  firstGameConfirmedNote,
  homeSub,
  homeTitle,
} from "@features/card/domain/card-journey-hints.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

const member = (activeWeeks = 2): HumanityCardState => ({
  kind: "member",
  activeWeeks,
  lastAttendedGame: 7,
  attendanceHistory: 0b11,
  window: 8,
});
const caution: HumanityCardState = {
  kind: "caution",
  activeWeeks: 0,
  misses: 2,
  allowedMisses: 3,
  window: 8,
  lastAttendedGame: 5,
  attendanceHistory: 0b110,
};

describe("homeTitle and homeSub", () => {
  it("tells a person what to do and what it brings, in one line each", () => {
    expect(homeTitle({ kind: "devicehood" })).toBe("Become a member");
    expect(homeSub({ kind: "devicehood" })).toBe("Play the weekly game to become a member.");
  });

  it("holds a not-enrolled card as a wait, not a task", () => {
    expect(homeTitle({ kind: "not-enrolled" })).toBe("Your card isn't ready yet");
    expect(homeSub({ kind: "not-enrolled" })).toContain("Polkadot app");
  });

  it("gives members no title or subtitle, regardless of streak", () => {
    for (const state of [member(0), member(4)]) {
      expect(homeTitle(state)).toBeNull();
      expect(homeSub(state)).toBeNull();
    }
    const ready: HumanityCardState = {
      kind: "membership-ready",
      activeWeeks: 2,
      lastAttendedGame: 7,
      attendanceHistory: 0b11,
      window: 8,
    };
    expect(homeTitle(ready)).toBeNull();
    expect(homeSub(ready)).toBeNull();
  });

  it("names the day a cautioned member can keep it, when there is one", () => {
    expect(homeTitle(caution)).toBe("Membership at risk");
    expect(homeSub(caution, "this Saturday")).toBe("Play this Saturday to keep it.");
    expect(homeSub(caution, "today")).toBe("Play today to keep it.");
    expect(homeSub(caution, "tomorrow")).toBe("Play tomorrow to keep it.");
    expect(homeSub(caution)).toBe("Play the next game to keep it.");
  });

  it("tells a suspended member the way back", () => {
    const state: HumanityCardState = { kind: "suspended", reason: "attendance" };
    expect(homeTitle(state)).toBe("Membership paused");
    expect(homeSub(state)).toBe("Register for another game to restart your membership journey.");
  });

  it("never uses the chain's words or the sales pitch", () => {
    const states: HumanityCardState[] = [
      { kind: "not-enrolled" },
      { kind: "devicehood" },
      { kind: "candidate", score: 1, personhoodThreshold: 8, gamesRemaining: 1 },
      member(),
      caution,
      { kind: "suspended", reason: "attendance" },
    ];
    for (const state of states) {
      const text = `${homeTitle(state) ?? ""} ${homeSub(state, "Saturday") ?? ""}`;
      expect(text, state.kind).not.toMatch(
        /devicehood|personhood|lite|score|chain|wallet|silver|warm|free|minutes/i,
      );
    }
  });
});

describe("the candidate line", () => {
  const candidate = (gamesRemaining: number): HumanityCardState => ({
    kind: "candidate",
    score: 3,
    personhoodThreshold: 5,
    gamesRemaining,
  });

  it("counts down only when one game is left", () => {
    expect(homeTitle(candidate(1))).toBe("Almost a member");
    expect(homeSub(candidate(1))).toBe("One more game to go.");
    for (const remaining of [2, 3, 7]) {
      expect(homeTitle(candidate(remaining)), `${remaining} to go`).toBe("On your way");
      expect(homeSub(candidate(remaining)), `${remaining} to go`).toBe(
        "Each game counts toward membership.",
      );
    }
  });

  it("counts by the streak, not one point a game", () => {
    // Score 3 of 5 on a streak of 4: the next game adds 5, not 1, so this
    // person is one game away. Asking whether `score + 1` cleared the
    // threshold said otherwise and told them to keep playing.
    expect(homeSub(candidate(1))).toBe("One more game to go.");
  });
});

describe("firstGameConfirmedNote", () => {
  it("promises the change and nothing more", () => {
    expect(firstGameConfirmedNote()).toBe("Your card updates after you play.");
  });
});

describe("cardStatusLabel", () => {
  it("names every state in the ladder's words, for assistive tech only", () => {
    const cases: [HumanityCardState, string][] = [
      [{ kind: "not-enrolled" }, "Not ready yet"],
      [{ kind: "devicehood" }, "Person"],
      [{ kind: "candidate", score: 1, personhoodThreshold: 8, gamesRemaining: 1 }, "Candidate"],
      [{ kind: "membership-ready", activeWeeks: 0, lastAttendedGame: 7, attendanceHistory: 0, window: 8 }, "Member"],
      [member(0), "Member"],
      [caution, "Member, at risk"],
      [{ kind: "suspended", reason: "attendance" }, "Suspended"],
    ];
    for (const [state, label] of cases) {
      expect(cardStatusLabel(state), state.kind).toBe(label);
    }
  });
});
