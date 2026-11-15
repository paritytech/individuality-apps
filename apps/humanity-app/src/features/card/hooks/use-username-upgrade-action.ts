// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { UsernameUpgradeAction } from "@features/card/components/index.ts";
import { usernameClaimTarget } from "@humanity/shared/card/username-claim.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import { scopeUpgradeState } from "@features/card/username-upgrade-state.ts";
import { useLiteUsernameUpgrade } from "./use-lite-username-upgrade.ts";
import { usePendingUsernameUpgrade } from "./use-pending-username-upgrade.ts";
import { useFailedUsernameUpgrade } from "./use-username-upgrade-marker.ts";

/** Shared claim wiring for the promotion overlay and the deep-link page. */
export function useUsernameUpgradeAction(
  card: HumanityCardResult | undefined,
  enabled = true,
  fullPersonhood = false,
): {
  target: ReturnType<typeof usernameClaimTarget>;
  action: UsernameUpgradeAction | undefined;
} {
  const target = usernameClaimTarget(card, fullPersonhood);
  const accountAddress =
    target.kind === "available" ? target.accountAddress : "";
  const persistedUpgrade = usePendingUsernameUpgrade(accountAddress, enabled);
  const failed = useFailedUsernameUpgrade(accountAddress);
  const upgrade = useLiteUsernameUpgrade();

  const action =
    enabled && target.kind === "available"
      ? {
          ...scopeUpgradeState(upgrade, accountAddress, persistedUpgrade),
          identityKey: accountAddress,
          failedUsername: failed?.fullUsername,
          suggestedUsername: failed?.fullUsername ?? target.suggestedUsername,
          onSubmit: (fullUsername: string) =>
            upgrade.submit({
              expectedLiteAddress: accountAddress,
              currentLiteUsername: target.currentLiteUsername,
              fullUsername,
            }),
        }
      : undefined;

  return { target, action };
}
