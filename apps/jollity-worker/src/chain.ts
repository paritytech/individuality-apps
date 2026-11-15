// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What the chat reads from the People chain, through
 * `@parity/product-sdk-individuality`, the same reads the app makes.
 *
 * The SDK takes a PAPI client and an API object. The app hands it the typed API
 * over `@parity/product-sdk-descriptors`, 20 MB that the worker bundle cannot
 * carry. The worker hands it the unsafe API of the same client instead, the
 * same runtime object without the types, and asserts the structural chain
 * types of the SDK over it once, in `connect`. `Assets.Metadata` for the prize
 * asset and `Timestamp.Now` for the chain clock are the only direct
 * polkadot-api reads here, and the SDK has no read for either yet. The SDK
 * pins these reads to the finalized block, so `atBestBlock` hands it the best
 * block in that place, which is where the app reads the game and the player.
 *
 * The player is the product account the app plays as, `productAccount()` at
 * `signupAccountIndex()` from @jollity/protocol, so the worker never waits for
 * the app to say who plays.
 */
import { AccountId, createClient, Enum, type PolkadotClient } from "polkadot-api"
import {
  confirmClaim,
  fromPapi,
  readCurrentGame,
  readPersonhoodState,
  readPrizeStatus,
  type AirdropDraw,
  type ClaimChain,
  type CurrentGameResult,
  type GameChain,
  type GamePhase,
  type GamePlayersChain,
  type IndividualityChain,
  type PrizeStatusChain,
} from "@parity/product-sdk-individuality"
import type { NftsChain, NftsCreditsChain } from "@parity/product-sdk-nfts"
import type { SlotCollectable, SlotPrize } from "./card"
import { chainGenesis, productAccount, signupAccountIndex, stashProduct } from "@jollity/protocol"
import {
  JOLLITY_PICKS_KEY,
  STASH_PICKS_KEY,
  manifestPicture,
  parseChestPicks,
  readChestPinned,
  withPicks,
} from "@jollity/collectables"
import { deriveAttendance, type AttendanceRow, type AttendanceView } from "@individuality/game-outcome"
import { readGameCredits } from "@individuality/game-outcome/chain"
import { CLAIM_RECOGNITIONS, prizeClaimEligibility, type ClaimStanding } from "@individuality/prize"
import { playEndsSeconds, registrationOpensSeconds } from "@individuality/shared-records"
import type { WorkerHost } from "./host"
import {
  CLOCK_OFFSET_KEY,
  CallDeadlineError,
  UNSEEN,
  readJSON,
  within,
  writeJSON,
  type SeenGame,
  type StorageHost,
  type StoredOutcome,
} from "./state"
import { chatCount, describeError } from "./telemetry"

/** The game in `Game.Game`, narrowed to what the cards need. Times are Unix seconds of the chain. */
export interface RunningGame {
  index: number
  phase: "registration" | "shuffle" | "reporting" | "settling" | "cancelled"
  /** A projection from the length of the registration phase, as on the schedule, since the chain stores no start for a game it created. */
  registrationStarts: number
  registrationEnds: number
  gamePlayTime: number
  /** When the last turn ends, from the rounds and the group cap of the game. */
  playEnds: number
  reportingEnds: number
  airdropsScheduled: number
  /** Null when the registration could not be read, which is not the same as unregistered. */
  registered: boolean | null
  /**
   * False while a prize draw of the game does not take entries yet, which is
   * when the native chat shows Opening soon. Null when the game has no draw or
   * the draws could not be read.
   */
  drawOpen: boolean | null
}

/** A game on the schedule that the chain has not created yet. */
export interface UpcomingGame {
  gamePlayTime: number
  /** A projection from the phase durations, not a stored boundary. */
  registrationStarts: number
  registrationEnds: number
  /** Projected the same way, which is when its settling starts, and the game after it is created once that settling ends. */
  reportingEnds: number
}

