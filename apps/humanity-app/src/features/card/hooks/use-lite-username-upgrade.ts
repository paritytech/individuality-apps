// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  upgradeLiteUsername,
  UsernameUpgradeError,
  type UpgradeLiteUsernameArgs,
  type UpgradeLiteUsernameResult,
} from "@features/card/chain/upgrade-lite-username.ts";
import { usernameAvailabilityKey } from "@features/card/hooks/use-username-availability.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

const logger = loggerFor("card", "username-upgrade");

/** Shared so readers can tell a claim is in flight in this tab. */
export const USERNAME_UPGRADE_MUTATION_KEY = ["card", "username-upgrade"] as const;

export interface LiteUsernameUpgrade {
  isPending: boolean;
  data?: UpgradeLiteUsernameResult;
  variables?: UpgradeLiteUsernameArgs;
  /** Last submission failure, or `null`. Surfaced so a caller can report
   *  *why* an upgrade failed rather than only that it stopped being pending. */
  error: unknown;
  submit: (args: UpgradeLiteUsernameArgs) => void;
}

/**
 * Lite-to-full username upgrade mutation, exposing the `isPending`/`data`/
 * `variables` shape `scopeUpgradeState` scopes to the submitting account.
 */
export function useLiteUsernameUpgrade(): LiteUsernameUpgrade {
  const queryClient = useQueryClient();
  const refreshIdentity = () => {
    void queryClient.invalidateQueries({
      queryKey: ["chain", "humanity-user-id"],
    });
    void queryClient.invalidateQueries({
      queryKey: ["chain", "humanity-card"],
    });
  };
  const mutation = useMutation<
    UpgradeLiteUsernameResult,
    unknown,
    UpgradeLiteUsernameArgs
  >({
    mutationKey: USERNAME_UPGRADE_MUTATION_KEY,
    // Success shows on inclusion; the card wears the name from the marker
    // until the finalized read catches up, refreshed again at finality.
    mutationFn: (args) =>
      upgradeLiteUsername(args, { onFinalized: refreshIdentity }),
    // The claim screen shows the pending, confirmed and failed states from
    // the upgrade markers; an unconfirmed send stays pending there.
    onSuccess: (result) => {
      if (result.status !== "included") return;
      refreshIdentity();
    },
    onError: (error, args) => {
      // Whatever the chain said about this name before, it has had its say
      // now: a name taken in the meantime must not still read as available.
      void queryClient.invalidateQueries({ queryKey: usernameAvailabilityKey(args.fullUsername) });
      logger.error("username upgrade failed; code={code}", {
        code: error instanceof UsernameUpgradeError ? error.code : "unknown",
      });
    },
  });

  return {
    isPending: mutation.isPending,
    data: mutation.data,
    variables: mutation.variables,
    error: mutation.error ?? null,
    submit: mutation.mutate,
  };
}
