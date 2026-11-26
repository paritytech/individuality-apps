// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The network Seity runs on, and the one product id it needs from it.
 *
 * `dotnsSuffix` is the network's DotNS TLD. It is never hard-coded as `.dot`:
 * paseo-next-v2 issues `.paseo` names, previewnet `.testnet` ones.
 */
export type NetworkKey = "paseo-next-v2" | "previewnet";

interface NetworkConfig {
  readonly key: NetworkKey;
  /** The `getChainAPI` environment for this network. */
  readonly environment: "paseo" | "previewnet";
  readonly dotnsSuffix: string;
}

const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  "paseo-next-v2": { key: "paseo-next-v2", environment: "paseo", dotnsSuffix: "paseo" },
  previewnet: { key: "previewnet", environment: "previewnet", dotnsSuffix: "testnet" },
};

function readNetwork(): NetworkConfig {
  const raw = (import.meta.env["VITE_NETWORK"] as string | undefined)?.trim() || "paseo-next-v2";
  if (!(raw in NETWORKS)) {
    throw new Error(`VITE_NETWORK="${raw}" is not one of ${Object.keys(NETWORKS).join(", ")}`);
  }
  return NETWORKS[raw as NetworkKey];
}

export const network = readNetwork();

/**
 * The product id the host serves Seity under: `peopl.<tld>`, the personhood
 * product, as Humanity is deployed. Its account 0 is the identity account that
 * holds the person's usernames (RFC-0028), so running as it lets Seity sign the
 * profile write and take the PGAS allowance on that one account.
 */
export const PRODUCT_ID = `peopl.${network.dotnsSuffix}`;
