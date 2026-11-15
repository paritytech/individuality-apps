// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";

type MetadataCache = {
  getMetadata: (codeHash: string) => Promise<Uint8Array | null>;
  setMetadata: (codeHash: string, metadata: Uint8Array) => void;
};

const mocks = vi.hoisted(() => {
  const wsProvider = { kind: "ws" };
  const hostProvider = { kind: "host-bridge" };
  class ChainNotSupportedError extends Error {
    constructor(readonly genesisHash: string) {
      super(`chain not supported: ${genesisHash}`);
    }
  }
  return {
    wsProvider,
    hostProvider,
    ChainNotSupportedError,
    getWsProvider: vi.fn(() => wsProvider),
    createClient: vi.fn((provider: unknown, options?: MetadataCache) => ({
      provider,
      options,
      destroy: vi.fn(),
    })),
    getHostProvider: vi.fn(),
    isInsideContainerSync: vi.fn(),
    logger: { debug: vi.fn(), warning: vi.fn() },
  };
});

vi.mock("@polkadot-api/ws-provider", () => ({
  getWsProvider: mocks.getWsProvider,
}));

vi.mock("polkadot-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("polkadot-api")>()),
  createClient: mocks.createClient,
}));

/** The metadata cache every client is created with: `{ getMetadata, setMetadata }`. */
const metadataCache = expect.objectContaining({
  getMetadata: expect.any(Function),
  setMetadata: expect.any(Function),
});

vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  ChainNotSupportedError: mocks.ChainNotSupportedError,
  getHostProvider: mocks.getHostProvider,
  isInsideContainerSync: mocks.isInsideContainerSync,
}));

vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => mocks.logger,
}));

import {
  getOrCreateClient,
  getProviderDiagnostics,
  resetClientCache,
} from "@humanity/shared/chain/connection.ts";
import { runBoundedChainRead } from "@humanity/shared/chain/bounded-read.ts";

const GENESIS = "0x1234" as const;
const WS_URL = "wss://people.example";
const SECOND_GENESIS = "0x5678" as const;

