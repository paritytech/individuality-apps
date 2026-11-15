// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Reads the chest through `@parity/product-sdk-nfts`.
 *
 * The chest is which claims a player holds, what each one would mint in every
 * collection it can claim from, and the verified art of those items.
 *
 * Those collections are the ones `getApprovedCollections` approves for the
 * network this build targets, as the Stash picks them. An id names a
 * collection on one Asset Hub only, but the network cannot come from the
 * genesis of that chain: Previewnet's changes on every reset, so no table
 * can name it. Local builds instead require an explicit approval list, then
 * apply the same on-chain claimability reads.
 *
 * Every read shares one Asset Hub block, the one `getClaims` pinned, so the
 * state of a claim and the collections offered for it describe one chain
 * state.
 *
 * Items carry no name of their own. Every item of a collection is named after
 * the collection, and what tells a hare from an allosaurus is the `archetype`
 * attribute. So the archetype is the display name of an item, and the
 * collection name is the label it is offered under.
 *
 * The hash of a claim picks the collection it is shown in from the approved
 * claimable collections in ascending id, as the Stash does, so the chest and
 * the Stash show the same item. When that collection cannot mint the claim or
 * could not be read, the claim is dealt among the collections it can mint in
 * instead, and `withPicks` lays a saved pick over either.
 */
import type {
  ClaimableCollection,
  CollectionItem,
  Claim,
  FinalizedSnapshot,
  MintPreview,
  NftsChain,
  NftsCreditsChain,
} from "@parity/product-sdk-nfts"
import { localNetwork, networkName } from "@jollity/protocol"
import { defaultCollectionFor } from "./picks"
import { effectiveRarities, rarerThanCommonest, rarityName } from "./rarity"

/** The People and Asset Hub reads that `@parity/product-sdk-nfts` takes. */
export type ScarcityChain = NftsChain & NftsCreditsChain

/** A line about a part of the chest that was left out or read again. */
export type ChestLog = (message: string, context?: Record<string, unknown>) => void

export type ChestRarity = "rare" | "common"

/** One way a claim can be minted: the item it would give in one collection. */
export interface ChestChoice {
  collectionId: number
  collection: string
  name: string
  /** The collection-defined rarity name, preserving its spelling. */
  tier?: string
  rarity: ChestRarity
  image: string
}

export interface ChestItem {
  hash: string
  /** Holds the sibling hashes a mint presents, and is null until the award block has a root. */
  proof: string[] | null
  state: "earned" | "claimable" | "claimed"
  name: string
  /** The collection-defined rarity name, preserving its spelling. */
  tier?: string
  rarity: ChestRarity
  image: string
  collection: string
  /** View provenance; Scarcity-owned picks are read-only in Jollity. */
  selectionSource?: "stash" | "jollity"
  /** Lists every collection this claim can be minted in, the shown one first. */
  choices: ChestChoice[]
}

export interface ChestView {
  gameIndex: number | null
  /** Decides the colourway of the trunk, which is the same for one player and one game on every device. */
  seed: string
  items: ChestItem[]
  /** Counts the award blocks whose claims the chain no longer holds. */
  unprovable: number
  /** Counts claims awarded but not yet mintable, because their tree has not reached Asset Hub. */
  pending: number
  /** Counts claims already minted, which live in the Pocket rather than the chest. */
  claimed: number
  /** Says why the chest could not be read, when it could not. */
  failed?: string
  /** The game shown is the last one the player attended (so an empty chest
   *  means no attestations, not absence). Set by the doorway. */
  attended?: boolean
  /** `Game.Players(player).sent_report`: false is a player the chain knows
   *  with no report; undefined is no row to read. Set by the doorway. */
  reportSent?: boolean
  /** Is set when a claim or collection could not be read, so the chest shows less than it holds. */
  partial?: boolean
  /** The game had not settled when this was read: it holds the credits co-players' votes
   *  awarded with their reports, and an attendee's other credits come at the settle. Set by
   *  the doorway. */
  settling?: boolean
}

export class ChestReadError extends Error {}

