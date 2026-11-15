// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { ss58Encode } from "@parity/product-sdk/address";
import type { AccountsProvider } from "@humanity/shared/chain/host-api.ts";
import { resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { personhoodProductId } from "@humanity/shared/identity/product-domain.ts";
import { resolveLiteOwner } from "@features/card/chain/resolve-lite-owner.ts";

const NETWORK = resolveNetwork("previewnet");
const PEOPL = personhoodProductId(NETWORK);
const key = new Uint8Array(32).fill(1);
const other = new Uint8Array(32).fill(2);
const address = ss58Encode(key, 42);

function providerFor(owner: string | null) {
  const getProductAccount = vi.fn((domain: string) => ({
    match: async (ok: (value: unknown) => unknown) =>
      ok({
        publicKey: domain === owner ? key : other,
        dotNsIdentifier: domain,
        derivationIndex: 0,
      }),
  }));
  return {
    provider: { getProductAccount } as unknown as AccountsProvider,
    getProductAccount,
  };
}

describe("username owner resolution", () => {
  it("resolves the owner to peopl.<tld>/0 and asks for nothing else", async () => {
    const { provider, getProductAccount } = providerFor(PEOPL);
    const owner = await resolveLiteOwner(provider, NETWORK, address);
    expect(owner).toMatchObject({ domain: PEOPL });
    expect(owner?.account.publicKey).toEqual(key);
    expect(getProductAccount.mock.calls).toEqual([[PEOPL, 0]]);
  });

  it("returns null when peopl.<tld>/0 is not the on-chain owner, with no uid fallback", async () => {
    const { provider, getProductAccount } = providerFor("other.testnet");
    expect(await resolveLiteOwner(provider, NETWORK, address)).toBeNull();
    expect(getProductAccount.mock.calls).toEqual([[PEOPL, 0]]);
  });

  it("returns null when the host has no account for peopl.<tld>", async () => {
    const getProductAccount = vi.fn(() => ({
      match: async (_ok: unknown, err: (e: unknown) => unknown) => err({ tag: "NotFound" }),
    }));
    const provider = { getProductAccount } as unknown as AccountsProvider;
    expect(await resolveLiteOwner(provider, NETWORK, address)).toBeNull();
  });
});
