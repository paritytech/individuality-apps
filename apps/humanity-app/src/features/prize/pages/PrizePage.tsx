// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  LiveDailyScreen,
  LivePrizeEmptyState,
} from "@features/prize/components/index.ts";
import {
  DebugDailyScreen,
  isActiveDebugPrize,
} from "@features/prize/components/DebugDailyScreen.tsx";
import { PrizeDemoView } from "@features/prize/components/PrizeDemoView.tsx";
import { PrizeLiveHomeBlock } from "@features/prize/components/PrizeLiveHomeBlock.tsx";
import { dailyPrizeEntryAvailable } from "@features/prize/domain/daily-prize-entry.ts";
import { restoreSettledWin } from "@features/prize/domain/live-prize-surface.ts";
import { humanityActionQueriesReady } from "@features/prize/domain/next-humanity-action.ts";
import { parsePrizeDemoState } from "@features/prize/domain/prize-demo.ts";
import { useAirdropPrizePageData } from "@features/prize/hooks/use-airdrop-prize-page.ts";
import { useDailyPrizeSettlementState } from "@features/prize/hooks/use-prize-winnings.ts";
import { useDailyPrizeScratchState } from "@features/prize/hooks/use-daily-scratch.ts";
import { usePrizePageRouting } from "@features/prize/hooks/use-prize-page-routing.ts";
import type { PrizeScreen } from "@features/prize/hooks/use-prize-page-routing.ts";
import { useAutoOpenHumanityAction } from "@features/prize/hooks/use-auto-open-humanity-action.ts";
import { useOpenScratchFromLink } from "@features/prize/hooks/use-open-scratch-from-link.ts";
import { useCardPromotion } from "@features/card/hooks/use-card-promotion.ts";
import { useCardReady } from "@features/card/hooks/use-card-ready.ts";
import { Screen } from "@shared/components/chrome.tsx";
import { LoadSpinner } from "@shared/components/LoadSpinner.tsx";
import { useAutoRegisterPersonhood } from "@features/card/hooks/use-auto-register-personhood.ts";
import { useDotnsNameClaim } from "@features/card/hooks/use-dotns-name-claim.ts";
import type { OnboardingHintId } from "@features/card/storage/onboarding-hints-store.ts";
import { membershipRootPending, usernameClaimTarget } from "@humanity/shared/card/username-claim.ts";
import { mayClaimDaily } from "@features/card/domain/card-journey-hints.ts";
import { usePublishDebugInput, useDebugStore } from "@features/debug/debug-store.ts";
import { DEBUG_PANEL } from "@humanity/shared/config/debug-panel.ts";
import { blockingError } from "@shared/chain/query-state.ts";
import { envConfig } from "@humanity/shared/config/env.ts";
import { productDomain } from "@humanity/shared/identity/product-domain.ts";

/** How long the home may wait on this session's card read before it says so. */
const SPINNER_AFTER_MS = 2_500;

export interface PrizePageProps {
  /** DEV-only demo query; production ignores it. */
  demo?: string;
  /** DEV-only: show an onboarding hint on a fixture, by name or the next. */
  demoHint?: boolean | OnboardingHintId;
  /** The matched URL decides which product surface is visible. */
  routeScreen?: PrizeScreen;
}

