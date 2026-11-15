// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => logMocks,
}));

import {
  DailyPrizeClaimError,
  watchClaimSubmission,
  type ClaimTransactionEvent,
  type ClaimWatchTransaction,
} from "@features/prize/chain/claim-submission.ts";

const TX_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;

interface FakeSigner {
  readonly address: string;
}


/**
 * The object-shaped observer passed by `watchClaimSubmission` to `subscribe`,
 * matching RxJS `Partial<Observer<T>>` semantics.
 */
interface FakeObserver {
  next(event: ClaimTransactionEvent): void;
  error?(error: unknown): void;
  complete?(): void;
}

/** A best-block inclusion event for the shared fake hashes. */
function includedEvent(ok: boolean): ClaimTransactionEvent {
  return ok
    ? {
        type: "inBestBlock",
        txHash: TX_HASH,
        ok: true,
        events: [],
        block: { hash: BLOCK_HASH, number: 1, index: 0 },
      }
    : {
        type: "inBestBlock",
        txHash: TX_HASH,
        ok: false,
        events: [],
        block: { hash: BLOCK_HASH, number: 1, index: 0 },
        dispatchError: { type: "Module", value: { index: 1, error: "0x01" } },
      };
}

function finalizedEvent(): ClaimTransactionEvent {
  return {
    type: "finalized",
    txHash: TX_HASH,
    ok: true,
    events: [],
    block: { hash: BLOCK_HASH, number: 1, index: 0 },
  };
}

/** A structurally typed fake transaction whose event observer can be scripted. */
function makeClaimWatch(
  sync?: ClaimTransactionEvent[],
  throwIn?: "sign" | "subscribe",
) {
  let observer: FakeObserver | undefined;
  let unsubscribed = false;
  const onBroadcast = vi.fn();
  const signer: FakeSigner = { address: "5FakeSigner" };
  const tx: ClaimWatchTransaction<FakeSigner> = {
    createSubmitAndWatch: () => {
      if (throwIn === "sign") throw new Error("signing failed");
      return {
        subscribe: (obs: FakeObserver) => {
          if (throwIn === "subscribe") throw new Error("subscribe failed");
          observer = obs;
          for (const event of sync ?? []) obs.next(event);
          return {
            unsubscribe: () => {
              unsubscribed = true;
            },
          };
        },
      };
    },
  };
  return {
    tx,
    signer,
    onBroadcast,
    isUnsubscribed: () => unsubscribed,
    push: (event: ClaimTransactionEvent) => observer?.next(event),
    pushError: (error: unknown) => observer?.error?.(error),
    pushComplete: () => observer?.complete?.(),
  };
}

function watchOptions(onBroadcast: () => void) {
  return {
    signingTimeoutMs: 1_000,
    finalityTimeoutMs: 5_000,
    onBroadcast,
  };
}

