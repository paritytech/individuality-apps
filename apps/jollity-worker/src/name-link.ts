// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * LINK THE PLAYER'S NAME, from the chat (#456): the username of the player
 * linked to the jollity account that holds their draw tickets, as the app does
 * (lib/draw/name-link.ts). ./name-gate.ts runs it in the background from the
 * poll, and no sign-up goes without it. The steps are `linkName`'s
 * (@individuality/name-link); this file hands in what the worker reaches:
 *
 *  - the username the host gives without a prompt (`accounts.userName`), else
 *    the one the app stored for the worker (`PLAYER_NAME_KEY`): a player who
 *    never granted it is not linked from here;
 *  - the root that owns it on the People chain, and its signature through the
 *    host's raw signing as that account (`accounts.signAsRoot`). That is the
 *    call the product SDK's `wallet.signMessageWithDotNsIdentity` makes in the
 *    app; the SDK's app layer itself is too heavy for the worker. The host asks
 *    the player to confirm;
 *  - the worker's own clients of both chains (./chain.ts);
 *  - the account's signer on transaction pipeline 1, and the host's PGAS allowance.
 *
 * One link at a time; it never throws, and never touches the sign-up. Each
 * link is a journey.name-link in Sentry, as the app's is
 * (lib/journeys/name-link-trace.ts): `name_link.stage` the step it reached,
 * the lookup's `name_link.lookup_reason` and `name_link.already_linked`
 * decision, `name_link.sign_ms` the time the player took to confirm the
 * root's signature, and one `name-link-failed` event when it stops short.
 */
import {
  linkName,
  usernameOwner,
  type LinkOutcome,
  type LinkStage,
  type NameLinkResult,
  type NameLinkTrigger,
} from "@individuality/name-link"
import { PLAYER_NAME_KEY, productAccount } from "@jollity/protocol"
import { connect, connectAssetHub } from "./chain"
import type { WorkerHost } from "./host"
import { chatFailure, chatJourney, describeError, maskSafe, type ChatJourney } from "./telemetry"

let running: Promise<NameLinkResult> | null = null

/**
 * Link this player's username to `account`, unless it already is, and say how
 * it ended. One at a time: a call while a link runs gets that link's answer.
 * Never throws: a link that threw is `failed`.
 */
export function linkNameFromChat(
  host: WorkerHost,
  account: { name: string; index: number },
  log?: (kind: "info" | "error", text: string) => void,
  trigger: NameLinkTrigger = "background",
  signal?: AbortSignal,
): Promise<NameLinkResult> {
  running ??= traced(host, account, trigger, log, signal)
    .catch((error: unknown): NameLinkResult => {
      log?.("error", `Linking the name failed: ${error instanceof Error ? error.message : String(error)}`)
      return "failed"
    })
    .finally(() => {
      running = null
    })
  return running
}

/** The link as Sentry sees it: the stage reached, the facts found, the root's signing time, the last warning. */
export function nameLinkTrace(trigger: NameLinkTrigger = "background") {
  const journey: ChatJourney = chatJourney("name-link", { "name_link.surface": "chat", "name_link.trigger": trigger })
  let stage: LinkStage | "setup" = "setup"
  let signingSince: number | null = null
  let warning = "none"
  const finish = (outcome: LinkOutcome | "skipped", attrs: Record<string, string> = {}) => {
    const signed: Record<string, string> = signingSince === null ? {} : { "name_link.sign_ms": String(Date.now() - signingSince) }
    signingSince = null
    if (outcome === "unfunded" || outcome === "not-signed" || outcome === "unowned" || outcome === "failed") {
      const reason = outcome === "failed" ? stage : outcome
      journey.markSad(reason)
      chatFailure("name-link-failed", reason, { stage, error: warning })
    }
    journey.end(outcome, { "name_link.stage": stage, ...signed, ...attrs })
  }
  return {
    stage(next: LinkStage) {
      if (signingSince !== null) journey.set({ "name_link.sign_ms": String(Date.now() - signingSince) })
      signingSince = next === "sign" ? Date.now() : null
      stage = next
    },
    // tags are not masked on the way out: the host's own answer is free text
    facts: (found: Record<string, string>) => journey.set(Object.fromEntries(Object.entries(found).map(([key, value]) => [key, maskSafe(value)]))),
    warned(message: string, detail?: unknown) {
      warning = detail === undefined ? message : `${message}: ${String(detail)}`
    },
    skipped: (why: string) => finish("skipped", { "name_link.why": why }),
    end: (outcome: LinkOutcome) => finish(outcome),
    threw(error: unknown) {
      warning = describeError(error)
      finish("failed")
    },
  }
}

async function traced(
  host: WorkerHost,
  account: { name: string; index: number },
  trigger: NameLinkTrigger,
  log?: (kind: "info" | "error", text: string) => void,
  signal?: AbortSignal,
): Promise<NameLinkResult> {
  const trace = nameLinkTrace(trigger)
  try {
    return await link(host, account, trace, log, signal)
  } catch (error) {
    trace.threw(error)
    throw error
  }
}

/** The name the app stored for the worker (lib/host/identity.ts), or null. */
async function storedName(host: WorkerHost): Promise<string | null> {
  const stored = await host.storage.readJSON<unknown>(PLAYER_NAME_KEY).catch(() => null)
  return typeof stored === "string" && stored.trim() ? stored.trim() : null
}

async function link(
  host: WorkerHost,
  account: { name: string; index: number },
  trace: ReturnType<typeof nameLinkTrace>,
  log?: (kind: "info" | "error", text: string) => void,
  signal?: AbortSignal,
): Promise<NameLinkResult> {
  const say = (text: string) => log?.("info", `Name link: ${text}`)
  const skip = (why: string): NameLinkResult => {
    say(`skipped: ${why}`)
    trace.skipped(why)
    return "skipped"
  }
  const signAsRoot = host.accounts.signAsRoot
  if (!signAsRoot) return skip("no-root-signing")
  const username = (await host.accounts.userName?.().catch(() => null)) || (await storedName(host))
  if (!username) return skip("no-username")
  const [people, assetHub, publicKey, signer] = await Promise.all([
    connect(host),
    connectAssetHub(host),
    host.productAccount(account.name, account.index).catch(() => null),
    host.accounts.signer(account.name, account.index, { txExtVersion: 1 }).catch(() => null),
  ])
  if (!people || !assetHub) return skip("no-chain")
  if (!publicKey || !signer) return skip("no-account")
  const outcome = await linkName({
    product: productAccount(),
    account: publicKey,
    username,
    assetHub,
    people: people.client,
    signer,
    signAsRoot: async (name, message) => {
      const root = await usernameOwner(people.client, name)
      if (!root) throw new Error(`no account owns ${name}`)
      return { root, signature: await signAsRoot(root, message) }
    },
    allowance: host.accounts.pgasAllowance ? () => host.accounts.pgasAllowance!(account.index) : undefined,
    // the gate's deadline: no further step once the link ran out of time
    signal,
    log: (message, data, level) => {
      say(data ? `${message} ${JSON.stringify(data)}` : message)
      if (level === "warn") trace.warned(message, data?.detail)
    },
    onStage: trace.stage,
    onFacts: trace.facts,
  })
  trace.end(outcome)
  return outcome
}