export interface ChainRead {
  running: RunningGame | null
  /** Chronological, so the first entry is the next game. */
  upcoming: UpcomingGame[]
  /** Chain clock minus device clock, in milliseconds. */
  clockOffsetMs: number
  /** Whether the player is a member, which a missed game pauses, or null when unread. */
  member: boolean | null
}

const PHASES: Record<GamePhase, RunningGame["phase"]> = {
  Registration: "registration",
  Shuffle: "shuffle",
  Reporting: "reporting",
  PlayerProcess: "settling",
  Cancelling: "cancelled",
}

// MembershipReady has reached personhood and waits for recognition, which
// Humanity's card already counts as a member (humanity-card-state.ts).
const MEMBER_STATES = new Set(["Member", "Caution", "MembershipReady"])

type UnsafeApi = ReturnType<PolkadotClient["getUnsafeApi"]>

/** Every chain shape of the SDK the reads below take. */
type SdkChain = GameChain & GamePlayersChain & IndividualityChain & PrizeStatusChain & ClaimChain

export interface People {
  client: PolkadotClient
  api: UnsafeApi
  chain: SdkChain
}

/**
 * The client as the SDK sees it, with the best block standing in for the finalized one.
 *
 * The app reads at the best block, as game-chain does, and shows a sign-up
 * there. Finality trails it by a few blocks, so a card reading at the finalized block keeps
 * offering Register after the app says Registered.
 *
 * The card can then flip with a reorg, exactly as the app does. An outcome the
 * worker stores once also comes from a block that is not final yet, and a fork
 * in the block or two after the game could leave a stale one behind.
 */
function atBestBlock(client: PolkadotClient) {
  return {
    // The best block comes first, and papi never lists fewer than one.
    getFinalizedBlock: async () => (await client.getBestBlocks())[0]!,
    getBestBlocks: () => client.getBestBlocks(),
    getChainSpecData: () => client.getChainSpecData(),
  }
}

/**
 * How long a connect may take. `host.chainProvider` makes a host round trip
 * with no deadline of its own, and a connect that never settles would stay
 * cached for the life of the worker, so it is given up on before the poll's
 * own deadline and asked again on the next call.
 */
export const CONNECT_DEADLINE_MS = 30_000

/**
 * One cached connect, retried on the next call once it fails or times out.
 * An attempt that answers after it was given up on builds nothing, so it can
 * neither leak a client nor replace a newer one.
 */
function cachedConnect<T>(chain: "people" | "asset-hub") {
  let cached: Promise<T | null> | undefined
  return async (build: (abandoned: () => boolean) => Promise<T | null>): Promise<T | null> => {
    if (!cached) {
      let abandoned = false
      cached = within(build(() => abandoned), CONNECT_DEADLINE_MS).catch((error) => {
        abandoned = true
        const reason = error instanceof CallDeadlineError ? "deadline" : "threw"
        chatCount("chat.chain.connect_failed", { chain, reason }, { key: `${chain}:${reason}`, once: true, detail: { error: describeError(error) } })
        return null
      })
    }
    const mine = cached
    const connected = await mine
    if (!connected && cached === mine) cached = undefined
    return connected
  }
}

const connectPeople = cachedConnect<People>("people")

/** One client for the life of the worker. A failed or hung connect is retried on the next call. */
export async function connect(host: WorkerHost): Promise<People | null> {
  return connectPeople(async (abandoned) => {
    const genesis = (await host.peopleGenesis()) ?? chainGenesis("people")
    if (!genesis) {
      chatCount("chat.chain.connect_failed", { chain: "people", reason: "no-genesis" }, { key: "people:no-genesis", once: true })
      return null
    }
    const provider = await host.chainProvider(genesis)
    if (!provider || abandoned()) {
      if (!abandoned()) chatCount("chat.chain.connect_failed", { chain: "people", reason: "no-provider" }, { key: "people:no-provider", once: true })
      return null
    }
    const client = createClient(provider)
    const api = client.getUnsafeApi()
    return { client, api, chain: fromPapi(atBestBlock(client), api) as unknown as SdkChain }
  })
}

