// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { journeyStory } from "@features/card/domain/journey-story.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

describe("journeyStory", () => {
  it("lights the rung each early state stands on", () => {
    expect(journeyStory({ kind: "not-enrolled" })).toEqual({ current: null });
    expect(journeyStory({ kind: "devicehood" })).toEqual({ current: 0 });
    expect(
      journeyStory({ kind: "candidate", score: 2, personhoodThreshold: 5, gamesRemaining: 2 }),
    ).toEqual({ current: 1 });
  });

  it("hides the story once the person has arrived", () => {
    const arrived: HumanityCardState[] = [
      { kind: "membership-ready", activeWeeks: 1, lastAttendedGame: 4, attendanceHistory: 1, window: 8 },
      { kind: "member", activeWeeks: 1, lastAttendedGame: 4, attendanceHistory: 1, window: 8 },
      { kind: "caution", activeWeeks: 0, misses: 2, allowedMisses: 1, window: 8, lastAttendedGame: 4, attendanceHistory: 2 },
      { kind: "suspended", reason: "attendance" },
    ];
    for (const state of arrived) expect(journeyStory(state), state.kind).toBeNull();
  });
});
