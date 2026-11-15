// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { hasScratchedDailyPrize } from "@features/prize/chain/daily-scratch-log.ts";

function scratchKey(accountAddress: string, eventId: string) {
  return ["daily-scratch", accountAddress, eventId] as const;
}

export interface DailyPrizeScratchState {
  scratched: boolean;
  isPending: boolean;
}

/**
 * Whether this identity already scratched this airdrop event open.
 *
 * The outcome is predetermined on chain, so scratching is what consumes the
 * card — win or miss. A scratched event shows "come back tomorrow" instead of
 * a fresh card, and because the key is the event id, a new card appears
 * exactly when the airdrop index or the game index changes.
 *
 * Defaults to scratched while the read is pending: briefly showing the
 * come-back state beats letting the same card be scratched twice.
 */
export function useDailyPrizeScratchState(
  accountAddress: string,
  eventId: string | null,
  enabled = true,
): DailyPrizeScratchState {
  const query = useQuery({
    queryKey: scratchKey(accountAddress, eventId ?? "none"),
    enabled: enabled && accountAddress.length > 0 && eventId != null,
    queryFn: () => hasScratchedDailyPrize(accountAddress, eventId ?? ""),
  });
  if (eventId == null) return { scratched: false, isPending: false };
  return { scratched: query.data ?? true, isPending: query.isPending };
}

/** Refresh the scratched flag right after a card is scratched open. */
export function useRefreshDailyScratch(): (
  accountAddress: string,
  eventId: string,
) => void {
  const queryClient = useQueryClient();
  return (accountAddress: string, eventId: string) => {
    void queryClient.invalidateQueries({
      queryKey: scratchKey(accountAddress, eventId),
    });
  };
}
