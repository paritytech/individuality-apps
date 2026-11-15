// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export interface LocalNetworkConfig {
  readonly dotnsTLD: "testnet"
  readonly productAccount: "dim2"
  readonly deviceUniquenessBackendUrl: string
  readonly genesis: { readonly people: `0x${string}`; readonly hubNextV2: `0x${string}` }
  readonly endpoints: { readonly people: string; readonly assetHub: string }
  readonly approvedCollections: readonly number[]
}
export function resolveLocalNetwork(env: Readonly<Record<string, string | undefined>>): LocalNetworkConfig
