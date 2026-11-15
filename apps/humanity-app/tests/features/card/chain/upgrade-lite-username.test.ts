// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { Binary, Enum } from "polkadot-api";
import { ss58Encode } from "@parity/product-sdk/address";
import { getPublicKey, secretFromSeed, sign } from "@scure/sr25519";

import {
  upgradeLiteUsername,
  UsernameUpgradeError,
  USERNAME_UPGRADE_MORTALITY_PERIOD,
  type UpgradeLiteUsernameArgs,
} from "@features/card/chain/upgrade-lite-username.ts";
import {
  clearFailedUsernameUpgrade,
  clearPendingUsernameUpgrade,
  hasPendingUsernameUpgrade,
  readFailedUsernameUpgrade,
  readPendingUsernameUpgrade,
  recordFailedUsernameUpgrade,
  setPendingUsernameUpgrade,
} from "@features/card/chain/pending-username-upgrade.ts";
import * as pendingUpgrade from "@features/card/chain/pending-username-upgrade.ts";
import * as transactionSubmission from "@humanity/shared/chain/transaction-submission.ts";
import * as resourcesAlias from "@humanity/shared/chain/bind-resources-alias.ts";
import { resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { personhoodProductId } from "@humanity/shared/identity/product-domain.ts";
import { personhoodContext } from "@humanity/shared/chain/individuality.ts";
import { envConfig } from "@humanity/shared/config/env.ts";
import { toHex } from "@humanity/shared/chain/host-api.ts";
import { productDomain } from "@humanity/shared/identity/product-domain.ts";

const mocks = vi.hoisted(() => ({
  getAccountsProvider: vi.fn(),
  getTruApi: vi.fn(),
  getPeopleClient: vi.fn(),
  watchClaimSubmission: vi.fn(),
  bindResourcesAlias: vi.fn(),
  resourcesAliasProof: vi.fn(),
  withAsPerson: vi.fn(),
  aliasSigner: { kind: "alias-account-signer" },
}));
vi.mock("@parity/product-sdk/individuality", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withAsPerson: mocks.withAsPerson,
}));
const logMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

// A dev subname signs transactions as its own `/0`, not as `peopl.<tld>/0`,
// so the tx signer and the username owner are two different accounts here.
vi.mock("@humanity/shared/identity/product-domain.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@humanity/shared/identity/product-domain.ts")
  >()),
  productDomain: () => "dev.peopl.paseo",
}));
vi.mock("@humanity/shared/chain/host-api.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@humanity/shared/chain/host-api.ts")
  >()),
  getAccountsProvider: mocks.getAccountsProvider,
  getTruApi: mocks.getTruApi,
}));
vi.mock("@humanity/shared/chain/client.ts", () => ({
  getPeopleClient: mocks.getPeopleClient,
}));
vi.mock(
  "@humanity/shared/chain/bind-resources-alias.ts",
  async (importOriginal) => ({
    ...(await importOriginal<typeof resourcesAlias>()),
    bindResourcesAlias: mocks.bindResourcesAlias,
    resourcesAliasProof: mocks.resourcesAliasProof,
  }),
);
vi.mock(
  "@humanity/shared/chain/transaction-submission.ts",
  async (importOriginal) => {
    const actual = await importOriginal<typeof transactionSubmission>();
    return {
      ...actual,
      watchTransactionSubmission: mocks.watchClaimSubmission,
    };
  },
);
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => logMocks,
}));

/** 32-byte contextual alias as `People.AccountToAlias` returns it. */
const ALIAS_HEX =
  "0x112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011";
/**
 * Both personhood contexts the preflight uses, derived exactly as production
 * does. Pinning either as hex is the bug this replaces: the literal
 * `pop:polkadot.network/resources  ` kept these tests green while every real
 * upgrade failed preflight. `personhood-context.test.ts` pins the derivation
 * itself against values read off the live chain.
 */
const DOTNS_SUFFIX = resolveNetwork(envConfig.chain.network).dotnsSuffix;
const RESOURCES_CONTEXT_HEX = personhoodContext(DOTNS_SUFFIX, "resources");
const AIRDROPS_CONTEXT_HEX = personhoodContext(DOTNS_SUFFIX, "peopleAirdrops");
/** `peopl.<suffix>`: its account 0 owns the usernames (RFC-0028). */
const LITE_IDENTITY_DOMAIN = personhoodProductId(
  resolveNetwork(envConfig.chain.network),
);

const CURRENT_LITE_USERNAME = "alice.42";
const FULL_USERNAME = "aliceperson";
const TX_HASH = `0x${"ab".repeat(32)}`;
const NONCE = 7;
const FINALIZED_BLOCK_HASH = `0x${"11".repeat(32)}`;
const FINALIZED_BLOCK_NUMBER = 12_345;

const testSecret = secretFromSeed(new Uint8Array(32).fill(0x11));
const legacyPublicKey = getPublicKey(testSecret);
const productPublicKey = new Uint8Array(32).fill(0x22);
const expectedLiteAddress = ss58Encode(legacyPublicKey, 42);
const productAddress = ss58Encode(productPublicKey, 42);
const signatureBytes = sign(testSecret, Binary.fromHex(ALIAS_HEX));
/**
 * The wire shape the unwatermarked proof call must take: the lite username
 * owner as product account `peopl.<tld>`/0 (RFC-0028), and the raw alias bytes as the payload — no `<Bytes>`
 * envelope for the host to strip or add.
 */
