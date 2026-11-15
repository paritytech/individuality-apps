// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Individuality from "@humanity/shared/chain/individuality.ts";
import type * as HostApi from "@humanity/shared/chain/host-api.ts";
import type * as ProductDomain from "@humanity/shared/identity/product-domain.ts";
import type * as TransactionSubmission from "@humanity/shared/chain/transaction-submission.ts";



const mocks = vi.hoisted(() => ({
  withAsPerson: vi.fn(),
  findRingVrfKeyHandle: vi.fn(),
  getTruApi: vi.fn(),
  membershipRingLocation: vi.fn(),
  productDomain: vi.fn(() => "peopl.paseo"),
  accountToAlias: vi.fn(),
  createRingVrfProof: vi.fn(),
  watchTransactionSubmission: vi.fn(),
  hasPendingAliasBinding: vi.fn(),
  setPendingAliasBinding: vi.fn(),
  clearPendingAliasBinding: vi.fn(),
}));

vi.mock("@humanity/shared/chain/individuality.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Individuality>();
  return {
    ...actual,
    membershipRingLocation: mocks.membershipRingLocation,
    withAsPerson: mocks.withAsPerson,
  };
});
vi.mock("@humanity/shared/chain/host-api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof HostApi>();
  return {
    ...actual,
    findRingVrfKeyHandle: mocks.findRingVrfKeyHandle,
    getTruApi: mocks.getTruApi,
  };
});
vi.mock("@humanity/shared/identity/product-domain.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProductDomain>();
  return { ...actual, productDomain: mocks.productDomain };
});
vi.mock("@humanity/shared/chain/ring-vrf-proof.ts", () => ({
  createRingVrfProof: mocks.createRingVrfProof,
}));
vi.mock("@humanity/shared/airdrops/chain/pending-alias-binding.ts", () => ({
  hasPendingAliasBinding: mocks.hasPendingAliasBinding,
  setPendingAliasBinding: mocks.setPendingAliasBinding,
  clearPendingAliasBinding: mocks.clearPendingAliasBinding,
}));
vi.mock("@humanity/shared/chain/transaction-submission.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof TransactionSubmission>();
  return { ...actual, watchTransactionSubmission: mocks.watchTransactionSubmission };
});

import type { AirdropAccount } from "@humanity/shared/airdrops/chain/airdrop-account.ts";
import {
  ensureAirdropAlias,
  NotAttestedDeviceError,
} from "@humanity/shared/airdrops/chain/ensure-airdrop-alias.ts";
import { PERSONHOOD_CONTEXT_INDEX } from "@humanity/shared/chain/individuality.ts";
import type { NetworkConfig } from "@humanity/shared/chain/networks.ts";
import type { RingLocation, RingVrfKeyHandle, TruApi } from "@humanity/shared/chain/host-api.ts";
import { TransactionSubmissionError } from "@humanity/shared/chain/transaction-submission.ts";

const ADDRESS = "5AirdropAccount";
const CONTEXT = `0x${"11".repeat(32)}` as const;
const ALIAS = `0x${"22".repeat(32)}` as const;
const OTHER_CONTEXT = `0x${"33".repeat(32)}` as const;
const BLOCK_HASH = `0x${"44".repeat(32)}` as const;
const MESSAGE = new Uint8Array([0xde, 0xad]);
const RING: RingLocation = { chainId: BLOCK_HASH, junctions: [] };
const KEY_HANDLE = {
  dotNsIdentifier: "peopl.paseo",
  derivationIndex: { tag: "Index", value: 0 },
} as unknown as RingVrfKeyHandle;
const TRU_API = { account: {} } as unknown as TruApi;
const TX = { kind: "set-alias-account" };
const TX_HASH = `0x${"aa".repeat(32)}`;
const PERSON_SIGNER = { kind: "alias-with-proof-signer", info: null as unknown };

