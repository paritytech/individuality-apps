// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {
  HumanityCardSnapshot,
  HumanityCardState,
} from "@humanity/shared/card/humanity-card-state.ts";
import type { PersonRingStanding } from "@humanity/shared/chain/ring-membership.ts";
import { parseHumanityUserId } from "@humanity/shared/identity/humanity-user-id.ts";

export interface UsernameClaimCard {
  kind: "card";
  primaryUsername: string;
  accountAddress: string;
  state: HumanityCardState;
  snapshot: HumanityCardSnapshot;
  membershipStanding?: PersonRingStanding | null;
}

/**
 * The person's Membership key is in a ring the chain has not rebuilt since it
 * was added: the card already says member, but the root every personhood
 * proof is checked against does not hold the key yet, so the host answers
 * `KeyNotInRing` and a username claim cannot even start. People's worker
 * rebuilds a stale ring within a few blocks; until then the person is still
 * being made a member, and nothing should offer them a name.
 */
export function membershipRootPending(
  card: Pick<UsernameClaimCard, "membershipStanding"> | { kind: string } | undefined,
): boolean {
  const standing =
    card != null && "membershipStanding" in card ? card.membershipStanding : null;
  if (standing?.position.kind !== "included" || standing.ring == null) return false;
  return standing.ring.includedKeys <= standing.position.ringPosition;
}

export type UsernameClaimTarget =
  | {
      kind: "available";
      accountAddress: string;
      currentLiteUsername: string;
      suggestedUsername: string;
    }
  | { kind: "already-claimed" }
  | { kind: "not-ready" };

/** Resolve whether a direct username-claim link may expose the mutation.
 *
 * A bare URL is never authority: the live card must be a Member — through the
 * game, ring inclusion, or verified full-ring inclusion (faucet) — and still
 * carry a lite `.<digits>` username. How the person became a Member says
 * nothing about their name: the numbered suffix is the evidence that no full
 * name was registered anywhere. The runtime remains the final authority when
 * the transaction is submitted.
 */
export function usernameClaimTarget(
  card: UsernameClaimCard | { kind: "account-unavailable" } | undefined,
  fullPersonhood = false,
): UsernameClaimTarget {
  if (card?.kind !== "card") return { kind: "not-ready" };

  const identity = parseHumanityUserId(card.primaryUsername);
  if (identity?.isUpgraded === true) return { kind: "already-claimed" };
  if (identity == null || (!fullPersonhood && card.state.kind !== "member")) {
    return { kind: "not-ready" };
  }
  if (membershipRootPending(card)) return { kind: "not-ready" };

  return {
    kind: "available",
    accountAddress: card.accountAddress,
    currentLiteUsername: identity.username,
    // The numbered name without its number, cut down to what a full name
    // may hold (a to z), so the default on offer is always a shape the
    // chain accepts; availability is still the chain's to say.
    suggestedUsername: identity.username.replace(/\.\d+$/, "").toLowerCase().replace(/[^a-z]/g, ""),
  };
}