afterEach(async () => {
  await resetClientCache();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("getOrCreateClient", () => {
  it("uses the host bridge without constructing a WS provider in-host", async () => {
    mocks.getHostProvider.mockResolvedValue(mocks.hostProvider);

    await expect(
      getOrCreateClient(GENESIS, WS_URL, { inHost: () => true }),
    ).resolves.toMatchObject({ provider: mocks.hostProvider });

    expect(mocks.getWsProvider).not.toHaveBeenCalled();
    expect(mocks.createClient).toHaveBeenCalledWith(mocks.hostProvider, metadataCache);
    expect(getProviderDiagnostics()).toMatchObject({
      provider: "host-bridge",
      acquisitionMs: expect.any(Number),
    });
  });

  it("fails without WS when the bridge is unavailable, evicts the entry, and retries", async () => {
    mocks.getHostProvider
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mocks.hostProvider);

    await expect(
      getOrCreateClient(GENESIS, WS_URL, { inHost: () => true }),
    ).rejects.toMatchObject({
      name: "HostProviderAcquisitionError",
      message: `Host chain provider unavailable for ${GENESIS}: bridge-unavailable`,
    });

    expect(mocks.getWsProvider).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(getProviderDiagnostics()).toMatchObject({
      provider: "host-bridge",
      failureReason: "bridge-unavailable",
    });
    expect(mocks.logger.warning).toHaveBeenCalledWith(
      "host chain provider unavailable; reason={reason} elapsedMs={elapsedMs}",
      expect.objectContaining({ reason: "bridge-unavailable" }),
    );

    await expect(
      getOrCreateClient(GENESIS, WS_URL, { inHost: () => true }),
    ).resolves.toMatchObject({ provider: mocks.hostProvider });
    expect(mocks.getHostProvider).toHaveBeenCalledTimes(2);
    expect(mocks.getWsProvider).not.toHaveBeenCalled();
  });

  it("fails without WS when the host declines the chain and retries", async () => {
    mocks.getHostProvider
      .mockRejectedValueOnce(new mocks.ChainNotSupportedError(GENESIS))
      .mockResolvedValueOnce(mocks.hostProvider);

    await expect(
      getOrCreateClient(GENESIS, WS_URL, { inHost: () => true }),
    ).rejects.toMatchObject({
      name: "HostProviderAcquisitionError",
      message: `Host chain provider unavailable for ${GENESIS}: host-declined-chain`,
    });

    expect(mocks.getWsProvider).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(getProviderDiagnostics()).toMatchObject({
      provider: "host-bridge",
      failureReason: "host-declined-chain",
    });

    await expect(
      getOrCreateClient(GENESIS, WS_URL, { inHost: () => true }),
    ).resolves.toMatchObject({ provider: mocks.hostProvider });
    expect(mocks.getHostProvider).toHaveBeenCalledTimes(2);
    expect(mocks.getWsProvider).not.toHaveBeenCalled();
  });

  it("records unexpected host acquisition failures without constructing WS", async () => {
    mocks.getHostProvider.mockRejectedValue(new Error("bridge unavailable"));

    await expect(
      getOrCreateClient(GENESIS, WS_URL, { inHost: () => true }),
    ).rejects.toMatchObject({
      name: "HostProviderAcquisitionError",
      message: `Host chain provider unavailable for ${GENESIS}: threw`,
    });

    expect(mocks.getWsProvider).not.toHaveBeenCalled();
    expect(getProviderDiagnostics()).toMatchObject({
      provider: "host-bridge",
      failureReason: "threw",
    });
  });

  it("uses WS only outside the host", async () => {
    await expect(
      getOrCreateClient(GENESIS, WS_URL, { inHost: () => false }),
    ).resolves.toMatchObject({ provider: mocks.wsProvider });

    expect(mocks.getHostProvider).not.toHaveBeenCalled();
    expect(mocks.getWsProvider).toHaveBeenCalledWith(WS_URL);
    expect(mocks.createClient).toHaveBeenCalledWith(mocks.wsProvider, metadataCache);
    expect(getProviderDiagnostics()).toEqual({
      provider: "ws",
      acquisitionMs: expect.any(Number),
    });
  });
});

describe("metadata cache", () => {
  const CODE_HASH = "0xabcd";
  const metadata = new Uint8Array([1, 2, 3, 250]);

  async function cacheOf() {
    mocks.getHostProvider.mockResolvedValue(mocks.hostProvider);
    await getOrCreateClient(GENESIS, WS_URL, { inHost: () => true });
    const options = mocks.createClient.mock.calls[0]?.[1];
    if (options == null) throw new Error("client created without a metadata cache");
    return options;
  }

  /** A storage like the browser's: the worker and Node have none, and there
   *  the cache is a pass-through, which the first case covers. */
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };

  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it("is a pass-through where there is no storage", async () => {
    const cache = await cacheOf();
    cache.setMetadata(CODE_HASH, metadata);
    await expect(cache.getMetadata(CODE_HASH)).resolves.toBeNull();
  });

  it("answers null before anything was stored", async () => {
    vi.stubGlobal("localStorage", localStorage);
    const cache = await cacheOf();
    await expect(cache.getMetadata(CODE_HASH)).resolves.toBeNull();
  });

  it("hands back the bytes stored for the same code hash", async () => {
    vi.stubGlobal("localStorage", localStorage);
    const cache = await cacheOf();
    cache.setMetadata(CODE_HASH, metadata);
    await expect(cache.getMetadata(CODE_HASH)).resolves.toEqual(metadata);
  });

  it("misses on another code hash: a runtime upgrade refetches", async () => {
    vi.stubGlobal("localStorage", localStorage);
    const cache = await cacheOf();
    cache.setMetadata(CODE_HASH, metadata);
    await expect(cache.getMetadata("0xffff")).resolves.toBeNull();
  });

  it("survives a corrupt entry", async () => {
    vi.stubGlobal("localStorage", localStorage);
    const cache = await cacheOf();
    localStorage.setItem("humanity.papi-metadata", `${CODE_HASH}:not-hex`);
    await expect(cache.getMetadata(CODE_HASH)).resolves.toBeNull();
  });
});

describe("bounded read client lifetime", () => {
  it("does not destroy a shared client when a read misses its deadline", async () => {
    vi.useFakeTimers();
    mocks.getHostProvider.mockResolvedValue(mocks.hostProvider);
    const client = await getOrCreateClient(GENESIS, WS_URL, {
      inHost: () => true,
    });
    const parent = new AbortController();
    const read = runBoundedChainRead(
      parent.signal,
      () => Promise.withResolvers<never>().promise,
      1_000,
    );

    const timedOut = expect(read).rejects.toThrow(
      "People Chain did not respond in time.",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOut;

    expect(client.destroy).not.toHaveBeenCalled();
  });

  it("does not destroy a shared client when the parent aborts", async () => {
    mocks.getHostProvider.mockResolvedValue(mocks.hostProvider);
    const client = await getOrCreateClient(SECOND_GENESIS, WS_URL, {
      inHost: () => true,
    });
    const parent = new AbortController();
    const abortError = new Error("PAPI unsubscribed the read");
    const read = runBoundedChainRead(parent.signal, (signal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError), {
          once: true,
        });
      }),
    );

    parent.abort();

    await expect(read).rejects.toBe(abortError);
    expect(client.destroy).not.toHaveBeenCalled();
  });
});
