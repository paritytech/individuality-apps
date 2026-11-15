// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { skipToken, useMutationState, useQuery } from "@tanstack/react-query";

import {
  clearFailedUsernameUpgrade,
  clearPendingUsernameUpgrade,
  getUsernameUpgradeStateVersion,
  markPendingUsernameUpgradeIncluded,
  readFailedUsernameUpgrade,
  readPendingUsernameUpgrade,
  recordFailedUsernameUpgrade,
  subscribeUsernameUpgradeState,
  type FailedUpgradeRecord,
  type PendingUpgradeRecord,
} from "@features/card/chain/pending-username-upgrade.ts";
import type {
  UpgradeLiteUsernameArgs,
  UpgradeLiteUsernameResult,
} from "@features/card/chain/upgrade-lite-username.ts";
import { USERNAME_UPGRADE_MUTATION_KEY } from "@features/card/hooks/use-lite-username-upgrade.ts";
import type { ResolvedHumanityCard } from "@humanity/shared/card/humanity-card-data.ts";
import { linkedCardIdentity } from "@humanity/shared/card/linked-card-identity.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import { CHAIN_READ_TIMEOUT_MS } from "@humanity/shared/chain/bounded-read.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import {
  parseHumanityUserId,
  type HumanityUserId,
} from "@humanity/shared/identity/humanity-user-id.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";

const logger = loggerFor("card", "username-upgrade-marker");

const READ_TIMEOUT_MESSAGE = "Timed out reading the best block.";

/** One People Chain block. */
const BEST_POLL_INTERVAL_MS = 12_000;

/**
 * How long a broadcast marker may be missing from best before it is called
 * dead. Inclusion normally lands in ~6–12 s; a reload inside this window must
 * not fail a transaction that is still on its way into a block.
 */
export const BROADCAST_GRACE_MS = 60_000;

export type BestBlockClaim = "present" | "absent";

function usernameUpgradeBestKey(address: string, txHash: string) {
  return ["chain", "username-upgrade-best", address, txHash] as const;
}

function useUsernameUpgradeStateVersion(): number {
  return useSyncExternalStore(
    subscribeUsernameUpgradeState,
    getUsernameUpgradeStateVersion,
    getUsernameUpgradeStateVersion,
  );
}

/** Newest unexpired upgrade marker for `address`, stable until the marker store changes. */
export function usePendingUsernameUpgradeRecord(
  address: string | undefined,
): PendingUpgradeRecord | null {
  const version = useUsernameUpgradeStateVersion();
  return useMemo(
    () => (address ? readPendingUsernameUpgrade(address) : null),
    [address, version],
  );
}

/** The last claim for `address` that best-block reconciliation found dead. */
export function useFailedUsernameUpgrade(
  address: string | undefined,
): FailedUpgradeRecord | null {
  const version = useUsernameUpgradeStateVersion();
  return useMemo(
    () => (address ? readFailedUsernameUpgrade(address) : null),
    [address, version],
  );
}

/**
 * Checks a claim against the best block and settles the marker. The only
 * place reconciliation acts, so concurrent card observers sharing the query
 * cannot double-fail a claim.
 *
 * A claim already seen in a best block is not failed on one read that lacks
 * it: best can briefly sit on a fork without the block, or lag the inclusion
 * event, and the transaction is still in the pool to be included again. Only
 * a different full name on the account — which rules this one out for good —
 * finality (`onFinalized`) or era expiry retires an included marker. A bare
 * broadcast keeps its grace period, then fails.
 */
export async function reconcileUsernameUpgradeAtBest(
  address: string,
  txHash: string,
  fullUsername: string,
  hostIdentity: HumanityUserId,
): Promise<BestBlockClaim> {
  const { api } = await getPeopleClient();
  const consumer = await withTimeout(
    api.query.Resources.Consumers.getValue(address, { at: "best" }),
    CHAIN_READ_TIMEOUT_MS,
    READ_TIMEOUT_MESSAGE,
  );
  const linked = linkedCardIdentity(hostIdentity, consumer?.full_username);
  const claim: BestBlockClaim =
    linked.isUpgraded && linked.username === fullUsername ? "present" : "absent";

  // The marker may have been retired or replaced while the read was in flight.
  const record = readPendingUsernameUpgrade(address);
  if (record?.txHash !== txHash) return claim;

  if (claim === "present") {
    if (record.phase === "broadcast") markPendingUsernameUpgradeIncluded(address, txHash);
    return claim;
  }
  const otherNameTaken = linked.isUpgraded;
  const broadcastLapsed =
    record.phase === "broadcast" && Date.now() - record.broadcastAt > BROADCAST_GRACE_MS;
  if (otherNameTaken || broadcastLapsed) {
    clearPendingUsernameUpgrade(address, txHash);
    // The failed record is what the claim screen shows; nothing else tells.
    recordFailedUsernameUpgrade(address, record.fullUsername);
    logger.warning("username claim {txHash} did not land at best; marked failed", {
      txHash,
    });
  } else if (record.phase === "included") {
    logger.warning(
      "username claim {txHash} was included but best lacks it now; keeping the name until finality decides",
      { txHash },
    );
  }
  return claim;
}