const connectHub = cachedConnect<PolkadotClient>("asset-hub")

/** One Asset Hub client for the life of the worker. A failed or hung connect is retried on the next call. */
export async function connectAssetHub(host: WorkerHost): Promise<PolkadotClient | null> {
  return connectHub(async (abandoned) => {
    const genesis = (await host.assetHubGenesis()) ?? chainGenesis("hubNextV2")
    if (!genesis) {
      chatCount("chat.chain.connect_failed", { chain: "asset-hub", reason: "no-genesis" }, { key: "asset-hub:no-genesis", once: true })
      return null
    }
    const provider = await host.chainProvider(genesis)
    if (!provider || abandoned()) {
      if (!abandoned()) chatCount("chat.chain.connect_failed", { chain: "asset-hub", reason: "no-provider" }, { key: "asset-hub:no-provider", once: true })
      return null
    }
    return createClient(provider)
  })
}

/**
 * People and Asset Hub as the nfts SDK reads them.
 *
 * The pair is built here rather than taken from game-chain, whose barrel would
 * pull the descriptors into the worker.
 */
function nftsChain(people: People, hub: PolkadotClient): NftsChain & NftsCreditsChain {
  return {
    individuality: people.api,
    assetHub: hub.getUnsafeApi() as unknown as NftsCreditsChain["assetHub"],
    raw: { individuality: people.client, assetHub: hub },
  } as unknown as NftsChain & NftsCreditsChain
}

/**
 * How many collectibles one game earned the player, or null when the read fails.
 *
 * The credit count every surface shows (@individuality/game-outcome's
 * `readGameCredits`), over People and Asset Hub: those of the game, plus
 * those with no game when it is the last one the player attended, and never
 * an unprovable one.
 */
export async function readEarned(people: People, hub: PolkadotClient, address: string, gameIndex: number): Promise<number | null> {
  const personhood = await readPersonhoodState(people.chain, { account: address })
  if (!personhood.ok) return null
  const latestGame = personhood.value.tag === "Resolved" && personhood.value.participant?.lastAttendedGame === gameIndex
  const credits = await readGameCredits(nftsChain(people, hub), { address, gameIndex, latestGame })
  return credits?.total ?? null
}

// The art of one collectible is two reads, the manifest and then nothing more,
// since the host fetches the picture by its CID. A host that has not got the
// manifest yet answers null, so a lookup waits this long before giving up.
const ART_TIMEOUT_MS = 10_000

/**
 * The collectibles one game earned the player, as the chest of the app deals
 * them, each with the Bulletin CID of its picture, or null when the read fails.
 * `pending` counts the claims whose award block has no root on Asset Hub yet,
 * which the chest cannot deal until it has.
 *
 * The chest is read by `@jollity/collectables`, the same read lib/scarcity.ts
 * runs, so a claim shows the item the chest would show, under the picks of
 * Scarcity and then of Jollity. The worker keeps only the CID of the picture,
 * read from the manifest of the item through the preimages of the host, which
 * checks the manifest against its digest.
 */
