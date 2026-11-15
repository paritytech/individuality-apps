// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getAccountsProvider } from "@humanity/shared/chain/host-api.ts";
import { resolveGameAccountAddress } from "@humanity/shared/identity/game-account.ts";
import { cardLoad } from "@features/card/telemetry/card-load.ts";

const GAME_ACCOUNT_QUERY_KEY = ["host", "game-account"] as const;

/**
 * Resolves the account that plays the game as its own query, deliberately
 * NOT inside the card's chain read.
 *
 * It is a host call, not a chain call, and a host with no product-account
 * support never answers it. Folding that stall into `runBoundedChainRead`
 * spent the card's whole 8s deadline before the People reads even started
 * and turned a missing account into a card-wide error. Isolated here it costs
 * one bounded wait after the host has resolved the user's identity. A null or
 * failed answer is retried once when the host next becomes connected; a
 * resolved account remains cached for that identity for the session.
 */
export function useGameAccount(
  username: string | undefined,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const previousStatus = useRef<"Connected" | "Disconnected" | null>(null);
  const connectedWhilePending = useRef(false);
  const active = enabled && username != null;
  const queryKey = [...GAME_ACCOUNT_QUERY_KEY, username ?? null] as const;
  const gameAccountQuery = useQuery<string | null>({
    queryKey,
    enabled: active,
    retry: false,
    // The derivation is deterministic per signed-in user; re-asking a host
    // that already declined only repeats the stall.
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: () => {
      cardLoad.stage("game-account");
      return resolveGameAccountAddress();
    },
  });

  useEffect(() => {
    if (!active) {
      previousStatus.current = null;
      connectedWhilePending.current = false;
      return;
    }
    previousStatus.current = null;
    connectedWhilePending.current = false;

    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    void getAccountsProvider().then((provider) => {
      if (!mounted || provider == null) return;
      const subscription = provider.subscribeAccountConnectionStatus((status) => {
        if (
          status === "Connected" &&
          previousStatus.current !== "Connected"
        ) {
          const queryState = queryClient.getQueryState<string | null>(queryKey);
          if (queryState?.status === "pending") {
            connectedWhilePending.current = true;
          } else if (
            queryState != null &&
            queryState.data == null
          ) {
            void queryClient.invalidateQueries({
              queryKey,
              exact: true,
            });
          }
        }
        previousStatus.current = status;
      });
      unsubscribe = () => subscription.unsubscribe();
    });

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [active, queryClient, username]);

  useEffect(() => {
    if (
      !active ||
      !connectedWhilePending.current ||
      gameAccountQuery.isPending
    ) {
      return;
    }

    connectedWhilePending.current = false;
    if (gameAccountQuery.data == null) {
      void queryClient.invalidateQueries({
        queryKey,
        exact: true,
      });
    }
  }, [
    active,
    gameAccountQuery.data,
    gameAccountQuery.isPending,
    queryClient,
    username,
  ]);

  return gameAccountQuery;
}
