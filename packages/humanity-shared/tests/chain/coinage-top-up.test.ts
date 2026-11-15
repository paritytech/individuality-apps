// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HexString, PaymentManager } from "@humanity/shared/chain/host-api.ts";
import type { FlowRun } from "@humanity/shared/telemetry/flow.ts";

const mocks = vi.hoisted(() => ({
  getPaymentManager: vi.fn<() => Promise<PaymentManager | null>>(),
  newPaymentId: vi.fn<() => HexString>(),
  topUp: vi.fn<PaymentManager["topUp"]>(),
  set: vi.fn<FlowRun["set"]>(),
}));

vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  getPaymentManager: mocks.getPaymentManager,
  newPaymentId: mocks.newPaymentId,
}));

vi.mock("@humanity/shared/telemetry/flow.ts", () => ({
  runFlow: (_name: string, body: (flow: FlowRun) => Promise<void>) =>
    body({ set: mocks.set } as unknown as FlowRun),
}));

import { topUpCoinageFromProductAccount } from "@humanity/shared/chain/coinage-top-up.ts";

const TOP_UP_ID = `0x${"cd".repeat(32)}` as const;

beforeEach(() => {
  mocks.getPaymentManager.mockResolvedValue({ topUp: mocks.topUp } as unknown as PaymentManager);
  mocks.newPaymentId.mockReturnValueOnce(TOP_UP_ID);
});

afterEach(() => {
  mocks.getPaymentManager.mockReset();
  mocks.newPaymentId.mockReset();
  mocks.topUp.mockReset();
  mocks.set.mockReset();
});

describe("coinage top-up works", () => {
  it("records the id it hands the host as top_up.id", async () => {
    // Given
    mocks.topUp.mockResolvedValue(undefined);

    // When
    await topUpCoinageFromProductAccount({ amount: 1_000_000n, derivationIndex: 0 });

    // Then
    expect(mocks.topUp).toHaveBeenCalledWith(expect.objectContaining({ id: TOP_UP_ID }));
    expect(mocks.set).toHaveBeenCalledWith({ "top_up.id": TOP_UP_ID });
  });
});

describe("coinage top-up fails", () => {
  it("records the id on a top-up the host refuses", async () => {
    // Given
    const refusal = new Error("SourceBusy");
    mocks.topUp.mockRejectedValue(refusal);

    // When
    const attempt = topUpCoinageFromProductAccount({ amount: 1_000_000n, derivationIndex: 0 });

    // Then
    await expect(attempt).rejects.toBe(refusal);
    expect(mocks.set).toHaveBeenCalledWith({ "top_up.id": TOP_UP_ID });
  });
});
