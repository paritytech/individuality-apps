// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";

import { watchCoinageBalance } from "@humanity/shared/chain/coinage-balance.ts";

/**
 * Keep the coinage balance subscription open while the panel is. Like
 * `useResourcesAliasProbe`, the values land in module diagnostics that
 * `withChainDiagnostics` reads; the returned counter only exists to repaint.
 */
export function useCoinageBalanceWatch(open: boolean): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    return watchCoinageBalance(() => setTick((n) => n + 1));
  }, [open]);

  return tick;
}