const listRingVrfKeys = vi.fn(() => ({
  match: (ok: (value: unknown[]) => unknown) => Promise.resolve(ok([])),
}));
const registerRingVrfKey = vi.fn(() => ({
  match: (ok: (value: Uint8Array) => unknown) =>
    Promise.resolve(ok(new Uint8Array(32))),
}));
const account = {
  address: ADDRESS,
  signer: { publicKey: new Uint8Array(32), signBytes: vi.fn(), signTx: vi.fn() },
  provider: { listRingVrfKeys, registerRingVrfKey },
} as unknown as AirdropAccount;
const setAliasAccount = vi.fn(() => TX);
// The SDK's `readPeopleAirdropsSigning` runs for real over these three reads.
const api = {
  constants: {
    PeopleAirdrops: { people_airdrops_context: vi.fn(async () => CONTEXT) },
  },
  query: {
    People: { AccountToAlias: { getValue: mocks.accountToAlias } },
    Members: {
      Root: { getValue: vi.fn(async (): Promise<{ revision: number } | undefined> => ({ revision: 5 })) },
    },
  },
  tx: { People: { set_alias_account: setAliasAccount } },
};
const client = {
  getBestBlocks: vi.fn(async () => [{ hash: BLOCK_HASH, number: 42 }]),
};
const network = {
  key: "paseo-next-v2",
  dotnsSuffix: "paseo",
} as unknown as NetworkConfig;

/** `People.AccountToAlias` as stored, at ring 0 revision 5. */
function binding(context: string) {
  return { revision: 5, ring: 0, ca: { alias: ALIAS, context } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountToAlias.mockResolvedValue(undefined);
  mocks.membershipRingLocation.mockReturnValue(RING);
  mocks.findRingVrfKeyHandle.mockReturnValue(KEY_HANDLE);
  mocks.getTruApi.mockResolvedValue(TRU_API);
  mocks.hasPendingAliasBinding.mockReturnValue(false);
  mocks.createRingVrfProof.mockResolvedValue({
    proof: new Uint8Array([1]),
    contextualAlias: {
      context: new Uint8Array(32).fill(0x11),
      alias: new Uint8Array(32).fill(0x22),
    },
    ringIndex: 0,
    ringRevision: 1,
  });
  mocks.withAsPerson.mockImplementation((_signer, info) => ({
    ...PERSON_SIGNER,
    info,
  }));
  mocks.watchTransactionSubmission.mockImplementation(
    async (
      _tx,
      signer: { info: { createProof(message: Uint8Array): Promise<unknown> } },
      _options,
      watchOptions: { onBroadcast?: (txHash: string) => void },
    ) => {
      await signer.info.createProof(MESSAGE);
      watchOptions.onBroadcast?.(TX_HASH);
      return { status: "finalized", txHash: TX_HASH };
    },
  );
});