const PROOF_REQUEST = {
  account: {
    dotNsIdentifier: LITE_IDENTITY_DOMAIN,
    derivationIndex: { tag: "Index", value: 0 },
  },
  payload: { tag: "Bytes", value: { bytes: ALIAS_HEX } },
};

interface FakeChainApi {
  query: {
    Resources: {
      UsernameOwnerOf: { getValue: Mock };
      UsernameReservationQueue: { getValue: Mock };
    };
    People: { AccountToAlias: { getValue: Mock } };
    Members: { Root: { getValue: Mock } };
    System: { Account: { getValue: Mock } };
  };
  constants: {
    PeopleAirdrops: { people_airdrops_context: Mock };
  };
  tx: { Resources: { register_person: Mock } };
}

function resultAsync<T>(value: T | Error) {
  return {
    match: async (ok: (v: T) => unknown, err: (e: unknown) => unknown) =>
      value instanceof Error ? err(value) : ok(value as T),
  };
}

interface FakeProvider {
  getUserId: Mock;
  getProductAccount: Mock;
  getProductAccountSigner: Mock;
}

function makeProvider(): FakeProvider {
  const productSigner = {
    publicKey: productPublicKey,
    signBytes: vi.fn(),
    signTx: vi.fn(),
  };
  const provider: FakeProvider = {
    getUserId: vi.fn(() =>
      resultAsync<{ primaryUsername: string }>({
        primaryUsername: "alice.42.paseo",
      }),
    ),
    // Domain-aware, because the upgrade resolves two different product
    // accounts: its own signer (a `dev.peopl.*` subname here, so it differs from
    // the owner) and the `peopl.<suffix>` identity account.
    getProductAccount: vi.fn((domain: string) =>
      resultAsync({
        publicKey:
          domain === LITE_IDENTITY_DOMAIN ? legacyPublicKey : productPublicKey,
        derivationIndex: 0,
        dotNsIdentifier: domain,
      }),
    ),
    getProductAccountSigner: vi.fn(() => productSigner),
  };
  return provider;
}

interface FakeTruApi {
  signing: {
    signRawUnwatermarkedDeprecated: Mock;
    signRawUnwatermarkedDeprecatedWithLegacyAccount: Mock;
  };
}

/**
 * The host's unwatermarked signing calls (host-rust-core#731), reached on the
 * truAPI client directly: the signature is over the raw alias, with no
 * `<Bytes>` envelope, which is what `Resources.register_person` verifies. The
 * legacy-account variant is only the fallback for a `dev.peopl.*` subname or
 * preview, where the product's own `/0` is not the owner; see `sign-lite-identity-proof.test.ts`.
 */
function makeTruApi(): FakeTruApi {
  return {
    signing: {
      signRawUnwatermarkedDeprecated: vi.fn(() =>
        resultAsync({ signature: toHex(signatureBytes) }),
      ),
      signRawUnwatermarkedDeprecatedWithLegacyAccount: vi.fn(() =>
        resultAsync({ signature: toHex(signatureBytes) }),
      ),
    },
  };
}

function makeApi(): FakeChainApi {
  return {
    query: {
      Resources: {
        UsernameOwnerOf: {
          getValue: vi.fn(async (key: Uint8Array) => {
            const currentKey = Binary.toHex(
              Binary.fromText(CURRENT_LITE_USERNAME),
            );
            return Binary.toHex(key) === currentKey
              ? expectedLiteAddress
              : null;
          }),
        },
        UsernameReservationQueue: {
          getValue: vi.fn(async () => null),
        },
      },
      People: {
        AccountToAlias: {
          getValue: vi.fn(async () => ({
            revision: 3,
            ring: 1,
            ca: { alias: ALIAS_HEX, context: RESOURCES_CONTEXT_HEX },
          })),
        },
      },
      // The alias above was bound at revision 3, and the ring is still at 3.
      Members: {
        Root: { getValue: vi.fn(async () => ({ revision: 3 })) },
      },
      System: {
        Account: {
          getValue: vi.fn(async () => ({ nonce: NONCE, providers: 1 })),
        },
      },
    },
    constants: {
      PeopleAirdrops: {
        people_airdrops_context: vi.fn(async () => AIRDROPS_CONTEXT_HEX),
      },
    },
    tx: {
      Resources: {
        register_person: vi.fn(() => ({ kind: "register_person-tx" })),
      },
    },
  };
}

interface Harness {
  provider: FakeProvider;
  api: FakeChainApi;
  truApi: FakeTruApi;
  productSigner: { signBytes: Mock };
  /** The truAPI proof call the `peopl.<suffix>/0` owner's signature goes through. */
  signLiteProof: Mock;
  registerPerson: Mock;
  reservationQueue: Mock;
  getFinalizedBlock: Mock;
}

function args(
  overrides: Partial<UpgradeLiteUsernameArgs> = {},
): UpgradeLiteUsernameArgs {
  return {
    expectedLiteAddress,
    currentLiteUsername: CURRENT_LITE_USERNAME,
    fullUsername: FULL_USERNAME,
    ...overrides,
  };
}

