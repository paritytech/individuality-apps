// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { resetClientCache } from "@humanity/shared/chain/connection.ts";
import { runFlow, type FlowRun } from "@humanity/shared/telemetry/flow.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";

import { resolvePrizeAccount } from "@features/prize/chain/prize-account.ts";
import { resolveAirdropAccount } from "@humanity/shared/airdrops/chain/airdrop-account.ts";
import { ensureAirdropAlias } from "@humanity/shared/airdrops/chain/ensure-airdrop-alias.ts";
import {
  DailyPrizeClaimError,
  watchClaimSubmission,
} from "@features/prize/chain/claim-submission.ts";
import {
  clearPendingDailyClaim,
  setPendingDailyClaim,
} from "@features/prize/chain/pending-daily-claim.ts";

import type { Hex32 } from "@individuality/daily-dollar";

export interface ClaimAirdropPrizeArgs {
  eventId: Hex32;
  /** Human identity used by the UI's pending-claim and winnings ledgers. */
  identityAccountAddress: string;
}

export type ClaimAirdropPrizeResult =
  | { status: "included"; txHash: string; awarded: bigint | null }
  | { status: "unknown"; txHash: string };

const SETUP_TIMEOUT_MS = 15_000;
const SIGNING_TIMEOUT_MS = 60_000;
const INCLUSION_TIMEOUT_MS = 120_000;

const CHAIN_TIMEOUT_MESSAGE = "People Chain did not respond in time.";
const ACCOUNT_MISSING_MESSAGE =
  "We couldn't find your People Chain account. Try again shortly.";
const SETUP_FAILURE_MESSAGE =
  "We couldn't refresh People Chain. Try again shortly.";

/**
 * Claim for a manager-scheduled people-airdrop draw.
 *
 * Fired by `useAutoClaimDraws` when the daily screen opens on a won draw —
 * the scratch reveal is presentation, the settlement is already in flight
 * behind it. Settles on best-block inclusion, not finality.
 *
 * The event id is the people-airdrop draw id and the extrinsic is
 * `PeopleAirdrops.claim`. The pending marker lives in `pending-daily-claim.ts`,
 * keyed by event id. Award parsing runs through `watchClaimSubmission`'s
 * `award`, reading the `Airdrop.PrizeClaimed` event.
 *
 * - Parallel account + client setup is bounded to 15 s; the client cache is
 *   reset only when the deadline fires.
 * - The dedicated airdrop subaccount claims under its contextual alias, while
 *   product account zero remains the payout destination. The SDK's
 *   `withAsPerson` wrapper supplies the runtime extensions and current nonce.
 *
 * @throws DailyPrizeClaimError on account unavailability, setup timeout,
 *   provider error, or included `!ok`.
 */
export function claimAirdropPrize(args: ClaimAirdropPrizeArgs): Promise<ClaimAirdropPrizeResult> {
  return runFlow("daily-dollar.claim", (flow) => runClaim(args, flow), {
    // An included claim with no `PrizeClaimed` event banked nothing: the
    // person was told they won and the purse says otherwise.
    outcome: (result) =>
      result.status !== "included"
        ? { kind: result.status, ok: false }
        : result.awarded == null
          ? { kind: "included-unawarded", ok: false }
          : { kind: "included", ok: true },
  });
}

async function runClaim(
  { eventId, identityAccountAddress }: ClaimAirdropPrizeArgs,
  flow: FlowRun,
): Promise<ClaimAirdropPrizeResult> {
  let broadcastTxHash: string | null = null;
  try {
    flow.stage("setup");
    const [airdropAccount, prizeAccount, peopleClient] = await withTimeout(
      Promise.all([
        resolveAirdropAccount(),
        resolvePrizeAccount(),
        getPeopleClient(),
      ]),
      SETUP_TIMEOUT_MS,
      CHAIN_TIMEOUT_MESSAGE,
      () => {
        void resetClientCache();
      },
    );

    if (airdropAccount == null || prizeAccount == null) {
      throw new DailyPrizeClaimError("signing", ACCOUNT_MISSING_MESSAGE);
    }

    const { api } = peopleClient;
    flow.stage("alias");
    const authorization = await ensureAirdropAlias({
      api,
      client: peopleClient.client,
      network: peopleClient.network,
      account: airdropAccount,
    });

    flow.stage("submit");
    const tx = api.tx.PeopleAirdrops.claim({
      event_id: eventId,
      destination: prizeAccount.address,
    });

    const result = await watchClaimSubmission(
      tx,
      authorization.signer,
      {},
      {
        signingTimeoutMs: SIGNING_TIMEOUT_MS,
        finalityTimeoutMs: INCLUSION_TIMEOUT_MS,
        onBroadcast: (txHash) => {
          broadcastTxHash = txHash;
          setPendingDailyClaim(eventId, identityAccountAddress, txHash);
        },
        award: { eventId, beneficiary: prizeAccount.address },
      },
    );

    if (result.status === "included") {
      clearPendingDailyClaim(eventId, identityAccountAddress, result.txHash);
    }
    return result;
  } catch (err) {
    if (broadcastTxHash != null) {
      clearPendingDailyClaim(eventId, identityAccountAddress, broadcastTxHash);
    }
    if (err instanceof DailyPrizeClaimError) throw err;
    throw new DailyPrizeClaimError("signing", SETUP_FAILURE_MESSAGE, {
      cause: err,
    });
  }
}
