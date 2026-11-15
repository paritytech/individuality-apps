// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PayoffCommand, PayoffInput, PayoffRoute, PayoffState, PayoffTag } from "./payoff-machine"
import { payoffSession } from "./payoff-session"

export interface PayoffScreenRunner {
  capture(): PayoffTag
  current(): PayoffState
  send(event: PayoffInput, tag?: PayoffTag): PayoffCommand[]
}

export function createPayoffScreenRunner(gameIndex: number, route: Extract<PayoffRoute, "/chest">): PayoffScreenRunner {
  return payoffSession(gameIndex, route)
}

/**
 * A normal chest result belongs to the read that produced it. The restart card
 * is different: it describes the screen's current failure after cancelling any
 * in-flight reread, so it must use the current epoch rather than the old view's
 * read tag.
 */
export function sendChestPageResult(runner: PayoffScreenRunner, readTag: PayoffTag | undefined, restart: boolean): PayoffCommand[] {
  return runner.send({ type: "chest-result" }, restart ? runner.capture() : readTag)
}

export interface ChestCommandHandlers {
  chestOpened(): void
  chestShown(): void
  payoffStalled(stage: string): void
  /** the payoff ended at the hand-off: its journey closes and the game's log goes */
  payoffEnded(): void
  /** leave the game for the player's Humanity card */
  handOff(): void
  /** the payoff's answer to chest-reread-due: the chest's own reread has already read */
  loadChest(): void
}

/** Every command the payoff emits, run or named as not the chest's. */
export function executeChestCommands(commands: PayoffCommand[], handlers: ChestCommandHandlers): void {
  for (const command of commands) {
    switch (command.kind) {
      case "telemetry":
        if (command.fact === "chestOpened") handlers.chestOpened()
        else if (command.fact === "chestShown") handlers.chestShown()
        else if (command.fact === "payoffStalled") handlers.payoffStalled(command.stage)
        // drawShown is the draw's, sent before the chest
        break
      case "end-payoff":
        // next-game and app-gone end the payoff from the session, not this page
        if (command.cause === "handed-off") handlers.payoffEnded()
        break
      case "hand-off":
        handlers.handOff()
        break
      case "load-chest":
        handlers.loadChest()
        break
      case "replace-route":
      case "arm-draw-idle":
      case "cancel-draw-idle":
      case "mark-draw-seen":
        // the draw's: the chest is where the payoff goes, and has no idle
        break
      default: {
        const unhandled: never = command
        throw new Error(`chest: no executor for ${JSON.stringify(unhandled)}`)
      }
    }
  }
}