let harness: Harness;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withAsPerson.mockReturnValue(mocks.aliasSigner);
  mocks.watchClaimSubmission.mockResolvedValue({
    status: "included",
    txHash: TX_HASH,
  });
  mocks.bindResourcesAlias.mockResolvedValue({
    outcome: "bound",
    address: "5product",
    txHash: `0x${"bb".repeat(32)}`,
  });
  const provider = makeProvider();
  const truApi = makeTruApi();
  const api = makeApi();
  const productSigner = provider.getProductAccountSigner({
    publicKey: productPublicKey,
  } as never) as { signBytes: Mock };
  const getFinalizedBlock = vi.fn(async () => ({
    hash: FINALIZED_BLOCK_HASH,
    number: FINALIZED_BLOCK_NUMBER,
  }));
  harness = {
    provider,
    api,
    truApi,
    productSigner,
    signLiteProof: truApi.signing.signRawUnwatermarkedDeprecated,
    registerPerson: api.tx.Resources.register_person,
    reservationQueue: api.query.Resources.UsernameReservationQueue.getValue,
    getFinalizedBlock,
  };
  mocks.getAccountsProvider.mockResolvedValue(provider);
  mocks.getTruApi.mockResolvedValue(truApi);
  mocks.getPeopleClient.mockResolvedValue({
    api,
    client: { getFinalizedBlock },
    network: {},
    wsUrl: "",
  });
});

afterEach(() => {
  clearPendingUsernameUpgrade(expectedLiteAddress, TX_HASH);
  clearFailedUsernameUpgrade(expectedLiteAddress);
  vi.restoreAllMocks();
});

describe("upgradeLiteUsername username validation", () => {
  it.each([
    ["short", "alice"],
    ["uppercase", "AlicePerson"],
    ["digits", "alice123"],
    ["hyphen", "alice-person"],
    ["too long", "a".repeat(33)],
  ])("rejects %s before any host access", async (_label, fullUsername) => {
    await expect(upgradeLiteUsername(args({ fullUsername }))).rejects.toEqual(
      expect.objectContaining({ code: "invalid-username" }),
    );
    expect(mocks.getAccountsProvider).not.toHaveBeenCalled();
    expect(mocks.getPeopleClient).not.toHaveBeenCalled();
  });

  it.each(["abcdef", "a".repeat(32)])(
    "accepts a valid length boundary",
    async (fullUsername) => {
      await expect(
        upgradeLiteUsername(args({ fullUsername })),
      ).resolves.toEqual({ status: "included", txHash: TX_HASH });
    },
  );
});

describe("upgradeLiteUsername happy path", () => {
  it("signs the proof as the peopl/0 identity account, without a prompt path", async () => {
    // `peopl` signs as the owner of its own account 0, so the product-account
    // call signs; the prompting legacy call is never reached.
    await expect(upgradeLiteUsername(args())).resolves.toEqual({
      status: "included",
      txHash: TX_HASH,
    });
    expect(harness.signLiteProof).toHaveBeenCalledWith(PROOF_REQUEST);
    expect(
      harness.truApi.signing.signRawUnwatermarkedDeprecatedWithLegacyAccount,
    ).not.toHaveBeenCalled();
  });

  it("rejects a watermarked signature before creating or broadcasting a claim", async () => {
    const alias = Binary.fromHex(ALIAS_HEX);
    const wrapped = new Uint8Array([
      ...new TextEncoder().encode("<Bytes>"),
      ...alias,
      ...new TextEncoder().encode("</Bytes>"),
    ]);
    harness.signLiteProof.mockReturnValue(
      resultAsync({ signature: toHex(sign(testSecret, wrapped)) }),
    );
    await expect(upgradeLiteUsername(args())).rejects.toMatchObject({
      code: "incompatible-proof",
    });
    expect(harness.registerPerson).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
    expect(hasPendingUsernameUpgrade(expectedLiteAddress)).toBe(false);
  });

  it("rejects malformed signatures before creating a claim", async () => {
    harness.signLiteProof.mockReturnValue(
      resultAsync({ signature: toHex(new Uint8Array(4)) }),
    );
    await expect(upgradeLiteUsername(args())).rejects.toMatchObject({
      code: "incompatible-proof",
    });
    expect(harness.registerPerson).not.toHaveBeenCalled();
  });

  it("composes the alias signature, tx args, signer, and signed extensions", async () => {
    mocks.watchClaimSubmission.mockResolvedValue({
      status: "included",
      txHash: TX_HASH,
    });

    await expect(upgradeLiteUsername(args())).resolves.toEqual({
      status: "included",
      txHash: TX_HASH,
    });

    // The tx signer's own product account (mocked `productDomain()`).
    expect(harness.provider.getProductAccount).toHaveBeenCalledWith(
      "dev.peopl.paseo",
      0,
    );
    // The owner is `peopl.<suffix>/0` — resolved from the personhood product
    // id, not from the (here distinct) product domain the tx signer uses.
    expect(harness.provider.getProductAccount).toHaveBeenCalledWith(
      LITE_IDENTITY_DOMAIN,
      0,
    );

    // The proof goes through truAPI's product-account call as the owner,
    // over the raw alias, with no watermark.
    expect(harness.signLiteProof).toHaveBeenCalledWith(PROOF_REQUEST);

    expect(harness.registerPerson).toHaveBeenCalledWith({
      linked_lite_identity: expectedLiteAddress,
      lite_identity_proof: Enum("Sr25519", Binary.toHex(signatureBytes)),
      username_choice: Enum("Standalone", Binary.fromText(FULL_USERNAME)),
    });

    expect(mocks.watchClaimSubmission).toHaveBeenCalledWith(
      { kind: "register_person-tx" },
      mocks.aliasSigner,
      {
        nonce: NONCE,
        at: FINALIZED_BLOCK_HASH,
        mortality: { mortal: true, period: USERNAME_UPGRADE_MORTALITY_PERIOD },
      },
      {
        signingFailureMessage:
          "We couldn't submit your username upgrade. Try again shortly.",
        finalityFailureMessage:
          "We couldn't confirm your username upgrade. Try again shortly.",
        onBroadcast: expect.any(Function),
        settleOn: "bestBlock",
        onFinalized: expect.any(Function),
      },
    );

    expect(mocks.withAsPerson).toHaveBeenCalledWith(harness.productSigner, {
      tag: "AliasWithAccount",
    });
    expect(harness.getFinalizedBlock).toHaveBeenCalledTimes(1);
  });

  it("passes the unknown result through with its tx hash", async () => {
    mocks.watchClaimSubmission.mockResolvedValue({
      status: "unknown",
      txHash: TX_HASH,
      detail: "no finalized block within 120000 ms",
    });

    await expect(upgradeLiteUsername(args())).resolves.toEqual({
      status: "unknown",
      txHash: TX_HASH,
    });
    expect(logMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("{detail}"),
      expect.objectContaining({
        detail: "no finalized block within 120000 ms",
      }),
    );
  });

  it("reads the current and requested username owners from UsernameOwnerOf", async () => {
    mocks.watchClaimSubmission.mockResolvedValue({
      status: "included",
      txHash: TX_HASH,
    });
    await upgradeLiteUsername(args());

    const ownerOf = harness.api.query.Resources.UsernameOwnerOf.getValue;
    expect(ownerOf).toHaveBeenNthCalledWith(
      1,
      Binary.fromText(CURRENT_LITE_USERNAME),
    );
    expect(ownerOf).toHaveBeenNthCalledWith(2, Binary.fromText(FULL_USERNAME));
  });
});

