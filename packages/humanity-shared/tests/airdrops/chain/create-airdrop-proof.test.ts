// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RingLocation,
  RingVrfKeyHandle,
  TruApi,
} from "@humanity/shared/chain/host-api.ts";
import { PERSONHOOD_CONTEXT_INDEX } from "@humanity/shared/chain/individuality.ts";
import { createAirdropProof } from "@humanity/shared/airdrops/chain/create-airdrop-proof.ts";

const CONTEXT = `0x${"11".repeat(32)}` as const;
const ALIAS = `0x${"22".repeat(32)}` as const;
const PROOF = "0xc0ffee" as const;
const MESSAGE = new Uint8Array([0xde, 0xad]);
const PRODUCT_ID = "peopl.paseo";
const KEY_HANDLE = {
  dotNsIdentifier: PRODUCT_ID,
  derivationIndex: { tag: "Index", value: 0 },
} as unknown as RingVrfKeyHandle;
const RING: RingLocation = {
  chainId: `0x${"33".repeat(32)}`,
  junctions: [],
};
const createAccountProof = vi.fn();
const CLIENT = { account: { createAccountProof } } as unknown as TruApi;

function hostResult(context = CONTEXT) {
  const response = {
    proof: PROOF,
    contextualAlias: { context, alias: ALIAS },
    ringIndex: 3,
    ringRevision: 7,
  };
  return {
    match: (ok: (value: typeof response) => unknown) =>
      Promise.resolve(ok(response)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createAccountProof.mockReturnValue(hostResult());
});

describe("createAirdropProof", () => {
  it("mints under the personhood product's airdrops context and decodes the response", async () => {
    const result = await createAirdropProof({
      client: CLIENT,
      keyHandle: KEY_HANDLE,
      productId: PRODUCT_ID,
      expectedContext: CONTEXT,
      ringLocation: RING,
      message: MESSAGE,
    });

    expect(createAccountProof).toHaveBeenCalledWith({
      keyHandle: KEY_HANDLE,
      context: {
        productId: PRODUCT_ID,
        suffix: { tag: "Index", value: PERSONHOOD_CONTEXT_INDEX.peopleAirdrops },
      },
      ringLocation: RING,
      message: "0xdead",
    });
    expect(result).toEqual({
      proof: new Uint8Array([0xc0, 0xff, 0xee]),
      contextualAlias: {
        context: new Uint8Array(32).fill(0x11),
        alias: new Uint8Array(32).fill(0x22),
      },
      ringIndex: 3,
      ringRevision: 7,
    });
  });

  it("rejects a proof returned for a different context", async () => {
    createAccountProof.mockReturnValue(
      hostResult(`0x${"44".repeat(32)}` as typeof CONTEXT),
    );

    await expect(
      createAirdropProof({
        client: CLIENT,
        keyHandle: KEY_HANDLE,
        productId: PRODUCT_ID,
        expectedContext: CONTEXT,
        ringLocation: RING,
        message: MESSAGE,
      }),
    ).rejects.toThrow(/different context/);
  });
});
