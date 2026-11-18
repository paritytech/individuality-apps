// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The Daily Dollar in the Jollity chat: Humanity's prize draws, taken over
 * from Humanity's own chat worker.
 *
 * The draws are `PeopleAirdrops` on the People chain, entered under the
 * person's airdrop alias by Humanity's airdrop account (`peopl` at index 1).
 * Humanity's manifest grants this product `context`, so the host hands the
 * worker that account's key and signer, and the worker registers as Humanity
 * would. The chain reads and the register calls come from
 * `@parity/product-sdk-individuality`; what to do with them - which draws to
 * enter, which pushes to book, what to say in the room - is the registry and
 * sweep ported from Humanity under ./registry and ./sweep, unchanged.
 *
 * Three limits, each by design for now:
 *   - The worker never binds the alias: `People.set_alias_account` is
 *     Humanity's, made when the person opens it, so until then the person is
 *     treated as outside the membership ring and not registered. A ring that moved on
 *     since the binding is renewed here, with a proof by the personhood key.
 *   - The registry lives in this product's storage. Humanity's app keeps its
 *     own and still registers while it is open, so each keeps its own record.
 *   - The scratch happens in Humanity. Its registry is read, best effort, for
 *     the reveal stamp, so the room can say how a ticket went; without that
 *     read the room only invites.
 */
import { AccountId } from "polkadot-api"
import {
  PERSONHOOD_CONTEXT_INDEX,
  peopleAirdropsRegisterCalls,
  peopleRing,
  readPeopleAirdropsSigning,
  readPeopleAirdropsStanding,
  withAsPerson,
  type AsPersonInfo,
  type CreateRingVRFProof,
  type PeopleAirdropsChain,
  type PeopleAirdropsRegisterChain,
  type PeopleAirdropsSigning,
  type PeopleAirdropsStanding,
} from "@parity/product-sdk-individuality"
import type { AirdropStanding, Hex32, TickResult } from "@individuality/daily-dollar"
import { dailyDollarScratchStore } from "@individuality/shared-records"
import { bindTx, type SubmittableTx } from "@jollity/game-chain"
import { chainGenesis, personhoodProduct } from "@jollity/protocol"
import type { People } from "../chain"
import type { ActionListener, RenderNode as WireNode, Unsubscribe, WorkerHost } from "../host"
import { artWellFor } from "../host-art-well"
import { decPayload, encPayload, toWire } from "../renderer"
import { CallDeadlineError, ROOM_ID, readJSON, tryWriteJSON, within } from "../state"
import { MESSAGE_DAILY_DOLLAR } from "../card"
import { dailyDollarTree, type TicketClosed } from "./cards"
import { DAILY_DOLLAR_CHAT_COPY, DAILY_DOLLAR_COPY } from "./copy"
import { loggerFor } from "./log"
import {
  applyChatSent,
  applyRegistrationResult,
  applyRegistrationSubmitted,
  applyScratched,
  applyTick,
  DEFAULT_REGISTRY_PLAN_CONFIG,
  OPEN_CARD_ACTION_ID,
  planChatMessages,
  sanitizeRegistry,
  type ChatLine,
  type DailyDollarCard,
  type DailyDollarRegistry,
  type DrawRecord,
} from "./registry"
import { runDailyDollarSweep, type RegisterDrawsResult, type SweepNotifications } from "./sweep"

const logger = loggerFor("daily-dollar")

/** Humanity's airdrop account: `AIRDROP_ACCOUNT_INDEX` in packages/humanity-shared/src/airdrops/chain/airdrop-account.ts. */
const DAILY_DOLLAR_ACCOUNT_INDEX = 1
/** How often the Daily Dollar sweeps, the cadence of Humanity's worker. */
export const DAILY_DOLLAR_TICK_MS = 60_000
/** The custom message a Daily Dollar line with a button is posted as. */
export { MESSAGE_DAILY_DOLLAR }
/** This product's registry for one account, the shape Humanity keeps under `daily-dollar:<account>`. */
export const REGISTRY_KEY_PREFIX = "jollity.dd.registry:"
/** Humanity's own registry, in its host storage, for the reveal stamp of a scratch. */
export const HUMANITY_REGISTRY_KEY_PREFIX = "humanity:daily-dollar:"
/** Signing waits the whole signing prompt and finality; Humanity gives 60 s and 120 s. */
const REGISTER_DEADLINE_MS = 180_000
const STANDING_DEADLINE_MS = 30_000
/** How often a drawn ticket checks whether it has been scratched or has shut. */
const TICKET_RECHECK_MS = 30_000
/** A ticket whose draw has left the registry shuts a day after it, as draws do. */
const CLAIM_WINDOW_SECONDS = 86_400

