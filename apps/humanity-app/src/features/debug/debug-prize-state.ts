// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pure, immutable state for the debug panel's isolated daily-dollar
 * simulation. `outcome` picks which simulated ticket is active — `null`
 * means the panel defers to the live event — and `winningsDollars` is the
 * cumulative counter the panel shows regardless of which path is active.
 * `ticket` is a monotonically increasing identity for the active simulated
 * ticket, bumped on every `selectDebugPrize` call (even re-selecting the
 * same outcome) so consumers can key off a fresh identity per pick.
 */
export interface DebugPrizeState {
  outcome: "win" | "miss" | null;
  revealed: boolean;
  winningsDollars: number;
  ticket: number;
}

export const INITIAL_DEBUG_PRIZE_STATE: DebugPrizeState = {
  outcome: null,
  revealed: false,
  winningsDollars: 214,
  ticket: 0,
};

/**
 * Picks a fresh simulated ticket for `outcome`. Winnings already accrued
 * carry over; `revealed` always resets so picking the same outcome again
 * restarts the scratch rather than reusing the settled ticket. `ticket`
 * always increments, including when re-selecting the same outcome, giving
 * each pick a unique identity.
 */
export function selectDebugPrize(
  state: DebugPrizeState,
  outcome: DebugPrizeState["outcome"],
): DebugPrizeState {
  return { ...state, outcome, revealed: false, ticket: state.ticket + 1 };
}

/**
 * Settles the active simulated ticket. Idempotent: once revealed, further
 * calls are no-ops. The first settle adds a dollar for a win, nothing for a
 * miss or the live (`null`) path.
 */
export function settleDebugPrize(state: DebugPrizeState): DebugPrizeState {
  if (state.revealed) return state;
  return {
    ...state,
    revealed: true,
    winningsDollars: state.outcome === "win" ? state.winningsDollars + 1 : state.winningsDollars,
  };
}

/** Drops back to the live path and clears the simulation entirely. */
export function resetDebugPrizeState(): DebugPrizeState {
  return { ...INITIAL_DEBUG_PRIZE_STATE };
}
