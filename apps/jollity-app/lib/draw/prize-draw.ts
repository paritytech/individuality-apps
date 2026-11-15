// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE PRIZE DRAW'S DATA CONTRACT — what the draw screen needs of one draw,
 * built from the CHAIN (pallet `airdrop`, through lib/game-source.ts's
 * prizeDrawView). The wheel (lib/draw/wheel) plays it; the chain's result is
 * authoritative and the screen never decides it.
 */
export interface PrizeDraw {
  /** the prize in WHOLE UNITS of its asset (the name is a holdover from a
   *  dollar-denominated design; the asset is `prizeSymbol`) */
  prizeUsd: number
  /** the player's ticket, a 32-byte slot as hex; empty when they are not in
   *  the draw */
  userTicket: string
  /** every winning ticket of this draw, same shape; may include userTicket */
  winningTickets: string[]
  /** how many entered the draw — the chain's own count (`total_participants`
   *  on the draw's status) where it carries one */
  totalEntries?: number
  /** how many entries the registration read actually returned. Fewer than
   *  `totalEntries` means the read came back short: the chain holds them all
   *  (an Android host read has been seen returning the draw without the
   *  player's own ticket, which the chain had the whole time) */
  listedEntries?: number
  /** AUTHORITATIVE outcome. The scene plays the ceremony; it never decides. */
  won: boolean
}

/**
 * WHERE THE DRAW IS, in the only terms the screen cares about.
 *
 * The pallet's own lifecycle has eight states (Scheduled, Registering,
 * AwaitingEntropy, DrawWinners, Claiming, ClearingRegistrations,
 * ClearingWinners, Finalizing) plus "swept from storage". The ceremony
 * branches on exactly three things: is there a result to reveal, is it still
 * coming, or is the whole thing over. Carrying the pallet tag into the UI
 * would make a runtime rename a UI bug — and it did leak, as `status: string`.
 */
export type DrawPhase =
  /** entries or the draw itself are still in flight — no winners to reveal */
  | "waiting"
  /** winners exist: the ceremony has something true to land on */
  | "drawn"
  /** finished, and nothing left in storage to show */
  | "over"

/**
 * What the WHEEL is drawn from (lib/draw/wheel): every entry's ticket slot,
 * where the draw cut them, and how many the wedge takes. The rule that turns
 * these into winners is the chain's (lib/draw/wheel/rule.ts), so the wheel
 * lands where the chain did.
 */
export interface DrawWheel {
  /** every entry's 32-byte slot, hex */
  tickets: string[]
  /** the draw's target, hex (`Airdrop.EventEntropy`) */
  target: string
  /** how many the draw picked */
  winners: number
  /** who holds each ticket (slot → SS58), where the chain says: a name on a
   *  dot is the holder's, through their root's signed note (@individuality/name-link) */
  holders?: Record<string, string>
}

/**
 * One draw, as the SCREEN needs it. Declared here — beside the contract it
 * extends — so a source is checked against the view's needs rather than the
 * view being shaped by whatever a source returns.
 */
export interface PrizeDrawView extends PrizeDraw {
  /** The game the draw belongs to, which the screen reports as seen to the chat card. */
  gameIndex: number
  /** index within the game's scheduled draws */
  airdropIndex: number
  phase: DrawPhase
  /** the wheel's input, or null when the draw can no longer be drawn (the
   *  entries are cleared, the target is not captured, the source cannot list
   *  them) — the plain result stands in */
  wheel: DrawWheel | null
  /** the prize asset's symbol, when the asset carries metadata */
  prizeSymbol: string | null
  /** the player won this draw and has already claimed it — never claimable
   *  again (a second claim fails, and a refused claim costs a fee) */
  claimed: boolean
  /** would the claim extrinsic be accepted, and if not, why */
  claimable: boolean
  claimBlockedReason: string | null
}
