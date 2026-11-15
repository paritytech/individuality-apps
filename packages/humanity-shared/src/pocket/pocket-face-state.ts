// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The app's card state in the terms the Pocket face draws.
 *
 * `HumanityCardState` carries what the home screen needs to say (last attended
 * game, suspension reason); the face carries what fits on a card.
 */
import type { PocketFace, PocketFaceState } from "@humanity/shared/pocket/humanity-face.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import type { ResolvedHumanityCard } from "@humanity/shared/card/humanity-card-data.ts";

/**
 * The Pocket face of a card read: its name and where it stands. The one
 * place either side turns a card into a face, so the face the worker draws
 * from its own read and the one the app hands it (`pocket-face-hint.ts`)
 * cannot disagree on what the same card says.
 */
export function pocketFaceOf(card: Pick<ResolvedHumanityCard, "primaryUsername" | "state">): PocketFace {
  return { name: card.primaryUsername, state: toPocketFaceState(card.state) };
}

export function toPocketFaceState(state: HumanityCardState): PocketFaceState {
  switch (state.kind) {
    case "not-enrolled":
      return { kind: "not-enrolled" };
    case "devicehood":
      return { kind: "devicehood" };
    case "candidate":
      return { kind: "candidate", score: state.score, threshold: state.personhoodThreshold };
    case "membership-ready":
      return { kind: "membership-ready", weeks: state.activeWeeks };
    case "member":
      return { kind: "member", weeks: state.activeWeeks };
    case "caution":
      return {
        kind: "caution",
        misses: state.misses,
        allowedMisses: state.allowedMisses,
        window: state.window,
      };
    case "suspended":
      return { kind: "suspended" };
  }
}
