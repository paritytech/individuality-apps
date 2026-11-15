// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Individuality from "@humanity/shared/chain/individuality.ts";
import type * as TransactionSubmission from "@humanity/shared/chain/transaction-submission.ts";

const mocks = vi.hoisted(() => ({
  getAccountsProvider: vi.fn(),
  readRegistrationEligibility: vi.fn(),
  isPersonhoodProduct: vi.fn(() => true),
  watchTransactionSubmission: vi.fn(),
  withScoreParticipant: vi.fn((signer: unknown) => ({ wrapped: signer })),
}));

vi.mock("@humanity/shared/chain/host-api.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAccountsProvider: mocks.getAccountsProvider,
}));
vi.mock("@humanity/shared/identity/product-domain.ts", () => ({
  isPersonhoodProduct: mocks.isPersonhoodProduct,
  personhoodProductId: () => "peopl.paseo",
}));
vi.mock("@humanity/shared/chain/individuality.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Individuality>()),
  individualityChain: (_client: unknown, api: unknown) => ({ individuality: api }),
  withScoreParticipant: mocks.withScoreParticipant,
  readRegistrationEligibility: mocks.readRegistrationEligibility,
}));
vi.mock("@humanity/shared/chain/transaction-submission.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof TransactionSubmission>()),
  watchTransactionSubmission: mocks.watchTransactionSubmission,
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn(), debug: vi.fn() }),
}));

import {
  REGISTER_REFUSED_MESSAGE,
  REGISTER_UNSUPPORTED_MESSAGE,
  registerPersonhood,
} from "@features/card/chain/register-personhood.ts";
import { membershipRingLocation, registerMessage } from "@humanity/shared/chain/individuality.ts";
import type { NetworkConfig } from "@humanity/shared/chain/networks.ts";
import { TransactionSubmissionError } from "@humanity/shared/chain/transaction-submission.ts";

const GENESIS = `0x${"33".repeat(32)}`;
const network = { peopleChain: { genesisHash: GENESIS } } as unknown as NetworkConfig;
/** Alice: any valid SS58 address works as the candidate. */
const CANDIDATE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const CANDIDATE_SIGNER = { publicKey: new Uint8Array(32), signBytes: vi.fn(), signTx: vi.fn() };
const MEMBER_KEY = new Uint8Array(32).fill(0xab);
const PROOF = new Uint8Array(64).fill(0xcd);
const HANDLE = { dotNsIdentifier: "peopl.paseo", derivationIndex: { tag: "Index", value: 0 } };
const TX = { kind: "score-register" };
const UNSUPPORTED = { tag: "Unsupported", value: undefined };

function result<T>(ok: boolean, value: T) {
  return {
    match: <R>(onOk: (v: T) => R, onErr: (e: T) => R) =>
      Promise.resolve(ok ? onOk(value) : onErr(value)),
  };
}

const peopleKey = () => ({
  handle: HANDLE,
  rings: [membershipRingLocation(network)],
  publicKey: MEMBER_KEY,
});

const register = vi.fn(() => TX);
const api = { tx: { Score: { register } } };
const listRingVrfKeys = vi.fn();
const registerRingVrfKey = vi.fn();
const ringVrfSign = vi.fn();
const provider = { listRingVrfKeys, registerRingVrfKey, ringVrfSign };

const run = () =>
  registerPersonhood({
    api,
    client: {},
    network,
    candidate: { address: CANDIDATE, signer: CANDIDATE_SIGNER },
  } as unknown as Parameters<
    typeof registerPersonhood
  >[0]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isPersonhoodProduct.mockReturnValue(true);
  mocks.getAccountsProvider.mockResolvedValue(provider);
  mocks.readRegistrationEligibility.mockResolvedValue({
    ok: true,
    value: { participant: {}, personhoodThreshold: 6, readyToRegister: true },
  });
  listRingVrfKeys.mockReturnValue(result(true, [peopleKey()]));
  ringVrfSign.mockReturnValue(result(true, PROOF));
  mocks.watchTransactionSubmission.mockResolvedValue({
    status: "finalized",
    txHash: "0xfeed",
    events: [],
  });
});

