// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { hasSettledDailyPrize } from "@features/prize/chain/prize-winnings.ts";

/** Query key for one identity account's local winnings ledger. */
function prizeWinningsKey(accountAddress: string) {
  return ["prize-winnings", accountAddress] as const;
}

function settledKey(accountAddress: string, eventId: string) {
  return ["prize-settled", accountAddress, eventId] as const;
}

export interface DailyPrizeSettlementState {
  settled: boolean;
  isPending: boolean;
}

/**
 * Whether this airdrop event has already been settled for the account — a
 * claimed win banked in the winnings ledger.
 *
 * Settlement decides what the claim CTA does and stops a banked draw from
 * being claimed twice. It does not decide whether the scratch card shows its
 * foil: that is the scratch log's (`use-daily-scratch.ts`), because the
 * claim submitted on opening can bank a win before the foil comes off.
 *
 * Defaults to settled while the read is pending: briefly showing nothing beats
 * offering a claim that was already made.
 */
export function useDailyPrizeSettlementState(
  accountAddress: string,
  eventId: string | null,
  enabled = true,
): DailyPrizeSettlementState {
  const query = useQuery({
    queryKey: settledKey(accountAddress, eventId ?? "none"),
    enabled: enabled && accountAddress.length > 0 && eventId != null,
    queryFn: () => hasSettledDailyPrize(accountAddress, eventId ?? ""),
  });
  if (eventId == null) return { settled: false, isPending: false };
  return { settled: query.data ?? true, isPending: query.isPending };
}

/** Refresh both the tally and the settled flag after a claim is written. */
export function useRefreshPrizeWinnings(): (
  accountAddress: string,
  eventId?: string,
) => void {
  const queryClient = useQueryClient();
  return (accountAddress: string, eventId?: string) => {
    void queryClient.invalidateQueries({
      queryKey: prizeWinningsKey(accountAddress),
    });
    if (eventId != null) {
      void queryClient.invalidateQueries({
        queryKey: settledKey(accountAddress, eventId),
      });
    }
  };
}
