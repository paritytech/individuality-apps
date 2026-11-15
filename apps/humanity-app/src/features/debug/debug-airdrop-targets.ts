// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pure targeting for the people-airdrops mutation triggers.
 *
 * The panel receives the same `AirdropStanding` the prize page reads, so a
 * trigger can offer the draws this person can actually act on instead of
 * asking anyone to guess a draw index. Prefills come from `pendingRegistrations`
 * and `claimableDraw` — the domain helpers whose guards mirror
 * `indiv_pallet_airdrop`'s own — so a prefilled submission is never a doomed
 * extrinsic.
 *
 * React-free so the targeting stays unit-testable, and chain-free so the panel
 * still only acts on state the page already saw.
 */
import {
  claimableDraw,
  pendingRegistrations,
  type AirdropParticipation,
  type AirdropStanding,
  type Hex32,
} from "@individuality/daily-dollar";

import type { MutationBlocked } from "./debug-mutations.ts";
import type { DebugPageInput } from "./debug-view.ts";

export type AirdropTarget =
  | { kind: "ready"; standing: AirdropStanding }
  | MutationBlocked;

/**
 * Whether the airdrop triggers can act at all.
 *
 * A context mismatch is called out specifically because it is invisible in the
 * draw list and fatal to both calls: the account's single contextual alias
 * belongs to another pallet's context, so every derived slot is wrong and the
 * runtime rejects `register`/`claim` with `BadOrigin`.
 */
export function airdropTarget(input: DebugPageInput): AirdropTarget {
  const { airdrops, airdropsPending, airdropsError } = input;
  if (airdrops == null) {
    if (airdropsError != null) return { kind: "blocked", reason: "standing read failed" };
    return {
      kind: "blocked",
      reason: airdropsPending ? "standing still loading" : "no standing read yet",
    };
  }
  if (!airdrops.contextMatches && airdrops.aliasContext != null) {
    return {
      kind: "blocked",
      reason:
        "alias belongs to another pallet's context — register/claim would be BadOrigin",
    };
  }
  return { kind: "ready", standing: airdrops };
}

/** The draws `useAutoRegisterDraws` would have swept, as an editable list.
 *  Space-separated draw indices, since `parseDrawRefs` accepts either shape. */
export function registerPrefill(
  standing: AirdropStanding,
  nowSeconds: number,
): string {
  return pendingRegistrations(standing, nowSeconds)
    .map((entry) => entry.draw.drawIndex.toString())
    .join(" ");
}

/**
 * Every draw open for registration right now, oldest first, whether or not
 * this account is already in it: the debug panel's one-tap targets. Sending
 * one this account is in is the operator's call - the chain refuses it.
 */
export function openDraws(
  standing: AirdropStanding,
  nowSeconds: number,
): { eventId: Hex32; drawIndex: bigint; registered: boolean | null; closesAt: number }[] {
  return standing.participations
    .filter(({ draw }) => draw.status === "Registering" && nowSeconds < draw.drawTimeSeconds)
    .map(({ draw, registered }) => ({
      eventId: draw.eventId,
      drawIndex: draw.drawIndex,
      registered,
      closesAt: draw.drawTimeSeconds,
    }))
    .sort((a, b) => (a.drawIndex < b.drawIndex ? -1 : 1));
}

/** The one draw whose prize is claimable right now, if any. */
export function claimPrefill(
  standing: AirdropStanding,
  nowSeconds: number,
): string {
  const claimable = claimableDraw(standing, nowSeconds);
  return claimable == null ? "" : claimable.draw.drawIndex.toString();
}

/** The prize of the newest draw this person won, in base units — the amount
 *  a claim just moved into the airdrop account and a top-up would move on.
 *  Empty when no won draw is on the standing. */
export function topUpPrefill(standing: AirdropStanding): string {
  const won = standing.participations
    .filter((entry) => entry.winner === true || entry.claimed === true)
    .sort((a, b) => (a.draw.drawIndex < b.draw.drawIndex ? 1 : -1));
  return won[0] == null ? "" : won[0].draw.prizeAmount.toString();
}

/**
 * The standing's participation for `eventId`, or `null`.
 *
 * `claim` is routed through the production hook, which banks the payout against
 * a participation — so a claim is only offered for a draw the page actually
 * read. Submitting one for an unread draw would leave the winnings ledger
 * describing a prize this session never observed.
 */
export function findParticipation(
  standing: AirdropStanding,
  eventId: Hex32,
): AirdropParticipation | null {
  return (
    standing.participations.find((entry) => entry.draw.eventId === eventId) ?? null
  );
}