describe("registerPersonhood", () => {
  it("signs the candidate's register message and sends key=[32B, 64B] as the participant", async () => {
    await expect(run()).resolves.toEqual({
      kind: "registered",
      confirmed: true,
      txHash: "0xfeed",
      candidate: CANDIDATE,
    });
    const message = ringVrfSign.mock.calls[0]?.[1] as Uint8Array;
    expect(ringVrfSign.mock.calls[0]?.[0]).toBe(HANDLE);
    expect(message).toEqual(registerMessage(CANDIDATE));
    expect(message.length).toBe(50);
    expect(new TextDecoder().decode(message.slice(0, 18))).toBe("pop register using");
    expect(register).toHaveBeenCalledWith({
      key: [`0x${"ab".repeat(32)}`, `0x${"cd".repeat(64)}`],
    });
    expect(mocks.withScoreParticipant).toHaveBeenCalledWith(CANDIDATE_SIGNER);
    expect(mocks.watchTransactionSubmission.mock.calls[0]?.slice(0, 2)).toEqual([
      TX,
      { wrapped: CANDIDATE_SIGNER },
    ]);
    expect(registerRingVrfKey).not.toHaveBeenCalled();
  });

  it("asks the chain first, and sends nothing for a candidate it has nothing to register for", async () => {
    mocks.readRegistrationEligibility.mockResolvedValue({
      ok: true,
      value: { participant: {}, personhoodThreshold: 6, readyToRegister: false },
    });
    await expect(run()).resolves.toMatchObject({ kind: "not-ready" });
    expect(mocks.readRegistrationEligibility.mock.calls[0]?.[1]).toEqual({
      registrant: { tag: "Account", accountAddress: CANDIDATE },
    });
    expect(listRingVrfKeys).not.toHaveBeenCalled();
    expect(ringVrfSign).not.toHaveBeenCalled();
    expect(mocks.watchTransactionSubmission).not.toHaveBeenCalled();
  });

  it("does not send blind when the eligibility read fails", async () => {
    mocks.readRegistrationEligibility.mockResolvedValue({ ok: false, error: new Error("rpc") });
    await expect(run()).resolves.toMatchObject({ kind: "failed" });
    expect(mocks.watchTransactionSubmission).not.toHaveBeenCalled();
  });

  it("mints the people key at index 0 when the host holds none, then uses it", async () => {
    listRingVrfKeys
      .mockReturnValueOnce(result(true, []))
      .mockReturnValue(result(true, [peopleKey()]));
    registerRingVrfKey.mockReturnValue(result(true, MEMBER_KEY));
    await expect(run()).resolves.toMatchObject({ kind: "registered" });
    expect(registerRingVrfKey).toHaveBeenCalledWith(0, membershipRingLocation(network));
  });

  it("reports an Unsupported host (native iOS) without minting or sending", async () => {
    listRingVrfKeys.mockReturnValue(result(false, UNSUPPORTED));
    await expect(run()).resolves.toMatchObject({
      kind: "unsupported-host",
      reason: REGISTER_UNSUPPORTED_MESSAGE,
    });
    expect(registerRingVrfKey).not.toHaveBeenCalled();
    expect(ringVrfSign).not.toHaveBeenCalled();
    expect(mocks.watchTransactionSubmission).not.toHaveBeenCalled();
  });

  it("reports Unsupported from ringVrfSign as an unsupported host too", async () => {
    ringVrfSign.mockReturnValue(result(false, { tag: "Unsupported" }));
    await expect(run()).resolves.toMatchObject({ kind: "unsupported-host" });
    expect(mocks.watchTransactionSubmission).not.toHaveBeenCalled();
  });

  it("reports a declined signature as refused, and sends nothing", async () => {
    ringVrfSign.mockReturnValue(result(false, { tag: "Rejected" }));
    await expect(run()).resolves.toMatchObject({
      kind: "refused",
      reason: REGISTER_REFUSED_MESSAGE,
    });
    expect(mocks.watchTransactionSubmission).not.toHaveBeenCalled();
  });

  it("reports a declined transaction signature as refused", async () => {
    mocks.watchTransactionSubmission.mockRejectedValue(
      new TransactionSubmissionError("signing", "safe", "user cancelled"),
    );
    await expect(run()).resolves.toMatchObject({ kind: "refused", detail: "user cancelled" });
  });

  it("never touches the host from a deploy that is not the personhood product", async () => {
    mocks.isPersonhoodProduct.mockReturnValue(false);
    await expect(run()).resolves.toMatchObject({ kind: "not-personhood-product" });
    expect(mocks.getAccountsProvider).not.toHaveBeenCalled();
  });

  it("returns an unconfirmed registration when finality is not seen", async () => {
    mocks.watchTransactionSubmission.mockResolvedValue({
      status: "unknown",
      txHash: "0xbeef",
      detail: "timeout",
    });
    await expect(run()).resolves.toMatchObject({ kind: "registered", confirmed: false });
  });

  it("fails on a signature of the wrong width rather than spending the allowance", async () => {
    ringVrfSign.mockReturnValue(result(true, new Uint8Array(96)));
    await expect(run()).resolves.toMatchObject({ kind: "failed" });
    expect(register).not.toHaveBeenCalled();
  });
});
