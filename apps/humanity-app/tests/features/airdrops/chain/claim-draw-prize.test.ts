// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAirdropAccount: vi.fn(),
  resolvePrizeAccount: vi.fn(),
  ensureAirdropAlias: vi.fn(),
  getPeopleClient: vi.fn(),
  watchClaimSubmission: vi.fn(),
  setPendingDailyClaim: vi.fn(),
  clearPendingDailyClaim: vi.fn(),
  /** The fake api handed to `getPeopleClient` for the current test. Held here
   *  rather than read back out of `getPeopleClient.mock.results[0]`, which is
   *  empty until the call under test happens and is wiped by
   *  `vi.clearAllMocks()`. */
  api: null as FakeApi | null,
}));

vi.mock("@features/prize/chain/prize-account.ts", () => ({
  resolvePrizeAccount: mocks.resolvePrizeAccount,
}));
vi.mock("@humanity/shared/airdrops/chain/airdrop-account.ts", () => ({
  resolveAirdropAccount: mocks.resolveAirdropAccount,
}));
vi.mock("@humanity/shared/airdrops/chain/ensure-airdrop-alias.ts", () => ({
  ensureAirdropAlias: mocks.ensureAirdropAlias,
}));
vi.mock("@humanity/shared/chain/client.ts", () => ({
  getPeopleClient: mocks.getPeopleClient,
}));
// Only `watchClaimSubmission` is faked. `DailyPrizeClaimError` must stay the
// real class: both the source and this file assert `instanceof` against it, so
// a wholesale module replacement would make that check vacuous.
vi.mock("@features/prize/chain/claim-submission.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ClaimSubmissionModule>();
  return { ...actual, watchClaimSubmission: mocks.watchClaimSubmission };
});
vi.mock("@features/prize/chain/pending-daily-claim.ts", () => ({
  setPendingDailyClaim: mocks.setPendingDailyClaim,
  clearPendingDailyClaim: mocks.clearPendingDailyClaim,
}));

import type { Hex32 } from "@individuality/daily-dollar";
import { claimAirdropPrize } from "@features/airdrops/chain/claim-draw-prize.ts";
import { DailyPrizeClaimError } from "@features/prize/chain/claim-submission.ts";
import * as ClaimSubmissionModule from "@features/prize/chain/claim-submission.ts";

const ADDRESS = "5PrizeAccount";
const AIRDROP_ADDRESS = "5AirdropAccount";
const IDENTITY_ADDRESS = "5HumanIdentity";
const TX_HASH = `0x${"ab".repeat(32)}`;
const PERSON_SIGNER = { kind: "alias-with-account-signer" };
const EVENT_ID =
  "0x706f703a70656f706c652d61697264726f70733a202020200000000000000007" as Hex32;

interface FakeApi {
  tx: { PeopleAirdrops: { claim: ReturnType<typeof vi.fn> } };
}

function makeApi(): FakeApi {
  return {
    tx: {
      PeopleAirdrops: {
        claim: vi.fn((args: { event_id: Hex32; destination: string }) => ({
          kind: "claim-tx",
          event_id: args.event_id,
          destination: args.destination,
        })),
      },
    },
  };
}

