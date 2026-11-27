// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * People chains, each verified against its live endpoint:
 * - Paseo Next V2 and Previewnet: `chain_getBlockHash(0)`,
 *   `state_getRuntimeVersion` (`next-people-paseo` spec 3002000), and
 *   `system_properties` (PAS, 10 decimals). Previewnet is ephemeral: its
 *   genesis rotates on every reset, so re-verify when connections start
 *   failing, and set `VITE_PEOPLE_GENESIS_HASH` / `VITE_ASSET_HUB_GENESIS_HASH`
 *   to build against a reset network before this table is updated.
 * Asset Hubs (the dotNS contracts and the `DotnsGateway` pallet): genesis read
 * with `chain_getBlockHash(0)`.
 */

import { envConfig } from "../config/env.ts";
import { resolveLocalNetwork, type LocalNetworkEnv } from "../config/local-network.ts";

export type NetworkKey = "paseo-next-v2" | "previewnet" | "local";

export interface ChainEndpoint {
  wsUrl: string;
  genesisHash: `0x${string}`;
}

export interface NativeToken {
  symbol: string;
  decimals: number;
}

export interface NetworkConfig {
  key: NetworkKey;
  displayName: string;
  isTestnet: boolean;
  peopleChain: ChainEndpoint;
  /** The network's Asset Hub: the dotNS contracts and `DotnsGateway`. */
  assetHub: ChainEndpoint;
  nativeToken: NativeToken;
  /**
   * DotNS suffix this network issues names under, without the leading dot.
   *
   * Every DotNS name the app derives an account from is `<label>.<this>`, so
   * the suffix belongs to the network and never to a build-time literal: a
   * name carrying another network's suffix derives a different — and here,
   * empty — product account. `bulletin-deploy` owns the same mapping for
   * deploys (see `DEPLOY_TARGETS` in `apps/humanity-app/scripts/setup.ts`), and
   * `humanity-user-id.ts` strips exactly these suffixes when reading a
   * username back off chain.
   */
  dotnsSuffix: string;
}

export const DEFAULT_NETWORK = "paseo-next-v2";

/** Hosted networks only; local config is resolved on explicit selection. */
export const NETWORKS: Record<Exclude<NetworkKey, "local">, NetworkConfig> = {
  "paseo-next-v2": {
    key: "paseo-next-v2",
    displayName: "Paseo Next V2",
    isTestnet: true,
    peopleChain: {
      wsUrl: "wss://paseo-people-next-system-rpc.polkadot.io",
      genesisHash:
        "0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48",
    },
    assetHub: {
      wsUrl: "wss://paseo-asset-hub-next-rpc.polkadot.io",
      genesisHash:
        "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a",
    },
    nativeToken: { symbol: "PAS", decimals: 10 },
    dotnsSuffix: "paseo",
  },
  previewnet: {
    key: "previewnet",
    displayName: "Previewnet",
    isTestnet: true,
    peopleChain: {
      wsUrl: "wss://previewnet.substrate.dev/people",
      genesisHash:
        "0x7f3a2a7ca80d660192d3e898968919c3abfbde64d77f0ca4ae9afe69682c17ee",
    },
    assetHub: {
      wsUrl: "wss://previewnet.substrate.dev/asset-hub",
      genesisHash:
        "0x413886e711b79dd1bb8d8fdf0b5988670c63ac10fc7a91d52314c89003bed8e0",
    },
    nativeToken: { symbol: "PAS", decimals: 10 },
    dotnsSuffix: "testnet",
  },
};

export function parseNetworkKey(
  value: string | undefined | null,
): NetworkKey | null {
  if (value == null) return null;
  return value === "local" || Object.hasOwn(NETWORKS, value) ? (value as NetworkKey) : null;
}

/**
 * Empty or absent resolves to {@link DEFAULT_NETWORK}. A non-empty unknown key
 * THROWS: a typo'd `VITE_NETWORK` must fail loudly rather than silently
 * connecting somewhere else.
 */
