// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Domain shapes for manager-scheduled people-airdrop draws.
 *
 * Airdrops are no longer tied to a game round. A manager origin schedules
 * draws whenever it likes through `PeopleAirdrops.schedule_draws`, each one
 * taking the next `NextDrawIndex`; the draw's id is derived from that index
 * alone (`peopleAirdropsEventId` in `@parity/product-sdk-individuality`).
 * Discovery is therefore a scan of `Airdrop.Events` filtered to the
 * people-airdrops id prefix — never a function of the weekly game.
 *
 * Pure types and predicates only: chain access lives in the SDK and in each
 * product's own chain adapters, never in this package.
 */

/** Hex-encoded 32-byte value, as PAPI returns `SizedHex<32>`. */
export type Hex32 = `0x${string}`;

/**
 * Lifecycle status of a draw, mirroring `indiv_pallet_airdrop::types::Status`.
 * Registration is only accepted in `Registering`; claims only in `Claiming`.
 */
export type AirdropDrawStatus =
  | "Scheduled"
  | "Registering"
  | "AwaitingEntropy"
  | "DrawWinners"
  | "Claiming"
  | "ClearingRegistrations"
  | "ClearingWinners"
  | "Finalizing";

/** A scheduled people-airdrop draw, projected from `Airdrop.Events`. */
export interface AirdropDraw {
  /** 32-byte event id; the `Airdrop.Events` key and the `register`/`claim` argument. */
  eventId: Hex32;
  /** `NextDrawIndex` value this draw was scheduled at, decoded from `eventId`. */
  drawIndex: bigint;
  status: AirdropDrawStatus;
  /** Registration opens, unix seconds. */
  registrationStartsSeconds: number;
  /** Registration closes and the draw is performed, unix seconds. */
  drawTimeSeconds: number;
  /** Claiming closes and clean-up starts, unix seconds. */
  endTimeSeconds: number;
  /** Per-winner prize in the asset's base units. */
  prizeAmount: bigint;
  /** Prize asset id, as the runtime's `pallet_assets` `AssetId` (an XCM location). */
  assetId: unknown;
  maxWinners: number;
  /** Registered participants, where the status carries the count. */
  totalParticipants: number | null;
  /** Runtime-capped winner count, once the draw has closed registration. */
  effectiveWinners: number | null;
  /** Winners that have claimed, where the status carries the count. */
  claimed: number | null;
}

/**
 * A draw plus this person's standing in it.
 *
 * `registered` and `winner` are tri-state: `null` means *not determinable*,
 * not *false*. The salt a slot is derived from is reaped by the pallet's
 * offchain worker once `end_time` passes, so a finished draw cannot be probed
 * for registration at all, and a person without an alias in the airdrops
 * context has no slot anywhere. Collapsing that into `false` would report a
 * person as unregistered in draws they in fact entered.
 */
export interface AirdropParticipation {
  draw: AirdropDraw;
  /** Entropy slot for this person and draw, or `null` when not derivable. */
  slot: Hex32 | null;
  /** `Airdrop.Registrations(eventId, slot)` is occupied. */
  registered: boolean | null;
  /**
   * `Airdrop.Winners(eventId, Alias{alias})` is occupied — an *unclaimed*
   * winner. The pallet removes the entry on a successful claim, so a winner
   * who has claimed reads back as `false`.
   */
  winner: boolean | null;
  /**
   * The winner entry was seen earlier in this session and has since gone,
   * which is the only signal that distinguishes a claimed prize from never
   * having won. `null` when no earlier observation exists.
   */
  claimed: boolean | null;
}

/** Everything a consumer needs about this person's airdrop standing. */
export interface AirdropStanding {
  /** Dedicated product subaccount that signs registration and claim calls. */
  accountAddress?: string;
  /** Every people-airdrops draw currently in `Airdrop.Events`, by draw index. */
  participations: AirdropParticipation[];
  /** The alias the slots were derived from, or `null` when the person has none. */
  alias: Hex32 | null;
  /** `PeopleAirdrops.people_airdrops_context()`. */
  airdropsContext: Hex32;
  /**
   * Context of the alias the product account actually holds in
   * `People.AccountToAlias`, or `null` when it holds none.
   */
  aliasContext: Hex32 | null;
  /**
   * Whether `aliasContext` equals `airdropsContext`. False means every derived
   * slot is wrong and the runtime will reject `register`/`claim` with
   * `BadOrigin`: the account's single contextual alias belongs to another
   * pallet's context. Surfaced rather than hidden — it is the difference
   * between "no draws open" and "this account can never participate".
   */
  contextMatches: boolean;
  /** Block the standing was read at, so callers can pin follow-up reads. */
  atBlockHash: Hex32;
}

/** Draws this person should register for: open, unregistered, still fillable. */
export function pendingRegistrations(
  standing: AirdropStanding,
  nowSeconds: number,
): AirdropParticipation[] {
  const aliasCanBeBound =
    standing.alias == null && standing.aliasContext == null;
  return standing.participations.filter(
    (entry) =>
      entry.draw.status === "Registering" &&
      ((entry.registered === false && entry.slot != null) ||
        (aliasCanBeBound && entry.registered == null && entry.slot == null)) &&
      nowSeconds < entry.draw.drawTimeSeconds,
  );
}

/**
 * The draw whose prize this person can claim right now, or `undefined`.
 *
 * Requires an unclaimed winner entry, a live `Claiming` status and a claim
 * window that has not shut — exactly the guards in
 * `indiv_pallet_airdrop::do_claim`, so a caller never submits a doomed
 * extrinsic. The earliest closing window wins, since it is the one about to
 * be lost.
 */
export function claimableDraw(
  standing: AirdropStanding,
  nowSeconds: number,
): AirdropParticipation | undefined {
  return standing.participations
    .filter(
      (entry) =>
        entry.winner === true &&
        entry.draw.status === "Claiming" &&
        nowSeconds < entry.draw.endTimeSeconds,
    )
    .sort((a, b) => a.draw.endTimeSeconds - b.draw.endTimeSeconds)[0];
}