/**
 * The full name a claim submitted from this tab saw included, for `address`.
 * The marker store is the shared record of that moment, but the card must
 * wear the name from the success itself: whatever happens to the marker
 * afterwards, the person watched this claim land. A claim later found failed
 * gives the name back.
 */
function useIncludedClaimInThisTab(
  address: string | undefined,
  failed: FailedUpgradeRecord | null,
): string | null {
  const included = useMutationState<string | null>({
    filters: { mutationKey: USERNAME_UPGRADE_MUTATION_KEY, status: "success" },
    select: (mutation) => {
      const data = mutation.state.data as UpgradeLiteUsernameResult | undefined;
      const variables = mutation.state.variables as UpgradeLiteUsernameArgs | undefined;
      return data?.status === "included" &&
        variables != null &&
        variables.expectedLiteAddress === address
        ? variables.fullUsername
        : null;
    },
  });
  if (address == null || failed != null) return null;
  // Mutations list oldest first; the newest included claim is the name.
  for (let index = included.length - 1; index >= 0; index -= 1) {
    const name = included[index];
    if (name != null) return name;
  }
  return null;
}

function withIncludedUpgrade(
  card: ResolvedHumanityCard,
  fullUsername: string,
  hostIdentity: HumanityUserId | null | undefined,
): ResolvedHumanityCard {
  const base = parseHumanityUserId(card.primaryUsername) ?? hostIdentity;
  if (base == null) return card;
  const linked = linkedCardIdentity(base, new TextEncoder().encode(fullUsername));
  if (!linked.isUpgraded) return card;
  return {
    ...card,
    primaryUsername: linked.primaryUsername,
    snapshot: { ...card.snapshot, isUpgradedIdentity: true },
  };
}

/**
 * Shows a claim included at best before the finalized card read catches up,
 * reconciles its marker against best while it waits, and retires the marker
 * once the finalized card reports the upgrade. The name comes from the
 * included marker, or failing that from this tab's own included claim.
 */
export function useUsernameUpgradeOverlay(
  card: HumanityCardResult | undefined,
  hostIdentity: HumanityUserId | null | undefined,
  enabled = true,
): HumanityCardResult | undefined {
  const resolved = card?.kind === "card" ? card : null;
  const address = resolved?.accountAddress;
  const finalizedUpgraded = resolved?.snapshot.isUpgradedIdentity === true;
  const record = usePendingUsernameUpgradeRecord(address);
  const failed = useFailedUsernameUpgrade(address);
  const claimInFlight =
    useMutationState({
      filters: { mutationKey: USERNAME_UPGRADE_MUTATION_KEY, status: "pending" },
    }).length > 0;

  useEffect(() => {
    if (address == null || !finalizedUpgraded) return;
    if (record != null) clearPendingUsernameUpgrade(address, record.txHash);
    if (failed != null) clearFailedUsernameUpgrade(address);
  }, [address, finalizedUpgraded, record, failed]);

  const reconcileIdentity =
    resolved == null
      ? null
      : (parseHumanityUserId(resolved.primaryUsername) ?? hostIdentity ?? null);
  useQuery<BestBlockClaim>({
    queryKey: usernameUpgradeBestKey(address ?? "", record?.txHash ?? ""),
    enabled: enabled && !finalizedUpgraded && !claimInFlight,
    retry: false,
    staleTime: 0,
    refetchInterval: BEST_POLL_INTERVAL_MS,
    queryFn:
      address == null || record == null || reconcileIdentity == null
        ? skipToken
        : () =>
            reconcileUsernameUpgradeAtBest(
              address,
              record.txHash,
              record.fullUsername,
              reconcileIdentity,
            ),
  });

  const tabIncludedUsername = useIncludedClaimInThisTab(address, failed);
  const includedUsername =
    record?.phase === "included" ? record.fullUsername : tabIncludedUsername;
  return useMemo(
    () =>
      resolved == null || finalizedUpgraded || includedUsername == null
        ? card
        : withIncludedUpgrade(resolved, includedUsername, hostIdentity),
    [card, resolved, finalizedUpgraded, includedUsername, hostIdentity],
  );
}
