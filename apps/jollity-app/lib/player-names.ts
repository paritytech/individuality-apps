// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A PLAYER'S NAME: the username of the player when their root account signed a
 * note for their game account in DotNS (@individuality/name-link). The
 * draw's wheel reads it here.
 *
 * DotNS lives on Asset Hub, which the game engine does not read. The reader
 * uses the host's Asset Hub client, else (the local host CLI, which serves no
 * chain reads) a lazy papi client on the network's own endpoint.
 */
import { describeError } from "./host/error-detail"
import { devLog } from "./debug/log-store"
import { dotnsNames, peopleNames, reviveCall } from "@individuality/name-link"
import { chainEndpoints } from "./draw/chain-endpoints"
import { productAccount, network } from "@jollity/protocol"
import { chainVerdict, classifyHostFailure } from "@individuality/people-chain"

/** Why a name read failed, as one fixed word for `name.error`. */
export type NameReadError = "no-chain" | "timeout" | "not-pinned" | "chain-lost" | "disconnected" | "decode" | "other"

export function nameReadError(error: unknown): NameReadError {
  const failureClass = classifyHostFailure(error)
  switch (failureClass) {
    case "block-not-pinned":
      return "not-pinned"
    case "timeout":
      return "timeout"
    case "network":
    case "host-interrupted":
      return "disconnected"
  }
  if (chainVerdict(failureClass) === "lost") return "chain-lost"
  if (/decode|codec|unexpected end|out of range/i.test(describeError(error))) return "decode"
  return "other"
}

/** why the page has no DotNS reader, once it found none */
let trouble: NameReadError = "no-chain"
export const readerTrouble = (): NameReadError => trouble

/** DotNS, read from this page's Asset Hub: the host's, or (the local host
 *  CLI, which serves no chain reads) the network's own endpoints.
 *  Null when there is none. */
let dotns: Promise<ReturnType<typeof dotnsNames> | null> | null = null
export function dotnsReader(): Promise<ReturnType<typeof dotnsNames> | null> {
  dotns ??= (async () => {
    try {
      const [{ assetHubClient, peopleChainClient }, { createClient }, { getWsProvider }] = await Promise.all([
        import("./engine"),
        import("polkadot-api"),
        import("polkadot-api/ws"),
      ])
      const { assetHub: assetHubWs, people: peopleWs } = chainEndpoints(network().dotnsTLD)
      const assetHub = (await assetHubClient()) ?? (assetHubWs ? createClient(getWsProvider(assetHubWs)) : null)
      if (!assetHub) {
        trouble = "no-chain"
        dotns = null
        return null
      }
      // People: the engine's client (the host's chain), else the network's endpoint
      const people = (peopleChainClient()) ?? (peopleWs ? createClient(getWsProvider(peopleWs)) : null)
      return dotnsNames(reviveCall(assetHub), people ? peopleNames(people) : async () => null, productAccount())
    } catch (error) {
      devLog("draw", "no DotNS to read names from", { detail: describeError(error) }, "warn")
      trouble = nameReadError(error)
      dotns = null
      return null
    }
  })()
  return dotns
}
