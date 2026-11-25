// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE ENGINE SEAM — where the app builds the `GameEngine` that answers the
 * Game pallet: the chain over papi, through the host's People provider or a
 * dev WebSocket. game-source.ts takes a `GameEngine` and reads views.
 */
import {
  createChainEngine,
  createPeopleClient,
  createPeopleClientFromProvider,
  withExtrinsicLogging,
} from "@jollity/game-chain"
import { claimsChain } from "@individuality/game-outcome/chain"
import type { ScarcityChain } from "@jollity/collectables"
import { chainGenesis, localNetwork, network, type GameEngine } from "@jollity/protocol"
import { createClient, type JsonRpcProvider, type PolkadotClient } from "polkadot-api"
import { getWsProvider } from "polkadot-api/ws"
import { devLog } from "./debug/log-store"
import { describeError } from "./host/error-detail"
import { appOpenStep } from "./journeys/app-open"

type HostSdk = typeof import("@parity/product-sdk-host")

// The JS host-container runtime has no chain-discovery handler, so without a
// fallback genesis the app shows the "Open in the Polkadot app" gate inside the
// host. The fallbacks live in NETWORK_CONFIG in @jollity/protocol.
// Discovery on a host without the handler may never answer; the fallback
// must not wait on it forever.
const DISCOVERY_TIMEOUT_MS = 5_000
const PROVIDER_RETRY_MS = 1_500

type PeopleClient = ReturnType<typeof createPeopleClientFromProvider>

/**
 * Chain reads through the host bridge. The People-chain genesis comes from
 * HOST CHAIN DISCOVERY (the host maps roles to its configured environment) —
 * no hard-coded hashes to go stale when a network is wiped. Null when the host
 * does not serve the chain (`getHostProvider` throws `ChainNotSupportedError`).
 */
async function hostChainClient(sdk: HostSdk, attempt = 0): Promise<PeopleClient | null> {
  try {
    // discovery first (hosts that map roles to their env); genesis fallback when
    // it answers nothing, so a discovery-less host still gets a provider.
    // "People" is truapi's ChainIdentifier status value (Relay | AssetHub |
    // People | Bulletin); the codec refuses a lowercase "people" ("Unknown
    // status value").
    const discovery = await Promise.race([
      sdk.getHostChainInfo(["People"]).catch((error: unknown) => {
        devLog("engine", "chain discovery failed", { detail: describeError(error) }, "warn")
        return undefined
      }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), DISCOVERY_TIMEOUT_MS)),
    ])
    const discovered = discovery?.chains?.People
    const genesis = discovered ?? chainGenesis("people")
    devLog("engine", "People chain genesis", {
      via: discovered ? "discovery" : genesis ? "fallback" : "none",
      genesis: genesis ?? null,
    })
    const provider = genesis ? await sdk.getHostProvider(genesis) : null
    return provider ? createPeopleClientFromProvider(provider) : null
  } catch (error) {
    // ChainNotSupportedError means the host's chain registry has no such
    // genesis (a different network flavour, or a reset chain). Anything else
    // (the bridge not answering yet, a timeout) is worth ONE more try before
    // the page falls back to the gate.
    const definitive = error instanceof sdk.ChainNotSupportedError
    devLog("engine", "host People provider unavailable", { detail: describeError(error), definitive }, "warn")
    if (!definitive && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, PROVIDER_RETRY_MS))
      return hostChainClient(sdk, attempt + 1)
    }
    return null
  }
}

// The truapi-host CLI serves chains from 0.21, but its provider refuses
// `archive_v1_storage`, so a read papi routes there never answers and the collectables screen
// hangs. A dev-host run therefore reads over the WebSocket it already names.
const DEV_HOST =
  process.env.NODE_ENV === "development" && Boolean(process.env.NEXT_PUBLIC_TRUAPI_HOST_PORT)

/**
 * The engine for a host container. It reads over the host's People provider, and over
 * `NEXT_PUBLIC_PEOPLE_WS` when the host serves no chain, or on a dev-host run
 * (DEV_HOST) — identity, signing and statements stay the host's either way.
 * Null when neither a host chain nor that override is there to read from.
 */
