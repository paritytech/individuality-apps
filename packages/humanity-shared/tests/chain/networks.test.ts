// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NETWORKS,
  candidateProductDomain,
  dotnsName,
  dim2Url,
  parseNetworkKey,
  resolveNetwork,
} from "@humanity/shared/chain/networks.ts";

const paseoNextV2 = NETWORKS["paseo-next-v2"];
const previewnet = resolveNetwork("previewnet");

const localEnv = {
  VITE_LOCAL_PEOPLE_WS_URL: "ws://127.0.0.1:9944",
  VITE_LOCAL_PEOPLE_GENESIS_HASH: `0x${"12".repeat(32)}`,
  VITE_LOCAL_ASSET_HUB_WS_URL: "wss://localhost:9945/asset-hub",
  VITE_LOCAL_ASSET_HUB_GENESIS_HASH: `0x${"AB".repeat(32)}`,
};

describe("local network", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resolves only an explicit local key from all four variables", () => {
    expect(parseNetworkKey("local")).toBe("local");
    expect(resolveNetwork("local", localEnv)).toEqual({
      key: "local",
      displayName: "Local",
      isTestnet: true,
      peopleChain: {
        wsUrl: localEnv.VITE_LOCAL_PEOPLE_WS_URL,
        genesisHash: localEnv.VITE_LOCAL_PEOPLE_GENESIS_HASH,
      },
      assetHub: {
        wsUrl: localEnv.VITE_LOCAL_ASSET_HUB_WS_URL,
        genesisHash: localEnv.VITE_LOCAL_ASSET_HUB_GENESIS_HASH.toLowerCase(),
      },
      nativeToken: { symbol: "PAS", decimals: 10 },
      dotnsSuffix: "testnet",
    });
  });

  it("reads the four build variables through envConfig and ignores the legacy WS override", async () => {
    vi.stubEnv("VITE_NETWORK", "local");
    vi.stubEnv("VITE_PEOPLE_WS_URL", "wss://another-network.invalid");
    for (const [name, value] of Object.entries(localEnv)) vi.stubEnv(name, value);
    vi.resetModules();
    const { envConfig } = await import("@humanity/shared/config/env.ts");
    const { resolveNetwork: resolve } = await import("@humanity/shared/chain/networks.ts");
    expect(envConfig.chain.peopleWsUrl).toBeNull();
    expect(resolve(envConfig.chain.network)).toEqual(resolveNetwork("local", localEnv));
  });

  it("ignores absent or malformed local settings on every existing network", () => {
    for (const key of [undefined, null, "", "paseo-next-v2", "previewnet"]) {
      expect(resolveNetwork(key, {})).toBe(resolveNetwork(key));
      expect(resolveNetwork(key, { VITE_LOCAL_PEOPLE_WS_URL: "bad" })).toBe(resolveNetwork(key));
    }
  });

  it.each(Object.keys(localEnv))("names missing %s", (name) => {
    for (const value of [undefined, "", "   "]) {
      expect(() => resolveNetwork("local", { ...localEnv, [name]: value })).toThrow(name);
    }
  });

  it.each(["VITE_LOCAL_PEOPLE_WS_URL", "VITE_LOCAL_ASSET_HUB_WS_URL"])(
    "names malformed %s",
    (name) => {
      for (const value of ["not a URL", "http://localhost:9944", "ws:localhost", "ws://local\nhost", "ws://", "ws://localhost:bad", "ws://user:pass@localhost", "ws://localhost/#fragment"]) {
        expect(() => resolveNetwork("local", { ...localEnv, [name]: value })).toThrow(name);
      }
    },
  );

  it.each(["VITE_LOCAL_PEOPLE_GENESIS_HASH", "VITE_LOCAL_ASSET_HUB_GENESIS_HASH"])(
    "names malformed %s",
    (name) => {
      for (const value of ["12".repeat(32), `0x${"12".repeat(31)}`, `0x${"12".repeat(33)}`, `0x${"gg".repeat(32)}`]) {
        expect(() => resolveNetwork("local", { ...localEnv, [name]: value })).toThrow(name);
      }
    },
  );

  it("trims values, lowercases genesis hashes and uses the existing testnet product names", () => {
    const padded = Object.fromEntries(Object.entries(localEnv).map(([name, value]) => [name, ` ${value} `]));
    const local = resolveNetwork(" local ", padded);
    expect(local).toEqual(resolveNetwork("local", localEnv));
    expect(local.peopleChain.genesisHash).toBe(localEnv.VITE_LOCAL_PEOPLE_GENESIS_HASH.toLowerCase());
    expect(local.assetHub.genesisHash).toBe(localEnv.VITE_LOCAL_ASSET_HUB_GENESIS_HASH.toLowerCase());
    const upperPeople = { ...localEnv, VITE_LOCAL_PEOPLE_GENESIS_HASH: `0x${"CD".repeat(32)}` };
    expect(resolveNetwork("local", upperPeople).peopleChain.genesisHash).toBe(`0x${"cd".repeat(32)}`);
    expect(dotnsName(local, "peopl")).toBe("peopl.testnet");
    expect(candidateProductDomain(local)).toBe("dim2.testnet");
    expect(dim2Url(local)).toBe("https://dim2.testnet");
  });
});

