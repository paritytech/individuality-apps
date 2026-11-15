// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The balance is push-only, so what the panel shows is whatever the
 *  subscription last said — including *why* the host cut it off. A generic
 *  "Subscription interrupted" would hide a PermissionDenied behind noise. */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostSubscription, PaymentManager } from "@humanity/shared/chain/host-api.ts";

const mocks = vi.hoisted(() => ({
  getPaymentManager: vi.fn<() => Promise<PaymentManager | null>>(),
}));

vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  getPaymentManager: mocks.getPaymentManager,
}));

import {
  getCoinageBalanceDiagnostics,
  watchCoinageBalance,
} from "@humanity/shared/chain/coinage-balance.ts";

class SubscriptionError extends Error {
  constructor(message: string, readonly reason?: unknown) {
    super(message);
  }
}

function fakePayments(): {
  payments: PaymentManager;
  push: (available: bigint) => void;
  interrupt: (reason?: unknown) => void;
} {
  let onBalance: ((b: { available: bigint }) => void) | undefined;
  let onInterrupt: ((reason?: unknown) => void) | undefined;
  const subscription: HostSubscription = {
    unsubscribe: vi.fn(),
    onInterrupt: (callback) => {
      onInterrupt = callback;
      return () => undefined;
    },
  };
  const payments = {
    subscribeBalance: (callback: (b: { available: bigint }) => void) => {
      onBalance = callback;
      return subscription;
    },
  } as unknown as PaymentManager;
  return {
    payments,
    push: (available) => onBalance?.({ available }),
    interrupt: (reason) => onInterrupt?.(reason),
  };
}

/** The watch chains `.then` on the manager promise; two microtask turns let
 *  that chain run without touching the clock. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("watchCoinageBalance", () => {
  afterEach(() => mocks.getPaymentManager.mockReset());

  it("settles on unavailable outside a host", async () => {
    mocks.getPaymentManager.mockResolvedValue(null);
    const stop = watchCoinageBalance(() => undefined);
    await settle();
    expect(getCoinageBalanceDiagnostics()).toEqual({ status: "unavailable" });
    stop();
  });

  it("records each pushed balance and repaints", async () => {
    const fake = fakePayments();
    mocks.getPaymentManager.mockResolvedValue(fake.payments);
    const onChange = vi.fn();
    const stop = watchCoinageBalance(onChange);
    await settle();
    fake.push(1_250_000n);
    expect(getCoinageBalanceDiagnostics()).toMatchObject({
      status: "subscribed",
      available: 1_250_000n,
    });
    expect(onChange).toHaveBeenCalledTimes(3);
    stop();
  });

  it("names the host's typed interrupt reason, not the generic message", async () => {
    const fake = fakePayments();
    mocks.getPaymentManager.mockResolvedValue(fake.payments);
    const stop = watchCoinageBalance(() => undefined);
    await settle();
    fake.interrupt(new SubscriptionError("Subscription interrupted", { tag: "PermissionDenied" }));
    expect(getCoinageBalanceDiagnostics()).toEqual({
      status: "interrupted",
      available: null,
      reason: "PermissionDenied",
    });
    fake.interrupt(
      new SubscriptionError("Subscription interrupted", {
        tag: "Domain",
        value: { tag: "Unknown", value: { reason: "payment surface not implemented" } },
      }),
    );
    expect(getCoinageBalanceDiagnostics()).toMatchObject({
      reason: "Domain/Unknown: payment surface not implemented",
    });
    stop();
  });
});