export async function readCollectables(
  host: WorkerHost,
  people: People,
  hub: PolkadotClient,
  address: string,
  gameIndex: number,
): Promise<{ items: SlotCollectable[]; pending: number } | null> {
  const personhood = await readPersonhoodState(people.chain, { account: address })
  if (!personhood.ok) return null
  const latestGame = personhood.value.tag === "Resolved" && personhood.value.participant?.lastAttendedGame === gameIndex
  const nfts = await import("@parity/product-sdk-nfts")
  const preimages = await host.preimages().catch(() => null)
  const source = preimages ? nfts.preimageSource(preimages, ART_TIMEOUT_MS) : null
  const loadArt = async (manifestCid: string) => {
    if (!source) return ""
    const ref = manifestCid.startsWith("0x") ? { hex: manifestCid, text: null } : { hex: "", text: manifestCid }
    const art = await nfts.getVerifiedArtwork(ref, { source })
    return art.ok && art.value.tag === "Verified" ? (manifestPicture(art.value.bytes)?.cid ?? "") : ""
  }
  try {
    const [view, jollity, stash] = await Promise.all([
      readChestPinned(nftsChain(people, hub), address, gameIndex, { loadArt, latestGame }),
      host.storage.readJSON(JOLLITY_PICKS_KEY).catch(() => null),
      host.storage.readProductJSON(stashProduct(), STASH_PICKS_KEY).catch(() => null),
    ])
    const items = withPicks(view.items, parseChestPicks(jollity), parseChestPicks(stash)).map((item) => ({
      name: item.name,
      rarity: item.rarity,
      ...(item.image ? { image: item.image } : {}),
    }))
    return { items, pending: view.pending }
  } catch {
    return null
  }
}

let player: string | null = null

/** The SS58 address the app plays as, or null while the host hands over no account. */
export async function playerAddress(host: WorkerHost): Promise<string | null> {
  if (player) return player
  const publicKey = await host.productAccount(productAccount(), signupAccountIndex()).catch((error) => {
    chatCount("chat.player.read_failed", {}, { once: true, detail: { error: describeError(error) } })
    return null
  })
  player = publicKey ? AccountId().dec(publicKey) : null
  return player
}

function toChainRead(result: CurrentGameResult, clockOffsetMs: number): ChainRead {
  // The chain opens each game when the one before it ends, not at the
  // schedule's kickoff-minus-registration projection.
  const previousGameEnds =
    result.tag === "BetweenGames" ? 0 : result.game.phase === "Cancelling" ? null : result.game.reportingEnds
  const opens = registrationOpensSeconds(
    result.upcoming.map((schedule) => schedule.timeline),
    previousGameEnds,
  )
  const upcoming = result.upcoming.map((schedule, i) => ({
    gamePlayTime: schedule.gamePlayTime,
    registrationStarts: opens[i]!,
    registrationEnds: schedule.timeline.registrationEnds,
    reportingEnds: schedule.timeline.reportingEnds,
  }))
  if (result.tag === "BetweenGames") return { running: null, upcoming, clockOffsetMs, member: null }
  const { game, registration } = result
  return {
    running: {
      index: game.index,
      phase: PHASES[game.phase],
      registrationStarts: game.registrationEnds - result.durations.registration,
      registrationEnds: game.registrationEnds,
      gamePlayTime: game.gamePlayTime,
      // the one formula Humanity uses too, so both say "results pending" from the same second
      playEnds: playEndsSeconds(game),
      reportingEnds: game.reportingEnds,
      airdropsScheduled: game.airdropsScheduled,
      registered:
        registration.tag === "Registered" ? true : registration.tag === "NotRegistered" ? false : null,
      drawOpen: null,
    },
    upcoming,
    clockOffsetMs,
    member: null,
  }
}

async function clockOffset(host: StorageHost, api: UnsafeApi): Promise<number | null> {
  try {
    // The best block, as the app reads it, so the two count down together.
    const now = await api.query.Timestamp?.Now?.getValue({ at: "best" })
    if (now !== undefined) {
      const offset = Number(now) - Date.now()
      void writeJSON(host, CLOCK_OFFSET_KEY, offset)
      return offset
    }
    const stored = await storedClockOffset(host)
    chatCount("chat.clock_offset_failed", { reason: "no-timestamp", fallback: stored === null ? "none" : "stored" })
    return stored
  } catch (error) {
    const stored = await storedClockOffset(host)
    chatCount(
      "chat.clock_offset_failed",
      { reason: "read-failed", fallback: stored === null ? "none" : "stored" },
      { detail: { error: describeError(error) }, key: "read-failed" },
    )
    return stored
  }
}