describe("upgradeLiteUsername preflight failures", () => {
  it("fails with owner-mismatch when the lite username owner changed", async () => {
    harness.api.query.Resources.UsernameOwnerOf.getValue.mockResolvedValue(
      ss58Encode(new Uint8Array(32).fill(0x44), 42),
    );

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "owner-mismatch" }),
    );
    expect(harness.signLiteProof).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("fails with username-taken when the requested username is owned", async () => {
    harness.api.query.Resources.UsernameOwnerOf.getValue.mockResolvedValueOnce(
      expectedLiteAddress,
    );
    harness.api.query.Resources.UsernameOwnerOf.getValue.mockResolvedValueOnce(
      ss58Encode(new Uint8Array(32).fill(0x55), 42),
    );

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "username-taken" }),
    );
    expect(harness.signLiteProof).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("fails with username-taken when another account heads the reservation queue", async () => {
    harness.reservationQueue.mockResolvedValue([
      { account: ss58Encode(new Uint8Array(32).fill(0x55), 42), joined_at: 1n },
      { account: expectedLiteAddress, joined_at: 2n },
    ]);

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "username-taken" }),
    );
    expect(harness.signLiteProof).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("claims the username as a Reservation when the lite identity heads the queue", async () => {
    harness.reservationQueue.mockResolvedValue([
      { account: expectedLiteAddress, joined_at: 1n },
      { account: ss58Encode(new Uint8Array(32).fill(0x55), 42), joined_at: 2n },
    ]);

    await expect(upgradeLiteUsername(args())).resolves.toEqual({
      status: "included",
      txHash: TX_HASH,
    });
    expect(harness.registerPerson).toHaveBeenCalledWith(
      expect.objectContaining({
        username_choice: Enum("Reservation", Binary.fromText(FULL_USERNAME)),
      }),
    );
  });

  it("reads the reservation queue for the requested username", async () => {
    mocks.watchClaimSubmission.mockResolvedValue({
      status: "included",
      txHash: TX_HASH,
    });
    await upgradeLiteUsername(args());

    expect(harness.reservationQueue).toHaveBeenCalledWith(
      Binary.fromText(FULL_USERNAME),
    );
  });

  it("claims the username as Standalone when the reservation queue is empty", async () => {
    harness.reservationQueue.mockResolvedValue([]);

    await expect(upgradeLiteUsername(args())).resolves.toEqual({
      status: "included",
      txHash: TX_HASH,
    });
    expect(harness.registerPerson).toHaveBeenCalledWith(
      expect.objectContaining({
        username_choice: Enum("Standalone", Binary.fromText(FULL_USERNAME)),
      }),
    );
  });

  it("fails with missing-alias when the product account has no alias", async () => {
    harness.api.query.People.AccountToAlias.getValue.mockResolvedValue(null);

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "missing-alias" }),
    );
    expect(harness.signLiteProof).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("fails with alias-context-mismatch when the alias belongs to another context", async () => {
    harness.api.query.People.AccountToAlias.getValue.mockResolvedValue({
      revision: 3,
      ring: 1,
      ca: {
        alias: ALIAS_HEX,
        context: `0x${"00".repeat(32)}`,
      },
    });

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "alias-context-mismatch" }),
    );
    expect(harness.signLiteProof).not.toHaveBeenCalled();
  });

  it("rejects the pre-0fec7071 literal Resources context", async () => {
    harness.api.query.People.AccountToAlias.getValue.mockResolvedValue({
      revision: 3,
      ring: 1,
      ca: {
        alias: ALIAS_HEX,
        // `pop:polkadot.network/resources  `, the context this preflight used to
        // pin. An alias still carrying it is not one `register_person` accepts.
        context:
          "0x706f703a706f6c6b61646f742e6e6574776f726b2f7265736f75726365732020",
      },
    });

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "alias-context-mismatch" }),
    );
    expect(harness.signLiteProof).not.toHaveBeenCalled();
  });

  it("fails with context-mismatch when the chain derives personhood contexts differently", async () => {
    harness.api.constants.PeopleAirdrops.people_airdrops_context.mockResolvedValue(
      `0x${"99".repeat(32)}`,
    );

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "context-mismatch" }),
    );
    expect(
      harness.api.query.People.AccountToAlias.getValue,
    ).not.toHaveBeenCalled();
    expect(harness.signLiteProof).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("accepts an alias context that differs only in hex case", async () => {
    harness.api.query.People.AccountToAlias.getValue.mockResolvedValue({
      revision: 3,
      ring: 1,
      ca: {
        alias: ALIAS_HEX,
        context: `0x${RESOURCES_CONTEXT_HEX.slice(2).toUpperCase()}`,
      },
    });

    await expect(upgradeLiteUsername(args())).resolves.toEqual({
      status: "included",
      txHash: TX_HASH,
    });
  });

  it("fails with lite-owner-unavailable when peopl.<suffix>/0 is not the on-chain owner", async () => {
    // Signing with anything the chain does not name as owner would fail
    // `lite_identity_proof.verify` after the user already approved it.
    harness.provider.getProductAccount.mockImplementation((domain: string) =>
      resultAsync({
        publicKey:
          domain === LITE_IDENTITY_DOMAIN
            ? new Uint8Array(32).fill(0x66)
            : productPublicKey,
        derivationIndex: 0,
      }),
    );

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "lite-owner-unavailable" }),
    );
    expect(harness.signLiteProof).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("fails with lite-owner-unavailable when the lite identity account cannot be resolved", async () => {
    harness.provider.getProductAccount.mockImplementation((domain: string) =>
      domain === LITE_IDENTITY_DOMAIN
        ? resultAsync<never>(new Error("no lite identity account"))
        : resultAsync({ publicKey: productPublicKey, derivationIndex: 0 }),
    );

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "lite-owner-unavailable" }),
    );
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("fails with signer-account-missing when the product account cannot be resolved", async () => {
    harness.provider.getProductAccount.mockImplementation((domain: string) =>
      domain === LITE_IDENTITY_DOMAIN
        ? resultAsync({ publicKey: legacyPublicKey, derivationIndex: 0 })
        : resultAsync<never>(new Error("no product account")),
    );

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "signer-account-missing" }),
    );
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("fails with account-missing when no accounts provider is available", async () => {
    mocks.getAccountsProvider.mockResolvedValue(null);

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "account-missing" }),
    );
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("fails with account-missing when the host exposes no truAPI client", async () => {
    // The lite owner's proof is signed on truAPI directly, so a missing
    // client has to fail the same way a missing provider does — before any
    // chain read.
    mocks.getTruApi.mockResolvedValue(null);

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "account-missing" }),
    );
    expect(
      harness.api.query.Resources.UsernameOwnerOf.getValue,
    ).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });
});

