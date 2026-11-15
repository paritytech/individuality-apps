// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ss58Encode } from "@parity/product-sdk/address";

const mocks = vi.hoisted(() => ({
  getAccountsProvider: vi.fn(),
  productDomain: vi.fn(() => "peopl.paseo"),
}));

vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  getAccountsProvider: mocks.getAccountsProvider,
}));
vi.mock("@humanity/shared/identity/product-domain.ts", () => ({
  productDomain: mocks.productDomain,
}));

import {
  AIRDROP_ACCOUNT_INDEX,
  resolveAirdropAccount,
} from "@humanity/shared/airdrops/chain/airdrop-account.ts";

const publicKey = new Uint8Array(32).fill(0x22);
const signer = { publicKey, signBytes: vi.fn(), signTx: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveAirdropAccount", () => {
  it("reserves product subaccount one and exposes its host signer", async () => {
    const account = { publicKey };
    const getProductAccount = vi.fn(() => ({
      match: (ok: (value: typeof account) => unknown) =>
        Promise.resolve(ok(account)),
    }));
    const provider = {
      getProductAccount,
      getProductAccountSigner: vi.fn(() => signer),
    };
    mocks.getAccountsProvider.mockResolvedValue(provider);

    await expect(resolveAirdropAccount()).resolves.toEqual({
      account,
      address: ss58Encode(publicKey, 42),
      signer,
      provider,
    });
    expect(AIRDROP_ACCOUNT_INDEX).toBe(1);
    expect(getProductAccount).toHaveBeenCalledWith("peopl.paseo", 1);
  });

  it("returns null when the host account provider is unavailable", async () => {
    mocks.getAccountsProvider.mockResolvedValue(null);
    await expect(resolveAirdropAccount()).resolves.toBeNull();
  });
});
