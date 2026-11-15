// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";

import { hasPendingUsernameUpgrade } from "@features/card/chain/pending-username-upgrade.ts";
import { CHAIN_READ_TIMEOUT_MS } from "@humanity/shared/chain/bounded-read.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";


const READ_TIMEOUT_MESSAGE = "Timed out reading the finalized block.";

/** One People Chain block: a marker can only retire as the head advances. */
const HEAD_POLL_INTERVAL_MS = 12_000;

async function readFinalizedBlockNumber(): Promise<number> {
  const { client } = await getPeopleClient();
  const finalized = await withTimeout(
    client.getFinalizedBlock(),
    CHAIN_READ_TIMEOUT_MS,
    READ_TIMEOUT_MESSAGE,
  );
  return finalized.number;
}

/**
 * Whether an unconfirmed upgrade broadcast for `address` still gates a
 * resubmission, judged against `finalizedBlock` when it is known.
 *
 * Markers expire by transaction mortality, so only the finalized head can
 * retire one. An unknown head is not evidence that the broadcast died: the
 * marker keeps gating until a head that outlives its era arrives, because a
 * second submission would risk registering the name twice.
 */
export function pendingUpgradeLock(
  address: string,
  finalizedBlock?: number,
): boolean {
  if (address.length === 0) return false;
  return finalizedBlock == null
    ? hasPendingUsernameUpgrade(address)
    : hasPendingUsernameUpgrade(address, finalizedBlock);
}

/**
 * Reload-safe half of the lite-to-full upgrade lock: a broadcast this page
 * never saw settle still holds the name.
 *
 * The finalized head is polled only while a marker for `address` exists, so an
 * upgrade-free card never touches the chain, and the poll keeps running until
 * the head passes the marker's era and the chain helper drops the record.
 */
export function usePendingUsernameUpgrade(
  address: string,
  enabled = true,
): boolean {
  const head = useQuery({
    queryKey: ["chain", "pending-username-upgrade-head", address],
    enabled: enabled && pendingUpgradeLock(address),
    retry: false,
    staleTime: 0,
    refetchInterval: HEAD_POLL_INTERVAL_MS,
    queryFn: readFinalizedBlockNumber,
  });
  return pendingUpgradeLock(address, head.data);
}
