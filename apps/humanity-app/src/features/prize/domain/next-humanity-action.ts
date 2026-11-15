// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { UsernameClaimTarget } from "@humanity/shared/card/username-claim.ts";
import type { HumanityAction } from "@shared/navigation/humanity-action.ts";

export interface HumanityActionState {
  ready: boolean;
  usernameTarget: UsernameClaimTarget;
  dismissed: readonly HumanityAction[];
}

export interface HumanityActionQueries {
  card: { isPending: boolean };
}

/** The card read decides whether a username claim is on offer; nothing else
 * has to settle before the launch route is chosen. */
export function humanityActionQueriesReady({ card }: HumanityActionQueries): boolean {
  return !card.isPending;
}

/** Resolve the next action on a plain Humanity launch. Only the durable
 * username upgrade opens on its own; the daily dollar waits on the home for
 * the person to come to it. Explicit routes bypass this. */
export function nextHumanityAction({
  ready,
  usernameTarget,
  dismissed,
}: HumanityActionState): HumanityAction | null {
  if (!ready) return null;
  if (
    usernameTarget.kind === "available" &&
    !dismissed.includes("claim-username")
  ) {
    return "claim-username";
  }
  return null;
}