export function resolveNetwork(
  key: string | undefined | null,
  localEnv: LocalNetworkEnv = envConfig.chain.localNetwork,
  genesis: GenesisOverride | undefined = envConfig.chain.genesisOverride,
): NetworkConfig {
  const trimmed = key?.trim() ?? "";
  if (trimmed === "") {
    return withGenesisOverride(NETWORKS[DEFAULT_NETWORK], genesis);
  }
  const parsed = parseNetworkKey(trimmed);
  if (parsed == null) {
    throw new Error(
      `unknown network "${trimmed}"; known networks: ${Object.keys(NETWORKS).join(", ")}, local`,
    );
  }
  return parsed === "local"
    ? resolveLocalNetwork(localEnv)
    : withGenesisOverride(NETWORKS[parsed], genesis);
}

/** Genesis hashes that replace a hosted network's built-in ones; null keeps the table's. */
export interface GenesisOverride {
  readonly people: `0x${string}` | null;
  readonly assetHub: `0x${string}` | null;
}

/** The hosted network with the build's genesis overrides applied: the same
 *  object when none is set (or a config without the field, as test mocks are). */
function withGenesisOverride(network: NetworkConfig, genesis: GenesisOverride | undefined): NetworkConfig {
  if (genesis == null || (genesis.people == null && genesis.assetHub == null)) return network;
  return {
    ...network,
    peopleChain: { ...network.peopleChain, genesisHash: genesis.people ?? network.peopleChain.genesisHash },
    assetHub: { ...network.assetHub, genesisHash: genesis.assetHub ?? network.assetHub.genesisHash },
  };
}

/**
 * A bare DotNS label as a full name on this network.
 *
 * THROWS on a label that already carries a suffix, rather than emitting
 * `peopl.paseo.testnet` or silently trusting a suffix that may belong to another
 * network. Mirrors `resolveLabel` in `apps/humanity-app/scripts/setup.ts`, which refuses the
 * same input on the deploy side.
 */
export function dotnsName(network: NetworkConfig, label: string): string {
  const bare = label.trim();
  if (bare === "") {
    throw new Error("dotnsName: label is empty; expected a bare DotNS label");
  }
  if (bare.includes(".")) {
    throw new Error(
      `dotnsName: expected a bare label but got "${bare}"; ` +
        `${network.key} issues .${network.dotnsSuffix} names, so the suffix is not yours to set`,
    );
  }
  return `${bare}.${network.dotnsSuffix}`;
}

/**
 * Reserved product ids of the products this app works alongside.
 *
 * Product ids, not DotNS labels — the distinction matters. `ReservedProductIds`
 * in the Android Polkadot app maps the wallet's built-in accounts to these
 * ids: `peopl` for personhood (this app), `dim2` for the game, `fund` for
 * funding. `peopl`'s account 0 is the person's identity account (RFC-0028). An RFC-0022 product account derives
 * from `//product//<id>.<suffix>/<index>`, so the id is what identifies the
 * *product* and the suffix is what identifies the *network*. Being the leftmost
 * segment of a DotNS name is a consequence of that, not what they are.
 *
 * Which is why they are protocol constants rather than per-network config:
 * only the suffix varies, and {@link NetworkConfig.dotnsSuffix} already owns
 * it. Two of these used to sit on `NetworkConfig` instead, spelling `dim2`
 * once per network under two different names — which is what let a per-repo
 * deploy name (`jollitydemo`, long since renamed by its own repo) masquerade
 * as a legitimate second product until every play hand-off was dead.
 */
const PRODUCT_IDS = {
  /**
   * DIM2, the method offered today. One product in two roles here: it owns
   * the candidate accounts this app reads, and it is where play happens — so
   * {@link candidateProductDomain} and {@link dim2Url} are two views of this
   * one id, not two products. Named for the product, not for the game: a
   * game is one session inside DIM2, and conflating the two is how a deploy
   * name passed for a product in the first place.
   */
  dim2: "dim2",
} as const;

/** Product domain for RFC-0022 candidate account lookups: DIM2 owns them. */
export function candidateProductDomain(network: NetworkConfig): string {
  return dotnsName(network, PRODUCT_IDS.dim2);
}

/**
 * Where a play handoff sends the user: DIM2 on this network. The host
 * resolves the bare DotNS name, so the URL is the name itself.
 */
export function dim2Url(network: NetworkConfig): string {
  return `https://${dotnsName(network, PRODUCT_IDS.dim2)}`;
}
