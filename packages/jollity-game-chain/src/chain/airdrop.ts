// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Reads the prize draws of a game, the `Airdrop` pallet side of the endgame, in
 * the shape the drum ceremony draws.
 *
 * A game can schedule **several** draws (`Game.Game.airdrops_scheduled`, each
 * with its own `draw_offset` / `claim_window` / prize). Each draw is an
 * `Airdrop` event whose id `gameAirdropEventId` in the SDK derives from the
 * game index and the airdrop index, so a client can address the draws of a
 * past game without having seen the `AirdropScheduled` events.
 *
 * The event itself comes from `readAirdropDraw` in the SDK, read at the best
 * block. What stays here is what only the drum needs: every ticket, every
 * winning ticket and the decimals of the prize asset, which no other product
 * reads. The claim check stays too, because it is per game
 * here and per draw in the SDK.
 *
 * ## Lifecycle (all transitions are driven by the offchain worker)
 *
 * `Scheduled → Registering → DrawWinners → Claiming → Clearing… → Finalizing`,
 * after which the event is removed from storage. `total_participants` and
 * `effective_winners` only exist from the state that first computes them, so
 * they are read defensively.
 *
 * A player enters at sign-up with one VRF per scheduled event, minted by
 * `mintAccountAirdropVrfs` in the SDK. A player who entered no VRFs has no
 * registration, and {@link fetchAirdropDraw} reports `ticket: null` for them,
 * correctly, not as a failure.
 */
import { Enum, type SS58String } from "polkadot-api"
import { fromHex } from "polkadot-api/utils"
import {
  fromPapi,
  gameAirdropEventId,
  readAirdropDraw,
  type AirdropStatusTag,
  type PlayerKey,
} from "@parity/product-sdk-individuality"
import type { PeopleApi, PeopleClient } from "./client"

const accountKey = (player: SS58String | PlayerKey): PlayerKey =>
  typeof player === "string" ? Enum("Account", player) : player

type AirdropQuery = PeopleApi["query"]["Airdrop"]

/** `Airdrop.Registrations` value — the registrant identity behind a ticket */
export type AirdropRegistrant = Awaited<
  ReturnType<AirdropQuery["Registrations"]["getValue"]>
>

/** `Assets.Metadata` for the prize asset — decimals/symbol to format the amount with */
export interface PrizeAssetMetadata {
  symbol: string
  name: string
  decimals: number
}

/** One prize draw of a game, as far as the chain can tell us */
export interface AirdropDraw {
  /** index within the game's `airdrops_scheduled` */
  airdropIndex: number
  eventId: string
  /** enum tag of `Airdrop.Events.status`, or `"gone"` once the event is removed */
  status: AirdropStatusTag | "gone"
  /** null once the event has been finalized and removed from storage */
  prize: {
    assetAmount: bigint
    maxWinners: number
    winnerCap: number
    /**
     * The prize asset's own `Assets.Metadata`, or null when the asset carries
     * none. **Not** the chain's native token: prizes are paid in a foreign
     * asset (an XCM `Location`), so formatting `assetAmount` with the chain's
     * `tokenDecimals` would be wrong. (iOS documents assuming the main asset's
     * precision here; this reads the real thing.)
     */
    asset: PrizeAssetMetadata | null
  } | null
  /** Unix **seconds** (u64 on chain, but `UnixTime::now().as_secs()`) */
  drawTime: number | null
  endTime: number | null
  registrationStarts: number | null
  /** `status.total_participants` where the state carries it, else the row count */
  totalEntries: number
  /** how many winners the draw actually picked, where the state carries it */
  effectiveWinners: number | null
  /** our 32-byte entropy slot, or null when we never entered (see module header) */
  ticket: string | null
  /** EVERY entry's slot (the `Airdrop.Registrations` keys), in storage order —
   *  which is ascending, the keys being `Identity`-hashed big-endian slots.
   *  Empty once the registrations are cleared after the claim window. This is
   *  what the wheel is drawn from. */
  tickets: string[]
  /** who holds each ticket, where the registrant is an account: slot → SS58.
   *  A tap on the wheel reads the holder's name (`@individuality/name-link`'s
   *  dotns-names.ts). */
  holders: Record<string, string>
  /** `Airdrop.EventEntropy`: where the draw cut the sorted tickets. The
   *  winners are the next `effectiveWinners` slots clockwise from it
   *  (`draw_winners_authorized`). Null until the entropy is captured. */
  target: string | null
  /** every winning ticket of this draw */
  winningTickets: string[]
  /** our ticket is among the winners — including a win already claimed,
   *  which `Airdrop.Winners` no longer lists (see `winnersOf`) */
  won: boolean
  /** we won and have claimed it: the claim removed our winner entry */
  claimed: boolean
}