async function storedClockOffset(host: StorageHost): Promise<number | null> {
  const stored = await readJSON<number>(host, CLOCK_OFFSET_KEY)
  return typeof stored === "number" && Number.isFinite(stored) ? stored : null
}

async function drawOpen(people: People, game: RunningGame): Promise<boolean | null> {
  if (game.phase !== "registration" || game.airdropsScheduled === 0) return null
  const status = await readPrizeStatus(people.chain, {
    game: { index: game.index, airdropsScheduled: game.airdropsScheduled },
  })
  if (!status.ok || status.value.tag !== "Draws" || status.value.draws.length === 0) return null
  return status.value.draws.every((draw) => draw.phase !== "Upcoming")
}

/**
 * The running game, the schedule after it and whether the player is signed up,
 * or null when the read fails or when no clock offset is known.
 */
export async function readGame(host: StorageHost, people: People, address: string | null): Promise<ChainRead | null> {
  const result = address
    ? await readCurrentGame(people.chain, { players: [{ tag: "Account", accountAddress: address }] })
    : await readCurrentGame(people.chain)
  if (!result.ok) return null
  const offset = await clockOffset(host, people.api)
  if (offset === null) return null
  const read = toChainRead(result.value, offset)
  if (read.running) read.running.drawOpen = await drawOpen(people, read.running)
  return read
}

/** The player's personhood state tag (Member, Suspended, Candidate...), or null when the read fails. */
export async function readStanding(people: People, address: string): Promise<string | null> {
  const personhood = await readPersonhoodState(people.chain, { account: address })
  if (!personhood.ok || personhood.value.tag !== "Resolved") return null
  return personhood.value.state.tag
}

const PEOPLE_RING = `0x${Array.from(new TextEncoder().encode("pop:polkadot.network/people".padEnd(32, " ")), (b) => b.toString(16).padStart(2, "0")).join("")}`

/**
 * Whether the player's full username can be claimed now: their Membership key
 * sits in the people ring under a root that covers it. The claim proves
 * against that root, so a key still in the onboarding queue cannot claim.
 *
 * `Score.register` leaves the personal id on the participant
 * (`Recognized(id)`), `People.People` holds the key of that id and
 * `Members.Members` says where the key stands. A member recognised outside
 * the game carries no id there and reads as ready, the chain having the last
 * word. Null when a read fails.
 */
export async function readNameReady(people: People, address: string): Promise<boolean | null> {
  try {
    const at = { at: "best" }
    const participant = (await people.api.query.Score?.Participants?.getValue(Enum("Account", address), at)) as
      | { recognition?: { type?: string; value?: bigint } }
      | undefined
    const recognition = participant?.recognition
    if (recognition?.type === "ExternallyRecognized") return true
    if (recognition?.type !== "Recognized" || recognition.value === undefined) return false
    const person = (await people.api.query.People?.People?.getValue(recognition.value, at)) as { key?: unknown } | undefined
    if (person?.key === undefined) return false
    const member = (await people.api.query.Members?.Members?.getValue(PEOPLE_RING, person.key, at)) as
      | { type?: string; value?: { ring_index: number; ring_position: number } }
      | undefined
    if (member?.type !== "Included" || member.value === undefined) return false
    const status = (await people.api.query.Members?.RingKeysStatus?.getValue(PEOPLE_RING, member.value.ring_index, at)) as
      | { included?: number }
      | undefined
    return status?.included !== undefined && status.included > member.value.ring_position
  } catch {
    return null
  }
}

/**
 * The player's verdict in the game the chain still holds, from their
 * `Game.Players` row at the best block (@individuality/game-outcome's
 * `deriveAttendance`, the read the app makes before the settle). `final` once
 * the pallet applied it early (#1096), when `Score.Participants` already holds
 * the game. Null while the row holds no verdict for it, undefined when the
 * read fails.
 */
