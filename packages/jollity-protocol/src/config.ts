// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { resolveLocalNetwork } from "./local-network.mjs"

/** The networks this build can target. */
export type NetworkName = "paseo" | "previewnet" | "local"

export interface NetworkConfig {
  /** DotNS suffix every name on this network carries, without the dot. */
  readonly dotnsTLD: string
  /**
   * Label whose product account plays the game.
   *
   * It covers the identity, the sign up, the report and the namespace game
   * statements are proved in. It is not the name a build is served under: a
   * label of its own would derive a fresh account that nobody funded and no
   * other player shares, so a build under it would play alone. See
   * docs/deploying.md for what a deploy under another name needs.
   */
  readonly productAccount: string
  /**
   * Issues the TURN credentials the mesh relays through.
   *
   * A product calls `/api/v1/turn/issue-with-proof`, which answers the CORS
   * preflight and takes a personhood proof as its authorization. The `/issue`
   * route next door belongs to the native apps and sends no CORS headers, so
   * a page can never read its reply however it asks.
   */
  readonly deviceUniquenessBackendUrl: string
  /**
   * Genesis of the People and Asset Hub chains, for a host whose chain
   * discovery answers nothing.
   *
   * Only a network whose chains are not reset carries them. Previewnet rotates
   * its genesis on every reset, so it relies on discovery or a WS override.
   */
  readonly genesis?: { readonly people: `0x${string}`; readonly hubNextV2: `0x${string}` }
}

/** Hosted defaults only. Local settings are resolved from required variables. */
export const NETWORK_CONFIG: Record<Exclude<NetworkName, "local">, NetworkConfig> = {
  paseo: {
    dotnsTLD: "paseo",
    productAccount: "dim2",
    deviceUniquenessBackendUrl: "https://identity.dotspark.app",
    genesis: {
      people: "0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48",
      hubNextV2: "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a",
    },
  },
  previewnet: {
    dotnsTLD: "testnet",
    productAccount: "dim2",
    deviceUniquenessBackendUrl: "https://identity-previewnet.dotspark.app",
  },
}

/**
 * Network this build targets, read from `NEXT_PUBLIC_NETWORK_NAME`.
 *
 * There is no default. A build that does not say which network it is for would
 * silently play as the account of the other network, so it must not build at
 * all. The app evaluates this while prerendering, which is where the failure
 * belongs.
 */
export function network(): NetworkConfig {
  const name = networkName()
  return name === "local" ? localNetwork()! : NETWORK_CONFIG[name]
}

/** Name of the network this build targets, such as `paseo`, checked as `network` checks it. */
export function networkName(): NetworkName {
  const name = process.env.NEXT_PUBLIC_NETWORK_NAME
  if (name === "local") {
    localNetwork()
    return name
  }
  if (!name || !Object.hasOwn(NETWORK_CONFIG, name)) {
    throw new Error(
      `NEXT_PUBLIC_NETWORK_NAME must be one of ${[...Object.keys(NETWORK_CONFIG), "local"].join(", ")}, ` +
        `got ${name ? `"${name}"` : "nothing"}`,
    )
  }
  return name as NetworkName
}

/** Full DotNS name whose product account signs, such as `dim2.paseo`. */
export function productAccount(): string {
  const { productAccount: label, dotnsTLD } = network()
  return `${label}.${dotnsTLD}`
}

/** Full DotNS name of the personhood product, where a member sets up their name, such as `peopl.paseo`. */
export function personhoodProduct(): string {
  return `peopl.${network().dotnsTLD}`
}

/** Full DotNS name of the stash product, where a player opens their collectibles, such as `stash.paseo`. */
export function stashProduct(): string {
  return `stash.${network().dotnsTLD}`
}

/**
 * Derivation index of the product account that plays, which the app signs up
 * with and the chat worker reads the game for.
 *
 * It is 1 by default: on the paseo and previewnet chains every lite person who
 * played is pinned to their index-1 account for good (`Game.LiteInvites`), and
 * every score sits on it, so moving would cost them their free seat and their
 * score. Humanity reads the same index (`VITE_GAME_ACCOUNT_INDEX`), so the two
 * move together. `NEXT_PUBLIC_SIGNUP_ACCOUNT_INDEX` overrides it, for a fresh
 * network or when an index is spent.
 */
export function signupAccountIndex(): number {
  const override = process.env.NEXT_PUBLIC_SIGNUP_ACCOUNT_INDEX
  return override != null ? Number(override) : 1
}

/**
 * Where TURN credentials come from, with any trailing slash removed.
 *
 * `NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL` overrides the network table, so
 * a local run can point at a forwarder without editing this file.
 */
export function deviceUniquenessBackendUrl(): string {
  if (process.env.NEXT_PUBLIC_NETWORK_NAME === "local") return localNetwork()!.deviceUniquenessBackendUrl
  const override = process.env.NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL
  return (override || network().deviceUniquenessBackendUrl).replace(/\/$/, "")
}

/**
 * Fallback genesis of one chain, for a host whose discovery answers nothing.
 *
 * `NEXT_PUBLIC_PEOPLE_GENESIS` and `NEXT_PUBLIC_ASSET_HUB_GENESIS` override the
 * network table.
 */
export function chainGenesis(chain: "people" | "hubNextV2"): `0x${string}` | undefined {
  if (process.env.NEXT_PUBLIC_NETWORK_NAME === "local") return localNetwork()!.genesis[chain]
  const override =
    chain === "people" ? process.env.NEXT_PUBLIC_PEOPLE_GENESIS : process.env.NEXT_PUBLIC_ASSET_HUB_GENESIS
  return (override as `0x${string}` | undefined) || network().genesis?.[chain]
}

/** The network whose Asset Hub has this genesis, or none for an Asset Hub the table does not carry. */
export function assetHubNetwork(genesis: string): NetworkName | undefined {
  const wanted = genesis.toLowerCase()
  return (Object.keys(NETWORK_CONFIG) as (keyof typeof NETWORK_CONFIG)[]).find((name) => NETWORK_CONFIG[name].genesis?.hubNextV2 === wanted)
}

/** Local settings use static env accesses so Next and the chat build both inline them. */
export function localNetwork() {
  if (process.env.NEXT_PUBLIC_NETWORK_NAME !== "local") return undefined
  return resolveLocalNetwork({
    NEXT_PUBLIC_PEOPLE_WS: process.env.NEXT_PUBLIC_PEOPLE_WS,
    NEXT_PUBLIC_PEOPLE_GENESIS: process.env.NEXT_PUBLIC_PEOPLE_GENESIS,
    NEXT_PUBLIC_ASSET_HUB_WS: process.env.NEXT_PUBLIC_ASSET_HUB_WS,
    NEXT_PUBLIC_ASSET_HUB_GENESIS: process.env.NEXT_PUBLIC_ASSET_HUB_GENESIS,
    NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL: process.env.NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL,
    NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS: process.env.NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS,
  })
}