/**
 * Does an `Airdrop` registrant entry refer to `player`?
 *
 * The two enums name the same thing differently: `Game`'s
 * `AccountOrPerson::{Account, Person}` vs `Airdrop`'s
 * `RegistrationEntry::{Account, Alias}`.
 */
function registrantMatches(
  registrant: AirdropRegistrant,
  player: PlayerKey,
): boolean {
  if (registrant === undefined) return false
  if (registrant.type === "Account" && player.type === "Account")
    return registrant.value.account_id === player.value
  if (registrant.type === "Alias" && player.type === "Person")
    return registrant.value.alias === player.value
  return false
}

/** `Vec<u8>` asset name / symbol (hex in papi) → text, empty when unset */
function decodeAsciiBytes(value: string | Uint8Array): string {
  const bytes =
    typeof value === "string" ? fromHex(value) : value
  return new TextDecoder().decode(bytes)
}

/**
 * THE WINNERS, INCLUDING ONES WHO HAVE CLAIMED.
 *
 * A claim removes the winner from `Airdrop.Winners` (`do_claim`:
 * `Winners::remove`) and only bumps the status's `claimed` count, so after a
 * claim the winners storage lists fewer than `effective_winners` — and a
 * winner who claimed reads as having lost. Seen on paseo: a player claimed
 * 10 CASH, and every read after it said nobody had won.
 *
 * The registrations and the target stay, so the draw can be re-run exactly:
 * the winners are the first `effective_winners` tickets clockwise from the
 * target (`draw_winners_authorized`; lib/draw/wheel/rule.ts checks the same
 * rule). When the storage lists them all it is used as it is; when it lists
 * fewer, the rule fills in the ones who claimed.
 */
function winnersOf(
  tickets: readonly string[],
  target: string | null,
  effective: number | null,
  listed: readonly string[],
): string[] {
  if (effective === null || listed.length >= effective || target === null || tickets.length === 0) return [...listed]
  const slot = (hex: string) => hex.replace(/^0x/i, "").toLowerCase()
  const sorted = tickets.map(slot).sort()
  const cut = slot(target)
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((sorted[mid] as string) >= cut) hi = mid
    else lo = mid + 1
  }
  const count = Math.min(effective, sorted.length)
  return Array.from({ length: count }, (_, i) => `0x${sorted[(lo + i) % sorted.length]}`)
}

/**
 * Read one prize draw of a game: the event, our ticket, and the winning
 * tickets.
 *
 * Returns a row with `status: "gone"` when the event is no longer in storage
 * (finalized and cleaned up, or never scheduled) — the caller can still show
 * "this draw is over" rather than nothing.
 */