export async function resolveHostEngine(sdk: HostSdk): Promise<GameEngine | null> {
  hostSdk = sdk
  const genesis = appOpenStep("chain.genesis")
  const client = (localNetwork() || (DEV_HOST && process.env.NEXT_PUBLIC_PEOPLE_WS)) ? null : await hostChainClient(sdk)
  genesis.end({ "chain.genesis": client ? "found" : "none" })
  if (client) return createChainEngine((peopleClient = client), { tld: network().dotnsTLD })
  const wsUrl = localNetwork()?.endpoints.people ?? process.env.NEXT_PUBLIC_PEOPLE_WS
  if (!wsUrl) return null
  console.warn(`[engine] host serves no People chain — reading ${wsUrl}, signing via host`)
  return createChainEngine((peopleClient = createPeopleClient(wsUrl)), { tld: network().dotnsTLD })
}

/**
 * The engine outside a host — development only, explicit and env-driven. A
 * READ-ONLY chain view when `NEXT_PUBLIC_PEOPLE_WS` names an endpoint;
 * otherwise nothing (the page shows the host-only gate).
 */
export function resolveDevEngine(): GameEngine | null {
  const wsUrl = localNetwork()?.endpoints.people ?? process.env.NEXT_PUBLIC_PEOPLE_WS
  return wsUrl ? createChainEngine((peopleClient = createPeopleClient(wsUrl)), { tld: network().dotnsTLD }) : null
}

export type { ScarcityChain }
export { withExtrinsicLogging }

let peopleClient: PeopleClient | null = null
let hostSdk: HostSdk | null = null
let scarcity: Promise<ScarcityChain | null> | null = null

async function assetHubProvider(): Promise<JsonRpcProvider | null> {
  if (hostSdk && !localNetwork() && !(DEV_HOST && process.env.NEXT_PUBLIC_ASSET_HUB_WS)) {
    try {
      const discovery = await Promise.race([
        hostSdk.getHostChainInfo(["AssetHub"]).catch((error: unknown) => {
          devLog("engine", "host chain discovery failed", { detail: describeError(error) }, "warn")
          return undefined
        }),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), DISCOVERY_TIMEOUT_MS)),
      ])
      const genesis = discovery?.chains?.AssetHub ?? chainGenesis("hubNextV2")
      const provider = genesis ? await hostSdk.getHostProvider(genesis) : null
      if (provider) return provider
    } catch (error) {
      devLog("engine", "host Asset Hub provider unavailable", { detail: describeError(error) }, "warn")
    }
  }
  const wsUrl = localNetwork()?.endpoints.assetHub ?? process.env.NEXT_PUBLIC_ASSET_HUB_WS
  return wsUrl ? getWsProvider(wsUrl) : null
}

let assetHub: Promise<PolkadotClient | null> | null = null
/** A client of the Asset Hub this page can reach (the host's, or
 *  `NEXT_PUBLIC_ASSET_HUB_WS`), for reads such as the names on the draw's
 *  wheel (@individuality/name-link); null when there is none. */
export function assetHubClient(): Promise<PolkadotClient | null> {
  assetHub ??= assetHubProvider().then((provider) => {
    if (!provider) assetHub = null // asked again next time: a host can gain the chain later
    return provider ? createClient(provider) : null
  })
  return assetHub
}

/** The People chain client the engine reads (the host's, or `NEXT_PUBLIC_PEOPLE_WS`); null before an engine is resolved. */
export function peopleChainClient(): PolkadotClient | null {
  return peopleClient?.client ?? null
}

/**
 * Builds the chain pair the collectables reads from.
 *
 * The People chain the engine already holds serves the credits. Asset Hub
 * serves the collections, what a credit would mint, and whether it is spent.
 *
 * `claimsChain` reads Asset Hub through the unsafe papi API and People at the
 * best block.
 *
 * It is null before an engine has been resolved.
 */
export function resolveScarcityChain(): Promise<ScarcityChain | null> {
  if (!peopleClient) return Promise.resolve(null)
  const people = peopleClient
  scarcity ??= assetHubProvider().then((provider) => {
    if (!provider) {
      devLog("engine", "no Asset Hub to read the chest from", undefined, "warn")
      // the next collectables read asks again, since a host can gain the chain later
      scarcity = null
      return null
    }
    return claimsChain(people, createClient(provider))
  })
  return scarcity
}