function makeSigner() {
  return {
    publicKey: new Uint8Array(32).fill(0x22),
    signBytes: vi.fn(),
    signTx: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const prizeSigner = makeSigner();
  mocks.resolvePrizeAccount.mockResolvedValue({
    account: { publicKey: prizeSigner.publicKey, derivationIndex: 0 },
    address: ADDRESS,
    signer: prizeSigner,
  });
  const airdropSigner = makeSigner();
  mocks.resolveAirdropAccount.mockResolvedValue({
    account: { publicKey: airdropSigner.publicKey, derivationIndex: 1 },
    address: AIRDROP_ADDRESS,
    signer: airdropSigner,
  });
  mocks.ensureAirdropAlias.mockResolvedValue({
    alias: `0x${"cd".repeat(32)}`,
    signer: PERSON_SIGNER,
  });
  mocks.api = makeApi();
  mocks.getPeopleClient.mockResolvedValue({
    api: mocks.api,
    client: { getBestBlocks: vi.fn().mockResolvedValue([]) },
    network: {},
    wsUrl: "",
  });
  mocks.watchClaimSubmission.mockResolvedValue({
    status: "included",
    txHash: TX_HASH,
    awarded: 1_000n,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claimAirdropPrize composition", () => {
  it("builds PeopleAirdrops.claim with the right event_id and destination", async () => {
    const api = mocks.api!;

    await claimAirdropPrize({ eventId: EVENT_ID, identityAccountAddress: IDENTITY_ADDRESS });

    expect(api.tx.PeopleAirdrops.claim).toHaveBeenCalledWith({
      event_id: EVENT_ID,
      destination: ADDRESS,
    });
  });

  it("claims as the dedicated airdrop alias while paying account zero", async () => {
    await claimAirdropPrize({ eventId: EVENT_ID, identityAccountAddress: IDENTITY_ADDRESS });

    expect(mocks.ensureAirdropAlias).toHaveBeenCalledWith(
      expect.objectContaining({
        api: mocks.api,
        account: expect.objectContaining({ address: AIRDROP_ADDRESS }),
      }),
    );
    expect(mocks.watchClaimSubmission).toHaveBeenCalledWith(
      expect.any(Object),
      PERSON_SIGNER,
      {},
      expect.objectContaining({
        award: { eventId: EVENT_ID, beneficiary: ADDRESS },
      }),
    );
  });

  it("keys pending claim state by the human identity used by the UI", async () => {
    mocks.watchClaimSubmission.mockImplementation(
      async (
        _tx: unknown,
        _signer: unknown,
        _options: unknown,
        watchOptions: { onBroadcast?: (txHash: string) => void },
      ) => {
        watchOptions.onBroadcast?.(TX_HASH);
        return { status: "included", txHash: TX_HASH, awarded: 1_000n };
      },
    );

    await claimAirdropPrize({ eventId: EVENT_ID, identityAccountAddress: IDENTITY_ADDRESS });

    expect(mocks.setPendingDailyClaim).toHaveBeenCalledWith(
      EVENT_ID,
      IDENTITY_ADDRESS,
      TX_HASH,
    );
    expect(mocks.clearPendingDailyClaim).toHaveBeenCalledWith(
      EVENT_ID,
      IDENTITY_ADDRESS,
      TX_HASH,
    );
  });

  it("parses the awarded amount through the same PrizeClaimed event path", async () => {
    mocks.watchClaimSubmission.mockResolvedValue({
      status: "included",
      txHash: TX_HASH,
      awarded: 250_000n,
    });

    const result = await claimAirdropPrize({ eventId: EVENT_ID, identityAccountAddress: IDENTITY_ADDRESS });

    expect(result).toEqual({ status: "included", txHash: TX_HASH, awarded: 250_000n });
  });

  it("rejects with a safe claim error when the prize account is missing", async () => {
    mocks.resolvePrizeAccount.mockResolvedValue(null);

    const error = await claimAirdropPrize({ eventId: EVENT_ID, identityAccountAddress: IDENTITY_ADDRESS }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(DailyPrizeClaimError);
    expect(mocks.watchClaimSubmission).not.toHaveBeenCalled();
  });

  it("passes an unknown result through with its tx hash", async () => {
    mocks.watchClaimSubmission.mockResolvedValue({
      status: "unknown",
      txHash: TX_HASH,
    });

    await expect(claimAirdropPrize({ eventId: EVENT_ID, identityAccountAddress: IDENTITY_ADDRESS })).resolves.toEqual({
      status: "unknown",
      txHash: TX_HASH,
    });
  });
});
