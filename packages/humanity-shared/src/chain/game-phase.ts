// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The card's name for a game phase, and the countdown to its deadline. The
 * phase and its deadline come from the SDK, which mirrors the runtime's
 * schedule; only the product's vocabulary and the clock stay here.
 *
 * All timestamps are SECONDS since the Unix epoch (not block numbers, not ms).
 */
import type { GamePhase } from "@humanity/shared/chain/individuality.ts";

export type GamePhaseLabel =
  | "registration"
  | "shuffle"
  | "reporting"
  | "processing"
  | "cancelling";

export interface GamePhaseView {
  label: GamePhaseLabel;
  /** Unix seconds of the deadline that ends this phase; null when the phase has no deadline. */
  nextDeadlineSeconds: number | null;
  /** Clamped at 0; null when there is no deadline. */
  secondsRemaining: number | null;
}

function labelFor(phase: GamePhase): GamePhaseLabel {
  switch (phase) {
    case "Registration":
      return "registration";
    case "Shuffle":
      return "shuffle";
    case "Reporting":
      return "reporting";
    case "PlayerProcess":
      return "processing";
    case "Cancelling":
      return "cancelling";
  }
}

/** Never re-derive `nextDeadline` from the clock: transitions run in an
 *  offchain worker's own time, so a boundary can be past while its phase is
 *  current. Hence the clamp. */
export function toGamePhaseView(
  phase: GamePhase,
  nextDeadline: number | null,
  nowSeconds: number,
): GamePhaseView {
  return {
    label: labelFor(phase),
    nextDeadlineSeconds: nextDeadline,
    secondsRemaining:
      nextDeadline == null ? null : Math.max(0, nextDeadline - nowSeconds),
  };
}