export function PrizePage({ demo, demoHint = false, routeScreen = "home" }: PrizePageProps) {
  const demoState = parsePrizeDemoState(demo, import.meta.env.DEV);
  const isLive = demoState === "live";
  const live = useAirdropPrizePageData(isLive);
  // The card as it was when the person left, or as the persisted cache kept
  // it, is not the card now: nothing under it shows until a read of this
  // foreground session has landed, and the launch action waits the same.
  const { ready: cardReady } = useCardReady();
  const gameError = blockingError(live.gameQuery.error, live.gameQuery.data) != null;
  const debugPrizeState = useDebugStore((state) => state.prize);
  const settleDebugPrize = useDebugStore((state) => state.settlePrize);
  const debugPrize =
    DEBUG_PANEL && isActiveDebugPrize(debugPrizeState) ? debugPrizeState : null;
  const accountAddress =
    live.cardQuery.data?.kind === "card"
      ? live.cardQuery.data.accountAddress
      : "";
  const scratchEventId =
    live.surface.kind === "ticket" ? live.surface.eventId : null;
  const scratchState = useDailyPrizeScratchState(
    accountAddress,
    scratchEventId,
    isLive && debugPrize == null,
  );
  const settlementState = useDailyPrizeSettlementState(
    accountAddress,
    scratchEventId,
    isLive && debugPrize == null,
  );
  const liveSurface = restoreSettledWin(
    live.surface,
    settlementState.isPending,
    settlementState.settled,
  );
  const liveOutcome = liveSurface.kind === "ticket" ? liveSurface.outcome : null;
  const dailyPrizeAvailable =
    debugPrize != null
      ? !debugPrize.revealed
      : dailyPrizeEntryAvailable({
          scratched: scratchState.scratched,
          outcome: liveOutcome,
        });
  const { screen, openDaily, closeDaily } = usePrizePageRouting(
    demoState,
    routeScreen,
  );
  // The promotion lives here, beside the auto-open, so the name screen cannot
  // open over it: the moment of becoming a member comes first, and it offers
  // the name itself.
  const liveCardState =
    isLive && live.cardQuery.data?.kind === "card" ? live.cardQuery.data.state : undefined;
  // The moment comes at the threshold, before the ring key: the screen then
  // offers no name (`usernameClaimTarget` waits for the key and its root),
  // and the home says "Preparing your membership…" until the name is ready.
  // A card whose root is still pending is held back as before, so the move
  // from it to the covered root is never read as a new one.
  const promotion = useCardPromotion(
    membershipRootPending(live.cardQuery.data) ? undefined : liveCardState,
  );
  // Beside the promotion it feeds: once the card clears the threshold this
  // sends `Score.register`, and its landing is what turns the card member.
  const membershipNote = useAutoRegisterPersonhood(live.cardQuery.data, isLive);
  // And once the card shows a full username, the dotNS half of the claim:
  // `DotnsGateway.register_name`, for a name claimed here a moment ago or
  // one People has held since before the app registered names in dotNS.
  useDotnsNameClaim(live.cardQuery.data, isLive);
  // Opened from the scratch link (`open=scratch`): the scratch, once the
  // ticket is known, and nothing else over it while it is.
  const scratchLinkWaiting = useOpenScratchFromLink({
    enabled: routeScreen === "home" && isLive && promotion.promotion == null,
    ready:
      debugPrize != null ||
      (cardReady &&
        !live.cardQuery.isPending &&
        !live.standingQuery.isPending &&
        !scratchState.isPending),
    available:
      dailyPrizeAvailable &&
      (debugPrize != null || (liveCardState != null && mayClaimDaily(liveCardState))),
    openDaily,
  });
  useAutoOpenHumanityAction({
    enabled: routeScreen === "home" && isLive && promotion.promotion == null && !scratchLinkWaiting,
    ready: cardReady && humanityActionQueriesReady({ card: live.cardQuery }),
    usernameTarget: usernameClaimTarget(live.cardQuery.data),
  });

  usePublishDebugInput({
    network: envConfig.chain.network,
    productDomain: productDomain(),
    card: live.cardQuery.data,
    cardPending: live.cardQuery.isPending,
    cardError: live.cardQuery.error,
    game: live.gameQuery.data,
    gamePending: live.gameQuery.isPending,
    gameError: live.gameQuery.error,
    airdrops: live.standingQuery.data,
    airdropsPending: live.standingQuery.isPending,
    airdropsError: live.standingQuery.error,
  });

  if (demoState !== "live") {
    return (
      <PrizeDemoView
        demoState={demoState}
        screen={screen}
        openDaily={openDaily}
        closeDaily={closeDaily}
        hint={demoHint}
      />
    );
  }

  // Ahead of the live gates on purpose: a simulated ticket must not depend on
  // the card, game or airdrop reads resolving.
  if (debugPrize != null && screen === "daily") {
    return (
      <DebugDailyScreen
        key={debugPrize.ticket}
        prize={debugPrize}
        onSettle={settleDebugPrize}
        onBack={closeDaily}
      />
    );
  }

  // Nothing until the card is read: the home's own entrance brings it in, and
  // only a read slower than that shows the host's spinner. Only the home waits for this session's read. A screen the person left in
  // the middle of (a scratch, a result, the promotion) stays as it was on the
  // card it already had, and the read catches up underneath it.
  const holdsTheHome = screen !== "daily" && promotion.promotion == null;
  if (live.cardQuery.isPending || (holdsTheHome && !cardReady)) {
    return (
      <Screen>
        <div className="body-col" role="status">
          <span className="sr-only">Loading your Humanity card</span>
          <div className="load-wait">
            <LoadSpinner afterMs={SPINNER_AFTER_MS} />
          </div>
        </div>
      </Screen>
    );
  }

  if (live.cardQuery.data?.kind === "account-unavailable") {
    return (
      <LivePrizeEmptyState message="Your Humanity account isn't available here. Open Humanity in its host to view your card." />
    );
  }

  const cardResult = live.cardQuery.data;
  if (live.cardQuery.error != null || cardResult?.kind !== "card") {
    return (
      <LivePrizeEmptyState message="Your Humanity card isn't available right now." />
    );
  }

  if (screen === "daily") {
    if (!mayClaimDaily(cardResult.state)) {
      return (
        <LivePrizeEmptyState
          message="The daily dollar is available to Humanity members."
          onBack={closeDaily}
        />
      );
    }
    return (
      <LiveDailyScreen
        key={scratchEventId ?? "none"}
        standing={live.standing}
        surface={liveSurface}
        accountAddress={cardResult.accountAddress}
        onBack={closeDaily}
      />
    );
  }

  return (
    <PrizeLiveHomeBlock
      cardResult={cardResult}
      game={gameError ? null : live.gameQuery.data ?? null}
      gamePending={live.gameQuery.isPending}
      gameUnavailable={gameError}
      dailyPrizeAvailable={dailyPrizeAvailable}
      openDaily={openDaily}
      promotion={promotion}
      membershipNote={membershipNote}
      signUpUnderWay={live.signUpUnderWay}
    />
  );
}