export interface ReadChestOptions {
  /**
   * Turns the manifest CID an item names into the image the caller shows.
   *
   * The app answers a blob URL of the verified art, and the chat worker the
   * CID of the thumbnail, which its host fetches itself. An empty string means
   * the art could not be read.
   */
  loadArt: (manifestCid: string) => Promise<string>
  log?: ChestLog
  /**
   * The viewed game is the latest the player attended.
   *
   * A claim has no game until its award block has a root, and the newest
   * awards are exactly those, so only the latest game may claim them.
   */
  latestGame?: boolean
  /**
   * Claims the caller already shows, by hash: left out of `items`, and not
   * previewed again. A chest read again while its game is still in reporting
   * then costs one claims query when nothing new has come.
   */
  except?: ReadonlySet<string>
}

function titleCase(fragment: string): string {
  return fragment.replace(/[-_]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase())
}

type ItemTable = Map<string, CollectionItem>

/** A dropped block is retried whole by `readChestPinned`, so it is never swallowed as a part. */
const unpinned = (message: string) => /not pinned/i.test(message)

async function readCollections(
  chain: ScarcityChain,
  at: FinalizedSnapshot,
): Promise<ClaimableCollection[]> {
  const nfts = await import("@parity/product-sdk-nfts")
  const network = networkName()
  const approved = new Set(localNetwork()?.approvedCollections ?? nfts.getApprovedCollections(network))
  if (approved.size === 0) throw new ChestReadError(`no approved collections on ${network}`)
  const collections: ClaimableCollection[] = []
  let fromId: number | undefined
  for (;;) {
    const result = await nfts.getClaimableCollections(chain, fromId === undefined ? { at } : { at, fromId })
    if (!result.ok) throw new ChestReadError(`collections: ${result.error.message}`)
    collections.push(...result.value.collections.filter((collection) => approved.has(collection.id)))
    if (result.value.nextId === null) break
    fromId = result.value.nextId
  }
  return collections.sort((a, b) => a.id - b.id)
}

async function readItems(
  chain: ScarcityChain,
  collections: ClaimableCollection[],
  at: FinalizedSnapshot,
  log: ChestLog,
): Promise<{ table: ItemTable; readable: ClaimableCollection[] }> {
  const nfts = await import("@parity/product-sdk-nfts")
  const table: ItemTable = new Map()
  const read = new Set<ClaimableCollection>()
  await Promise.all(
    collections.map(async (collection) => {
      let fromId: number | undefined
      const found: CollectionItem[] = []
      for (;;) {
        const options = fromId === undefined ? { at, attributes: true } : { at, attributes: true, fromId }
        const result = await nfts.getCollectionItems(chain, collection.id, options)
        if (!result.ok) {
          const message = `collection ${collection.id}: ${result.error.message}`
          if (unpinned(message)) throw new ChestReadError(message)
          log("collection unreadable, left out", { collection: collection.id, detail: message })
          return
        }
        if (result.value.tag !== "Found") return
        found.push(...result.value.collection.items)
        if (result.value.nextId === null) break
        fromId = result.value.nextId
      }
      read.add(collection)
      for (const item of found) table.set(`${collection.id}:${item.index}`, item)
    }),
  )
  // registry order rather than arrival order, so every device shows a claim as the same collectable
  return { table, readable: collections.filter((collection) => read.has(collection)) }
}

async function choiceOf(
  preview: MintPreview,
  collections: ClaimableCollection[],
  items: ItemTable,
  loadArt: ReadChestOptions["loadArt"],
): Promise<ChestChoice | null> {
  if (preview.outcome.tag !== "Mints") return null
  const collection = collections.find((c) => c.id === preview.collection)
  const item = items.get(`${preview.collection}:${preview.outcome.item}`)
  const label = collection?.name ?? preview.outcome.name ?? `Collection ${preview.collection}`
  const archetype = item?.attributes?.archetype
  const manifest = item?.attributes?.manifest
  const rarities = effectiveRarities(item?.attributes?.rarities)
  const tier = rarityName(item?.rarity ?? preview.outcome.rarity, rarities)
  return {
    collectionId: preview.collection,
    collection: label,
    name: archetype ? titleCase(archetype) : label,
    tier,
    rarity: rarerThanCommonest(tier, rarities) ? "rare" : "common",
    image: manifest ? await loadArt(manifest) : "",
  }
}

/**
 * Reads the chest again when the node let go of the block it pinned.
 *
 * The SDK pins one finalized block per read, and a host provider can drop it
 * before the read finishes. Its guidance is to read again on a fresh block.
 */
