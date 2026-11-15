// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";

const CANDIDATE = "5CandidateAccount";
const PASEO_CANDIDATE_DOMAIN = "dim2.paseo";
const PREVIEWNET_CANDIDATE_DOMAIN = "dim2.testnet";

const mocks = vi.hoisted(() => ({
  network: "",
  gameAccountIndex: 1,
  getAccountsProvider: vi.fn(),
  ss58Encode: vi.fn(() => CANDIDATE),
}));

vi.mock("@humanity/shared/config/env.ts", () => ({
  envConfig: {
    chain: {
      get network() { return mocks.network; },
      get gameAccountIndex() { return mocks.gameAccountIndex; },
      gameStorageLabel: "",
    },
    host: { productLabel: "peopl" },
  },
}));
vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  getAccountsProvider: mocks.getAccountsProvider,
}));
vi.mock("@parity/product-sdk/address", () => ({
  ss58Encode: mocks.ss58Encode,
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ debug: vi.fn(), warning: vi.fn() }),
}));

function hostAccountAfter(delayMs: number) {
  return {
    getProductAccount: vi.fn(() => ({
      match: (onSuccess: (account: { publicKey: Uint8Array }) => unknown) =>
        (() => {
          const { promise, resolve } = Promise.withResolvers<unknown>();
          setTimeout(() => resolve(onSuccess({ publicKey: new Uint8Array(32) })), delayMs);
          return promise;
        })(),
    })),
    getProductAccountSigner: vi.fn(),
  };
}

async function loadGameAccountForNetwork(network: string) {
  mocks.network = network;
  vi.resetModules();
  // Module initialization snapshots the mocked Vite network.
  return import("@humanity/shared/identity/game-account.ts");
}

afterEach(() => {
  vi.useRealTimers();
  mocks.getAccountsProvider.mockReset();
  mocks.ss58Encode.mockClear();
  mocks.network = "";
  mocks.gameAccountIndex = 1;
});

describe("resolveGameAccountAddress", () => {
  it("accepts the mobile host candidate response throughout the 30-second readiness window", async () => {
    vi.useFakeTimers();
    const provider = hostAccountAfter(29_000);
    mocks.getAccountsProvider.mockResolvedValue(provider);

    const { CANDIDATE_PRODUCT_DOMAIN, resolveGameAccountAddress } =
      await loadGameAccountForNetwork("");

    const resolution = resolveGameAccountAddress();
    await vi.advanceTimersByTimeAsync(29_000);

    await expect(resolution).resolves.toBe(CANDIDATE);
    expect(CANDIDATE_PRODUCT_DOMAIN).toBe(PASEO_CANDIDATE_DOMAIN);
    expect(provider.getProductAccount).toHaveBeenCalledWith(
      PASEO_CANDIDATE_DOMAIN,
      1,
    );
  });

  it("uses the previewnet candidate domain for the host product account", async () => {
    vi.useFakeTimers();
    const provider = hostAccountAfter(0);
    mocks.getAccountsProvider.mockResolvedValue(provider);
    const { CANDIDATE_PRODUCT_DOMAIN, resolveGameAccountAddress } =
      await loadGameAccountForNetwork("previewnet");

    const resolution = resolveGameAccountAddress();
    await vi.advanceTimersByTimeAsync(0);

    await expect(resolution).resolves.toBe(CANDIDATE);
    expect(CANDIDATE_PRODUCT_DOMAIN).toBe(PREVIEWNET_CANDIDATE_DOMAIN);
    expect(provider.getProductAccount).toHaveBeenCalledWith(
      PREVIEWNET_CANDIDATE_DOMAIN,
      1,
    );
  });

  it("asks the host for the configured game account index, and reports it", async () => {
    vi.useFakeTimers();
    mocks.gameAccountIndex = 3;
    const provider = hostAccountAfter(0);
    mocks.getAccountsProvider.mockResolvedValue(provider);
    const { GAME_ACCOUNT_INDEX, getGameAccountDiagnostics, resolveGameAccountAddress } =
      await loadGameAccountForNetwork("paseo-next-v2");

    const resolution = resolveGameAccountAddress();
    await vi.advanceTimersByTimeAsync(0);

    await expect(resolution).resolves.toBe(CANDIDATE);
    expect(GAME_ACCOUNT_INDEX).toBe(3);
    expect(provider.getProductAccount).toHaveBeenCalledWith(PASEO_CANDIDATE_DOMAIN, 3);
    expect(getGameAccountDiagnostics()?.index).toBe(3);
  });
});