describe("upgradeLiteUsername claim method", () => {
  it("does not bind the alias on the product-sdk route", async () => {
    await upgradeLiteUsername(args({ method: "product-sdk" }));

    expect(mocks.bindResourcesAlias).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).toHaveBeenCalledOnce();
  });

  it("does not bind again when the Resources alias already exists", async () => {
    await upgradeLiteUsername({
      expectedLiteAddress,
      currentLiteUsername: CURRENT_LITE_USERNAME,
      fullUsername: FULL_USERNAME,
    });

    expect(mocks.bindResourcesAlias).not.toHaveBeenCalled();
  });

  it("binds the alias before submitting on the truAPI route", async () => {
    harness.api.query.People.AccountToAlias.getValue.mockResolvedValueOnce(
      undefined,
    );
    await upgradeLiteUsername(args({ method: "truapi" }));

    expect(mocks.bindResourcesAlias).toHaveBeenCalledOnce();
    // The binding settles on a best block, so the alias it wrote and the
    // nonce the claim signs with are read there, not at finality.
    expect(
      harness.api.query.People.AccountToAlias.getValue,
    ).toHaveBeenLastCalledWith(productAddress, { at: "best" });
    expect(harness.api.query.System.Account.getValue).toHaveBeenCalledWith(
      productAddress,
      { at: "best" },
    );
    // Order matters: an unbound alias makes register_person a bad origin, so
    // the binding has to land first.
    const bindOrder = mocks.bindResourcesAlias.mock.invocationCallOrder[0];
    const submitOrder = mocks.watchClaimSubmission.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(submitOrder ?? Number.POSITIVE_INFINITY);
  });

  it("fails with alias-binding-failed and never submits when binding throws", async () => {
    harness.api.query.People.AccountToAlias.getValue.mockResolvedValueOnce(
      undefined,
    );
    mocks.bindResourcesAlias.mockRejectedValue(new Error("host refused"));

    await expect(
      upgradeLiteUsername(args({ method: "truapi" })),
    ).rejects.toEqual(
      expect.objectContaining({ code: "alias-binding-failed" }),
    );
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("reports a still-unconfirmed earlier binding as pending, not as a failure", async () => {
    harness.api.query.People.AccountToAlias.getValue.mockResolvedValueOnce(
      undefined,
    );
    mocks.bindResourcesAlias.mockRejectedValue(
      new resourcesAlias.BindResourcesAliasError(
        "pending",
        "a previous binding is still unconfirmed",
      ),
    );

    await expect(
      upgradeLiteUsername(args({ method: "truapi" })),
    ).rejects.toEqual(expect.objectContaining({ code: "pending" }));
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });
});

describe("upgradeLiteUsername alias revision", () => {
  /** `pop:polkadot.network/people`, space-padded to 32 bytes. */
  const PEOPLE_RING_ID = toHex(
    new TextEncoder().encode("pop:polkadot.network/people     "),
  );

  it("reads the binding ring's root at best and claims with AliasWithAccount while it is current", async () => {
    await upgradeLiteUsername(args());

    expect(harness.api.query.Members.Root.getValue).toHaveBeenCalledWith(
      PEOPLE_RING_ID,
      1,
      { at: "best" },
    );
    expect(mocks.resourcesAliasProof).not.toHaveBeenCalled();
    expect(mocks.withAsPerson).toHaveBeenCalledWith(harness.productSigner, {
      tag: "AliasWithAccount",
    });
    expect(mocks.watchClaimSubmission).toHaveBeenCalledOnce();
  });

  it("revises a stale binding inside the claim with a fresh Resources proof", async () => {
    const createProof = vi.fn();
    mocks.resourcesAliasProof.mockResolvedValue(createProof);
    harness.api.query.Members.Root.getValue.mockResolvedValue({ revision: 4 });

    await upgradeLiteUsername(args());

    expect(mocks.resourcesAliasProof).toHaveBeenCalledWith(
      harness.provider,
      harness.truApi,
      resolveNetwork(envConfig.chain.network),
      productDomain(),
    );
    // `AliasWithAccount` on a stale revision is `Invalid.BadSigner` on chain.
    expect(mocks.withAsPerson).toHaveBeenCalledWith(harness.productSigner, {
      tag: "AliasWithAccountRevised",
      createProof,
    });
    expect(mocks.withAsPerson).not.toHaveBeenCalledWith(
      harness.productSigner,
      { tag: "AliasWithAccount" },
    );
    // The binding exists, so revising it is not a second `set_alias_account`.
    expect(mocks.bindResourcesAlias).not.toHaveBeenCalled();
    // The ring key is resolved before the lite owner is asked to sign.
    const proofOrder = mocks.resourcesAliasProof.mock.invocationCallOrder[0];
    const signOrder = harness.signLiteProof.mock.invocationCallOrder[0];
    expect(proofOrder).toBeLessThan(signOrder ?? Number.POSITIVE_INFINITY);
    expect(mocks.watchClaimSubmission).toHaveBeenCalledOnce();
  });

  it("fails with alias-binding-failed before the lite owner signs when the proof cannot be minted", async () => {
    mocks.resourcesAliasProof.mockRejectedValue(new Error("no ring key"));
    harness.api.query.Members.Root.getValue.mockResolvedValue({ revision: 4 });

    await expect(upgradeLiteUsername(args())).rejects.toMatchObject({
      code: "alias-binding-failed",
    });
    expect(harness.signLiteProof).not.toHaveBeenCalled();
    expect(mocks.withAsPerson).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("fails with ring-unavailable before signing when the binding's ring has no root", async () => {
    harness.api.query.Members.Root.getValue.mockResolvedValue(undefined);

    await expect(upgradeLiteUsername(args())).rejects.toMatchObject({
      code: "ring-unavailable",
    });
    expect(mocks.resourcesAliasProof).not.toHaveBeenCalled();
    expect(harness.signLiteProof).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });
});

describe("automatic Resources binding", () => {
  it("binds a missing alias by default, then claims", async () => {
    harness.api.query.People.AccountToAlias.getValue.mockResolvedValueOnce(
      undefined,
    );
    await upgradeLiteUsername(args());
    expect(mocks.bindResourcesAlias).toHaveBeenCalledOnce();
    expect(mocks.watchClaimSubmission).toHaveBeenCalledOnce();
  });

  it("does not claim while the alias binding is unconfirmed", async () => {
    harness.api.query.People.AccountToAlias.getValue.mockResolvedValueOnce(
      undefined,
    );
    mocks.bindResourcesAlias.mockResolvedValue({
      outcome: "submitted-unconfirmed",
      address: "5product",
    });
    await expect(upgradeLiteUsername(args())).rejects.toMatchObject({
      code: "pending",
    });
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
    expect(harness.signLiteProof).not.toHaveBeenCalled();
  });

  it("does not bind when the requested username is already taken", async () => {
    harness.api.query.Resources.UsernameOwnerOf.getValue
      .mockResolvedValueOnce(expectedLiteAddress)
      .mockResolvedValueOnce("5Other");
    await expect(upgradeLiteUsername(args())).rejects.toMatchObject({
      code: "username-taken",
    });
    expect(mocks.bindResourcesAlias).not.toHaveBeenCalled();
  });
});

describe("upgradeLiteUsername submission failures", () => {
  it("remaps a finalized !ok rejection to a safe finalized-error", async () => {
    mocks.watchClaimSubmission.mockRejectedValue(
      new transactionSubmission.TransactionSubmissionError(
        "finalized-error",
        "raw finality failure",
        "Resources.UsernameTaken",
      ),
    );

    const error = await upgradeLiteUsername(args()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsernameUpgradeError);
    expect((error as UsernameUpgradeError).code).toBe("finalized-error");
    expect((error as UsernameUpgradeError).message).toBe(
      "We couldn't confirm your username upgrade. Try again shortly.",
    );
    // The classified error keeps the safe sentence, so the dispatch error is
    // only recoverable from the log.
    expect(logMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("{detail}"),
      expect.objectContaining({ detail: "Resources.UsernameTaken" }),
    );
  });

  it("wraps a proof-signing failure as a safe signing error", async () => {
    harness.signLiteProof.mockReturnValue(
      resultAsync<never>(new Error("host denied")),
    );

    const error = await upgradeLiteUsername(args()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsernameUpgradeError);
    expect((error as UsernameUpgradeError).code).toBe("signing");
    expect((error as UsernameUpgradeError).message).toBe(
      "We couldn't submit your username upgrade. Try again shortly.",
    );
  });
});

describe("upgradeLiteUsername pending marker", () => {
  function broadcastThen(
    decision:
      | { status: "included"; txHash: string }
      | { status: "unknown"; txHash: string; detail: string },
  ) {
    mocks.watchClaimSubmission.mockImplementation(
      async (_tx, _signer, _options, watchOptions) => {
        watchOptions?.onBroadcast?.(TX_HASH);
        return decision;
      },
    );
  }

  it("rejects with pending before any host access when a marker exists", async () => {
    setPendingUsernameUpgrade(
      expectedLiteAddress,
      FULL_USERNAME,
      TX_HASH,
      FINALIZED_BLOCK_NUMBER + USERNAME_UPGRADE_MORTALITY_PERIOD,
    );

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "pending" }),
    );
    expect(mocks.getAccountsProvider).not.toHaveBeenCalled();
    expect(mocks.getPeopleClient).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("persists the marker with its era-checkpoint expiry and marks it included", async () => {
    const setPendingSpy = vi.spyOn(pendingUpgrade, "setPendingUsernameUpgrade");
    broadcastThen({ status: "included", txHash: TX_HASH });

    await expect(upgradeLiteUsername(args())).resolves.toEqual({
      status: "included",
      txHash: TX_HASH,
    });
    expect(setPendingSpy).toHaveBeenCalledWith(
      expectedLiteAddress,
      FULL_USERNAME,
      TX_HASH,
      FINALIZED_BLOCK_NUMBER + USERNAME_UPGRADE_MORTALITY_PERIOD,
    );
    // A best block can still be reorged: a reload before finality must not
    // offer a second claim.
    expect(readPendingUsernameUpgrade(expectedLiteAddress)).toMatchObject({
      fullUsername: FULL_USERNAME,
      txHash: TX_HASH,
      phase: "included",
    });
  });

  it("is still in the broadcast phase when onBroadcast fires", async () => {
    let phaseAtBroadcast: string | undefined;
    mocks.watchClaimSubmission.mockImplementation(
      async (_tx, _signer, _options, watchOptions) => {
        watchOptions?.onBroadcast?.(TX_HASH);
        phaseAtBroadcast = readPendingUsernameUpgrade(expectedLiteAddress)?.phase;
        return { status: "included", txHash: TX_HASH };
      },
    );

    await upgradeLiteUsername(args());
    expect(phaseAtBroadcast).toBe("broadcast");
  });

  it("replaces an earlier failed record on broadcast", async () => {
    recordFailedUsernameUpgrade(expectedLiteAddress, "previousname");
    broadcastThen({ status: "included", txHash: TX_HASH });

    await upgradeLiteUsername(args());
    expect(readFailedUsernameUpgrade(expectedLiteAddress)).toBeNull();
  });

  function captureFinality() {
    let reportFinality:
      | ((outcome: { txHash: string; ok: boolean }) => void)
      | undefined;
    mocks.watchClaimSubmission.mockImplementation(
      async (_tx, _signer, _options, watchOptions) => {
        watchOptions?.onBroadcast?.(TX_HASH);
        reportFinality = watchOptions?.onFinalized;
        return { status: "included", txHash: TX_HASH };
      },
    );
    return (ok: boolean) => reportFinality?.({ txHash: TX_HASH, ok });
  }

  it("leaves the included marker for the finalized card read on a finalized ok", async () => {
    const reportFinality = captureFinality();
    const onFinalized = vi.fn();

    await upgradeLiteUsername(args(), { onFinalized });
    expect(onFinalized).not.toHaveBeenCalled();

    reportFinality(true);
    expect(readPendingUsernameUpgrade(expectedLiteAddress)?.phase).toBe(
      "included",
    );
    expect(readFailedUsernameUpgrade(expectedLiteAddress)).toBeNull();
    expect(onFinalized).toHaveBeenCalledOnce();
  });

  it("clears the marker and records the failure on a finalized !ok, then tells the caller", async () => {
    const reportFinality = captureFinality();
    let stateAtCallback: { pending: boolean; failed: unknown } | undefined;
    const onFinalized = vi.fn(() => {
      stateAtCallback = {
        pending: hasPendingUsernameUpgrade(expectedLiteAddress),
        failed: readFailedUsernameUpgrade(expectedLiteAddress),
      };
    });

    await upgradeLiteUsername(args(), { onFinalized });
    expect(hasPendingUsernameUpgrade(expectedLiteAddress)).toBe(true);

    reportFinality(false);
    expect(onFinalized).toHaveBeenCalledOnce();
    expect(stateAtCallback).toEqual({
      pending: false,
      failed: { address: expectedLiteAddress, fullUsername: FULL_USERNAME },
    });
  });

  it("retains the broadcast marker when finality is unknown", async () => {
    broadcastThen({
      status: "unknown",
      txHash: TX_HASH,
      detail:
        "the signing stream closed after broadcast without a finalized block",
    });

    await expect(upgradeLiteUsername(args())).resolves.toEqual({
      status: "unknown",
      txHash: TX_HASH,
    });
    expect(readPendingUsernameUpgrade(expectedLiteAddress)?.phase).toBe(
      "broadcast",
    );
    expect(readFailedUsernameUpgrade(expectedLiteAddress)).toBeNull();
  });

  it("clears the marker and records the failure on an included !ok", async () => {
    mocks.watchClaimSubmission.mockImplementation(
      async (_tx, _signer, _options, watchOptions) => {
        watchOptions?.onBroadcast?.(TX_HASH);
        throw new transactionSubmission.TransactionSubmissionError(
          "finalized-error",
          "raw finality failure",
          "Resources.InvalidProof",
        );
      },
    );

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "finalized-error" }),
    );
    expect(hasPendingUsernameUpgrade(expectedLiteAddress)).toBe(false);
    expect(readFailedUsernameUpgrade(expectedLiteAddress)).toEqual({
      address: expectedLiteAddress,
      fullUsername: FULL_USERNAME,
    });
  });

  it("never persists a marker when no broadcast occurs", async () => {
    mocks.watchClaimSubmission.mockRejectedValue(
      new transactionSubmission.TransactionSubmissionError(
        "signing",
        "raw signing failure",
        "signing timed out after 60000 ms with no broadcast",
      ),
    );

    await expect(upgradeLiteUsername(args())).rejects.toEqual(
      expect.objectContaining({ code: "signing" }),
    );
    expect(hasPendingUsernameUpgrade(expectedLiteAddress)).toBe(false);
    expect(readFailedUsernameUpgrade(expectedLiteAddress)).toBeNull();
  });
});