describe("ensureAirdropAlias", () => {
  it("returns an existing matching alias without asking the host for a proof", async () => {
    mocks.accountToAlias.mockResolvedValue(binding(CONTEXT));

    await expect(
      ensureAirdropAlias({ api: api as never, client: client as never, network, account }),
    ).resolves.toMatchObject({ alias: ALIAS });
    expect(listRingVrfKeys).not.toHaveBeenCalled();
    expect(mocks.watchTransactionSubmission).not.toHaveBeenCalled();
    expect(mocks.withAsPerson).toHaveBeenCalledWith(account.signer, {
      tag: "AliasWithAccount",
    });
    expect(mocks.accountToAlias).toHaveBeenCalledWith(
      ADDRESS,
      expect.objectContaining({ at: BLOCK_HASH }),
    );
  });

  it("refuses when the binding's ring has no root on chain", async () => {
    mocks.accountToAlias.mockResolvedValue(binding(CONTEXT));
    api.query.Members.Root.getValue.mockResolvedValueOnce(undefined);

    await expect(
      ensureAirdropAlias({ api: api as never, client: client as never, network, account }),
    ).rejects.toThrow(/ring for your Daily Dollar identity is unavailable/);
    expect(listRingVrfKeys).not.toHaveBeenCalled();
  });

  it("revises an alias whose stored ring revision is stale", async () => {
    mocks.accountToAlias.mockResolvedValue(binding(CONTEXT));
    api.query.Members.Root.getValue.mockResolvedValueOnce({ revision: 11 });

    const authorization = await ensureAirdropAlias({
      api: api as never,
      client: client as never,
      network,
      account,
    });

    expect(authorization.alias).toBe(ALIAS);
    expect(mocks.withAsPerson).toHaveBeenCalledWith(
      account.signer,
      expect.objectContaining({ tag: "AliasWithAccountRevised" }),
    );
    const info = (authorization.signer as unknown as typeof PERSON_SIGNER).info as {
      createProof(message: Uint8Array): Promise<unknown>;
    };
    await info.createProof(MESSAGE);
    expect(mocks.createRingVrfProof).toHaveBeenCalledWith({
      client: TRU_API,
      keyHandle: KEY_HANDLE,
      productId: "peopl.paseo",
      contextIndex: PERSONHOOD_CONTEXT_INDEX.peopleAirdrops,
      expectedContext: CONTEXT,
      ringLocation: RING,
      message: MESSAGE,
      failureMessage: "Host could not create the airdrop proof",
      contextMismatchMessage:
        "Host returned an airdrop proof for a different context.",
    });
    expect(mocks.watchTransactionSubmission).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an alias already bound to another context", async () => {
    mocks.accountToAlias.mockResolvedValue(binding(OTHER_CONTEXT));

    await expect(
      ensureAirdropAlias({ api: api as never, client: client as never, network, account }),
    ).rejects.toThrow(/different identity context/);
    expect(listRingVrfKeys).not.toHaveBeenCalled();
  });

  it("registers the personhood key when the host registry names no handle yet, then binds", async () => {
    // A fresh registry: the attested key is in the keystore, the registry has
    // not named it for this ring. Listing alone lost this to the promotion
    // flow by seconds and `registerForDraws` then sat on "not this device"
    // for an hour.
    mocks.findRingVrfKeyHandle.mockReturnValueOnce(undefined).mockReturnValue(KEY_HANDLE);

    await expect(
      ensureAirdropAlias({ api: api as never, client: client as never, network, account }),
    ).resolves.toMatchObject({ alias: ALIAS });

    expect(registerRingVrfKey).toHaveBeenCalledTimes(1);
    // Index 0 under the reserved personhood product: the same key the phone
    // attested with, not a key under the deploy's own product id (af54520).
    expect(registerRingVrfKey).toHaveBeenCalledWith(0, RING);
    expect(listRingVrfKeys).toHaveBeenCalledTimes(2);
    expect(listRingVrfKeys).toHaveBeenCalledWith("peopl.paseo");
    expect(mocks.createRingVrfProof).toHaveBeenCalledTimes(1);
    expect(setAliasAccount).toHaveBeenCalledTimes(1);
  });

  it("refuses as not-attested only when the registry still names no handle after registering", async () => {
    mocks.findRingVrfKeyHandle.mockReturnValue(undefined);

    const error = await ensureAirdropAlias({
      api: api as never,
      client: client as never,
      network,
      account,
    }).catch((err: unknown) => err);
    // Typed, so `registerForDraws` can remember "not this device" instead of
    // retrying it every beat like a chain failure.
    expect(error).toBeInstanceOf(NotAttestedDeviceError);
    expect((error as Error).message).toMatch(
      new RegExp(`no full-personhood ring-VRF key under peopl\\.paseo for ring ${BLOCK_HASH}`),
    );
    expect(registerRingVrfKey).toHaveBeenCalledTimes(1);
    expect(listRingVrfKeys).toHaveBeenCalledTimes(2);
    expect(mocks.createRingVrfProof).not.toHaveBeenCalled();
    expect(mocks.watchTransactionSubmission).not.toHaveBeenCalled();
    expect(setAliasAccount).not.toHaveBeenCalled();
  });

  it("treats a host that declines to list keys as a transient failure, not an unattested device", async () => {
    listRingVrfKeys.mockReturnValueOnce({
      match: (_ok: (value: unknown[]) => unknown, err?: (error: unknown) => unknown) =>
        Promise.resolve(err?.({ tag: "HostUnavailable" })),
    } as never);

    const error = await ensureAirdropAlias({
      api: api as never,
      client: client as never,
      network,
      account,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NotAttestedDeviceError);
    expect((error as Error).message).toBe("The host could not read your personhood key.");
    expect(registerRingVrfKey).not.toHaveBeenCalled();
    expect(mocks.createRingVrfProof).not.toHaveBeenCalled();
  });

  it("rejects when the current host exposes no proof API", async () => {
    mocks.getTruApi.mockResolvedValue(null);

    await expect(
      ensureAirdropAlias({ api: api as never, client: client as never, network, account }),
    ).rejects.toThrow(/proof API is not available/);
    expect(setAliasAccount).not.toHaveBeenCalled();
  });

  it("does not replay an alias bind whose broadcast is still unresolved", async () => {
    mocks.hasPendingAliasBinding.mockReturnValue(true);

    await expect(
      ensureAirdropAlias({ api: api as never, client: client as never, network, account }),
    ).rejects.toThrow(/still being confirmed/);
    expect(listRingVrfKeys).not.toHaveBeenCalled();
  });

  it("binds account one with an AliasWithProof signer and returns its alias", async () => {
    await expect(
      ensureAirdropAlias({ api: api as never, client: client as never, network, account }),
    ).resolves.toMatchObject({ alias: ALIAS });

    // The reserved personhood product, not the deploy name this test's
    // `productDomain` mock returns — the two must not be the same string.
    expect(listRingVrfKeys).toHaveBeenCalledWith("peopl.paseo");
    expect(mocks.findRingVrfKeyHandle).toHaveBeenCalledWith([], RING);
    expect(setAliasAccount).toHaveBeenCalledWith({
      account: ADDRESS,
      call_valid_at: 42,
    });
    expect(mocks.withAsPerson).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: account.signer.publicKey,
        signBytes: expect.any(Function),
        signTx: expect.any(Function),
      }),
      expect.objectContaining({ tag: "AliasWithProof" }),
    );
    expect(mocks.createRingVrfProof).toHaveBeenCalledWith({
      client: TRU_API,
      keyHandle: KEY_HANDLE,
      productId: "peopl.paseo",
      contextIndex: PERSONHOOD_CONTEXT_INDEX.peopleAirdrops,
      expectedContext: CONTEXT,
      ringLocation: RING,
      message: MESSAGE,
      failureMessage: "Host could not create the airdrop proof",
      contextMismatchMessage:
        "Host returned an airdrop proof for a different context.",
    });
    expect(mocks.watchTransactionSubmission).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ kind: "alias-with-proof-signer" }),
      {},
      expect.objectContaining({
        signingTimeoutMs: 60_000,
        finalityTimeoutMs: 120_000,
        onBroadcast: expect.any(Function),
      }),
    );
    expect(mocks.setPendingAliasBinding).toHaveBeenCalledWith(ADDRESS, TX_HASH);
    expect(mocks.clearPendingAliasBinding).toHaveBeenCalledWith(ADDRESS, TX_HASH);
    // A proof path never mints a ring key: only the attested device's key is
    // enrolled, so anything registered here could not verify.
    expect(registerRingVrfKey).not.toHaveBeenCalled();
  });

  it("does not register draws after alias-binding finality becomes unknown", async () => {
    const detail = "no finalized block within 120000 ms";
    mocks.watchTransactionSubmission.mockImplementation(
      async (
        _tx,
        signer: { info: { createProof(message: Uint8Array): Promise<unknown> } },
        _options,
        watchOptions: { onBroadcast?: (txHash: string) => void },
      ) => {
        await signer.info.createProof(MESSAGE);
        watchOptions.onBroadcast?.(TX_HASH);
        return { status: "unknown", txHash: TX_HASH, detail };
      },
    );

    const error = await ensureAirdropAlias({
      api: api as never,
      client: client as never,
      network,
      account,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TransactionSubmissionError);
    // The player still reads the same sentence; the operator now gets the
    // watcher's reason instead of that sentence repeated back.
    expect((error as TransactionSubmissionError).message).toBe(
      "We couldn't bind your Daily Dollar identity. Try again shortly.",
    );
    expect((error as TransactionSubmissionError).detail).toContain(detail);
    expect(mocks.setPendingAliasBinding).toHaveBeenCalledWith(ADDRESS, TX_HASH);
    expect(mocks.clearPendingAliasBinding).not.toHaveBeenCalled();
  });
});
