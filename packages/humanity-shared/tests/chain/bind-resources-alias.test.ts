// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  membershipRingLocation,
  PERSONHOOD_CONTEXT_INDEX,
  personhoodContext,
} from "@humanity/shared/chain/individuality.ts";
import { resolveNetwork } from "@humanity/shared/chain/networks.ts";

const m = vi.hoisted(() => ({
  account: vi.fn(),
  host: vi.fn(),
  client: vi.fn(),
  alias: vi.fn(),
  submit: vi.fn(),
  ring: vi.fn(),
  proof: vi.fn(),
  setAlias: vi.fn(),
  withAsPerson: vi.fn(),
  signer: vi.fn(),
}));
vi.mock("@humanity/shared/chain/client.ts", () => ({
  getPeopleClient: m.client,
}));
vi.mock("@humanity/shared/chain/host-api.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAccountsProvider: m.account,
  getTruApi: m.host,
}));
vi.mock("@humanity/shared/chain/ring-vrf-key.ts", () => ({
  resolveRingVrfKeyHandle: m.ring,
}));
vi.mock("@humanity/shared/chain/ring-vrf-proof.ts", () => ({
  createRingVrfProof: m.proof,
}));
vi.mock("@humanity/shared/chain/transaction-submission.ts", () => ({
  watchTransactionSubmission: m.submit,
}));
vi.mock("@parity/product-sdk/individuality", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withAsPerson: m.withAsPerson,
}));

import {
  bindResourcesAlias,
  resourcesAliasProof,
} from "@humanity/shared/chain/bind-resources-alias.ts";
const network = resolveNetwork("previewnet");
const domain = "peopl.testnet";
const hash = `0x${"12".repeat(32)}`;
const PRODUCT_SIGNER = { kind: "product-signer" };
let keyIndex = 0;

beforeEach(() => {
  vi.resetAllMocks();
  keyIndex += 1;
  m.account.mockResolvedValue({
    getProductAccount: () => ({
      match: async (ok: (v: unknown) => unknown) =>
        ok({
          publicKey: new Uint8Array(32).fill(keyIndex),
          dotNsIdentifier: domain,
          derivationIndex: 0,
        }),
    }),
    getProductAccountSigner: m.signer,
  });
  m.signer.mockReturnValue(PRODUCT_SIGNER);
  m.host.mockResolvedValue({});
  m.alias.mockResolvedValue(undefined);
  m.client.mockResolvedValue({
    client: { getFinalizedBlock: async () => ({ hash, number: 100 }) },
    api: {
      constants: {
        PeopleAirdrops: {
          people_airdrops_context: async () =>
            personhoodContext("testnet", "peopleAirdrops"),
        },
      },
      query: { People: { AccountToAlias: { getValue: m.alias } } },
      tx: { People: { set_alias_account: m.setAlias } },
    },
  });
  m.ring.mockResolvedValue({});
  m.submit.mockResolvedValue({ status: "included", txHash: hash });
});

describe("Resources alias binding", () => {
  it("binds account zero with the Resources proof on the SDK signer", async () => {
    const result = await bindResourcesAlias(network, domain);
    expect(result.outcome).toBe("bound");
    expect(m.setAlias).toHaveBeenCalledWith({
      account: result.address,
      call_valid_at: 100,
    });
    // The claim follows on the best block, so the binding settles there and
    // its "already bound" check reads there too.
    expect(m.alias).toHaveBeenCalledWith(result.address, { at: "best" });
    expect(m.submit.mock.calls[0]?.[3]).toMatchObject({ settleOn: "bestBlock" });
    expect(m.withAsPerson).toHaveBeenCalledWith(
      PRODUCT_SIGNER,
      expect.objectContaining({ tag: "AliasWithProof" }),
    );
    const { createProof } = m.withAsPerson.mock.calls[0]![1];
    const message = new Uint8Array([1, 2]);
    await createProof(message);
    expect(m.proof).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "peopl.testnet",
        contextIndex: PERSONHOOD_CONTEXT_INDEX.resources,
        expectedContext: personhoodContext("testnet", "resources"),
        message,
      }),
    );
    expect(m.signer).toHaveBeenCalledWith(
      expect.objectContaining({ derivationIndex: 0 }),
    );
  });

  it("does not submit again when already bound", async () => {
    m.alias.mockResolvedValue({
      ca: { context: personhoodContext("testnet", "resources") },
    });
    expect((await bindResourcesAlias(network, domain)).outcome).toBe(
      "already-bound",
    );
    expect(m.submit).not.toHaveBeenCalled();
    expect(m.ring).not.toHaveBeenCalled();
  });

  it("rejects an account already used for Daily Dollar", async () => {
    m.alias.mockResolvedValue({
      ca: { context: personhoodContext("testnet", "peopleAirdrops") },
    });
    await expect(bindResourcesAlias(network, domain)).rejects.toMatchObject({
      stage: "chain",
    });
    expect(m.submit).not.toHaveBeenCalled();
  });

  it("locks an unknown broadcast, but reconciles it when chain state catches up", async () => {
    m.submit.mockImplementation(async (_tx, _signer, _options, callbacks) => {
      callbacks.onBroadcast(hash);
      return { status: "unknown", txHash: hash };
    });
    expect((await bindResourcesAlias(network, domain)).outcome).toBe(
      "submitted-unconfirmed",
    );
    await expect(bindResourcesAlias(network, domain)).rejects.toMatchObject({
      stage: "pending",
    });
    expect(m.submit).toHaveBeenCalledOnce();
    m.alias.mockResolvedValue({
      ca: { context: personhoodContext("testnet", "resources") },
    });
    expect((await bindResourcesAlias(network, domain)).outcome).toBe(
      "already-bound",
    );
  });

  it("does not bind if the host has no proof API", async () => {
    m.host.mockResolvedValue(null);
    await expect(bindResourcesAlias(network, domain)).rejects.toMatchObject({
      stage: "host",
    });
    expect(m.submit).not.toHaveBeenCalled();
  });
});

describe("Resources alias proof factory", () => {
  /** How a live host declares the people ring: with the pallet instance. */
  const DECLARED_RING = {
    chainId: "0xdeclared",
    junctions: [
      { tag: "PalletInstance", value: 67 },
      { tag: "CollectionId", value: "0xpeople" },
    ],
  };

  it("resolves the key up front and proves against the host's declared ring", async () => {
    const provider = { kind: "provider" };
    const truApi = { kind: "truapi" };
    m.ring.mockResolvedValue({ handle: "key-handle", ring: DECLARED_RING });

    const createProof = await resourcesAliasProof(
      provider as never,
      truApi as never,
      network,
      domain,
    );
    expect(m.ring).toHaveBeenCalledWith(
      provider,
      domain,
      membershipRingLocation(network),
    );
    expect(m.proof).not.toHaveBeenCalled();

    const message = new Uint8Array([3, 4]);
    await createProof(message);
    expect(m.proof).toHaveBeenCalledWith(
      expect.objectContaining({
        client: truApi,
        keyHandle: "key-handle",
        productId: "peopl.testnet",
        contextIndex: PERSONHOOD_CONTEXT_INDEX.resources,
        expectedContext: personhoodContext("testnet", "resources"),
        ringLocation: DECLARED_RING,
        message,
      }),
    );
  });

  it("rejects without proving when the host holds no ring key", async () => {
    m.ring.mockRejectedValue(new Error("missing"));

    await expect(
      resourcesAliasProof({} as never, {} as never, network, domain),
    ).rejects.toThrow("missing");
    expect(m.proof).not.toHaveBeenCalled();
  });
});
