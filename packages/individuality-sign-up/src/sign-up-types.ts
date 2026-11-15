// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SIGN-UP'S SEAM TYPES: what the flow (./sign-up-flow.ts) asks of the
 * chain, which ./chain answers over the product SDK's game registration
 * (`@parity/product-sdk-individuality`), and a product with an engine of its
 * own can answer too.
 *
 * The seat, the bind and the sign-up are the SDK's, in its own types. What is
 * here is only what Jollity adds on top: the draw rule of #167
 * (`not-member-yet`), and the shape the flow reads a bind and a sign-up in.
 */
import type {
  BindGameSeatOutcome,
  DrawOutcome,
  DrawSkipKind as SdkDrawSkipKind,
  GameRegistrationCapabilities,
  GameSeat,
  GameSeatBindRefusal,
} from "@parity/product-sdk-individuality"

// ── a sign-up that goes out without its draw ticket ─────────────────────────

/**
 * WHY A SIGN-UP WENT OUT WITHOUT ITS DRAW TICKETS: the SDK's reasons, and
 * `not-member-yet`, left out on purpose: this game cannot make the player a
 * member, so a ticket of theirs could never be paid (../draw-ticket.ts
 * `drawTicketCanPay`, #167). Not a failure.
 */
export type DrawSkipKind = SdkDrawSkipKind | "not-member-yet"

/** What a sign-up carried for the game's prize draws: the SDK's outcome, with Jollity's reason. */
export type SignUpDraws = Omit<DrawOutcome, "kind"> & { kind?: DrawSkipKind }

/** What a sign-up did about the prize draw, as the telemetry names it:
 *  `entered` (tickets went with it), `no-draw` (the game has none, so nothing
 *  was missed), `ineligible` (left out on purpose: `not-member-yet`) or
 *  `skipped` (a draw it could not enter). */
export type DrawResult = "entered" | "skipped" | "no-draw" | "ineligible"

export function drawResult(draws: Pick<SignUpDraws, "entered" | "scheduled" | "kind">): DrawResult {
  if (draws.entered > 0) return "entered"
  if (draws.kind === "not-member-yet") return "ineligible"
  return draws.scheduled === 0 && !draws.kind ? "no-draw" : "skipped"
}

// ── what the flow asks of the chain ─────────────────────────────────────────

/** How a bind of the free seat ended: the SDK's outcome, or its refusal as
 *  the flow acts on it. `permanent` closes the lite route for the session. */
export type BindResult =
  | { kind: BindGameSeatOutcome }
  | {
      kind: "refused"
      permanent: boolean
      refusal: GameSeatBindRefusal
      /** the chain's error name, or the SDK's own code */
      code: string
      /** for `pinned-elsewhere`: the account the seat is pinned to */
      account?: string
      /** what the refusal said, for the log */
      detail: string
    }

/** A sign-up as it came back. A failure carries the chain error name, or the SDK
 *  code, apart from the message that wraps it. */
export type RegisterResult = { ok: true } | { ok: false; error: string; code?: string; landingUnknown?: true }

export interface RegisterOptions {
  /** Given up on: the sign-up stops before the broadcast, and nothing more is signed. */
  signal?: AbortSignal
  /** the sign-up is on the wire */
  onBroadcast?: () => void
  /** what the sign-up carries for the draws, before it is signed */
  onDraws?: (draws: SignUpDraws) => void
}

/** The sign-up's calls, which an engine of a product's own may carry too. */
export interface SignUpChain {
  /** the seat at the best block, as the SDK's `readGameSeat` decides it */
  seat(account: string, facts: { litePerson: boolean; bound?: boolean }): Promise<GameSeat>
  /** whether this person can take the free route: the SDK's `holdsLiteKey` */
  holdsLiteKey(capabilities: GameRegistrationCapabilities): Promise<boolean>
  /** leg 1 of the free route: the SDK's `bindGameSeat` */
  bind(capabilities: GameRegistrationCapabilities, options?: { signal?: AbortSignal }): Promise<BindResult>
  /** the sign-up, with the draw entries: the SDK's `registerForGame`. A failure
   *  is a `RegisterResult` the flow's retry policy reads, never a throw. */
  register(
    capabilities: GameRegistrationCapabilities,
    identifierKey: Uint8Array,
    options?: RegisterOptions,
  ): Promise<RegisterResult>
}

/** The chain the flow signs up through: the sign-up's calls, and the two reads
 *  it reconciles with. */
export interface SignUpFlowChain extends SignUpChain {
  /** `Game.Players[address]` at the best block */
  player(address: string): Promise<{ registered: boolean } | undefined>
  /** `Game.Game`: the game a sign-up is for, and when its registration ends */
  game(): Promise<{ index: number; state: { type: string }; registration_ends: number } | undefined>
}
