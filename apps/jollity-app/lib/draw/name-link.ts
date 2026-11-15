// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * LINK THE PLAYER'S NAME (#456): the username of the player linked to the
 * jollity account that holds their draw tickets, so the wheel can name them.
 * lib/game-source.ts runs it in the BACKGROUND as soon as the source has the
 * player, again until it links, and no sign-up goes without it ("Saving
 * your seat…"). The steps are `linkName`'s
 * (@individuality/name-link); this file hands in what the app reaches:
 *
 *  - the username the host gives (lib/host/identity.ts, the answer the app
 *    open already asked for, so no prompt of its own);
 *  - the root's signature, through the product SDK's
 *    `wallet.signMessageWithDotNsIdentity`: it finds the root that owns the
 *    username on the People chain and has the host sign as it. The host asks
 *    the player to confirm, right after their tap on Register;
 *  - the host's chains (lib/engine.ts), else the network's own endpoints;
 *  - the account's signer on transaction pipeline 1, and the host's PGAS
 *    allowance (`SmartContractAllowance`).
 *
 * One link at a time; it never throws, and never touches the sign-up. Each
 * link is a journey.name-link in Sentry (lib/journeys/name-link-trace.ts).
 */
import { createClient, type PolkadotClient } from "polkadot-api"
import { fromHex } from "polkadot-api/utils"
import { getWsProvider } from "polkadot-api/ws"
import type { App } from "@parity/product-sdk"
import type { ProductAccount } from "@parity/product-sdk-host"
import { linkName, type NameLinkResult, type NameLinkTrigger } from "@individuality/name-link"
import { localNetwork, network, productAccount, signupAccountIndex } from "@jollity/protocol"
import { devLog } from "../debug/log-store"
import { assetHubClient, peopleChainClient } from "../engine"
import { knownDisplayName } from "../host/identity"
import { traceNameLink, type NameLinkSkip, type NameLinkTrace } from "../journeys/name-link-trace"
import { chainEndpoints } from "./chain-endpoints"

// How a link ended (`skipped`: no host accounts, no username, no chain), and
// what asked for it: the shared gate's words (name-gate.ts)
export type { NameLinkResult, NameLinkTrigger }

let running: Promise<NameLinkResult> | null = null
let app: Promise<App> | null = null

/** the debug sheet, and in development the console too (the link runs unseen) */
function note(message: string, data?: unknown, level: "info" | "warn" = "info") {
  devLog("names", message, data, level)
  if (process.env.NODE_ENV === "development") console.info("[names]", message, data ?? "")
}

/** `message`, signed by the root account that owns `username`, as the product SDK has the host sign it */
async function signWithRoot(username: string, message: Uint8Array) {
  const { createApp } = await import("@parity/product-sdk")
  // nothing of the SDK app is used but the wallet: no Bulletin cloud storage
  app ??= createApp({ cloudStorage: false })
  const base =
    network().dotnsTLD === "paseo"
      ? (await import("@parity/product-sdk-descriptors/paseo-individuality")).paseo_individuality
      : (await import("@parity/product-sdk-descriptors/previewnet-individuality")).previewnet_individuality
  const local = localNetwork()
  const peopleChain = local ? { ...base, genesis: local.genesis.people } : base
  const signed = await (await app).wallet.signMessageWithDotNsIdentity({ peopleChain, username, message })
  return { root: fromHex(signed.accountId), signature: signed.signature }
}

/**
 * Link this player's username to `account`, unless it already is, and say how
 * it ended. One at a time: a call while a link runs gets that link's answer.
 * `signal` stops the link before its next step (the name gate's deadline).
 * Never throws: a link that threw is `failed`.
 */
export function linkPlayerName(account: ProductAccount, trigger: NameLinkTrigger, signal?: AbortSignal): Promise<NameLinkResult> {
  running ??= link(account, trigger, signal)
    .catch((error: unknown): NameLinkResult => {
      note("linking the name failed", { detail: String(error) }, "warn")
      return "failed"
    })
    .finally(() => {
      running = null
    })
  return running
}

async function link(account: ProductAccount, trigger: NameLinkTrigger, signal?: AbortSignal): Promise<NameLinkResult> {
  const trace = traceNameLink(trigger)
  try {
    return await linkTraced(account, trace, signal)
  } catch (error) {
    trace.threw(error)
    throw error
  }
}

async function linkTraced(account: ProductAccount, trace: NameLinkTrace, signal?: AbortSignal): Promise<NameLinkResult> {
  const skipped = (why: NameLinkSkip): NameLinkResult => {
    trace.skipped(why)
    return "skipped"
  }
  const sdk = await import("@parity/product-sdk-host")
  const accounts = await sdk.getAccountsProvider()
  if (!accounts) return skipped("no-host")
  const username = await knownDisplayName({ ask: true })
  if (!username) {
    note("no username to link: the host gave none")
    return skipped("no-username")
  }

  // the host's chains, as the rest of the app reads them; the network's own
  // endpoints only where the host serves none
  const endpoints = chainEndpoints(network().dotnsTLD)
  const opened: PolkadotClient[] = []
  const open = (ws: string | null) => {
    if (!ws) return null
    const client = createClient(getWsProvider(ws))
    opened.push(client)
    return client
  }
  const assetHub = (await assetHubClient()) ?? open(endpoints.assetHub)
  const people = peopleChainClient() ?? open(endpoints.people)
  try {
    if (!assetHub || !people) {
      note("no Asset Hub or People chain to reach")
      return skipped("no-chain")
    }
    const outcome = await linkName({
      product: productAccount(),
      account: account.publicKey,
      username,
      assetHub,
      people,
      // fees in PGAS too: Asset Hub (runtime 3004000 on) takes them from PGAS
      // only on transaction-extension pipeline 1; the default, 0, charges the native coin
      signer: accounts.getProductAccountSigner(account, { txExtVersion: 1 }),
      signAsRoot: signWithRoot,
      allowance: async () => {
        const outcome = await sdk.requestResourceAllocation([{ tag: "SmartContractAllowance", value: { tag: "Index", value: signupAccountIndex() } }])
        return outcome.ok ? String(outcome.value[0]) : sdk.formatHostError(outcome.error)
      },
      log: (message, data, level) => {
        note(message, data, level)
        if (level === "warn") trace.warned(message, data?.detail)
      },
      onStage: trace.stage,
      onFacts: trace.facts,
      signal,
    })
    note(`name link: ${outcome}`)
    trace.end(outcome)
    return outcome
  } finally {
    for (const client of opened) client.destroy()
  }
}
