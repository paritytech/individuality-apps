// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TxEvent } from "polkadot-api";

import {
  TransactionSubmissionError,
  submissionDetail,
  watchTransactionSubmission,
  type WatchTransaction,
} from "@humanity/shared/chain/transaction-submission.ts";

const TX_HASH = `0x${"ab".repeat(32)}` as const;
const SIGNER = "test-signer";
const SIGNING_FAILURE = "We couldn't reserve your weekly game seat. Try again shortly.";
const FINALITY_FAILURE = "Your weekly game seat wasn't confirmed on chain.";
const OPTIONS = {
  signingFailureMessage: SIGNING_FAILURE,
  finalityFailureMessage: FINALITY_FAILURE,
};
const BLOCK = { hash: "0xbeef", number: 42, index: 1 };
const BROADCASTED: TxEvent = { type: "broadcasted", txHash: TX_HASH };

interface FakeObserver {
  next?: (event: TxEvent) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
}

/**
 * A `WatchTransaction` whose observer is held so a test can emit events after
 * `watchTransactionSubmission` returns, or during `subscribe` via `onSubscribe`
 * for the synchronous paths.
 */
function fakeTransaction(onSubscribe?: (observer: FakeObserver) => void) {
  const unsubscribe = vi.fn();
  let observer: FakeObserver | undefined;
  const tx: WatchTransaction<string> = {
    createSubmitAndWatch: () => ({
      subscribe(given: FakeObserver) {
        observer = given;
        onSubscribe?.(given);
        return { unsubscribe };
      },
    }),
  };
  return {
    tx,
    unsubscribe,
    next(event: TxEvent) {
      observer?.next?.(event);
    },
    fail(error: unknown) {
      observer?.error?.(error);
    },
    finish() {
      observer?.complete?.();
    },
  };
}

