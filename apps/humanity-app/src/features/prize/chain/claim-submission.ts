// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { TxEvent } from "polkadot-api";
import {
  submissionDetail,
  TransactionSubmissionError,
  watchTransactionSubmission,
} from "@humanity/shared/chain/transaction-submission.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

import {
  awardedFromClaimEvents,
  type ClaimChainEvent,
} from "./prize-claimed-event.ts";

/** Full PAPI transaction event stream, including best-block progress events. */
export type ClaimTransactionEvent = TxEvent;

/** Object-shaped observer accepted by a claim transaction's observable. */
export interface ClaimEventObserver {
  next?: (event: ClaimTransactionEvent) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
}

/** Minimal structural shape of a claim transaction (e.g. `api.tx.PeopleAirdrops.claim(...)`). */
export interface ClaimWatchTransaction<TSigner> {
  createSubmitAndWatch(
    signer: TSigner,
    options?: object,
  ): { subscribe(observer: ClaimEventObserver): { unsubscribe(): void } };
}

export interface WatchClaimSubmissionOptions {
  /** Milliseconds before rejecting when no broadcast is observed. Default: 60_000. */
  signingTimeoutMs?: number;
  /** Milliseconds after broadcast before resolving `unknown`. Default: 120_000. */
  finalityTimeoutMs?: number;
  /** Called exactly once, on the first `broadcasted` event. */
  onBroadcast?: (txHash: string) => void;
  /** Airdrop event id and beneficiary the `PrizeClaimed` award is read for. */
  award?: { eventId: string; beneficiary: string };
}

export type ClaimResultIncluded = {
  readonly status: "included";
  readonly txHash: string;
  /** Amount the chain actually paid, from the claim's own `PrizeClaimed`
   *  event. `null` when no matching event was emitted — never a guess. */
  readonly awarded: bigint | null;
};

export type ClaimResultUnknown = {
  readonly status: "unknown";
  readonly txHash: string;
};

/** Stable error categories for claim submission. */
export type DailyPrizeClaimErrorCode = "timeout" | "finalized-error" | "signing";

/**
 * Classified claim error. `message` is fixed, safe copy for logging and
 * diagnostics only; it is never rendered. Any raw failure is carried only as
 * `cause`.
 */
export class DailyPrizeClaimError extends Error {
  readonly code: DailyPrizeClaimErrorCode;

  constructor(
    code: DailyPrizeClaimErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DailyPrizeClaimError";
    this.code = code;
  }
}

const logger = loggerFor("prize", "claim-submission");

const SIGNING_FAILURE_MESSAGE =
  "We couldn't submit your daily claim. Try again shortly.";
const FINALITY_FAILURE_MESSAGE =
  "We couldn't confirm your daily claim. Try again shortly.";

/**
 * Submit a claim transaction and watch it to best-block inclusion.
 *
 * Only the first `broadcasted` event fires `onBroadcast` exactly once and
 * replaces the signing deadline with the inclusion deadline. Before broadcast,
 * the signing deadline, an observer `error`, or `complete` reject with a safe
 * `DailyPrizeClaimError`. After broadcast they resolve
 * `{ status: "unknown", txHash }`. Inclusion in a best block resolves
 * `included` when `ok` and otherwise rejects safe.
 */
export async function watchClaimSubmission<TSigner>(
  tx: ClaimWatchTransaction<TSigner>,
  signer: TSigner,
  txOptions: object,
  options: WatchClaimSubmissionOptions = {},
): Promise<ClaimResultIncluded | ClaimResultUnknown> {
  const {
    signingTimeoutMs,
    finalityTimeoutMs,
    onBroadcast,
    award,
  } = options;

  try {
    const result = await watchTransactionSubmission(tx, signer, txOptions, {
      signingFailureMessage: SIGNING_FAILURE_MESSAGE,
      finalityFailureMessage: FINALITY_FAILURE_MESSAGE,
      signingTimeoutMs,
      finalityTimeoutMs,
      onBroadcast,
      settleOn: "bestBlock",
    });
    if (result.status === "unknown") {
      logger.error("daily claim unconfirmed, tx {txHash}: {detail}", {
        txHash: result.txHash,
        detail: result.detail,
      });
      // Deliberately rebuilt rather than returned as-is: `ClaimResultUnknown`
      // is what the UI reads, and the watcher's `detail` is for operators.
      return { status: "unknown", txHash: result.txHash };
    }

    const awarded =
      award == null
        ? null
        : awardedFromClaimEvents(
            result.events as readonly ClaimChainEvent[] | undefined,
            award.eventId,
            award.beneficiary,
          );
    return {
      status: "included",
      txHash: result.txHash,
      awarded,
    };
  } catch (cause) {
    if (cause instanceof TransactionSubmissionError) {
      logger.error("daily claim submission failed: {detail}", {
        detail: submissionDetail(cause),
      });
      throw new DailyPrizeClaimError(cause.code, cause.message, { cause });
    }
    throw cause;
  }
}