export async function readAttendance(people: People, address: string, running: RunningGame): Promise<AttendanceView | null | undefined> {
  if (running.phase !== "reporting" && running.phase !== "settling") return null
  try {
    const raw = (await people.api.query.Game?.Players?.getValue(Enum("Account", address), { at: "best" })) as RawAttendanceRow | undefined
    const slot = { index: running.index, state: { type: running.phase === "settling" ? "PlayerProcess" : "Reporting" } }
    return deriveAttendance(running.index, slot, raw && attendanceRow(raw))
  } catch {
    return undefined
  }
}

/** What the chain keeps of the games behind the player, for the cards the chat never posted. */
export interface PastGames {
  /** Null for a player the chain holds no game for. */
  first: number | null
  attended: Set<number>
  /** The play time of each game in Unix seconds, by game index. */
  history: Map<number, number>
  /** The one game `readOutcome` can still answer for. */
  lastAttended: number | null
}

/**
 * The past games of the player, or null when a read fails.
 *
 * The first game is the smallest the chain names, since an archived row can
 * start later than the attendance list it left behind.
 */
export async function readPastGames(people: People, address: string): Promise<PastGames | null> {
  const account = Enum("Account", address)
  const game = people.api.query.Game
  try {
    const [entries, attendance, player, archived, personhood] = (await Promise.all([
      game?.GameHistory?.getEntries({ at: "best" }),
      game?.PlayerAttendanceHistory?.getValue(account, { at: "best" }),
      game?.Players?.getValue(account, { at: "best" }),
      game?.ArchivedPlayers?.getValue(account, { at: "best" }),
      readPersonhoodState(people.chain, { account: address }),
    ])) as [
      { keyArgs: [number]; value: number | bigint }[],
      number[],
      { first_game: number } | undefined,
      { value: { first_game: number } } | undefined,
      Awaited<ReturnType<typeof readPersonhoodState>>,
    ]
    if (!personhood.ok) throw personhood.error
    const firsts = [player?.first_game, archived?.value.first_game, ...attendance].filter((first) => first !== undefined)
    return {
      first: firsts.length > 0 ? Math.min(...firsts) : null,
      attended: new Set(attendance),
      history: new Map(entries.map(({ keyArgs, value }) => [keyArgs[0], Number(value)])),
      lastAttended: personhood.value.tag === "Resolved" ? (personhood.value.participant?.lastAttendedGame ?? null) : null,
    }
  } catch (error) {
    chatCount("chat.outcome.read_failed", { stage: "history" }, { key: "history", once: true, detail: { error: describeError(error) } })
    return null
  }
}

/** `Game.Players` as the unsafe API decodes it, as far as the verdict reads it. */
interface RawAttendanceRow {
  registered: boolean
  sent_report: boolean
  yes_person: number
  no_not_person: number
  expected_max_vote_weight: number
  early_attendance_enactment?: { attendance: boolean } | null
}

function attendanceRow(raw: RawAttendanceRow): AttendanceRow {
  const enacted = raw.early_attendance_enactment
  return {
    registered: raw.registered,
    sent_report: raw.sent_report,
    yes_person: Number(raw.yes_person),
    no_not_person: Number(raw.no_not_person),
    expected_max_vote_weight: Number(raw.expected_max_vote_weight),
    early_attendance_enactment: enacted ? { attendance: enacted.attendance } : null,
  }
}

function asciiOf(value: unknown): string {
  let bytes: ArrayLike<number> = []
  if (value instanceof Uint8Array) bytes = value
  else if (typeof value === "string" && value.startsWith("0x")) {
    bytes = Array.from({ length: (value.length - 2) / 2 }, (_, index) =>
      parseInt(value.slice(2 + 2 * index, 4 + 2 * index), 16),
    )
  } else if (typeof value === "string") return value
  let text = ""
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]!)
  return text
}