export async function fetchAirdropDraw(
  { client, api }: PeopleClient,
  options: {
    gameIndex: number
    airdropIndex: number
    player: SS58String | PlayerKey
    /** Pass `Game.airdrop_event_id_base` to read the constant once across several draws. */
    eventIdBase?: string
  },
): Promise<AirdropDraw> {
  const player = accountKey(options.player)
  const base = options.eventIdBase ?? (await api.constants.Game.airdrop_event_id_base())
  const eventId = gameAirdropEventId({
    base,
    gameIndex: options.gameIndex,
    airdropIndex: options.airdropIndex,
  })

  const read = await readAirdropDraw(fromPapi(client, api), { eventId, at: "best" })
  if (!read.ok) throw read.error
  const { event, entropy, at } = read.value
  const [registrations, winners] = await Promise.all([
    api.query.Airdrop.Registrations.getEntries(eventId, { at: at.blockHash }),
    api.query.Airdrop.Winners.getEntries(eventId, { at: at.blockHash }),
  ])
  const tickets = registrations.map(({ keyArgs }) => keyArgs[1])
  const holders: Record<string, string> = {}
  for (const { keyArgs, value } of registrations) if (value?.type === "Account") holders[keyArgs[1]] = value.value.account_id
  const target = entropy

  const ticket =
    registrations.find(({ value }) => registrantMatches(value, player))
      ?.keyArgs[1] ?? null
  const listedWinners = winners.map(({ value }) => value)
  const listedWon = winners.some(({ keyArgs }) => registrantMatches(keyArgs[1], player))
  const winningTickets = winnersOf(
    tickets,
    target,
    event === null ? null : event.effectiveWinners,
    listedWinners,
  )
  const same = (a: string, b: string) => a.replace(/^0x/i, "").toLowerCase() === b.replace(/^0x/i, "").toLowerCase()
  // a win the storage no longer lists is a claimed one
  const claimed = !listedWon && ticket !== null && winningTickets.some((slot) => same(slot, ticket))
  const won = listedWon || claimed

  if (event === null) {
    return {
      airdropIndex: options.airdropIndex,
      eventId,
      status: "gone",
      prize: null,
      drawTime: null,
      endTime: null,
      registrationStarts: null,
      totalEntries: registrations.length,
      effectiveWinners: null,
      ticket,
      tickets,
      holders,
      target,
      winningTickets,
      won,
      claimed,
    }
  }

  const metadata = await api.query.Assets.Metadata.getValue(
    event.prize.assetId as Parameters<PeopleApi["query"]["Assets"]["Metadata"]["getValue"]>[0],
    { at: at.blockHash },
  )
  // ValueQuery: an unregistered asset yields empty name/symbol and 0 decimals,
  // which is indistinguishable from "no metadata" — treat both as null.
  const symbol = decodeAsciiBytes(metadata.symbol)
  const asset: PrizeAssetMetadata | null =
    symbol === ""
      ? null
      : { symbol, name: decodeAsciiBytes(metadata.name), decimals: metadata.decimals }

  return {
    airdropIndex: options.airdropIndex,
    eventId,
    status: event.status,
    prize: {
      assetAmount: event.prize.assetAmount,
      maxWinners: event.prize.maxWinners,
      winnerCap: event.prize.winnerCapPermill,
      asset,
    },
    drawTime: event.drawTime,
    endTime: event.endTime,
    registrationStarts: event.registrationStarts,
    totalEntries: event.totalParticipants ?? registrations.length,
    effectiveWinners: event.effectiveWinners,
    ticket,
    tickets,
    holders,
    target,
    winningTickets,
    won,
    claimed,
  }
}

/**
 * Every prize draw of a game, in airdrop-index order.
 *
 * `airdropsScheduled` comes from `Game.Game.airdrops_scheduled` while the game
 * is current. It is unknowable once the game is gone, so a caller that did not
 * capture it can omit the count: we then probe indices upwards and stop at the
 * first one with neither an event nor any registrations.
 */
export async function fetchAirdropDraws(
  people: PeopleClient,
  options: {
    gameIndex: number
    player: SS58String | PlayerKey
    airdropsScheduled?: number
    /** cap when probing (`airdropsScheduled` omitted) */
    probeLimit?: number
  },
): Promise<AirdropDraw[]> {
  const base = await people.api.constants.Game.airdrop_event_id_base()
  const shared = { gameIndex: options.gameIndex, player: options.player, eventIdBase: base }

  if (options.airdropsScheduled !== undefined) {
    return Promise.all(
      Array.from({ length: options.airdropsScheduled }, (_, airdropIndex) =>
        fetchAirdropDraw(people, { ...shared, airdropIndex }),
      ),
    )
  }

  const draws: AirdropDraw[] = []
  const limit = options.probeLimit ?? 4
  for (let airdropIndex = 0; airdropIndex < limit; airdropIndex++) {
    const draw = await fetchAirdropDraw(people, { ...shared, airdropIndex })
    // Nothing on chain and nobody registered ⇒ this index was never scheduled.
    if (draw.status === "gone" && draw.totalEntries === 0) break
    draws.push(draw)
  }
  return draws
}
