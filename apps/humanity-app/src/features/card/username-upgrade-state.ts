// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {
  UpgradeLiteUsernameArgs,
  UpgradeLiteUsernameResult,
} from "@features/card/chain/upgrade-lite-username.ts";
import type { UsernameUpgradeAction } from "@features/card/components/index.ts";

/** Keep mutation state attached to the account that submitted it. */
export function scopeUpgradeState(
  mutation: {
    isPending: boolean;
    data?: UpgradeLiteUsernameResult;
    variables?: UpgradeLiteUsernameArgs;
  },
  expectedLiteAddress: string,
  persistedUpgrade: boolean,
): Omit<UsernameUpgradeAction, "onSubmit"> {
  const isCurrent =
    mutation.variables?.expectedLiteAddress === expectedLiteAddress;
  const result = isCurrent ? mutation.data : undefined;
  // An included claim keeps its pending marker until finality; that marker
  // guards a reload or a reorg, not the screen that just saw it land.
  const confirmed = result?.status === "included";
  return {
    pending: isCurrent && mutation.isPending,
    unknown: !confirmed && (result?.status === "unknown" || persistedUpgrade),
    confirmed,
  };
}
