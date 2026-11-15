// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Where a card stands on the one ladder the home tells: person, candidate,
 * member. The story block shows the ladder only while there is still a rung
 * to climb, and marks the rung the person is on.
 */
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

/** Rung index into the three-step story, or null when the story is hidden. */
export type JourneyStep = 0 | 1 | 2;

export interface JourneyStory {
  /** The rung the person is on; null for a card with no rung lit yet. */
  current: JourneyStep | null;
}

/**
 * The story is for people still on their way: a member has arrived and the
 * ladder would only repeat what the card already says. Not enrolled shows the
 * ladder with nothing lit — the person has not stepped on it yet.
 */
export function journeyStory(state: HumanityCardState): JourneyStory | null {
  switch (state.kind) {
    case "not-enrolled":
      return { current: null };
    case "devicehood":
      return { current: 0 };
    case "candidate":
      return { current: 1 };
    case "membership-ready":
    case "member":
    case "caution":
    case "suspended":
      return null;
  }
}
