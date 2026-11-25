// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PayoffCommand, PayoffInput, PayoffState, PayoffTag } from "../payoff-machine"
import { payoffSession } from "../payoff-session"

export interface PrizeDrawPayoffRunner {
  capture(): PayoffTag
  current(): PayoffState
  send(event: PayoffInput, tag?: PayoffTag): PayoffCommand[]
}

/** Stateful page adapter around the pure reducer; load attempts retain their start tag. */
export function createPrizeDrawPayoffRunner(gameIndex: number): PrizeDrawPayoffRunner {
  return payoffSession(gameIndex, "/prize-draw")
}

export interface PrizeDrawCommandHandlers {
  drawShown(): void
  markDrawSeen(): void
  replaceCollectables(): void
  /** the 60 s idle watch (lib/draw/draw-idle): start it, or stop it on the way out */
  armIdle(): void
  cancelIdle(): void
  /** the collectables screen comes next: get it ready (start reading its claims) */
  loadCollectables(): void
}

/**
 * Runs every command the payoff sends the prize draw's page, one case each, so
 * a new kind of command fails the typecheck until this page decides what it
 * does with it (AGENTS.md "State machines" rule 2).
 */
export function executePrizeDrawCommands(commands: PayoffCommand[], handlers: PrizeDrawCommandHandlers): void {
  for (const command of commands) {
    switch (command.kind) {
      case "telemetry":
        // the draw's own fact; the collectables screen's and a stall's come from the collectables screen's inputs, never this page's
        if (command.fact === "drawShown") handlers.drawShown()
        break
      case "mark-draw-seen":
        handlers.markDrawSeen()
        break
      case "replace-route":
        // "/prize-draw" is where this page already is
        if (command.route === "/collectables") handlers.replaceCollectables()
        break
      case "arm-draw-idle":
        handlers.armIdle()
        break
      case "cancel-draw-idle":
        handlers.cancelIdle()
        break
      case "load-collectables":
        handlers.loadCollectables()
        break
      case "hand-off":
      case "end-payoff":
        // the hand-off and the payoff's end follow the collectables screen (collectables-continue,
        // collectables-skip) or the session (next-game, app-gone), never this page's inputs
        break
      default: {
        const unhandled: never = command
        throw new Error(`prize draw: no executor for ${JSON.stringify(unhandled)}`)
      }
    }
  }
}
