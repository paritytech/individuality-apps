// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The debug panel as a full page (`/debug`), for when the sheet is too small
 * to read a table in. It runs the same live reads the card page runs and
 * publishes them itself, so the state shown is current rather than whatever
 * the card page last published before navigating away.
 *
 * Dev-only: the route exists only when `DEBUG_PANEL` folds on.
 */
import { Link } from "@tanstack/react-router";

import { useAirdropPrizePageData } from "@features/prize/hooks/use-airdrop-prize-page.ts";
import { envConfig } from "@humanity/shared/config/env.ts";
import { productDomain } from "@humanity/shared/identity/product-domain.ts";

import { DebugPanelBody } from "./DebugPanelBody.tsx";
import { usePublishDebugInput } from "./debug-store.ts";
import { useCoinageBalanceWatch } from "./use-coinage-balance.ts";
import { latestPrizeAssetId, usePayoutBalanceWatch } from "./use-payout-balance.ts";
import { useResourcesAliasProbe } from "./use-resources-alias.ts";

export function DebugPage() {
  const live = useAirdropPrizePageData(true);
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
  useResourcesAliasProbe(true);
  useCoinageBalanceWatch(true);
  usePayoutBalanceWatch(true, latestPrizeAssetId(live.standingQuery.data));

  return (
    <main className="debug-page" aria-label="Debug state">
      <header className="debug-page-header">
        <Link to="/" search={{ demo: undefined }} className="debug-chip">
          ← Back to Humanity
        </Link>
        <h1 className="debug-page-title">Debug state</h1>
      </header>
      <DebugPanelBody expandedAll />
    </main>
  );
}
