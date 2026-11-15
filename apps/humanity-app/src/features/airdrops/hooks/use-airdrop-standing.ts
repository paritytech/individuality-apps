// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { runBoundedChainRead } from "@humanity/shared/chain/bounded-read.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import type { QueryView } from "@shared/chain/query-view.ts";
import { resolveAirdropAccount } from "@humanity/shared/airdrops/chain/airdrop-account.ts";
import {
  type AirdropParticipation,
  type AirdropStanding,
  type Hex32,
} from "@individuality/daily-dollar";
import { loadAirdropStanding } from "@humanity/shared/airdrops/chain/airdrop-standing.ts";

/**
 * Stable prefix for the chain-standing query. The full key the query is
 * stored under is `[...AIRDROP_STANDING_QUERY_KEY, accountAddress]` so a
 * fresh `accountAddress` invalidates the cache as soon as the product
 * account changes.
 */
export const AIRDROP_STANDING_QUERY_KEY = ["chain", "airdrop-standing"] as const;

/**
 * Session-scoped memory of every draw this account has been seen winning,
 * keyed by the people-airdrop event id. Used to recover `claimed` only when
 * a later read sees the winner entry gone and the draw is post-`Claiming`
 * — the only signal distinguishing "claimed and removed" from "never won".
 *
 * This memory is lost on reload and on a brand-new tab: the standing view
 * will briefly claim `claimed: null` for a draw whose prize was already
 * collected in an earlier session. There is no on-chain history to reach
 * back into, so this is the honest ceiling.
 */
const winnersSeen: Record<Hex32, true> = {};

/** Statuses where a missing winner entry could plausibly mean a prior claim. */
const POST_CLAIM_STATUSES = new Set<string>([
  "Claiming",
  "ClearingRegistrations",
  "ClearingWinners",
  "Finalizing",
]);

function refineClaimed(participations: AirdropParticipation[]): AirdropParticipation[] {
  return participations.map((entry) => {
    if (entry.winner === true) {
      winnersSeen[entry.draw.eventId] = true;
      return entry;
    }
    if (
      entry.winner === false &&
      POST_CLAIM_STATUSES.has(entry.draw.status) &&
      winnersSeen[entry.draw.eventId] === true
    ) {
      return { ...entry, claimed: true };
    }
    return entry;
  });
}

/**
 * Resolve the dedicated host airdrop account once per mount. Outside a host container
 * (or before the host answers) this stays `null` and the query stays
 * disabled — the same way `useLiveDailyPrize` defers to `currentGame`.
 */
function useAirdropAccountAddress(): string | null {
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    resolveAirdropAccount()
      .then((acc) => {
        if (!cancelled) setAddress(acc?.address ?? null);
      })
      .catch(() => {
        if (!cancelled) setAddress(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return address;
}

/**
 * Refetch the standing whenever the best-block head changes. The 12 s poll
 * on the query is the fallback for a silent subscription.
 */
function useRefetchOnBestBlock(
  queryKey: readonly unknown[],
  enabled: boolean,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let subscription: { unsubscribe(): void } | undefined;
    let lastHash: string | null = null;
    void getPeopleClient().then(({ client }) => {
      if (cancelled) return;
      subscription = client.bestBlocks$.subscribe((blocks) => {
        const head = blocks[0]?.hash ?? null;
        if (head == null || head === lastHash) return;
        lastHash = head;
        void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
      });
    });
    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [enabled, queryClient, ...queryKey]);
}

/**
 * Airdrop standing for the dedicated airdrop account, pinned to the best block
 * and refetched on every new best block; a 12 s poll — also after an error,
 * so a transient RPC failure self-heals — is the fallback.
 *
 * `enabled === false` is also used when no product account exists yet (the
 * prize and card features share the same gate); the hook returns a pending
 * `QueryView` instead of starting a read.
 */
export function useAirdropStanding(enabled: boolean): QueryView<AirdropStanding> {
  const accountAddress = useAirdropAccountAddress();
  const queryKey = [...AIRDROP_STANDING_QUERY_KEY, accountAddress ?? "no-account"] as const;
  const live = enabled && accountAddress != null;
  useRefetchOnBestBlock(queryKey, live);

  const query = useQuery<AirdropStanding>({
    queryKey,
    enabled: live,
    retry: false,
    refetchInterval: 12_000,
    refetchIntervalInBackground: true,
    queryFn: ({ signal }): Promise<AirdropStanding> =>
      runBoundedChainRead(
        signal,
        async (childSignal): Promise<AirdropStanding> => {
          if (accountAddress == null) {
            throw new Error("Airdrop standing read needs a product account");
          }
          const standing = await loadAirdropStanding(accountAddress, childSignal);
          return { ...standing, participations: refineClaimed(standing.participations) };
        },
      ),
  });

  return query;
}
