// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";

import {
  claimableDraw,
  type AirdropStanding,
  type Hex32,
} from "@individuality/daily-dollar";
import { useClaimAirdropPrize } from "@features/airdrops/hooks/use-claim-airdrop-prize.ts";
import { hasPendingDailyClaim } from "@features/prize/chain/pending-daily-claim.ts";
import { useDailyPrizeSettlementState } from "@features/prize/hooks/use-prize-winnings.ts";

/** Event ids claimed this session, shared by every instance so reopening the
 *  daily screen never submits the same claim twice. */
const attemptedEventIds = new Set<Hex32>();

/**
 * Submits the claim for a won draw once the daily screen showing it is open;
 * mounted only by that screen, so nothing claims in the background. The
 * settlement runs behind the scratch reveal. One attempt per draw per
 * session; a failed attempt is retried only through the card's CTA. A draw
 * with a pending-claim marker (broadcast seen, inclusion not) or already
 * settled in the winnings ledger is never resubmitted.
 */
export function useAutoClaimDraws(
  standing: AirdropStanding | undefined,
  accountAddress: string,
  enabled: boolean,
): void {
  const claim = useClaimAirdropPrize(accountAddress);
  const target =
    enabled && standing != null && accountAddress !== ""
      ? claimableDraw(standing, Math.floor(Date.now() / 1000))
      : undefined;
  const eventId = target?.draw.eventId ?? null;
  const settlement = useDailyPrizeSettlementState(accountAddress, eventId);

  useEffect(() => {
    if (target == null || eventId == null) return;
    if (settlement.isPending || settlement.settled) return;
    if (attemptedEventIds.has(eventId)) return;
    if (hasPendingDailyClaim(eventId, accountAddress)) return;
    attemptedEventIds.add(eventId);
    claim.claim(target);
  }, [target, eventId, accountAddress, settlement.isPending, settlement.settled, claim]);
}

/** Exposed for tests so each case can reset the cross-instance state. */
export function __resetAutoClaimForTests(): void {
  attemptedEventIds.clear();
}
