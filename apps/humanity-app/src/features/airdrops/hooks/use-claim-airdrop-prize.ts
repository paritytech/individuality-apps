// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  useMutation,
  useMutationState,
  useQueryClient,
  type MutationState,
} from "@tanstack/react-query";

import {
  claimAirdropPrize,
  type ClaimAirdropPrizeResult,
} from "@features/airdrops/chain/claim-draw-prize.ts";
import { DailyPrizeClaimError } from "@features/prize/chain/claim-submission.ts";
import { sweepPrizeIntoCoinage } from "@features/prize/chain/prize-coinage.ts";
import { recordPrizeWin } from "@features/prize/chain/prize-winnings.ts";
import { useRefreshPrizeWinnings } from "@features/prize/hooks/use-prize-winnings.ts";

import type {
  AirdropParticipation,
  Hex32,
} from "@individuality/daily-dollar";

import { AIRDROP_STANDING_QUERY_KEY } from "@features/airdrops/hooks/use-airdrop-standing.ts";

import { loggerFor } from "@humanity/shared/logging/logger.ts";

interface ClaimAirdropStatus {
  pending: boolean;
  /** The claim landed in a best block with `ok`. */
  included: boolean;
  unknown: boolean;
  /** Failure of this draw's own claim, or `null`. Scoped like the flags above:
   *  another draw's failure never surfaces here. */
  error: unknown;
  /** Hash of this draw's submitted claim, or `null` — the identifier needed to
   *  find the extrinsic on chain afterwards. */
  txHash: string | null;
}

export interface ClaimAirdropPrize {
  claim: (participation: AirdropParticipation) => void;
  statusFor: (eventId: Hex32) => ClaimAirdropStatus;
}

const logger = loggerFor("airdrops", "claim");

interface ClaimResultWithId {
  result: ClaimAirdropPrizeResult;
  eventId: Hex32;
}

type ClaimMutationState = MutationState<
  ClaimResultWithId,
  unknown,
  AirdropParticipation
>;

/** One key per identity account so every hook instance observes the same
 *  claim — the daily screen submits it, the debug panel reads it. */
function claimAirdropMutationKey(accountAddress: string) {
  return ["airdrop-claim", accountAddress] as const;
}

const IDLE_STATUS: ClaimAirdropStatus = {
  pending: false,
  included: false,
  unknown: false,
  error: null,
  txHash: null,
};

function statusFromMutation(state: ClaimMutationState): ClaimAirdropStatus {
  const data = state.data;
  return {
    pending: state.status === "pending",
    included: data?.result.status === "included",
    unknown: data?.result.status === "unknown",
    error: state.error ?? null,
    txHash: data?.result.txHash ?? null,
  };
}

/**
 * People-airdrop claim submission for one identity account: banks what the
 * chain actually paid, sweeps the prize on into the host coinage purse, then
 * refreshes the standing query so the home tally sees the won prize. The
 * sweep is fire-and-forget — the scratch UI settles on the claim's inclusion,
 * never on a second host transaction — so a failed top-up leaves the prize on
 * product account zero; `useSweepStrandedPrizes` recovers at the next app
 * start whatever this sweep never got to send, and the debug panel can still
 * move it by hand. `statusFor` reads the latest claim for a draw across every
 * instance sharing the account's mutation key.
 */
export function useClaimAirdropPrize(
  accountAddress: string,
): ClaimAirdropPrize {
  const queryClient = useQueryClient();
  const refreshWinnings = useRefreshPrizeWinnings();
  const mutationKey = claimAirdropMutationKey(accountAddress);
  const claimMutation = useMutation({
    mutationKey,
    mutationFn: async (
      participation: AirdropParticipation,
    ): Promise<ClaimResultWithId> => {
      const result = await claimAirdropPrize({
        eventId: participation.draw.eventId,
        identityAccountAddress: accountAddress,
      });
      if (result.status === "included") {
        if (result.awarded == null) {
          logger.error(
            "airdrop claim included without a PrizeClaimed event; nothing banked. " +
              "eventId={eventId}",
            { eventId: participation.draw.eventId },
          );
        } else {
          await recordPrizeWin({
            accountAddress,
            eventId: participation.draw.eventId,
            amount: result.awarded,
          });
        }

        const sweepAmount = result.awarded ?? participation.draw.prizeAmount;
        if (sweepAmount <= 0n) {
          logger.info(
            "no prize to sweep into coinage. eventId={eventId} amount={amount}",
            {
              eventId: participation.draw.eventId,
              amount: sweepAmount.toString(),
            },
          );
        } else {
          void sweepPrizeIntoCoinage(sweepAmount)
            .then(() => {
              logger.info(
                "coinage top-up accepted; host loads the prize once its balance lands. " +
                  "eventId={eventId} amount={amount}",
                {
                  eventId: participation.draw.eventId,
                  amount: sweepAmount.toString(),
                },
              );
            })
            .catch((error: unknown) => {
              logger.error(
                "coinage sweep failed; prize remains on product account 0. " +
                  "eventId={eventId} amount={amount} error={error}",
                {
                  eventId: participation.draw.eventId,
                  amount: sweepAmount.toString(),
                  error: String(error),
                },
              );
            });
        }
      }
      return { result, eventId: participation.draw.eventId };
    },
    onSuccess: ({ result, eventId }) => {
      if (result.status === "included") {
        refreshWinnings(accountAddress, eventId);
        void queryClient.invalidateQueries({
          queryKey: AIRDROP_STANDING_QUERY_KEY,
        });
      }
    },
    onError: (error, participation) => {
      if (error instanceof DailyPrizeClaimError) {
        logger.error(
          "airdrop claim failed. eventId={eventId} code={code}",
          {
            eventId: participation.draw.eventId,
            code: error.code,
          },
        );
        return;
      }
      logger.error(
        "airdrop claim failed. eventId={eventId}",
        { eventId: participation.draw.eventId },
      );
    },
  });
  const claims = useMutationState<ClaimMutationState>({
    filters: { mutationKey },
    select: (mutation) => mutation.state as ClaimMutationState,
  });

  return {
    claim: (participation) => claimMutation.mutate(participation),
    statusFor: (eventId) => {
      for (let index = claims.length - 1; index >= 0; index -= 1) {
        const state = claims[index];
        if (state?.variables?.draw.eventId === eventId) {
          return statusFromMutation(state);
        }
      }
      return IDLE_STATUS;
    },
  };
}