type DrawChain = PeopleAirdropsChain & PeopleAirdropsRegisterChain<SubmittableTx>

/** Humanity's card in Pocket, opened at the root of its page: the app's own
 *  Pocket route (trinity#1542). The old `https://<product>/-/pocket/open` form
 *  now opens a route inside the product's page and draws nothing. */
export function humanityPocketLink(): string {
  const query = new URLSearchParams({ product: personhoodProduct(), card: "humanity" })
  return `polkadotapp://pocket/open?${query.toString()}`
}

/** Humanity's card in Pocket with the scratch opened: `open=scratch` tells
 *  Humanity's page to open the ticket. A host that does not pass the extra
 *  parameter on to the page opens the card at its root instead. */
export function scratchLink(): string {
  return `${humanityPocketLink()}&open=scratch`
}

/** The SDK's standing in the shape the ported registry plans over. */
function toAirdropStanding(standing: PeopleAirdropsStanding): AirdropStanding {
  const { binding, airdropsContext } = standing.alias
  return {
    accountAddress: standing.account,
    alias: binding.tag === "Bound" ? (binding.alias as Hex32) : null,
    airdropsContext: airdropsContext as Hex32,
    aliasContext:
      binding.tag === "Bound" ? (airdropsContext as Hex32) : binding.tag === "OtherContext" ? (binding.context as Hex32) : null,
    contextMatches: binding.tag === "Bound",
    atBlockHash: standing.at.blockHash as Hex32,
    participations: standing.draws.map(({ drawIndex, event, slot, registered, won }) => ({
      draw: {
        eventId: event.eventId as Hex32,
        drawIndex,
        status: event.status,
        registrationStartsSeconds: event.registrationStarts,
        drawTimeSeconds: event.drawTime,
        endTimeSeconds: event.endTime,
        prizeAmount: event.prize.assetAmount,
        assetId: event.prize.assetId,
        maxWinners: event.prize.maxWinners,
        totalParticipants: event.totalParticipants,
        effectiveWinners: event.effectiveWinners,
        claimed: event.claimed,
      },
      slot: slot as Hex32 | null,
      registered,
      winner: won,
      claimed: null,
    })),
  }
}

const WAITING_ON_HUMANITY: Record<Exclude<PeopleAirdropsSigning["tag"], "Bound" | "Revised">, string> = {
  Unbound: "no airdrop alias is bound yet; Humanity binds it when the person opens it",
  OtherContext: "the airdrop account is bound under another context",
  RingUnavailable: "the alias's ring has no root on chain",
}

export interface DailyDollarDeps {
  host: WorkerHost
  connect(): Promise<People | null>
  /** Seconds since the epoch. */
  now(): number
}

export interface DailyDollar {
  tick(): Promise<TickResult>
  /** Draws a Daily Dollar line with buttons, and opens the scratch when one is pressed. */
  render(payload: Uint8Array, send: (node: WireNode) => void, onAction: (cb: ActionListener) => Unsubscribe): Unsubscribe
}

