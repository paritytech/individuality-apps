// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getAccountsProvider } from "@humanity/shared/chain/host-api.ts";
import {
  resolveHumanityUserId,
  type HumanityUserId,
} from "@humanity/shared/identity/humanity-user-id.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";
import { cardLoad } from "@features/card/telemetry/card-load.ts";

const logger = loggerFor("identity", "user-id");
const HUMANITY_USER_ID_QUERY_KEY = ["chain", "humanity-user-id"] as const;
const HOST_ID_TIMEOUT_MS = 30_000;

/**
 * Resolves the connected user's primary DotNS identity as its own query so
 * the card can key on it: the connection subscription clears the cached
 * identity on disconnect and refreshes it on reconnect, so a user switch
 * never serves a stale card. Kept apart from `useHumanityCard` so the card
 * hook stays under the file ceiling.
 */
export function useHumanityUserId(enabled: boolean) {
  const queryClient = useQueryClient();
  const previousStatus = useRef<"Connected" | "Disconnected" | null>(null);

  useEffect(() => {
    if (!enabled) {
      previousStatus.current = null;
      return;
    }

    let active = true;
    let unsubscribe: (() => void) | undefined;
    let removeInterrupt: (() => void) | undefined;
    let lifecycleVersion = 0;
    const clearIdentity = () => {
      const version = ++lifecycleVersion;
      void queryClient
        .cancelQueries({
          queryKey: HUMANITY_USER_ID_QUERY_KEY,
          exact: true,
        })
        .then(() => {
          if (active && version === lifecycleVersion) {
            queryClient.setQueryData(HUMANITY_USER_ID_QUERY_KEY, null);
          }
        });
    };
    void getAccountsProvider().then((provider) => {
      if (!active || provider == null) return;
      const subscription = provider.subscribeAccountConnectionStatus((status) => {
        // A cleared identity is the "account isn't available" screen, so the
        // event behind it is worth a line.
        logger.debug("account connection status {status}", { status });
        if (status === "Disconnected") {
          clearIdentity();
        } else {
          lifecycleVersion += 1;
          if (previousStatus.current === "Disconnected") {
            void queryClient.invalidateQueries({
              queryKey: HUMANITY_USER_ID_QUERY_KEY,
              exact: true,
            });
          }
        }
        previousStatus.current = status;
      });
      unsubscribe = () => subscription.unsubscribe();
      // An interrupted stream says nothing about the person: the host still
      // answers `getUserId` with whoever is connected, so ask it again rather
      // than drop to the "account isn't available" screen on a transport
      // hiccup. A real disconnect arrives as a status, above.
      removeInterrupt = subscription.onInterrupt(() => {
        logger.warning("account connection subscription interrupted; re-reading the identity");
        if (active) {
          void queryClient.invalidateQueries({
            queryKey: HUMANITY_USER_ID_QUERY_KEY,
            exact: true,
          });
        }
      });
    });

    return () => {
      active = false;
      removeInterrupt?.();
      unsubscribe?.();
    };
  }, [enabled, queryClient]);

  return useQuery<HumanityUserId | null>({
    queryKey: HUMANITY_USER_ID_QUERY_KEY,
    enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: () => {
      cardLoad.stage("identity");
      return withTimeout(
        resolveHumanityUserId(),
        HOST_ID_TIMEOUT_MS,
        "Host identity did not respond in time.",
      );
    },
  });
}
