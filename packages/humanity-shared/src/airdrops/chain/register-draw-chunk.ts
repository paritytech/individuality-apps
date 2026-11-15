// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ProductAccountSigner } from "@humanity/shared/chain/host-api.ts";

import {
  submissionDetail,
  TransactionSubmissionError,
  watchTransactionSubmission,
  type WatchTransaction,
} from "@humanity/shared/chain/transaction-submission.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

import type { Hex32 } from "@individuality/daily-dollar";

import {
  clearPendingRegistration,
  setPendingRegistration,
} from "./pending-registration.ts";
import { RegisterDrawsError } from "./register-draws-shared.ts";
import type { RegisterDrawChunkResult } from "./register-draws-shared.ts";

const logger = loggerFor("airdrops", "register-chunk");

const CHAIN_TIMEOUT_MESSAGE = "People Chain did not respond in time.";

export interface RunRegisterChunkArgs {
  /** One `PeopleAirdrops.register` call for exactly `eventIds`. */
  tx: WatchTransaction<ProductAccountSigner>;
  signer: ProductAccountSigner;
  /** Stable alias key used to suppress resubmission across reloads. */
  pendingKey: string;
  eventIds: Hex32[];
  signingFailureMessage: string;
  finalityFailureMessage: string;
  signingTimeoutMs: number;
  finalityTimeoutMs: number;
}

/** Submit one chunked `PeopleAirdrops.register` extrinsic. The pending
 *  marker is written at broadcast and cleared on `finalized`; `unknown`
 *  retains it so a reload does not resubmit. A thrown failure clears only
 *  this attempt's broadcast markers — pre-broadcast errors leave any
 *  pre-existing marker untouched. */
export async function runRegisterChunk({
  tx,
  signer,
  pendingKey,
  eventIds,
  signingFailureMessage,
  finalityFailureMessage,
  signingTimeoutMs,
  finalityTimeoutMs,
}: RunRegisterChunkArgs): Promise<RegisterDrawChunkResult> {
  let broadcastTxHash: string | null = null;
  try {
    const outcome = await watchTransactionSubmission(
      tx,
      signer,
      {},
      {
        signingTimeoutMs,
        finalityTimeoutMs,
        signingFailureMessage,
        finalityFailureMessage,
        onBroadcast: (txHash) => {
          broadcastTxHash = txHash;
          setPendingRegistration(eventIds, pendingKey, txHash);
        },
      },
    );

    if (outcome.status === "finalized") {
      clearPendingRegistration(eventIds, pendingKey, outcome.txHash);
      return { eventIds, status: "finalized", txHash: outcome.txHash };
    }
    // `unknown` is the one outcome the chunk result cannot carry a reason
    // for: it is a status, not an error, so the decoded reason would be
    // dropped here if it were not logged.
    logger.error(
      "airdrop registration unconfirmed for {count} draws, tx {txHash}: {detail}",
      {
        count: eventIds.length,
        txHash: outcome.txHash,
        detail: outcome.detail,
      },
    );
    return { eventIds, status: "unknown", txHash: outcome.txHash };
  } catch (cause) {
    if (broadcastTxHash != null) {
      clearPendingRegistration(eventIds, pendingKey, broadcastTxHash);
    }
    logger.error("airdrop registration failed for {count} draws, tx {txHash}: {detail}", {
      count: eventIds.length,
      txHash: broadcastTxHash,
      detail: submissionDetail(cause),
    });
    if (cause instanceof TransactionSubmissionError) {
      if (cause.code === "finalized-error") {
        return {
          eventIds,
          status: "failed",
          error: new RegisterDrawsError(
            "finalized-error",
            finalityFailureMessage,
            { cause },
          ),
        };
      }
      return {
        eventIds,
        status: "failed",
        error: new RegisterDrawsError("signing", signingFailureMessage, {
          cause,
        }),
      };
    }
    if (cause instanceof Error && cause.message === CHAIN_TIMEOUT_MESSAGE) {
      return {
        eventIds,
        status: "failed",
        error: new RegisterDrawsError("timeout", CHAIN_TIMEOUT_MESSAGE, {
          cause,
        }),
      };
    }
    return {
      eventIds,
      status: "failed",
      error: new RegisterDrawsError("signing", signingFailureMessage, {
        cause,
      }),
    };
  }
}
