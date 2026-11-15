// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { TxEvent } from "polkadot-api";

import {
  describeError,
  dispatchErrorText,
} from "@humanity/shared/chain/error-detail.ts";
import { childSpan, type ChildSpanEnd } from "@humanity/shared/telemetry/flow.ts";

/** Object-shaped observer accepted by a PAPI transaction observable. */
interface TransactionEventObserver {
  next?: (event: TxEvent) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
}

/** Minimal structural transaction shape needed by the submission watcher. */
export interface WatchTransaction<TSigner> {
  createSubmitAndWatch(
    signer: TSigner,
    options?: object,
  ): {
    subscribe(observer: TransactionEventObserver): { unsubscribe(): void };
  };
}

export type TransactionSubmissionErrorCode = "finalized-error" | "signing";

/**
 * Submission failure carrying two independent strings.
 *
 * `message` is the safe copy the owning feature chose, and it is the only
 * thing a user ever reads. `detail` is the decoded technical reason, which
 * exists because wrapping the real error as an unread `cause` is exactly how
 * every seat-bind diagnosis used to be lost: the canned sentence was logged
 * in place of the refusal that caused it. Log `submissionDetail(error)`.
 */
export class TransactionSubmissionError extends Error {
  readonly code: TransactionSubmissionErrorCode;

  /** Decoded technical detail. Safe to log; NEVER shown to a user. */
  readonly detail: string;

