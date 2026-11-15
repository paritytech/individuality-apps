// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState } from "react";

import { watchPayoutBalances } from "@features/airdrops/chain/payout-balance.ts";
import type { AirdropStanding } from "@individuality/daily-dollar";

/** The prize asset the latest draw pays in; `null` until a draw exists. */
export function latestPrizeAssetId(standing: AirdropStanding | undefined): unknown {
  const participations = standing?.participations;
  if (participations == null || participations.length === 0) return null;
  return participations.reduce((latest, entry) =>
    entry.draw.drawIndex > latest.draw.drawIndex ? entry : latest,
  ).draw.assetId;
}

/**
 * Keep the payout/airdrop balance poll running while the panel is. Like
 * `useCoinageBalanceWatch`, the values land in module diagnostics that
 * `withChainDiagnostics` reads; the returned counter only exists to repaint.
 */
export function usePayoutBalanceWatch(open: boolean, assetId: unknown): number {
  const [tick, setTick] = useState(0);
  const asset = useRef(assetId);
  asset.current = assetId;
  const assetKey = JSON.stringify(assetId ?? null, (_, value: unknown) =>
    typeof value === "bigint" ? `${value}n` : value,
  );

  useEffect(() => {
    if (!open) return;
    return watchPayoutBalances(asset.current, () => setTick((n) => n + 1));
  }, [open, assetKey]);

  return tick;
}