/** Whole units of the prize asset, by its own decimals rather than those of the chain. */
async function prizeAmount(api: UnsafeApi, draw: AirdropDraw): Promise<number> {
  const prize = draw.event?.prize
  if (!prize) return 0
  try {
    const metadata = (await api.query.Assets?.Metadata?.getValue(prize.assetId)) as
      | { decimals: number; symbol: unknown }
      | undefined
    const decimals = metadata && asciiOf(metadata.symbol) ? metadata.decimals : 0
    return Number(prize.assetAmount) / Math.pow(10, decimals)
  } catch (error) {
    chatCount("chat.outcome.read_failed", { stage: "prize-metadata" }, { key: "prize-metadata", once: true, detail: { error: describeError(error) } })
    return 0
  }
}

const DRAW_PHASES: Record<AirdropDraw["phase"], SlotPrize["phase"]> = {
  Upcoming: "waiting",
  Registering: "waiting",
  Drawing: "waiting",
  Claiming: "drawn",
  Settling: "over",
  Gone: "over",
}

/** A prize and the position of its draw among the draws of the game. */
export interface PrizeReading {
  prize: SlotPrize
  drawIndex: number
}

/** The draw a reading follows: the one read before, else a win, else the first still running. */
function pickDraw(draws: AirdropDraw[], drawIndex: number | undefined): number {
  if (drawIndex !== undefined && draws[drawIndex]) return drawIndex
  const won = draws.findIndex((draw) => draw.outcome.tag === "Won")
  if (won >= 0) return won
  const running = draws.findIndex((draw) => DRAW_PHASES[draw.phase] !== "over")
  return running >= 0 ? running : 0
}

/** The claim's view of the player's score row (@individuality/prize), none without one. */
function claimStanding(participant: { recognition: string; reachedPersonhood: boolean; lastAttendedGame: number | null } | null | undefined): ClaimStanding | undefined {
  if (!participant) return undefined
  return {
    recognized: CLAIM_RECOGNITIONS.has(participant.recognition),
    reachedPersonhood: participant.reachedPersonhood,
    lastAttendedGame: participant.lastAttendedGame,
  }
}

/**
 * The prize draw of the player for a game, or null with no draw to be in.
 *
 * It is undefined when a read fails, so a caller holding an older reading
 * keeps it rather than lose the prize. Whether a win can be claimed is the
 * shared rule of `Game.claim_airdrop` (@individuality/prize's
 * `prizeClaimEligibility`): a member, or a player over the personhood
 * threshold, whose last attended game is this one, so attending the next game
 * closes it. A win the chain holds this game's attendance for, of a player
 * who is neither, is `membersOnly`. Without `standing` the read looks it up.
 */
export async function readPrize(
  people: People,
  address: string,
  game: SeenGame,
  known: { drawIndex?: number; standing?: ClaimStanding | null } = {},
): Promise<PrizeReading | null | undefined> {
  if (game.airdropsScheduled === 0) return null
  const status = await readPrizeStatus(people.chain, {
    registrant: { tag: "Account", accountAddress: address },
    game: { index: game.index, airdropsScheduled: game.airdropsScheduled },
  })
  if (!status.ok || status.value.tag !== "Draws") return undefined
  const draws = status.value.draws
  if (draws.length === 0) return null
  let standing = known.standing
  if (standing === undefined) {
    const personhood = await readPersonhoodState(people.chain, { account: address })
    if (!personhood.ok) return undefined
    standing = personhood.value.tag === "Resolved" ? (claimStanding(personhood.value.participant) ?? null) : null
  }
  const eligibility = prizeClaimEligibility(standing ?? undefined, game.index)
  const drawIndex = pickDraw(draws, known.drawIndex)
  const draw = draws[drawIndex]!
  const won = draw.outcome.tag === "Won"
  return {
    drawIndex,
    prize: {
      amountUsd: await prizeAmount(people.api, draw),
      ticket: draw.outcome.tag === "Won" ? draw.outcome.ticket : "",
      drawAt: draw.event?.drawTime ?? game.endsAt,
      phase: DRAW_PHASES[draw.phase],
      won,
      claimable: won && draw.phase === "Claiming" && eligibility.eligible,
      // judged once the chain holds this game's attendance, never before
      ...(won && eligibility.isMostRecentAttendedGame && !eligibility.personhood ? { membersOnly: true } : {}),
    },
  }
}