export async function readChestPinned(
  chain: ScarcityChain,
  account: string,
  gameIndex: number | null,
  options: ReadChestOptions,
  attempts = 3,
): Promise<Omit<ChestView, "seed">> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readChest(chain, account, gameIndex, options)
    } catch (error) {
      const retry = error instanceof ChestReadError && unpinned(error.message)
      if (!retry || attempt >= attempts) throw error
      options.log?.("pinned block dropped, reading again", { attempt })
    }
  }
}

/**
 * The chest for one account and, when given, one game.
 *
 * A failure that leaves nothing to show throws a `ChestReadError`, so the page
 * can tell "could not read" from "you earned nothing". A single collection or
 * preview that fails drops only that part.
 */
export async function readChest(
  chain: ScarcityChain,
  account: string,
  gameIndex: number | null,
  options: ReadChestOptions,
): Promise<Omit<ChestView, "seed">> {
  const nfts = await import("@parity/product-sdk-nfts")
  const log: ChestLog = options.log ?? (() => {})

  // A chest read follows a best-block watch. Finality trails it by two or three
  // blocks, so a finalized People read held no claims yet and the chest opened
  // empty, then filled 20 to 40 seconds later.
  const claims = await nfts.getClaims(chain, {
    claimant: { tag: "Account", address: account },
    individualityAt: "best",
  })
  if (!claims.ok) throw new ChestReadError(`claims: ${claims.error.message}`)
  const at = claims.value.at.assetHub
  const inGame = (claim: Claim) =>
    gameIndex === null ||
    claim.gameIndex === gameIndex ||
    (claim.gameIndex === null && options.latestGame === true)
  const mine = claims.value.claims.filter(inGame)
  // an unprovable claim always carries a null hash, so the hash alone decides
  const held = mine.filter(
    (claim): claim is Claim & { hash: string; state: ChestItem["state"] } =>
      claim.hash !== null && claim.state !== "claimed",
  )
  const view: Omit<ChestView, "seed"> = {
    gameIndex,
    items: [],
    unprovable: mine.filter((claim) => claim.state === "unprovable").length,
    pending: mine.filter((claim) => claim.state === "earned" && claim.hash === null).length,
    claimed: mine.filter((claim) => claim.state === "claimed").length,
  }
  const except = options.except
  const fresh = except ? held.filter((claim) => !except.has(claim.hash)) : held
  if (fresh.length === 0) return view

  const collections = await readCollections(chain, at)
  if (collections.length === 0) throw new ChestReadError("no claimable collections")
  const { table: items, readable } = await readItems(chain, collections, at, log)
  if (readable.length === 0) throw new ChestReadError("no collection could be read")
  const offeredIds = collections.map((collection) => collection.id)

  const failures: string[] = []
  const offered = await Promise.all(
    fresh.map(async (claim) => {
      const preview = await nfts.previewClaim(chain, {
        credit: claim.hash,
        collections: readable.map((c) => c.id),
        at,
      })
      if (!preview.ok) {
        const message = `preview ${claim.hash}: ${preview.error.message}`
        if (unpinned(message)) throw new ChestReadError(message)
        failures.push(message)
        log("claim preview refused, left out", { detail: message })
        return null
      }
      const candidates = (
        await Promise.all(preview.value.previews.map((p) => choiceOf(p, readable, items, options.loadArt)))
      )
        .filter((choice): choice is ChestChoice => choice !== null)
        .sort((a, b) => a.collectionId - b.collectionId)
      return { claim, candidates }
    }),
  )
  view.items = offered.flatMap((entry): ChestItem[] => {
    if (!entry) return []
    const { claim, candidates } = entry
    const mintable = candidates.map((choice) => choice.collectionId)
    const choiceIn = (id: number | undefined) => candidates.find((choice) => choice.collectionId === id)
    const shown = choiceIn(defaultCollectionFor(claim.hash, offeredIds)) ?? choiceIn(defaultCollectionFor(claim.hash, mintable))
    const choices = shown ? [shown, ...candidates.filter((choice) => choice !== shown)] : candidates
    return [{
      hash: claim.hash,
      proof: claim.proof,
      state: claim.state,
      name: shown?.name ?? "Unknown",
      tier: shown?.tier,
      rarity: shown?.rarity ?? "common",
      image: shown?.image ?? "",
      collection: shown?.collection ?? "",
      choices,
    }]
  })
  view.partial = failures.length > 0 || readable.length < collections.length
  if (view.items.length === 0 && failures.length > 0) throw new ChestReadError(failures[0]!)
  return view
}
