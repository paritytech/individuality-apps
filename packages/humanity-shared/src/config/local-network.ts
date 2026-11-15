// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ChainEndpoint, NetworkConfig } from "../chain/networks.ts";

/** Raw build variables, shared by Vite config resolution and runtime config. */
export type LocalNetworkEnv = Readonly<Record<string, string | undefined>>;

function required(env: LocalNetworkEnv, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (value === "") {
    throw new Error(`${name} is required when VITE_NETWORK=local`);
  }
  return value;
}

function endpoint(
  env: LocalNetworkEnv,
  wsName: string,
  genesisName: string,
): ChainEndpoint {
  const wsUrl = required(env, wsName);
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    throw new Error(`${wsName} must be a valid ws:// or wss:// URL`);
  }
  if (
    !/^wss?:\/\//.test(wsUrl) ||
    /\s/.test(wsUrl) ||
    !["ws:", "wss:"].includes(url.protocol) ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    wsUrl.includes("#")
  ) {
    throw new Error(`${wsName} must be a valid ws:// or wss:// URL without credentials or a fragment`);
  }
  const genesisHash = required(env, genesisName);
  if (!/^0x[0-9a-fA-F]{64}$/.test(genesisHash)) {
    throw new Error(`${genesisName} must be 0x followed by 64 hexadecimal characters`);
  }
  return { wsUrl, genesisHash: genesisHash.toLowerCase() as `0x${string}` };
}

/** No defaults: a local build must identify both chains explicitly. */
export function resolveLocalNetwork(env: LocalNetworkEnv): NetworkConfig {
  return {
    key: "local",
    displayName: "Local",
    isTestnet: true,
    peopleChain: endpoint(env, "VITE_LOCAL_PEOPLE_WS_URL", "VITE_LOCAL_PEOPLE_GENESIS_HASH"),
    assetHub: endpoint(env, "VITE_LOCAL_ASSET_HUB_WS_URL", "VITE_LOCAL_ASSET_HUB_GENESIS_HASH"),
    nativeToken: { symbol: "PAS", decimals: 10 },
    dotnsSuffix: "testnet",
  };
}