/**
 * Whether the chain confirms that a winning ticket was claimed, or undefined when the read fails.
 *
 * A claim removes the winning ticket, and so does the draw leaving its claim
 * window, so only a ticket gone while the draw still takes claims counts. Ask
 * it only of a ticket that won, since a ticket that never won is gone too.
 */
export async function readClaimed(people: People, address: string, gameIndex: number, airdropIndex: number): Promise<boolean | undefined> {
  const outcome = await confirmClaim(people.chain, {
    gameIndex,
    airdropIndex,
    registrant: { tag: "Account", accountAddress: address },
  })
  if (!outcome.ok) {
    chatCount("chat.outcome.read_failed", { stage: "claim", "game.index": String(gameIndex) }, {
      key: `claim:${gameIndex}`,
      once: true,
      detail: { error: describeError(outcome.error) },
    })
    return undefined
  }
  return outcome.value.tag === "Claimed"
}

/** What the card of a game needs after the games list has let the game go. */
function kept(game: SeenGame): Pick<StoredOutcome, "gameIndex" | "registered" | "memberBefore"> {
  return { gameIndex: game.index, registered: game.registered, memberBefore: game.memberBefore }
}

/**
 * How the game went for the player, once the chain has moved past it, in the
 * `GameResults` shape of src/card that the results card draws.
 *
 * The chain says whether the player attended and where their membership
 * stands, but not what their chest holds, since that lives on Asset Hub. So a
 * played game carries `collectables: null`, earned and unnamed, and the card
 * points at the chest until the app says it was opened. There are no names
 * for the group either. It is null when a read fails.
 */
export async function readOutcome(people: People, address: string, game: SeenGame): Promise<StoredOutcome | null> {
  const personhood = await readPersonhoodState(people.chain, { account: address })
  if (!personhood.ok) return null
  const resolved = personhood.value.tag === "Resolved" ? personhood.value : null
  const state = resolved?.state
  const gamesToMembership = state?.tag === "Candidate" && state.gamesRemaining > 0 ? state.gamesRemaining : null
  const participant = resolved?.participant
  const member = state !== undefined && MEMBER_STATES.has(state.tag)
  const metrics = resolved?.metrics
  // The grace window forgives some misses, so only the chain's own Suspended is a pause.
  const standing = {
    paused: state?.tag === "Suspended",
    missesLeft: member && typeof metrics?.misses === "number" ? Math.max(metrics.allowedMisses - metrics.misses, 0) : null,
  }
  if (!participant || participant.lastAttendedGame !== game.index) {
    return { cancelled: false, results: null, gamesToMembership, ...standing, ...kept(game) }
  }
  // A failed prize read stores the results without the prize and marks it
  // unread, so the card still shows the membership and the prize is read again.
  const reading = await readPrize(people, address, game, { standing: claimStanding(participant) ?? null })
  return {
    cancelled: false,
    gamesToMembership,
    ...standing,
    ...kept({ ...game, registered: true }),
    ...(reading === undefined ? { prizeUnread: true } : reading ? { drawIndex: reading.drawIndex } : {}),
    results: {
      endedAt: game.gamePlayTime,
      passed: participant.streak.tag === "Attended",
      collectables: null,
      prize: reading?.prize ?? null,
      membership: { member, justBecameMember: member && game.memberBefore === false, gamesToMembership },
      seen: UNSEEN,
    },
  }
}
