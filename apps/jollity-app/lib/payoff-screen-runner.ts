// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PayoffCommand, PayoffInput, PayoffRoute, PayoffState, PayoffTag } from "./payoff-machine"
import { payoffSession } from "./payoff-session"

export interface PayoffScreenRunner {
  capture(): PayoffTag
  current(): PayoffState
  send(event: PayoffInput, tag?: PayoffTag): PayoffCommand[]
}

export function createPayoffScreenRunner(gameIndex: number, route: Extract<PayoffRoute, "/collectables">): PayoffScreenRunner {
  return payoffSession(gameIndex, route)
}

/**
 * A normal collectables result belongs to the read that produced it. The restart card
 * is different: it describes the screen's current failure after cancelling any
 * in-flight reread, so it must use the current epoch rather than the old view's
 * read tag.
 */
export function sendCollectablesPageResult(runner: PayoffScreenRunner, readTag: PayoffTag | undefined, restart: boolean): PayoffCommand[] {
  return runner.send({ type: "collectables-result" }, restart ? runner.capture() : readTag)
}

export interface CollectablesCommandHandlers {
  collectablesOpened(): void
  collectablesShown(): void
  payoffStalled(stage: string): void
  /** the payoff ended at the hand-off: its journey closes and the game's log goes */
  payoffEnded(): void
  /** leave the game for the player's Humanity card */
  handOff(): void
  /** the payoff's answer to collectables-reread-due: the collectables screen's own reread has already read */
  loadCollectables(): void
}

/** Every command the payoff emits, run or named as not the collectables screen's. */
export function executeCollectablesCommands(commands: PayoffCommand[], handlers: CollectablesCommandHandlers): void {
  for (const command of commands) {
    switch (command.kind) {
      case "telemetry":
        if (command.fact === "collectablesOpened") handlers.collectablesOpened()
        else if (command.fact === "collectablesShown") handlers.collectablesShown()
        else if (command.fact === "payoffStalled") handlers.payoffStalled(command.stage)
        // drawShown is the draw's, sent before the collectables screen
        break
      case "end-payoff":
        // next-game and app-gone end the payoff from the session, not this page
        if (command.cause === "handed-off") handlers.payoffEnded()
        break
      case "hand-off":
        handlers.handOff()
        break
      case "load-collectables":
        handlers.loadCollectables()
        break
      case "replace-route":
      case "arm-draw-idle":
      case "cancel-draw-idle":
      case "mark-draw-seen":
        // the draw's: the collectables screen is where the payoff goes, and has no idle
        break
      default: {
        const unhandled: never = command
        throw new Error(`collectables screen: no executor for ${JSON.stringify(unhandled)}`)
      }
    }
  }
}