  constructor(
    code: TransactionSubmissionErrorCode,
    message: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TransactionSubmissionError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Loggable technical detail for anything thrown by a watched submission.
 *
 * This is the one call a feature needs to log a submission failure: it names
 * what the signer, host, or chain actually reported instead of repeating the
 * safe copy the user already saw.
 *
 * The watcher decodes `detail` from the cause as it constructs the error —
 * `describeError` for a thrown refusal, `dispatchErrorText` for a rejected
 * dispatch — so rendering the cause again printed every chain twice
 * (`… <- InvalidRequest: … <- … <- InvalidRequest: …`), the same unreadable
 * log this module exists to fix. The cause is therefore appended only when it
 * says something `detail` does not already contain, which keeps a
 * hand-constructed error's cause from being dropped.
 */
export function submissionDetail(error: unknown): string {
  if (!(error instanceof TransactionSubmissionError)) return describeError(error);
  if (error.cause === undefined) return error.detail;
  const cause = describeError(error.cause);
  return error.detail.includes(cause) || cause.includes(error.detail)
    ? error.detail
    : `${error.detail} <- ${cause}`;
}

export type SettleMode = "finalized" | "bestBlock";

export interface WatchTransactionSubmissionOptions<
  Mode extends SettleMode = "finalized",
> {
  /** Safe copy for a failure before the transaction is broadcast. */
  signingFailureMessage: string;
  /** Safe copy for a transaction that failed on chain. */
  finalityFailureMessage: string;
  /** Milliseconds before rejecting when no broadcast is observed. */
  signingTimeoutMs?: number;
  /** Milliseconds after broadcast before resolving `unknown`. */
  finalityTimeoutMs?: number;
  /** Called exactly once, on the first `broadcasted` event. */
  onBroadcast?: (txHash: string) => void;
  /** `"finalized"` (default) settles on finality; `"bestBlock"` settles as
   *  soon as the transaction is found in a best block, which a reorg can
   *  still revert — the caller trades that for latency. */
  settleOn?: Mode;
  /** Only with `settleOn: "bestBlock"`: keep watching after a successful
   *  inclusion and call this once with the finalized dispatch outcome. Not
   *  called when finality is not seen within `finalityTimeoutMs` of the
   *  inclusion, or the stream errors or closes first. */
  onFinalized?: (outcome: { txHash: string; ok: boolean }) => void;
}

export interface TransactionFinalizedResult {
  readonly status: "finalized";
  readonly txHash: string;
  readonly events: readonly unknown[] | undefined;
}

export interface TransactionIncludedResult {
  readonly status: "included";
  readonly txHash: string;
  readonly events: readonly unknown[] | undefined;
}

export interface TransactionUnknownResult {
  readonly status: "unknown";
  readonly txHash: string;
  /** Why finality was never observed. Safe to log; never shown. */
  readonly detail: string;
}

export type TransactionSubmissionResult<
  Mode extends SettleMode = "finalized",
> =
  | (Mode extends "bestBlock"
      ? TransactionIncludedResult
      : TransactionFinalizedResult)
  | TransactionUnknownResult;

/**
 * Submit a PAPI transaction and watch it until it settles — at finality by
 * default, or at best-block inclusion with `settleOn: "bestBlock"`.
 *
 * Pre-broadcast failures reject safely. Once broadcast, observer failure,
 * completion, or the settle deadline resolves `unknown` so callers never
 * submit the same transaction twice. Every settle path clears timers and
 * unsubscribes, including synchronous events and throws from `subscribe` —
 * except a best-block inclusion with `onFinalized`, which keeps a fresh
 * deadline and the subscription until finality is seen, the stream ends, or
 * that deadline fires.
 *
 * Every settle path also carries a `detail` string that is deliberately not
 * the user-facing one: the caller's safe copy stays the `message` (or is
 * simply absent from an `unknown` result), while `detail` names the decoded
 * signer, host, dispatch, or timeout reason for the log and the debug
 * snapshot. The two strings are never merged, because a sentence written for
 * a player is useless to an operator and vice versa.
 */
export async function watchTransactionSubmission<
  TSigner,
  Mode extends SettleMode = "finalized",
>(
  tx: WatchTransaction<TSigner>,
  signer: TSigner,
  txOptions: object,
  options: WatchTransactionSubmissionOptions<Mode>,
): Promise<TransactionSubmissionResult<Mode>> {
  const {
    signingFailureMessage,
    finalityFailureMessage,
    signingTimeoutMs = 60_000,
    finalityTimeoutMs = 120_000,
    onBroadcast,
    settleOn = "finalized",
    onFinalized,
  } = options;
  const { promise: settle, resolve, reject } =
    Promise.withResolvers<TransactionSubmissionResult<Mode>>();

  let settled = false;
  /** Inclusion already resolved; still watching for `onFinalized`. */
  let following = false;
  let broadcast = false;
  let observedTxHash = "";
  let signingTimer: ReturnType<typeof setTimeout> | undefined;
  let finalityTimer: ReturnType<typeof setTimeout> | undefined;
  let subscription: { unsubscribe(): void } | undefined;
  // Two timed spans under the flow in flight, if any: `sign` runs until the
  // broadcast (host signing plus the submit), `settle` from the broadcast to
  // the settle decision. Timeouts and dispatch failures land on whichever is
  // open, with the detail the result carries.
  let endSign: ChildSpanEnd | null = childSpan("chain.tx", "sign");
  let endSettle: ChildSpanEnd | null = null;
  const closeSpans = (ok: boolean, detail: string, status: string): void => {
    endSign?.({ ok, detail }, { "tx.status": status });
    endSign = null;
    endSettle?.({ ok, detail }, { "tx.status": status });
    endSettle = null;
  };

  const clearTimers = () => {
    clearTimeout(signingTimer);
    clearTimeout(finalityTimer);
    signingTimer = undefined;
    finalityTimer = undefined;
  };
  const cleanup = () => {
    clearTimers();
    subscription?.unsubscribe();
  };
  const stopFollowing = () => {
    following = false;
    cleanup();
  };
  const settleOnce = (decision: TransactionSubmissionResult<Mode>) => {
    if (settled) return;
    settled = true;
    cleanup();
    closeSpans(
      decision.status !== "unknown",
      decision.status === "unknown" ? decision.detail : decision.status,
      decision.status,
    );
    resolve(decision);
  };
  const rejectOnce = (error: TransactionSubmissionError) => {
    if (settled) return;
    settled = true;
    cleanup();
    closeSpans(false, error.detail, error.code);
    reject(error);
  };
  const failPreBroadcast = (detail: string, cause?: unknown) =>
    rejectOnce(
      new TransactionSubmissionError(
        "signing",
        signingFailureMessage,
        detail,
        { cause },
      ),
    );
  const resolveUnknown = (detail: string) =>
    settleOnce({ status: "unknown", txHash: observedTxHash, detail });
  const settleIncluded = (
    status: "finalized" | "included",
    event: { txHash: string; ok: boolean; events?: readonly unknown[]; dispatchError?: unknown },
  ) => {
    if (!event.ok) {
      rejectOnce(
        new TransactionSubmissionError(
          "finalized-error",
          finalityFailureMessage,
          dispatchErrorText(event),
          { cause: event.dispatchError },
        ),
      );
      return;
    }
    const result = {
      status,
      txHash: event.txHash,
      events: event.events,
    } as TransactionSubmissionResult<Mode>;
    if (status !== "included" || onFinalized == null) {
      settleOnce(result);
      return;
    }
    if (settled) return;
    settled = true;
    following = true;
    clearTimers();
    finalityTimer = setTimeout(stopFollowing, finalityTimeoutMs);
    closeSpans(true, status, status);
    resolve(result);
  };

  // Wrapped: `setTimeout` passes the timer argument to its callback, and a
  // deadline has no cause and no detail but its own.
  signingTimer = setTimeout(() => {
    failPreBroadcast(
      `signing timed out after ${signingTimeoutMs} ms with no broadcast`,
    );
  }, signingTimeoutMs);

  try {
    subscription = tx.createSubmitAndWatch(signer, txOptions).subscribe({
      next(event) {
        if (following) {
          if (event.type === "finalized") {
            stopFollowing();
            onFinalized?.({ txHash: event.txHash, ok: event.ok });
          }
          return;
        }
        if (event.type === "created" || event.type === "notInBestBlock") return;
        if (event.type === "inBestBlock") {
          if (settleOn === "bestBlock") settleIncluded("included", event);
          return;
        }
        if (event.type === "broadcasted") {
          if (broadcast) return;
          broadcast = true;
          observedTxHash = event.txHash;
          endSign?.({ ok: true }, { "tx.hash": event.txHash });
          endSign = null;
          endSettle = childSpan("chain.tx", "settle", { "tx.hash": event.txHash });
          onBroadcast?.(event.txHash);
          clearTimeout(signingTimer);
          signingTimer = undefined;
          finalityTimer = setTimeout(() => {
            resolveUnknown(`no finalized block within ${finalityTimeoutMs} ms`);
          }, finalityTimeoutMs);
          return;
        }
        settleIncluded("finalized", event);
      },
      error(error) {
        if (following) stopFollowing();
        else if (broadcast) resolveUnknown(describeError(error));
        else failPreBroadcast(describeError(error), error);
      },
      complete() {
        if (following) {
          stopFollowing();
        } else if (broadcast) {
          resolveUnknown(
            "the signing stream closed after broadcast without a finalized block",
          );
        } else {
          failPreBroadcast(
            "the signing stream closed before the transaction was broadcast",
          );
        }
      },
    });
    if (settled && !following) subscription.unsubscribe();
  } catch (error) {
    if (following) stopFollowing();
    else if (broadcast) resolveUnknown(describeError(error));
    else failPreBroadcast(describeError(error), error);
  }

  return settle;
}
