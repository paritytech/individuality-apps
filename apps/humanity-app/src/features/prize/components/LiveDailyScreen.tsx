// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Live scratch-off screen for manager-scheduled people-airdrop draws.
 *
 *  Opening it is what submits the claim for a won draw (`useAutoClaimDraws`);
 *  nothing claims while it is closed. The after-block reflects the real
 *  claim outcome (pending / included / unknown) rather than pretending the
 *  reveal settled before the transaction did.
 *
 *  The surface is the resolved `LiveSurface`; it carries the event id of
 *  the in-flight draw so the ledgers the screen reads stay keyed by it. */
import { useRef, useState } from "react";

import {
  claimableDraw,
  type AirdropStanding,
} from "@individuality/daily-dollar";
import { applyScratched } from "@humanity/shared/airdrops/domain/daily-dollar-registry.ts";
import { updateDailyDollarRegistry } from "@humanity/shared/airdrops/storage/daily-dollar-registry-store.ts";
import { useClaimAirdropPrize } from "@features/airdrops/hooks/use-claim-airdrop-prize.ts";
import { useAutoClaimDraws } from "@features/airdrops/hooks/use-auto-claim-draws.ts";
import { hasPendingDailyClaim } from "@features/prize/chain/pending-daily-claim.ts";
import { recordDailyScratch } from "@features/prize/chain/daily-scratch-log.ts";
import type { LiveSurface } from "@features/prize/domain/live-prize-surface.ts";
import { useRefreshDailyScratch, useDailyPrizeScratchState } from "@features/prize/hooks/use-daily-scratch.ts";
import { useDailyPrizeSettlementState } from "@features/prize/hooks/use-prize-winnings.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

import {
  DailyPrizeScreen,
  type DailyPrizeClaimState,
} from "./DailyPrizeScreen.tsx";
import { LivePrizeEmptyState } from "./LivePrizeEmptyState.tsx";

const logger = loggerFor("prize", "live-daily-screen");

export interface LiveDailyScreenProps {
  standing: AirdropStanding | undefined;
  surface: LiveSurface;
  /** The HUMAN identity account (the card's account) — the ledger that
   *  accumulates winnings is keyed by this, not the payout account. */
  accountAddress: string;
  onBack: () => void;
}

export function LiveDailyScreen({
  standing,
  surface,
  accountAddress,
  onBack,
}: LiveDailyScreenProps) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claimable =
    standing == null ? undefined : claimableDraw(standing, nowSeconds);
  // Keep the ticket identity after a successful claim removes the runtime's
  // winner entry. The surface still knows which claimed draw is being shown,
  // and the settlement/scratch ledgers must remain keyed to that draw so the
  // revealed card settles as a win instead of losing its state mid-animation.
  const eventId =
    surface.kind === "ticket"
      ? surface.eventId
      : claimable?.draw.eventId ?? null;
  const refreshScratch = useRefreshDailyScratch();
  const scratch = useDailyPrizeScratchState(accountAddress, eventId);
  const settlement = useDailyPrizeSettlementState(accountAddress, eventId);
  const claim = useClaimAirdropPrize(accountAddress);
  useAutoClaimDraws(
    standing,
    accountAddress,
    surface.kind === "ticket" && surface.outcome === "win",
  );
  const [revealedHere, setRevealedHere] = useState(false);
  // Latched at open so a scratch record landing mid-scratch cannot re-mount
  // the card exposed under the user's finger. Settlement is deliberately not
  // part of this: the claim can bank a win before the foil comes off, and a
  // banked win still owes the user their scratch.
  const scratchedAtOpen = useRef<boolean | null>(null);

  if (surface.kind === "empty") {
    return <LivePrizeEmptyState message={surface.message} onBack={onBack} />;
  }
  if (scratch.isPending || settlement.isPending) return null;
  scratchedAtOpen.current ??= scratch.scratched;
  const alreadyExposed = scratchedAtOpen.current;

  const claimStatus = eventId == null ? null : claim.statusFor(eventId);
  // Per-draw, never per-account: the `pending-daily-claim` marker already
  // encodes the broadcast hash so an unresolved claim keeps this screen
  // locked across reloads.
  const pendingClaimRecord = eventId == null
    ? false
    : hasPendingDailyClaim(eventId, accountAddress);
  const claimed = (claimStatus?.included ?? false) || settlement.settled;
  const unknown = (claimStatus?.unknown ?? false) || pendingClaimRecord;

  const handleRevealed = () => {
    setRevealedHere(true);
    if (eventId == null) return;
    void recordDailyScratch(accountAddress, eventId).then(() =>
      refreshScratch(accountAddress, eventId),
    );
    // The daily-dollar registry is keyed by the AIRDROP subaccount, which is
    // `standing.accountAddress` - not the human identity account this screen
    // takes as a prop. Fire-and-forget: the marker only stops reminders about
    // an opened ticket, and a failed write must never stand
    // between a finger and the card underneath it.
    const registryAccount = standing?.accountAddress;
    if (registryAccount == null || registryAccount === "") return;
    void updateDailyDollarRegistry(registryAccount, (registry) =>
      applyScratched(registry, eventId, Math.floor(Date.now() / 1000)),
    ).catch((error: unknown) => {
      logger.error("scratch marker write failed: {error}", { error });
    });
  };

  // Already consumed for this draw: no second card. Two exceptions keep a
  // real result on screen — a won-but-unclaimed draw (hiding it would
  // strand real money) and a card revealed in this very mount, whose
  // scratch record must not replace the result before the CTA is reachable.
  const awaitingClaim =
    surface.outcome === "win" && !claimed && !unknown;
  if (alreadyExposed && !awaitingClaim && !settlement.settled && !revealedHere) {
    return (
      <LivePrizeEmptyState
        message="You've already opened today's dollar. Come back when the next draw opens."
        onBack={onBack}
      />
    );
  }

  // The claim was submitted when this screen opened; the CTA only retries a
  // failed attempt.
  const claimState: DailyPrizeClaimState | undefined =
    surface.outcome === "win"
      ? {
          pending: claimStatus?.pending ?? false,
          claimed,
          unknown,
          failed: claimStatus?.error != null,
          onClaim: () => {
            if (
              claimable != null &&
              !(claimStatus?.pending ?? false) &&
              !claimed &&
              !unknown
            ) {
              claim.claim(claimable);
            }
          },
        }
      : undefined;

  return (
    <DailyPrizeScreen
      ticket={{
        outcome: surface.outcome,
        ...surface.labels,
      }}
      onDone={onBack}
      claim={claimState}
      onRevealed={handleRevealed}
      revealed={alreadyExposed}
    />
  );
}
