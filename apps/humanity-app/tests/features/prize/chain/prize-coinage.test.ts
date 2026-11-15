// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The sweep is the only hop that moves a claimed prize off product account
 *  zero, and the host signs from whatever derivation index it is handed — so
 *  the exact `topUp` payload is the contract worth pinning. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaymentManager } from "@humanity/shared/chain/host-api.ts";

const mocks = vi.hoisted(() => ({
  getPaymentManager: vi.fn<() => Promise<PaymentManager | null>>(),
  topUp: vi.fn<PaymentManager["topUp"]>(),
}));

vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  getPaymentManager: mocks.getPaymentManager,
  newPaymentId: () => TOP_UP_ID,
}));
import { PRIZE_ACCOUNT_INDEX } from "@features/prize/chain/prize-account.ts";
import { sweepPrizeIntoCoinage } from "@features/prize/chain/prize-coinage.ts";

const PRIZE = 1_000_000n;
const TOP_UP_ID = `0x${"ab".repeat(32)}` as const;

beforeEach(() => {
  mocks.topUp.mockResolvedValue(undefined);
  mocks.getPaymentManager.mockResolvedValue({
    topUp: mocks.topUp,
  } as unknown as PaymentManager);
});

afterEach(() => {
  mocks.getPaymentManager.mockReset();
  mocks.topUp.mockReset();
});

describe("sweepPrizeIntoCoinage", () => {
  it("tops the coinage purse up from the prize product account", async () => {
    await expect(sweepPrizeIntoCoinage(PRIZE)).resolves.toEqual({
      status: "sent",
      amount: PRIZE,
    });

    expect(mocks.topUp).toHaveBeenCalledTimes(1);
    // Literal 0, not PRIZE_ACCOUNT_INDEX: this is the account
    // `PeopleAirdrops.claim` pays into, so the host must be asked to sign from
    // that same index — a change on either side has to fail here.
    expect(mocks.topUp).toHaveBeenCalledWith({
      id: TOP_UP_ID,
      amount: PRIZE,
      source: {
        tag: "ProductAccount",
        value: { derivationIndex: { tag: "Index", value: 0 } },
      },
    });
    expect(PRIZE_ACCOUNT_INDEX).toBe(0);
  });

  it("fails outside a host container instead of pretending to sweep", async () => {
    mocks.getPaymentManager.mockResolvedValue(null);

    await expect(sweepPrizeIntoCoinage(PRIZE)).rejects.toThrow(
      /no host payment manager/,
    );
    expect(mocks.topUp).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount before reaching the host", async () => {
    await expect(sweepPrizeIntoCoinage(0n)).rejects.toThrow(RangeError);
    expect(mocks.topUp).not.toHaveBeenCalled();
  });

  it("propagates a host top-up rejection to the caller", async () => {
    const failure = new Error("purse unavailable");
    mocks.topUp.mockRejectedValue(failure);

    await expect(sweepPrizeIntoCoinage(PRIZE)).rejects.toBe(failure);
  });
});