export function createDailyDollar({ host, connect, now }: DailyDollarDeps): DailyDollar {
  let address: string | null = null
  let ticking = false
  let notifications: Promise<SweepNotifications | null> | null = null
  // One registry write at a time, so a sweep's commit never overwrites a chat mark.
  let writes: Promise<unknown> = Promise.resolve()
  /** Ring standing as of the last read that answered, so a tick whose read
   *  failed neither registers a non-member nor stalls a member. */
  let inMembershipRing = false

  async function account(): Promise<string | null> {
    if (address) return address
    const key = await host.productAccount(personhoodProduct(), DAILY_DOLLAR_ACCOUNT_INDEX)
    address = key ? AccountId().dec(key) : null
    return address
  }

  async function readRegistry(owner: string): Promise<DailyDollarRegistry> {
    const raw = await readJSON<unknown>(host, `${REGISTRY_KEY_PREFIX}${owner}`)
    // A read that failed is not an empty registry: planning over one would book every push again.
    if (raw === undefined) throw new Error("the Daily Dollar registry could not be read")
    return sanitizeRegistry(raw, owner)
  }

  function updateRegistry(owner: string, update: (current: DailyDollarRegistry) => DailyDollarRegistry): Promise<DailyDollarRegistry> {
    const next = writes.then(async () => {
      const updated = update(await readRegistry(owner))
      if (!(await tryWriteJSON(host, `${REGISTRY_KEY_PREFIX}${owner}`, updated))) {
        throw new Error("the Daily Dollar registry could not be written")
      }
      return updated
    })
    writes = next.catch(() => undefined)
    return next
  }

  /**
   * The origin for an alias whose ring moved on since it was bound: the same
   * alias, proven afresh with the personhood key in the airdrops context, as
   * Humanity's `ensureAirdropAlias` does. The host serves the `peopl` key to
   * this product under Humanity's `context` grant; the host's personhood
   * keys (`personhood()`) find and use a key in whichever ring they are given.
   */
  async function revisedOrigin(): Promise<AsPersonInfo | null> {
    const genesis = (await host.peopleGenesis()) ?? chainGenesis("people")
    if (!genesis) return null
    const ring = { key: "full" as const, owner: personhoodProduct(), ring: peopleRing(genesis) }
    const keys = host.accounts.personhood()
    if (!(await keys.holds(ring))) return null
    const context = { productId: personhoodProduct(), suffix: { tag: "Index" as const, value: PERSONHOOD_CONTEXT_INDEX.peopleAirdrops } }
    const createProof: CreateRingVRFProof = (message) => keys.prove(ring, context, message)
    return { tag: "AliasWithAccountRevised", createProof }
  }

  /**
   * Whether this person can register at all: their airdrop alias is proven in
   * the current `people` ring, or their personhood key is still in it to renew
   * the alias. Humanity's worker gates the same way on its card's
   * `inMembershipRing`. Anyone else - not a member yet, or no alias bound -
   * would only fail every open draw on backoff and fill the logs, so they are
   * not tried. `null` when the chain could not say.
   */
  async function readInMembershipRing(people: People, owner: string): Promise<boolean | null> {
    const signing = await readPeopleAirdropsSigning(people.chain as unknown as DrawChain, { account: owner })
    if (!signing.ok) return null
    if (signing.value.tag === "Bound") return true
    if (signing.value.tag !== "Revised") return false
    return (await revisedOrigin()) != null
  }

  /**
   * Registers and records each outcome in the registry, as Humanity's
   * `registerForDraws` does: the sweep plans its retries off those records.
   */
  async function registerForDraws(eventIds: Hex32[]): Promise<RegisterDrawsResult> {
    const owner = await account()
    if (!owner) return [{ eventIds, status: "failed", error: new Error("the host handed over no airdrop account") }]
    const results = await submitRegistrations(owner, eventIds)
    for (const { eventIds: ids, status, txHash, error } of results) {
      const outcome = {
        status,
        ...(txHash == null ? {} : { txHash }),
        ...(error == null ? {} : { error: error instanceof Error ? error.message : String(error) }),
      }
      await updateRegistry(owner, (current) =>
        applyRegistrationResult(current, ids, outcome, "worker", now(), DEFAULT_REGISTRY_PLAN_CONFIG),
      ).catch((writeError: unknown) => logger.warning("registration result not recorded: {error}", { error: writeError }))
    }
    return results
  }

  async function submitRegistrations(owner: string, eventIds: Hex32[]): Promise<RegisterDrawsResult> {
    const failed = (error: unknown): RegisterDrawsResult => [{ eventIds, status: "failed", error }]
    const people = await connect()
    if (!people) return failed(new Error("the People chain is unavailable"))
    const chain = people.chain as unknown as DrawChain
    const signing = await readPeopleAirdropsSigning(chain, { account: owner })
    if (!signing.ok) return failed(signing.error)
    const plan = signing.value
    if (plan.tag !== "Bound" && plan.tag !== "Revised") return failed(new Error(WAITING_ON_HUMANITY[plan.tag]))
    const signer = await host.accounts.signer(personhoodProduct(), DAILY_DOLLAR_ACCOUNT_INDEX)
    if (!signer) return failed(new Error("the host handed over no signer for the airdrop account"))
    const origin = plan.tag === "Bound" ? ({ tag: "AliasWithAccount" } as const) : await revisedOrigin()
    if (!origin) return failed(new Error("this host holds no personhood key in the people ring to renew the alias with"))
    const calls = await peopleAirdropsRegisterCalls(chain, eventIds)
    if (!calls.ok) return failed(calls.error)

    const asPerson = withAsPerson(signer, origin)
    const results: RegisterDrawsResult = []
    for (const call of calls.value) {
      const ids = call.eventIds as Hex32[]
      // `submitted` is the interlock that keeps a slow finality from being registered twice.
      await updateRegistry(owner, (current) => applyRegistrationSubmitted(current, ids, "worker", now())).catch(() => undefined)
      try {
        const outcome = (await within(bindTx(call.tx, asPerson).createAndSubmit(), REGISTER_DEADLINE_MS)) as {
          ok: boolean
          txHash: string
          dispatchError?: unknown
        }
        results.push(
          outcome.ok
            ? { eventIds: ids, status: "finalized", txHash: outcome.txHash }
            : {
                eventIds: ids,
                status: "failed",
                txHash: outcome.txHash,
                error: new Error(`register failed on chain: ${JSON.stringify(outcome.dispatchError)}`),
              },
        )
      } catch (error) {
        // Past the deadline the call may still land; the next standing read tells.
        results.push({ eventIds: ids, status: error instanceof CallDeadlineError ? "unknown" : "failed", error })
      }
    }
    return results
  }

  function sweepNotifications(): Promise<SweepNotifications | null> {
    notifications ??= Promise.resolve({
      push: ({ text: body, deeplink, scheduledAtMs }) =>
        host.notifications.push({
          text: body,
          ...(deeplink == null ? {} : { deeplink }),
          ...(scheduledAtMs == null ? {} : { scheduledAt: Math.trunc(scheduledAtMs) }),
        }),
      cancel: (id) => host.notifications.cancel(id),
    })
    return notifications
  }

  const humanityScratches = dailyDollarScratchStore(async () => ({
    readJSON: (key) => within(host.storage.readProductJSON<unknown>(personhoodProduct(), key)),
  }))

  /** Copies Humanity's reveal stamps into this registry. Best effort: a refused read leaves it as it was. */
  async function mergeScratches(owner: string): Promise<void> {
    const raw = await host.storage
      .readProductJSON<unknown>(personhoodProduct(), `${HUMANITY_REGISTRY_KEY_PREFIX}${owner}`)
      .catch((error: unknown) => {
        logger.debug("Humanity's registry is unreadable: {error}", { error })
        return null
      })
    if (raw == null) return
    const theirs = sanitizeRegistry(raw, owner)
    const scratched = Object.values(theirs.draws).filter((record) => record.scratchedAtSeconds != null)
    if (scratched.length === 0) return
    await updateRegistry(owner, (current) =>
      scratched.reduce((registry, record) => applyScratched(registry, record.eventId, record.scratchedAtSeconds!), current),
    )
  }

  async function post({ text, buttons, card }: ChatLine): Promise<void> {
    // Every line is a card; its words are what the chats list shows for it.
    await within(host.chat.postMessage(ROOM_ID, MESSAGE_DAILY_DOLLAR, encPayload({ text, buttons, card }), text))
  }

  /** Why a ticket can no longer be scratched (scratched already, or its claim
   *  window shut), or null while it still can. Humanity's reveal stamps are
   *  merged first, so a scratch greys the button within one recheck. */
  async function ticketClosed(card: DailyDollarCard): Promise<TicketClosed | null> {
    let record: DrawRecord | undefined
    const owner = await account().catch(() => null)
    if (owner) {
      await mergeScratches(owner).catch(() => undefined)
      record = (await readRegistry(owner).catch(() => null))?.draws[card.eventId]
    }
    if (record?.scratchedAtSeconds != null) return "scratched"
    const scratchedInHumanity = await humanityScratches.scratchedAt(card.eventId).catch((error: unknown) => {
      logger.debug("Humanity's scratch record is unreadable: {error}", { error })
      return null
    })
    if (scratchedInHumanity != null) return "scratched"
    return now() >= (record?.endTimeSeconds ?? card.drawTimeSeconds + CLAIM_WINDOW_SECONDS) ? "expired" : null
  }

  async function chatPass(owner: string): Promise<void> {
    await mergeScratches(owner)
    const registry = await readRegistry(owner)
    const actions = planChatMessages(registry, now(), DAILY_DOLLAR_CHAT_COPY)
    if (actions.length === 0) return
    for (const action of actions) {
      await post(action)
      // A line posted and not marked goes out again on the next tick, which is the lesser harm.
      await updateRegistry(owner, (current) => applyChatSent(current, action.eventId, action.kind, now()))
    }
  }

  async function runTick(): Promise<TickResult> {
    const owner = await within(account()).catch(() => null)
    if (!owner) return "no-account"
    const people = await within(connect()).catch(() => null)
    if (!people) return "error"
    const standing = await within(
      readPeopleAirdropsStanding(people.chain as unknown as DrawChain, { account: owner }),
      STANDING_DEADLINE_MS,
    ).catch((error: unknown) => ({ ok: false as const, error }))
    if (!standing.ok) {
      const message = standing.error instanceof Error ? standing.error.message : String(standing.error)
      logger.error("standing read failed: {error}", { error: message })
      await updateRegistry(owner, (current) => applyTick(current, { atSeconds: now(), result: "error", error: message })).catch(
        () => undefined,
      )
      return "error"
    }
    const ring = await within(readInMembershipRing(people, owner)).catch(() => null)
    if (ring != null) inMembershipRing = ring
    if (!inMembershipRing) logger.debug("not in the membership ring; skipping airdrop registration")
    const { result } = await runDailyDollarSweep(
      {
        now,
        registerForDraws: inMembershipRing ? registerForDraws : null,
        notifications: sweepNotifications,
        readRegistry,
        updateRegistry,
        deeplink: scratchLink(),
        config: DEFAULT_REGISTRY_PLAN_CONFIG,
        copy: DAILY_DOLLAR_COPY,
        won: true,
      },
      owner,
      toAirdropStanding(standing.value),
    )
    if (result !== "error") {
      await chatPass(owner).catch((error: unknown) => logger.error("chat pass failed: {error}", { error }))
    }
    return result
  }

  return {
    async tick() {
      if (ticking) return "idle"
      ticking = true
      try {
        return await runTick()
      } catch (error) {
        logger.error("tick failed: {error}", { error })
        return "error"
      } finally {
        ticking = false
      }
    },
    render(payload, send, onAction) {
      let line: ChatLine
      try {
        line = decPayload<ChatLine>(payload)
      } catch {
        line = { text: "" }
      }
      const ticket = line.card?.kind === "ticket" ? line.card : null
      let closed: TicketClosed | null = null
      let disposed = false
      const well = artWellFor(host)
      const draw = (): void => send(toWire(dailyDollarTree(line, closed, well.current())))
      draw()
      const stopWatchingWell = well.onChange(draw)
      const recheck = (): void => {
        if (ticket == null || closed) return
        void ticketClosed(ticket).then((why) => {
          if (disposed || why == null || closed) return
          closed = why
          draw()
        })
      }
      recheck()
      const interval = ticket == null ? null : setInterval(recheck, TICKET_RECHECK_MS)
      const unsubscribe = onAction((actionId) => {
        if (actionId !== OPEN_CARD_ACTION_ID || closed) return
        void host.navigate(scratchLink()).then((opened) => {
          if (!opened) logger.warning("the scratch could not be opened")
        })
      })
      return () => {
        disposed = true
        stopWatchingWell()
        if (interval != null) clearInterval(interval)
        unsubscribe()
      }
    },
  }
}