describe("resolveNetwork", () => {
  it("falls back to paseo-next-v2 when the key is absent or empty", () => {
    expect(resolveNetwork(undefined)).toBe(paseoNextV2);
    expect(resolveNetwork("")).toBe(paseoNextV2);
    expect(resolveNetwork(null)).toBe(paseoNextV2);
  });

  it("resolves both supported networks to their registry entries", () => {
    expect(resolveNetwork("paseo-next-v2")).toBe(paseoNextV2);
    expect(paseoNextV2.displayName).toBe("Paseo Next V2");
    expect(resolveNetwork("previewnet")).toBe(previewnet);
    expect(previewnet.displayName).toBe("Previewnet");
  });

  it("throws on a non-empty unknown key rather than connecting elsewhere", () => {
    expect(() => resolveNetwork("nope")).toThrow('unknown network "nope"');
  });

  it("carries the exact People chain endpoint and genesis hash for each network", () => {
    expect(paseoNextV2.peopleChain.wsUrl).toBe(
      "wss://paseo-people-next-system-rpc.polkadot.io",
    );
    expect(paseoNextV2.peopleChain.genesisHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(paseoNextV2.peopleChain.genesisHash).toBe(
      "0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48",
    );
    expect(previewnet.peopleChain.wsUrl).toBe("wss://previewnet.substrate.dev/people");
    expect(previewnet.peopleChain.genesisHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(previewnet.peopleChain.genesisHash).toBe(
      "0x7f3a2a7ca80d660192d3e898968919c3abfbde64d77f0ca4ae9afe69682c17ee",
    );
  });

  it("carries the PAS native token with 10 decimals for previewnet", () => {
    expect(previewnet.nativeToken).toEqual({ symbol: "PAS", decimals: 10 });
  });

  it("preserves the Asset Hub endpoints and hashes on hosted networks", () => {
    expect(paseoNextV2.assetHub).toEqual({
      wsUrl: "wss://paseo-asset-hub-next-rpc.polkadot.io",
      genesisHash: "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a",
    });
    expect(previewnet.assetHub).toEqual({
      wsUrl: "wss://previewnet.substrate.dev/asset-hub",
      genesisHash: "0x413886e711b79dd1bb8d8fdf0b5988670c63ac10fc7a91d52314c89003bed8e0",
    });
  });
});

describe("genesis overrides", () => {
  const people = `0x${"ab".repeat(32)}` as const;
  const assetHub = `0x${"cd".repeat(32)}` as const;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("replace a hosted network's genesis hashes and keep its endpoints", () => {
    const overridden = resolveNetwork("previewnet", {}, { people, assetHub });
    expect(overridden.peopleChain).toEqual({ ...previewnet.peopleChain, genesisHash: people });
    expect(overridden.assetHub).toEqual({ ...previewnet.assetHub, genesisHash: assetHub });
    expect(resolveNetwork("previewnet", {}, { people, assetHub: null }).assetHub).toEqual(previewnet.assetHub);
    expect(resolveNetwork(undefined, {}, { people, assetHub: null }).peopleChain.genesisHash).toBe(people);
    expect(NETWORKS.previewnet.peopleChain.genesisHash).not.toBe(people);
  });

  it("leave the registry entry itself when none is set, and never touch local", () => {
    expect(resolveNetwork("previewnet", {}, { people: null, assetHub: null })).toBe(previewnet);
    expect(resolveNetwork("local", localEnv, { people, assetHub })).toEqual(resolveNetwork("local", localEnv));
  });

  it("are read through envConfig, lowercased, and a malformed one is ignored", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("VITE_NETWORK", "previewnet");
    vi.stubEnv("VITE_PEOPLE_GENESIS_HASH", ` 0x${"AB".repeat(32)} `);
    vi.stubEnv("VITE_ASSET_HUB_GENESIS_HASH", "0x1234");
    vi.resetModules();
    const { envConfig } = await import("@humanity/shared/config/env.ts");
    const { resolveNetwork: resolve } = await import("@humanity/shared/chain/networks.ts");
    expect(envConfig.chain.genesisOverride).toEqual({ people, assetHub: null });
    expect(resolve(envConfig.chain.network).peopleChain.genesisHash).toBe(people);
    expect(resolve(envConfig.chain.network).assetHub).toEqual(previewnet.assetHub);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("VITE_ASSET_HUB_GENESIS_HASH"));
    warn.mockRestore();
  });
});

describe("DotNS product names", () => {
  it("composes a bare label with each network's own suffix", () => {
    const paseoName = dotnsName(paseoNextV2, "dim2");
    const previewnetName = dotnsName(previewnet, "dim2");

    expect(paseoName).toBe("dim2.paseo");
    expect(previewnetName).toBe("dim2.testnet");
    expect(paseoName).not.toBe(previewnetName);
  });

  it("rejects a label that already carries a suffix", () => {
    expect(() => dotnsName(paseoNextV2, "dim2.testnet")).toThrow(
      "expected a bare label",
    );
  });

  it("rejects empty and whitespace-only labels", () => {
    expect(() => dotnsName(paseoNextV2, "")).toThrow("label is empty");
    expect(() => dotnsName(previewnet, "   ")).toThrow("label is empty");
  });

  it("derives the DIM2 product names from the network", () => {
    expect(candidateProductDomain(paseoNextV2)).toBe("dim2.paseo");
    expect(candidateProductDomain(previewnet)).toBe("dim2.testnet");
    expect(candidateProductDomain(paseoNextV2)).not.toBe(
      candidateProductDomain(previewnet),
    );
    expect(dim2Url(paseoNextV2)).toBe("https://dim2.paseo");
    expect(dim2Url(previewnet)).toBe("https://dim2.testnet");
    // The candidate account and the play hand-off are the SAME product:
    // DIM2 holds both, under its reserved id `dim2`. This used to assert the
    // opposite, back when the hand-off pointed at a per-repo deploy name.
    for (const network of [paseoNextV2, previewnet]) {
      expect(dim2Url(network)).toBe(`https://${candidateProductDomain(network)}`);
    }
  });
});
