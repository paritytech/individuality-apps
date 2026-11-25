// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE PAYOFF IN FIXED WORDS — the draw and the collectables screen as the journey.payoff
 * attributes. Pure: each takes the view the page already
 * renders from and returns text attributes.
 */
import type { PrizeDrawView } from "../draw/prize-draw"
import type { WheelCheck } from "../draw/wheel/rule"
import type { CollectablesViewState } from "../collectables/view-state"
import type { Attrs } from "../telemetry"

export const DRAW_REASONS = ["not-entered", "not-in-draw", "entries-cleared", "no-draw"] as const
export const COLLECTABLES_REASONS = ["absent", "no-attestations", "report-missed", "on-the-way", "pocketed", "pruned", "failed", "no-identity", "not-recognised", "voting"] as const

export type DrawState = { kind: "loading" } | { kind: "no-identity" } | { kind: "none" } | { kind: "ready"; draw: PrizeDrawView }

export function drawFacts(state: DrawState, check: WheelCheck | null, signupSkip: string | null): Attrs {
  if (state.kind === "none") return { "draw.invited": "false", "draw.reason": "no-draw" }
  if (state.kind !== "ready") return {}
  const { draw } = state
  const won = { "draw.won": draw.won ? "true" : "false" }
  if (!draw.userTicket)
    return { "draw.invited": "false", "draw.reason": "not-entered", ...(signupSkip ? { "draw.skipped": signupSkip } : {}), ...won }
  if (!draw.wheel) return { "draw.invited": "false", "draw.reason": "entries-cleared", ...won }
  if (check?.code === "not-in-draw") return { "draw.invited": "false", "draw.reason": "not-in-draw", ...won }
  return { "draw.invited": "true", ...won }
}

/** The rule refused because it and the chain disagree: `draw-unplayable`.
 *  A ticket missing from the entries is a not-invited reason instead. */
export function drawUnplayable(check: WheelCheck | null): "winners-disagree" | "result-disagree" | null {
  return check?.code === "winners-disagree" || check?.code === "result-disagree" ? check.code : null
}

export function collectablesFacts(state: CollectablesViewState): Attrs | null {
  switch (state.kind) {
    case "loading":
    case "retrying":
      return null
    case "ready":
      return {
        "chest.outcome": "collectables",
        "chest.count": String(state.items.length),
        // opened before the game settled, on the claims of co-players' votes
        ...(state.settling ? { "chest.settling": "true" } : {}),
      }
    case "empty":
      return { "chest.outcome": "none", "chest.reason": state.reason }
    case "restart":
      return { "chest.outcome": "none", "chest.reason": "failed" }
    default:
      return { "chest.outcome": "none", "chest.reason": state.kind }
  }
}