describe("watchClaimSubmission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logMocks.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves included when the transaction lands ok in a best block", async () => {
    const { tx, signer, onBroadcast, isUnsubscribed, push } = makeClaimWatch();
    const result = watchClaimSubmission(tx, signer, {}, watchOptions(onBroadcast));
    const settled = expect(result).resolves.toEqual({
      status: "included",
      txHash: TX_HASH,
      // No `award` context supplied, so no payout is read back.
      awarded: null,
    });
    push({ type: "created", txHash: TX_HASH });
    push({ type: "broadcasted", txHash: TX_HASH });
    push({ type: "notInBestBlock", txHash: TX_HASH });
    expect(isUnsubscribed()).toBe(false);
    push(includedEvent(true));
    await settled;
    expect(isUnsubscribed()).toBe(true);
    expect(onBroadcast).toHaveBeenCalledTimes(1);
  });

  it("does not wait for finality once included", async () => {
    const { tx, signer, onBroadcast, isUnsubscribed, push } = makeClaimWatch();
    const result = watchClaimSubmission(tx, signer, {}, watchOptions(onBroadcast));
    push({ type: "broadcasted", txHash: TX_HASH });
    push(includedEvent(true));
    await expect(result).resolves.toMatchObject({ status: "included" });
    push(finalizedEvent());
    expect(isUnsubscribed()).toBe(true);
  });

  it("resolves unknown when inclusion is not observed in time", async () => {
    const { tx, signer, onBroadcast, isUnsubscribed, push } = makeClaimWatch();
    const result = watchClaimSubmission(tx, signer, {}, watchOptions(onBroadcast));
    const settled = expect(result).resolves.toEqual({
      status: "unknown",
      txHash: TX_HASH,
    });
    push({ type: "created", txHash: TX_HASH });
    push({ type: "broadcasted", txHash: TX_HASH });
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    expect(isUnsubscribed()).toBe(true);
    expect(onBroadcast).toHaveBeenCalledTimes(1);
    // The user-facing result stays `{ status, txHash }`; the reason finality
    // was never seen is now in the log instead of nowhere.
    expect(logMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("{detail}"),
      expect.objectContaining({
        detail: "no finalized block within 5000 ms",
      }),
    );
  });

  it("rejects with a safe claim error when signing never broadcasts in time", async () => {
    const { tx, signer, onBroadcast } = makeClaimWatch();
    const result = watchClaimSubmission(tx, signer, {}, watchOptions(onBroadcast));
    const rejected = expect(result).rejects.toBeInstanceOf(DailyPrizeClaimError);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(onBroadcast).not.toHaveBeenCalled();
  });

  it("rejects with a safe claim error when the transaction fails in a best block", async () => {
    const { tx, signer, onBroadcast, isUnsubscribed, push } = makeClaimWatch();
    const result = watchClaimSubmission(tx, signer, {}, watchOptions(onBroadcast));
    const rejected = expect(result).rejects.toBeInstanceOf(DailyPrizeClaimError);
    push({ type: "created", txHash: TX_HASH });
    push({ type: "broadcasted", txHash: TX_HASH });
    push(includedEvent(false));
    await rejected;
    expect(isUnsubscribed()).toBe(true);
    expect(onBroadcast).toHaveBeenCalledTimes(1);
  });

  it("resolves unknown when the observer errors after broadcast", async () => {
    const { tx, signer, onBroadcast, isUnsubscribed, push, pushError } =
      makeClaimWatch();
    const result = watchClaimSubmission(tx, signer, {}, watchOptions(onBroadcast));
    const settled = expect(result).resolves.toEqual({ status: "unknown", txHash: TX_HASH });
    push({ type: "created", txHash: TX_HASH });
    push({ type: "broadcasted", txHash: TX_HASH });
    pushError(new Error("connection lost"));
    await settled;
    expect(isUnsubscribed()).toBe(true);
    expect(onBroadcast).toHaveBeenCalledTimes(1);
  });

  it("rejects with a safe claim error when the observer completes before broadcast", async () => {
    const { tx, signer, onBroadcast, isUnsubscribed, push, pushComplete } =
      makeClaimWatch();
    const result = watchClaimSubmission(tx, signer, {}, watchOptions(onBroadcast));
    const rejected = expect(result).rejects.toBeInstanceOf(DailyPrizeClaimError);
    push({ type: "created", txHash: TX_HASH });
    pushComplete();
    await rejected;
    expect(isUnsubscribed()).toBe(true);
  });

  it("resolves included and unsubscribes when inclusion arrives synchronously", async () => {
    const { tx, signer, onBroadcast, isUnsubscribed } = makeClaimWatch([
      includedEvent(true),
    ]);
    const result = watchClaimSubmission(tx, signer, {}, watchOptions(onBroadcast));
    await expect(result).resolves.toEqual({
      status: "included",
      txHash: TX_HASH,
      awarded: null,
    });
    expect(isUnsubscribed()).toBe(true);
    expect(onBroadcast).not.toHaveBeenCalled();
  });

  it("rejects with a safe claim error when signing or subscribing throws synchronously", async () => {
    for (const throwIn of ["sign", "subscribe"] as const) {
      const { tx, signer, onBroadcast, isUnsubscribed } = makeClaimWatch(undefined, throwIn);
      const result = watchClaimSubmission(tx, signer, {}, watchOptions(onBroadcast));
      const rejected = expect(result).rejects.toBeInstanceOf(DailyPrizeClaimError);
      await rejected;
      expect(onBroadcast).not.toHaveBeenCalled();
      expect(isUnsubscribed()).toBe(false);
    }
  });
});