describe("upgradeLiteUsername bounded phases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds account resolution that never settles", async () => {
    harness.provider.getUserId.mockReturnValue({
      match: () => new Promise(() => {}),
    });

    const attempt = upgradeLiteUsername(args());
    const rejection = expect(attempt).rejects.toEqual(
      expect.objectContaining({ code: "timeout" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(harness.signLiteProof).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("bounds chain preflight that never settles", async () => {
    harness.api.query.Resources.UsernameOwnerOf.getValue.mockReturnValue(
      new Promise(() => {}),
    );

    const attempt = upgradeLiteUsername(args());
    const rejection = expect(attempt).rejects.toEqual(
      expect.objectContaining({ code: "timeout" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(harness.signLiteProof).not.toHaveBeenCalled();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("bounds the era-checkpoint read that never settles", async () => {
    harness.getFinalizedBlock.mockReturnValue(new Promise(() => {}));

    const attempt = upgradeLiteUsername(args());
    const rejection = expect(attempt).rejects.toEqual(
      expect.objectContaining({ code: "timeout" }),
    );
    // Proof verification lazy-loads crypto; wait for that real module work
    // before advancing the fake clock for this specific chain phase.
    await vi.waitFor(() =>
      expect(harness.getFinalizedBlock).toHaveBeenCalled(),
    );
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(harness.signLiteProof).toHaveBeenCalledOnce();
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("bounds raw proof signing that never settles", async () => {
    const { promise: neverSettles } = Promise.withResolvers<never>();
    harness.signLiteProof.mockReturnValue({ match: () => neverSettles });

    const attempt = upgradeLiteUsername(args());
    const rejection = expect(attempt).rejects.toEqual(
      expect.objectContaining({ code: "signing" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });
});