/** Narrows a caught value so tests can read `code`, `detail`, and `cause`. */
function submissionError(value: unknown): TransactionSubmissionError {
  if (value instanceof TransactionSubmissionError) return value;
  throw new Error(`expected a TransactionSubmissionError, got ${String(value)}`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watchTransactionSubmission", () => {
  it("keeps the safe copy as the message and the whole cause chain as the detail", async () => {
    const fake = fakeTransaction();
    const settled = watchTransactionSubmission(fake.tx, SIGNER, {}, OPTIONS).catch(
      (error: unknown) => error,
    );

    fake.fail(
      new Error("The host could not build a V5 transaction.", {
        cause: {
          tag: "PermissionDenied",
          value: { reason: "foreign product account" },
        },
      }),
    );

    const error = submissionError(await settled);
    expect(error.code).toBe("signing");
    expect(error.message).toBe(SIGNING_FAILURE);
    expect(error.detail).toBe(
      "The host could not build a V5 transaction. <- PermissionDenied: foreign product account",
    );
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("names a stream that closes before broadcast, with no cause to read", async () => {
    const fake = fakeTransaction();
    const settled = watchTransactionSubmission(fake.tx, SIGNER, {}, OPTIONS).catch(
      (error: unknown) => error,
    );

    fake.finish();

    const error = submissionError(await settled);
    expect(error.code).toBe("signing");
    expect(error.message).toBe(SIGNING_FAILURE);
    expect(error.detail).toBe(
      "the signing stream closed before the transaction was broadcast",
    );
    expect(error.cause).toBeUndefined();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reports the signing deadline itself, not the timer handle it was called with", async () => {
    vi.useFakeTimers();
    const fake = fakeTransaction();
    const settled = watchTransactionSubmission(fake.tx, SIGNER, {}, {
      ...OPTIONS,
      signingTimeoutMs: 5_000,
    }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5_000);

    const error = submissionError(await settled);
    expect(error.code).toBe("signing");
    expect(error.detail).toBe("signing timed out after 5000 ms with no broadcast");
    // `setTimeout` hands its callback the timer id; a deadline has no cause,
    // and the id must never reach the log as one.
    expect(error.cause).toBeUndefined();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("decodes the pallet error of a finalized failure and keeps the raw payload", async () => {
    const dispatchError = {
      type: "Module",
      value: { type: "PeopleLite", value: { type: "InvalidProof" } },
    };
    const fake = fakeTransaction();
    const settled = watchTransactionSubmission(fake.tx, SIGNER, {}, OPTIONS).catch(
      (error: unknown) => error,
    );

    fake.next(BROADCASTED);
    fake.next({
      type: "finalized",
      txHash: TX_HASH,
      ok: false,
      dispatchError,
      events: [],
      block: BLOCK,
    });

    const error = submissionError(await settled);
    expect(error.code).toBe("finalized-error");
    expect(error.message).toBe(FINALITY_FAILURE);
    expect(error.detail).toBe("PeopleLite.InvalidProof");
    expect(error.cause).toBe(dispatchError);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("resolves unknown with the finality deadline once the transaction is out", async () => {
    vi.useFakeTimers();
    const fake = fakeTransaction();
    const settle = watchTransactionSubmission(fake.tx, SIGNER, {}, {
      ...OPTIONS,
      finalityTimeoutMs: 7_000,
    });

    fake.next(BROADCASTED);
    await vi.advanceTimersByTimeAsync(7_000);

    await expect(settle).resolves.toEqual({
      status: "unknown",
      txHash: TX_HASH,
      detail: "no finalized block within 7000 ms",
    });
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("resolves finalized with the hash and events of a successful transaction", async () => {
    const fake = fakeTransaction();
    const settle = watchTransactionSubmission(fake.tx, SIGNER, {}, OPTIONS);

    fake.next(BROADCASTED);
    fake.next({
      type: "finalized",
      txHash: TX_HASH,
      ok: true,
      events: [],
      block: BLOCK,
    });

    await expect(settle).resolves.toEqual({
      status: "finalized",
      txHash: TX_HASH,
      events: [],
    });
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("describes a synchronous throw from subscribe as a pre-broadcast failure", async () => {
    const tx: WatchTransaction<string> = {
      createSubmitAndWatch: () => ({
        subscribe() {
          throw new Error("signer unavailable");
        },
      }),
    };

    const error = submissionError(
      await watchTransactionSubmission(tx, SIGNER, {}, OPTIONS).catch(
        (thrown: unknown) => thrown,
      ),
    );
    expect(error.code).toBe("signing");
    expect(error.message).toBe(SIGNING_FAILURE);
    expect(error.detail).toBe("signer unavailable");
  });
  describe("settleOn", () => {
    const INCLUDED: TxEvent = {
      type: "inBestBlock",
      txHash: TX_HASH,
      ok: true,
      events: [],
      block: BLOCK,
    };
    const FINALIZED: TxEvent = {
      type: "finalized",
      txHash: TX_HASH,
      ok: true,
      events: [],
      block: BLOCK,
    };

    it("ignores best-block inclusion and settles on finality by default", async () => {
      const fake = fakeTransaction();
      const result = watchTransactionSubmission(fake.tx, SIGNER, {}, OPTIONS);
      fake.next(BROADCASTED);
      fake.next(INCLUDED);
      expect(fake.unsubscribe).not.toHaveBeenCalled();
      fake.next(FINALIZED);
      await expect(result).resolves.toEqual({
        status: "finalized",
        txHash: TX_HASH,
        events: [],
      });
      expect(fake.unsubscribe).toHaveBeenCalledOnce();
    });

    it("settles on best-block inclusion when asked", async () => {
      const fake = fakeTransaction();
      const result = watchTransactionSubmission(fake.tx, SIGNER, {}, {
        ...OPTIONS,
        settleOn: "bestBlock",
      });
      fake.next(BROADCASTED);
      fake.next({ type: "notInBestBlock", txHash: TX_HASH });
      expect(fake.unsubscribe).not.toHaveBeenCalled();
      fake.next(INCLUDED);
      await expect(result).resolves.toEqual({
        status: "included",
        txHash: TX_HASH,
        events: [],
      });
      expect(fake.unsubscribe).toHaveBeenCalledOnce();
    });

    it("rejects a best-block inclusion that failed on chain, with the decoded reason", async () => {
      const fake = fakeTransaction();
      const result = watchTransactionSubmission(fake.tx, SIGNER, {}, {
        ...OPTIONS,
        settleOn: "bestBlock",
      });
      const rejected = result.then(
        () => {
          throw new Error("expected the inclusion to reject");
        },
        submissionError,
      );
      fake.next(BROADCASTED);
      fake.next({
        type: "inBestBlock",
        txHash: TX_HASH,
        ok: false,
        events: [],
        block: BLOCK,
        dispatchError: { type: "Module", value: { index: 1, error: "0x01" } },
      });
      const error = await rejected;
      expect(error.code).toBe("finalized-error");
      expect(error.message).toBe(FINALITY_FAILURE);
      expect(error.detail).toContain("Module");
    });

    it("resolves on inclusion, then reports finality once when asked to follow", async () => {
      const onFinalized = vi.fn();
      const fake = fakeTransaction();
      const result = watchTransactionSubmission(fake.tx, SIGNER, {}, {
        ...OPTIONS,
        settleOn: "bestBlock",
        onFinalized,
      });
      fake.next(BROADCASTED);
      fake.next(INCLUDED);
      await expect(result).resolves.toEqual({
        status: "included",
        txHash: TX_HASH,
        events: [],
      });
      // Still subscribed: finality has not been seen yet.
      expect(fake.unsubscribe).not.toHaveBeenCalled();
      expect(onFinalized).not.toHaveBeenCalled();

      fake.next(INCLUDED);
      fake.next({ ...FINALIZED, ok: false, dispatchError: { type: "Other" } } as TxEvent);
      fake.next(FINALIZED);
      expect(onFinalized).toHaveBeenCalledExactlyOnceWith({
        txHash: TX_HASH,
        ok: false,
      });
      expect(fake.unsubscribe).toHaveBeenCalledOnce();
    });

    it("stops following without a report when finality misses its deadline after inclusion", async () => {
      vi.useFakeTimers();
      const onFinalized = vi.fn();
      const fake = fakeTransaction();
      const result = watchTransactionSubmission(fake.tx, SIGNER, {}, {
        ...OPTIONS,
        settleOn: "bestBlock",
        finalityTimeoutMs: 10_000,
        onFinalized,
      });
      fake.next(BROADCASTED);
      await vi.advanceTimersByTimeAsync(9_000);
      fake.next(INCLUDED);
      await expect(result).resolves.toMatchObject({ status: "included" });

      // The follow gets its own deadline from inclusion, not the remainder.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fake.unsubscribe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.unsubscribe).toHaveBeenCalledOnce();

      fake.next(FINALIZED);
      expect(onFinalized).not.toHaveBeenCalled();
    });

    it("stops following without a report when the stream ends after inclusion", async () => {
      const onFinalized = vi.fn();
      const fake = fakeTransaction();
      const result = watchTransactionSubmission(fake.tx, SIGNER, {}, {
        ...OPTIONS,
        settleOn: "bestBlock",
        onFinalized,
      });
      fake.next(BROADCASTED);
      fake.next(INCLUDED);
      await expect(result).resolves.toMatchObject({ status: "included" });
      fake.fail(new Error("transport dropped"));
      expect(fake.unsubscribe).toHaveBeenCalledOnce();
      fake.next(FINALIZED);
      expect(onFinalized).not.toHaveBeenCalled();
    });

    it("unsubscribes a follow that sees inclusion and finality during subscribe", async () => {
      const onFinalized = vi.fn();
      const fake = fakeTransaction((observer) => {
        observer.next?.(BROADCASTED);
        observer.next?.(INCLUDED);
        observer.next?.(FINALIZED);
      });
      await expect(
        watchTransactionSubmission(fake.tx, SIGNER, {}, {
          ...OPTIONS,
          settleOn: "bestBlock",
          onFinalized,
        }),
      ).resolves.toMatchObject({ status: "included" });
      expect(onFinalized).toHaveBeenCalledExactlyOnceWith({ txHash: TX_HASH, ok: true });
      expect(fake.unsubscribe).toHaveBeenCalledOnce();
    });
  });
});

describe("submissionDetail", () => {
  it("returns the detail alone when nothing was thrown underneath it", () => {
    const error = new TransactionSubmissionError(
      "signing",
      SIGNING_FAILURE,
      "the signing stream closed before the transaction was broadcast",
    );

    expect(submissionDetail(error)).toBe(
      "the signing stream closed before the transaction was broadcast",
    );
  });

  it("reports the decoded detail without re-rendering the cause it came from", () => {
    const error = new TransactionSubmissionError(
      "finalized-error",
      FINALITY_FAILURE,
      "PeopleLite.InvalidProof",
      {
        cause: {
          type: "Module",
          value: { type: "PeopleLite", value: { type: "InvalidProof" } },
        },
      },
    );

    expect(submissionDetail(error)).toBe("PeopleLite.InvalidProof");
  });

  it("still appends a cause that says something the detail does not", () => {
    const error = new TransactionSubmissionError(
      "signing",
      SIGNING_FAILURE,
      "host refused at host_create_transaction",
      { cause: { tag: "PermissionDenied", value: { reason: "foreign product account" } } },
    );

    expect(submissionDetail(error)).toBe(
      "host refused at host_create_transaction <- PermissionDenied: foreign product account",
    );
  });

  it("does not print a pre-broadcast refusal chain twice", async () => {
    // `detail` is already `describeError(cause)` on this path, so appending the
    // cause once printed "host … <- refusal <- host … <- refusal".
    const refusal = {
      tag: "InvalidRequest",
      value: { reason: "unknown transaction extension id PeopleLiteAuth" },
    };
    const thrown = await watchTransactionSubmission(
      {
        createSubmitAndWatch: () => ({
          subscribe(observer: { error?: (error: unknown) => void }) {
            observer.error?.(
              new Error("The host could not build a V5 transaction.", {
                cause: refusal,
              }),
            );
            return { unsubscribe: () => undefined };
          },
        }),
      },
      {},
      {},
      {
        signingFailureMessage: SIGNING_FAILURE,
        finalityFailureMessage: FINALITY_FAILURE,
      },
    ).catch((error: unknown) => error);

    expect(submissionDetail(thrown)).toBe(
      "The host could not build a V5 transaction. <- InvalidRequest: unknown transaction extension id PeopleLiteAuth",
    );
  });

  it("describes a foreign error that never went through the watcher", () => {
    expect(submissionDetail(new TypeError("signer is not a function"))).toBe(
      "TypeError: signer is not a function",
    );
  });
});
