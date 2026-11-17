// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Checks the call sequences of the worker against a fake `WorkerHost`.
 *
 * The chain reads of chain.ts are mocked out. The tests do not prove the wire
 * works, because only a real host can. They prove what the worker means: it
 * registers a room and a renderer on boot, posts the eight rules, posts one
 * card per game from what the chain says, books the reminders of that game,
 * stores how the game went once the chain moves past it, draws that with what
 * the app says was seen, and signs up from the chat when Register is pressed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { GameRegistrationError } from "@parity/product-sdk-individuality"
import { cardCopy, INTRO } from "./card"
import { AccountId } from "polkadot-api"
import { NETWORK_CONFIG, PLAYER_NAME_KEY, productAccount, turnPassKey } from "@jollity/protocol"
import { GAME_REGISTRATION_KEY, SENT_TTL_MS, type GameRegistration } from "@individuality/shared-records"
import type { RegisterOptions } from "@individuality/sign-up"
import type { ChainRead, PastGames, RunningGame } from "./chain"
import { footerMessageId, type ActionListener, type RenderHandler, type RoomFooterOutcome, type WorkerHost } from "./host"
import { decPayload, encPayload, type GameCardData, type IntroData } from "./renderer"
import { BOT_ICON, ROOM_ICON, UNSEEN, WORKER_HEARTBEAT_KEY, type Scheduled, type SeenGame, type StoredOutcome } from "./state"
import { decodeTelemetryEnvelope, telemetryRecords, type TelemetryRecord } from "./testing/telemetry-envelope"

vi.mock("./signup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./signup")>()),
  signupEngine: vi.fn(),
}))

// the name link (./name-gate.ts) gates every sign-up: here the account already carries the name
vi.mock("./name-link", () => ({ linkNameFromChat: vi.fn(async () => "already-linked") }))
vi.mock("./chain", () => ({
  connect: vi.fn(),
  playerAddress: vi.fn(),
  readGame: vi.fn(),
  readStanding: vi.fn(),
  readNameReady: vi.fn(),
  readOutcome: vi.fn(),
  readPastGames: vi.fn(),
  readAttendance: vi.fn(),
  readPrize: vi.fn(),
  readClaimed: vi.fn(),
  connectAssetHub: vi.fn(),
  readEarned: vi.fn(),
  readCollectables: vi.fn(),
}))

const TEXT_RULES = INTRO.flatMap((rule) => (rule.image ? [] : [rule.text]))
const PICTURES = INTRO.flatMap((rule) => (rule.image ? [rule.image.path] : []))
const PICTURE_RULES = INTRO.flatMap((rule) => (rule.image ? [rule.text] : []))
const FIRST_PICTURE_RULE = INTRO.find((rule) => rule.image)!
const postedRules = (host: WorkerHost) => vi.mocked(host.chat.postText).mock.calls.map(([, text]) => text)
const postedMessages = (host: WorkerHost, messageType: string) =>
  vi.mocked(host.chat.postMessage).mock.calls.flatMap(([, type, payload, alt]) => (type === messageType ? [{ payload, alt }] : []))
const postedPictures = (host: WorkerHost) =>
  postedMessages(host, "jollity.intro").map(({ payload }) => decPayload<IntroData>(payload).image)
const postedAlts = (host: WorkerHost, messageType: string) => postedMessages(host, messageType).map(({ alt }) => alt)

const RESULTS = {
  endedAt: 1_800_000_600,
  passed: true,
  collectables: null,
  prize: null,
  membership: { member: true, justBecameMember: false, gamesToMembership: null },
  seen: UNSEEN,
}

const OCTOPUS = { name: "Blanket Octopus", rarity: "rare" as const, image: "bafk-octopus" }
const ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const workerLogTexts = (host: WorkerHost & { store: Map<string, unknown> }): string[] =>
  ((host.store.get("jollity.wg.workerLog") as { text?: unknown }[] | undefined) ?? []).flatMap((entry) =>
    typeof entry.text === "string" ? [entry.text] : [],
  )
const workerLogEntries = (host: WorkerHost & { store: Map<string, unknown> }): [string, string][] =>
  ((host.store.get("jollity.wg.workerLog") as { kind?: string; text?: string }[] | undefined) ?? []).map((entry) => [
    String(entry.kind),
    String(entry.text),
  ])

function fakeHost(overrides: Partial<WorkerHost> = {}): WorkerHost & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    hostInfo: vi.fn().mockResolvedValue({ info: { name: "Polkadot Mobile", version: "1.4.2" }, failed: false }),
    chat: {
      registerBot: vi.fn().mockResolvedValue("New"),
      registerRoom: vi.fn().mockResolvedValue("New"),
      postMessage: vi.fn().mockResolvedValue(undefined),
      postText: vi.fn().mockResolvedValue(undefined),
      setRoomFooter: vi.fn().mockResolvedValue("set"),
    },
    renderer: { onRender: vi.fn(() => () => {}) },
    notifications: {
      push: vi.fn().mockResolvedValue(1),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
    permissions: { requestDevice: vi.fn().mockResolvedValue(true) },
    game: {
      remindNextGame: vi.fn().mockResolvedValue("unsupported"),
      cancelNextGame: vi.fn().mockResolvedValue("unsupported"),
    },
    navigate: vi.fn().mockResolvedValue(true),
    storage: {
      readJSON: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)) as WorkerHost["storage"]["readJSON"],
      writeJSON: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value)
      }),
      readProductJSON: vi.fn().mockResolvedValue(null) as WorkerHost["storage"]["readProductJSON"],
    },
    preimages: vi.fn().mockResolvedValue(null),
    peopleGenesis: vi.fn().mockResolvedValue(null),
    assetHubGenesis: vi.fn().mockResolvedValue(null),
    chainProvider: vi.fn().mockResolvedValue(null),
    productAccount: vi.fn().mockResolvedValue(null),
    topUp: vi.fn().mockResolvedValue("no-host"),
    accounts: {
      signer: vi.fn().mockResolvedValue(null),
      signVrf: vi.fn(() => vi.fn()),
      personhood: vi.fn(() => ({ holds: vi.fn().mockResolvedValue(false), prove: vi.fn() })),
    },
    entropy: vi.fn().mockResolvedValue(null),
    turnPass: vi.fn().mockResolvedValue({ stage: "proof", cause: "no-accounts", reason: "a fake host proves nothing" }),
    ...overrides,
  }
}

/** The accounts of a host that signs, which is what the chat signs up with. */
function signingAccounts(): WorkerHost["accounts"] {
  return {
    signer: vi.fn().mockResolvedValue({ publicKey: new Uint8Array(32) }),
    signVrf: vi.fn(() => vi.fn()),
    personhood: vi.fn(() => ({ holds: vi.fn().mockResolvedValue(false), prove: vi.fn() })),
  }
}

/** An engine that seats a returning player and runs the sign-up through `register`. */
async function signupEngineWith(register: (options: RegisterOptions) => Promise<{ ok: true }>) {
  const engine = {
    // a returning player, as the SDK's seat reads one
    seat: vi.fn().mockResolvedValue({
      path: "returning",
      ready: true,
      registered: false,
      open: true,
      required: 20n,
      requirement: { blockers: [{ tag: "AlreadyPlaying" }] },
      funds: { free: 0n, deposit: 10n, estimatedFee: 5n, decimals: 10, symbol: "PAS" },
    }),
    // a chain with no lite ring a host mints in: nobody takes the free route
    holdsLiteKey: vi.fn().mockResolvedValue(false),
    bind: vi.fn(),
    register: vi.fn((_capabilities: unknown, _id: Uint8Array, options: RegisterOptions) => register(options)),
  }
  const signup = await import("./signup")
  vi.mocked(signup.signupEngine).mockReturnValue(engine as never)
  return engine
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** A game in registration two hours out, whose window opened two hours before it closes. */
function running(overrides: Partial<RunningGame> = {}): RunningGame {
  const gamePlayTime = nowSeconds() + 2 * 3600
  const game = {
    index: 7,
    phase: "registration" as const,
    registrationEnds: gamePlayTime - 90,
    gamePlayTime,
    playEnds: gamePlayTime + 144,
    reportingEnds: gamePlayTime + 600,
    airdropsScheduled: 1,
    registered: false,
    drawOpen: true,
    ...overrides,
  }
  return { registrationStarts: game.registrationEnds - 2 * 3600, ...game }
}

function chainRead(overrides: Partial<ChainRead> = {}): ChainRead {
  return { running: running(), upcoming: [], clockOffsetMs: 0, member: null, ...overrides }
}

async function withChain(...reads: ChainRead[]) {
  const chain = await import("./chain")
  // A value a previous test queued and never consumed would serve this test first.
  for (const read of [chain.readGame, chain.readPastGames, chain.readPrize, chain.readClaimed, chain.readOutcome, chain.readAttendance, chain.readEarned, chain.readCollectables, chain.connectAssetHub]) vi.mocked(read).mockReset()
  vi.mocked(chain.connect).mockResolvedValue({} as never)
  vi.mocked(chain.playerAddress).mockResolvedValue(ADDRESS)
  vi.mocked(chain.readStanding).mockResolvedValue({ tag: "Candidate", gamesToMembership: null })
  vi.mocked(chain.readNameReady).mockReset().mockResolvedValue(true)
  vi.mocked(chain.connectAssetHub).mockResolvedValue(null)
  vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([], null))
  for (const read of reads) vi.mocked(chain.readGame).mockResolvedValueOnce(read)
  return chain
}

const pastPlayTime = (index: number) => 1_700_000_000 + index * 86_400
const pastRecap = (index: number) => `jollity.wg.recap:${pastPlayTime(index)}`

function pastGames(indices: number[], first: number | null, attended: number[] = [], lastAttended: number | null = null): PastGames {
  return { first, attended: new Set(attended), history: new Map(indices.map((index) => [index, pastPlayTime(index)])), lastAttended }
}

/** A host that has the card of the running game, so every card it posts is a past one. */
function announcedHost(game: RunningGame) {
  const host = fakeHost()
  host.store.set("jollity.wg.announced", [game.gamePlayTime])
  return host
}

function postedCards(host: WorkerHost): GameCardData[] {
  return vi
    .mocked(host.chat.postMessage)
    .mock.calls.filter(([, type]) => type === "jollity.gamecard")
    .map(([, , payload]) => decPayload<GameCardData>(payload))
}

/** A host whose chat already has the rules, so boot goes straight to the poll. */
function welcomedHost(overrides: Partial<WorkerHost> = {}) {
  const host = fakeHost(overrides)
  host.store.set("jollity.wg.intro.v3", INTRO.length)
  return host
}

const OPENS_NOTICE = "Register for the next game now. Prizes and other perks await!"
const HOUR_NOTICE = "Game starts in an hour. Register now, prizes and collectibles await!"
const TEN_MINUTES_NOTICE = "10 minutes left to register. Register now, prizes and collectibles await!"
const pushedTexts = (host: WorkerHost) => vi.mocked(host.notifications.push).mock.calls.map(([input]) => input.text)

const PEOPLE_ROOT = AccountId().dec(new Uint8Array(32).fill(2))
const NEW_MEMBER_PLAY_TIME = Math.floor(Date.now() / 1000) - 3600
const GAME_CARD_REQUEST = { messageId: "m5", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: NEW_MEMBER_PLAY_TIME }) }

/** A welcomed host whose stored game made the player a member, the player being `carol.01`. */
function newMemberHost() {
  const host = welcomedHost()
  const results = { ...RESULTS, endedAt: NEW_MEMBER_PLAY_TIME + 600, earned: 0, membership: { member: true, justBecameMember: true, gamesToMembership: 0 } }
  host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: NEW_MEMBER_PLAY_TIME, registered: true }])
  host.store.set(`jollity.wg.recap:${NEW_MEMBER_PLAY_TIME}`, { cancelled: false, results, gamesToMembership: null })
  host.store.set(PLAYER_NAME_KEY, "carol.01")
  return host
}

/** Polls that read a member between games on a People chain where `carol.01` belongs to PEOPLE_ROOT, whose consumer holds `consumer`. */
/** The raw `Resources.Consumers` record the SDK decodes, with no full username when `full_username` is null. */
const consumerRecord = (consumer: { full_username: Uint8Array | null; lite_username: Uint8Array }) => ({
  lite_username: consumer.lite_username,
  ...(consumer.full_username ? { full_username: consumer.full_username } : {}),
  credibility: { type: "Lite" },
})

async function peopleHolding(consumer: { full_username: Uint8Array | null; lite_username: Uint8Array }, member = true) {
  const query = {
    Resources: {
      UsernameOwnerOf: { getValue: vi.fn(async () => PEOPLE_ROOT) },
      Consumers: { getValue: vi.fn(async () => consumerRecord(consumer)) },
    },
  }
  const chain = await withChain(...Array.from({ length: 8 }, () => chainRead({ running: null })))
  vi.mocked(chain.connect).mockResolvedValue({ client: { getUnsafeApi: () => ({ query }) } } as never)
  vi.mocked(chain.readStanding).mockResolvedValue({ tag: member ? "Member" : "Candidate", gamesToMembership: null })
  return query
}

/** A welcomed host with the booking a worker from before the migrations left, its opening notice spent. */
function spentOpeningHost(game: RunningGame, overrides: Partial<WorkerHost> = {}) {
  const host = welcomedHost(overrides)
  host.store.set("jollity.wg.notifs", {
    gamePlayTime: game.gamePlayTime,
    registered: false,
    hostReminds: false,
    ids: [9, 10],
    moments: {
      [`opens:${game.gamePlayTime}`]: { id: 9, at: Date.now() - 60_000 },
      [`close-1h:${game.gamePlayTime}`]: { id: 10, at: (game.registrationEnds - 3600) * 1000 },
    },
    stale: [],
    complete: true,
  })
  return host
}

/** Delays the read of the stored migration number, since an instant store lets the migrations win the race with the poll. */
function answerMigrationsLate(host: WorkerHost): void {
  const read = host.storage.readJSON
  host.storage.readJSON = vi.fn(async (key: string) => {
    if (key === "jollity.wg.migrations") await new Promise((resolve) => setTimeout(resolve, 50))
    return read(key)
  }) as WorkerHost["storage"]["readJSON"]
}

async function renderHandler(host: WorkerHost): Promise<RenderHandler> {
  const { main } = await import("./index")
  await main(host)
  await flush()
  return vi.mocked(host.renderer.onRender).mock.calls[0]![0]
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

const docked = (gamePlayTime: number) => ({ card: { messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) } })
const footers = (host: WorkerHost) => vi.mocked(host.chat.setRoomFooter).mock.calls.map(([, footer]) => footer)
const fedCards = (host: WorkerHost) =>
  vi.mocked(host.chat.postMessage).mock.calls.flatMap(([, type, payload]) => (type === "jollity.gamecard" ? [decPayload<{ gamePlayTime: number }>(payload).gamePlayTime] : []))
const nextGameAt = (gamePlayTime: number) => chainRead({ running: running({ gamePlayTime }) })
const reportingAt = (gamePlayTime: number) => running({ gamePlayTime, phase: "reporting", playEnds: gamePlayTime + 144 })
const noGameLeft = () => chainRead({ running: null, upcoming: [] })
const footerHost = (setRoomFooter: WorkerHost["chat"]["setRoomFooter"]) => welcomedHost({ chat: { ...fakeHost().chat, setRoomFooter } })

/** A footer that answers outcome for the card of the game, or of any game when none is named, and set for the rest. */
const cardFooterAnswers = (outcome: RoomFooterOutcome, game?: number) =>
  vi.fn<WorkerHost["chat"]["setRoomFooter"]>(async (_room, footer) =>
    typeof footer === "string" || (game !== undefined && decPayload<{ gamePlayTime: number }>(footer.card.payload).gamePlayTime !== game) ? "set" : outcome,
  )

/** Boots the worker and waits out its first poll. */
async function started(host: WorkerHost) {
  const { readGame } = await import("./chain")
  const { main, tick } = await import("./index")
  await main(host)
  await vi.waitFor(() => expect(readGame).toHaveBeenCalled())
  await flush()
  return tick
}

async function poll(tick: (host: WorkerHost) => Promise<void>, host: WorkerHost) {
  await tick(host)
  await flush()
}

describe("the boot sequence works", () => {
  it("starts the worker heartbeat before room registration or other long startup work settles", async () => {
    const { main } = await import("./index")
    const host = welcomedHost({
      chat: { ...fakeHost().chat, registerRoom: vi.fn(() => new Promise<never>(() => {})) },
    })

    await main(host)

    expect(host.store.get(WORKER_HEARTBEAT_KEY)).toMatchObject({ release: expect.any(String) })
  })

  it("reports an interrupted sign-up before waiting for the player address", async () => {
    const chain = await import("./chain")
    vi.mocked(chain.playerAddress).mockReturnValue(new Promise(() => {}))
    const { main } = await import("./index")
    const host = welcomedHost()
    host.store.set("jollity.registration", { gameIndex: 7, phase: "registering", surface: "chat", at: Date.now(), attempt: 123 })

    await main(host)

    await vi.waitFor(() => expect(host.store.get("jollity.signup.reported")).toBe(123))
  })

  it("registers the bot and the room, and installs the render handler", async () => {
    // Given
    const { main } = await import("./index")
    const host = welcomedHost()

    // When
    await main(host)
    await flush()

    // Then
    expect(host.chat.registerBot).toHaveBeenCalledWith("weekly-game-bot", "Weekly Game", BOT_ICON)
    expect(host.chat.registerRoom).toHaveBeenCalledWith("jollity", "Polkadot", ROOM_ICON)
    expect(host.renderer.onRender).toHaveBeenCalledTimes(1)
  })

  it("hides the text input of the room once it is registered", async () => {
    // Given
    const { main } = await import("./index")
    const host = welcomedHost()

    // When
    await main(host)
    await flush()

    // Then
    expect(host.chat.setRoomFooter).toHaveBeenCalledWith("jollity", "Empty")
    expect(workerLogEntries(host)).toContainEqual(["success", "setRoomFooter answered set."])
  })

  it("logs a footer the host does not set as information", async () => {
    // Given
    const { main } = await import("./index")
    const host = welcomedHost({ chat: { ...fakeHost().chat, setRoomFooter: vi.fn().mockResolvedValue("unsupported") } })

    // When
    await main(host)
    await flush()

    // Then
    expect(workerLogEntries(host)).toContainEqual(["info", "setRoomFooter answered unsupported."])
  })

  describe("the docked game card works", () => {
    it("docks the live card of the next game and leaves it out of the feed", async () => {
      // Given
      await withChain(nextGameAt(5_000))
      const host = welcomedHost()

      // When
      await started(host)

      // Then
      expect(footers(host)).toEqual(["Empty", docked(5_000)])
      expect(fedCards(host)).toEqual([])
      expect(host.store.get("jollity.wg.docked")).toBe(5_000)
      expect(workerLogEntries(host)).toContainEqual(["success", "Docking the game at 5000 answered set."])
    })

    it("leaves the footer alone while the game stays the same", async () => {
      // Given
      await withChain(nextGameAt(5_000), nextGameAt(5_000))
      const host = welcomedHost()
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(footers(host)).toEqual(["Empty", docked(5_000)])
    })

    it("posts the finished game to the feed and docks the next one", async () => {
      // Given
      await withChain(nextGameAt(5_000), nextGameAt(6_000))
      const host = welcomedHost()
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(fedCards(host)).toEqual([5_000])
      expect(footers(host)).toEqual(["Empty", docked(5_000), docked(6_000)])
    })

    it("posts the finished game and empties the footer when no game is left", async () => {
      // Given
      await withChain(nextGameAt(5_000), noGameLeft())
      const host = welcomedHost()
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(fedCards(host)).toEqual([5_000])
      expect(footers(host)).toEqual(["Empty", docked(5_000), "Empty"])
      expect(host.store.get("jollity.wg.docked")).toBeNull()
      expect(workerLogEntries(host)).toContainEqual(["success", "Emptying the footer answered set."])
    })

    it("posts a game whose last turn has ended to the feed and docks the next one, before the chain settles it", async () => {
      // Given
      const playTime = nowSeconds() - 300
      const nextPlayTime = playTime + 3 * 3600
      const upcoming = [{ gamePlayTime: nextPlayTime, registrationStarts: nextPlayTime - 7200, registrationEnds: nextPlayTime - 150, reportingEnds: nextPlayTime + 600 }]
      await withChain(nextGameAt(playTime), chainRead({ running: reportingAt(playTime), upcoming }))
      const host = welcomedHost()
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(fedCards(host)).toEqual([playTime])
      expect(footers(host)).toEqual(["Empty", docked(playTime), docked(nextPlayTime)])
    })

    it("keeps a game docked while its turns are still being played", async () => {
      // Given
      const playTime = nowSeconds() - 60
      await withChain(nextGameAt(playTime), chainRead({ running: reportingAt(playTime) }))
      const host = welcomedHost()
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(fedCards(host)).toEqual([])
      expect(footers(host)).toEqual(["Empty", docked(playTime)])
    })

    it("keeps a game docked while its turns are still being played on the chain clock, behind the device clock", async () => {
      // Given
      const playTime = nowSeconds() - 660
      await withChain({ ...nextGameAt(playTime), clockOffsetMs: -600_000 }, chainRead({ running: reportingAt(playTime), clockOffsetMs: -600_000 }))
      const host = welcomedHost()
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(fedCards(host)).toEqual([])
      expect(footers(host)).toEqual(["Empty", docked(playTime)])
    })

    it("posts a game whose last turn has ended to the feed and empties the footer when no game is on the schedule", async () => {
      // Given
      const playTime = nowSeconds() - 300
      await withChain(nextGameAt(playTime), chainRead({ running: reportingAt(playTime), upcoming: [] }))
      const host = welcomedHost()
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(fedCards(host)).toEqual([playTime])
      expect(footers(host)).toEqual(["Empty", docked(playTime), "Empty"])
    })

    it("keeps an upcoming docked game in the footer, and out of the feed, through a read that lists no game", async () => {
      // Given
      const ahead = Math.floor(Date.now() / 1000) + 3_600
      await withChain(nextGameAt(ahead), noGameLeft())
      const host = welcomedHost()
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(fedCards(host)).toEqual([])
      expect(footers(host)).toEqual(["Empty", docked(ahead)])
      expect(host.store.get("jollity.wg.docked")).toBe(ahead)
    })

    it("draws the docked game as still on through one read that lists no game", async () => {
      // Given
      const ahead = Math.floor(Date.now() / 1000) + 3_600
      await withChain(nextGameAt(ahead), noGameLeft())
      const host = welcomedHost()
      const tick = await started(host)
      await poll(tick, host)
      const handler = vi.mocked(host.renderer.onRender).mock.calls[0]![0]
      const send = vi.fn()

      // When
      handler({ messageId: footerMessageId("jollity"), messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: ahead }) }, send, () => () => {})
      await flush()

      // Then
      expect(send).toHaveBeenCalled()
      expect(JSON.stringify(send.mock.calls.at(-1)![0])).not.toContain(cardCopy.GAME_CANCELLED)
    })

    it("posts an upcoming docked game as cancelled and empties the footer once two reads in a row list no game", async () => {
      // Given
      const ahead = Math.floor(Date.now() / 1000) + 3_600
      await withChain(nextGameAt(ahead), noGameLeft(), noGameLeft())
      const host = welcomedHost()
      const tick = await started(host)
      await poll(tick, host)
      const handler = vi.mocked(host.renderer.onRender).mock.calls[0]![0]
      const send = vi.fn()

      // When
      await poll(tick, host)
      handler({ messageId: "m1", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: ahead }) }, send, () => () => {})
      await flush()

      // Then
      expect(fedCards(host)).toEqual([ahead])
      expect(footers(host)).toEqual(["Empty", docked(ahead), "Empty"])
      expect(JSON.stringify(send.mock.calls.at(-1)![0])).toContain(cardCopy.GAME_CANCELLED)
    })

    it("draws the docked card without the gap under a card in the feed", async () => {
      // Given
      const ahead = Math.floor(Date.now() / 1000) + 3_600
      await withChain(nextGameAt(ahead), noGameLeft(), noGameLeft())
      const host = welcomedHost()
      const tick = await started(host)
      await poll(tick, host)
      await poll(tick, host)
      const handler = vi.mocked(host.renderer.onRender).mock.calls[0]![0]
      const dockedSend = vi.fn()
      const feedSend = vi.fn()

      // When
      handler({ messageId: footerMessageId("jollity"), messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: ahead }) }, dockedSend, () => () => {})
      handler({ messageId: "m1", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: ahead }) }, feedSend, () => () => {})
      await flush()

      // Then
      const feedGap = '{"tag":"Padding","value":{"top":0,"end":0,"bottom":24,"start":0}}'
      expect(JSON.stringify(feedSend.mock.calls.at(-1)![0])).toContain(feedGap)
      expect(JSON.stringify(dockedSend.mock.calls.at(-1)![0])).not.toContain(feedGap)
    })

    it("posts a docked game the chain calls off as cancelled and empties the footer on the first read", async () => {
      // Given
      const ahead = Math.floor(Date.now() / 1000) + 3_600
      await withChain(nextGameAt(ahead), chainRead({ running: running({ gamePlayTime: ahead, phase: "cancelled" }), upcoming: [] }))
      const host = welcomedHost()
      const tick = await started(host)
      await poll(tick, host)

      // When
      await poll(tick, host)

      // Then
      expect(fedCards(host)).toEqual([ahead])
      expect(footers(host)).toEqual(["Empty", docked(ahead), "Empty"])
    })

    it("docks the game a previous run docked before the first poll", async () => {
      // Given
      await withChain(nextGameAt(5_000))
      const host = welcomedHost()
      host.store.set("jollity.wg.docked", 5_000)

      // When
      await started(host)

      // Then
      expect(footers(host)).toEqual([docked(5_000)])
      expect(fedCards(host)).toEqual([])
    })

    it("replaces the game a previous run docked once the chat has moved on, and posts it", async () => {
      // Given
      await withChain(nextGameAt(6_000))
      const host = welcomedHost()
      host.store.set("jollity.wg.docked", 5_000)

      // When
      await started(host)

      // Then
      expect(fedCards(host)).toEqual([5_000])
      expect(footers(host)).toEqual([docked(5_000), docked(6_000)])
    })

    it("posts the game a previous run docked when no game is left, though the boot could not dock it", async () => {
      // Given
      await withChain(noGameLeft())
      const host = footerHost(cardFooterAnswers("failed"))
      host.store.set("jollity.wg.docked", 5_000)

      // When
      await started(host)

      // Then
      expect(fedCards(host)).toEqual([5_000])
      expect(footers(host)).toEqual([docked(5_000), "Empty", "Empty"])
      expect(host.store.get("jollity.wg.docked")).toBeNull()
    })

    it("keeps a card the feed already has out of the footer", async () => {
      // Given
      await withChain(nextGameAt(5_000), nextGameAt(5_000))
      const host = welcomedHost()
      host.store.set("jollity.wg.announced", [5_000])
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(footers(host)).toEqual(["Empty"])
      expect(fedCards(host)).toEqual([])
    })

    it("keeps a stored game the feed already has out of the footer at boot", async () => {
      // Given
      await withChain(nextGameAt(5_000))
      const host = welcomedHost()
      host.store.set("jollity.wg.docked", 5_000)
      host.store.set("jollity.wg.announced", [5_000])

      // When
      await started(host)

      // Then
      expect(footers(host)).toEqual(["Empty", "Empty"])
      expect(fedCards(host)).toEqual([])
    })
  })

  it("asks for the notification permission once the rules are out", async () => {
    // Given
    const { main } = await import("./index")
    const host = welcomedHost()

    // When
    await main(host)
    await flush()

    // Then
    expect(host.chat.postText).not.toHaveBeenCalled()
    expect(host.permissions.requestDevice).toHaveBeenCalledWith("Notifications")
    expect(workerLogTexts(host)).toContain("Notification permission granted.")
  })

  it("records when notification permission was not granted", async () => {
    // Given
    const { main } = await import("./index")
    const host = welcomedHost({ permissions: { requestDevice: vi.fn().mockResolvedValue(false) } })

    // When
    await main(host)
    await flush()

    // Then
    expect(workerLogTexts(host)).toContain("Notification permission not granted.")
  })

  it("sends the opening notice an older booking spent once more, and the ten-minute notice it never held, on the first boot alone", async () => {
    // Given: the booking a worker from before the migrations left for the game in registration
    const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
    const chain = await withChain(...Array.from({ length: 4 }, () => chainRead({ running: game })))
    const host = spentOpeningHost(game)

    // When: the chat boots, then boots again
    await (await import("./index")).main(host)
    await vi.waitFor(() => expect(pushedTexts(host)).toEqual([OPENS_NOTICE, TEN_MINUTES_NOTICE]))
    const logged = workerLogTexts(host)
    vi.resetModules()
    await (await import("./index")).main(host)
    await vi.waitFor(() => expect(vi.mocked(chain.readGame).mock.calls.length).toBeGreaterThanOrEqual(2))
    await flush()

    // Then
    expect(pushedTexts(host)).toEqual([OPENS_NOTICE, TEN_MINUTES_NOTICE])
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(host.store.get("jollity.wg.migrations")).toBe(1)
    expect(logged).toContain("Migration 1 opening-notice-again applied.")
  })

  it("books the reminders only once the migrations are done, when the stored number answers late", async () => {
    // Given
    const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
    await withChain(...Array.from({ length: 4 }, () => chainRead({ running: game })))
    const host = spentOpeningHost(game)
    answerMigrationsLate(host)

    // When
    await (await import("./index")).main(host)
    await vi.waitFor(() => expect(pushedTexts(host)).toEqual([OPENS_NOTICE, TEN_MINUTES_NOTICE]))
    await flush()

    // Then
    expect(pushedTexts(host)).toEqual([OPENS_NOTICE, TEN_MINUTES_NOTICE])
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ moments: { [`opens:${game.gamePlayTime}`]: { id: 1 } } })
  })
})

describe("the boot sequence fails", () => {
  it("still polls the chain when the host refuses the room", async () => {
    // Given
    const chain = await withChain(chainRead())
    const host = fakeHost({ chat: { ...fakeHost().chat, registerRoom: vi.fn().mockRejectedValue(new Error("refused")) } })
    const { main } = await import("./index")

    // When
    await main(host)
    await flush()

    // Then
    expect(chain.readGame).toHaveBeenCalled()
    expect(host.chat.setRoomFooter).not.toHaveBeenCalled()
    expect(host.store.get("jollity.wg.migrations")).toBe(1)
  })

  it("books the reminders only once the migrations are done, when the host refuses the room", async () => {
    // Given
    const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
    await withChain(...Array.from({ length: 4 }, () => chainRead({ running: game })))
    const host = spentOpeningHost(game, { chat: { ...fakeHost().chat, registerRoom: vi.fn().mockRejectedValue(new Error("refused")) } })
    answerMigrationsLate(host)

    // When
    await (await import("./index")).main(host)
    await vi.waitFor(() => expect(pushedTexts(host)).toEqual([OPENS_NOTICE, TEN_MINUTES_NOTICE]))
    await flush()

    // Then
    expect(pushedTexts(host)).toEqual([OPENS_NOTICE, TEN_MINUTES_NOTICE])
  })

  it("still polls the chain when nobody answers the notification prompt", async () => {
    // Given
    vi.useFakeTimers()
    const chain = await withChain(chainRead())
    const host = welcomedHost({ permissions: { requestDevice: vi.fn(() => new Promise<boolean>(() => {})) } })
    const { main } = await import("./index")

    // When
    await main(host)
    await vi.advanceTimersByTimeAsync(29_000)
    const beforeTheWait = vi.mocked(chain.readGame).mock.calls.length
    await vi.advanceTimersByTimeAsync(2_000)
    const afterTheWait = vi.mocked(chain.readGame).mock.calls.length
    const texts = workerLogTexts(host)
    vi.useRealTimers()

    // Then
    expect(beforeTheWait).toBe(0)
    expect(afterTheWait).toBeGreaterThan(0)
    expect(texts).toContain("Notification permission request timed out after 30 seconds.")
  })

  it("keeps going when the host refuses the bot, as iOS does", async () => {
    // Given
    const { main } = await import("./index")
    const host = fakeHost({
      chat: { ...fakeHost().chat, registerBot: vi.fn().mockRejectedValue(new Error("not supported")) },
    })

    // When
    await main(host)
    await flush()

    // Then
    expect(postedPictures(host)[0]).toBe(PICTURES[0])
  })

  describe("the docked game card fails", () => {
    it("keeps the finished game in the footer while its post fails", async () => {
      // Given
      await withChain(nextGameAt(5_000), nextGameAt(6_000), nextGameAt(6_000))
      const host = welcomedHost()
      const tick = await started(host)
      vi.mocked(host.chat.postMessage).mockRejectedValueOnce(new Error("refused"))

      // When
      await poll(tick, host)
      const afterRefusal = footers(host).length
      await poll(tick, host)

      // Then
      expect(afterRefusal).toBe(2)
      expect(fedCards(host)).toEqual([5_000, 5_000])
      expect(footers(host)).toEqual(["Empty", docked(5_000), docked(6_000)])
    })

    it("posts the live card to the feed on a host with no Card footer", async () => {
      // Given
      await withChain(nextGameAt(5_000), nextGameAt(6_000))
      const host = footerHost(cardFooterAnswers("unsupported"))
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(fedCards(host)).toEqual([5_000, 6_000])
      expect(footers(host)).toEqual(["Empty", docked(5_000)])
      expect(workerLogEntries(host)).toContainEqual(["info", "Docking the game at 5000 answered unsupported."])
    })

    it("tries a failed footer again, and posts the live card to the feed after three failures", async () => {
      // Given
      await withChain(nextGameAt(5_000), nextGameAt(5_000), nextGameAt(5_000))
      const setRoomFooter = vi.fn<WorkerHost["chat"]["setRoomFooter"]>().mockResolvedValueOnce("set").mockResolvedValue("failed")
      const host = footerHost(setRoomFooter)
      const tick = await started(host)

      // When
      await poll(tick, host)
      const fedAfterTwo = fedCards(host).length
      await poll(tick, host)

      // Then
      expect(fedAfterTwo).toBe(0)
      expect(footers(host)).toEqual(["Empty", docked(5_000), docked(5_000), docked(5_000)])
      expect(fedCards(host)).toEqual([5_000])
    })

    it("counts only the footer failures in a row", async () => {
      // Given
      await withChain(nextGameAt(5_000), nextGameAt(5_000), nextGameAt(5_000), nextGameAt(6_000), nextGameAt(6_000))
      const setRoomFooter = vi
        .fn<WorkerHost["chat"]["setRoomFooter"]>()
        .mockResolvedValue("failed")
        .mockResolvedValueOnce("set")
        .mockResolvedValueOnce("failed")
        .mockResolvedValueOnce("failed")
        .mockResolvedValueOnce("set")
      const host = footerHost(setRoomFooter)
      const tick = await started(host)

      // When
      for (let polls = 0; polls < 4; polls++) await poll(tick, host)

      // Then
      expect(footers(host)).toEqual(["Empty", docked(5_000), docked(5_000), docked(5_000), docked(6_000), docked(6_000)])
      expect(fedCards(host)).toEqual([5_000])
    })

    it("empties the footer when the live card moves to the feed after a card was docked", async () => {
      // Given
      await withChain(nextGameAt(5_000), nextGameAt(6_000), nextGameAt(6_000), nextGameAt(6_000))
      const host = footerHost(cardFooterAnswers("failed", 6_000))
      const tick = await started(host)

      // When
      for (let polls = 0; polls < 3; polls++) await poll(tick, host)

      // Then
      expect(footers(host)).toEqual(["Empty", docked(5_000), docked(6_000), docked(6_000), docked(6_000), "Empty"])
      expect(fedCards(host)).toEqual([5_000, 6_000])
      expect(host.store.get("jollity.wg.docked")).toBeNull()
    })

    it("posts the live card to the feed and empties the footer after one card call that never answers", async () => {
      // Given
      await withChain(noGameLeft(), nextGameAt(5_000))
      const setRoomFooter = vi.fn<WorkerHost["chat"]["setRoomFooter"]>((_room, footer) => (typeof footer === "string" ? Promise.resolve("set") : new Promise(() => {})))
      const host = footerHost(setRoomFooter)
      const tick = await started(host)

      // When
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const polled = tick(host)
        await vi.advanceTimersByTimeAsync(45_000)
        await polled
      } finally {
        vi.useRealTimers()
      }
      await flush()

      // Then
      expect(footers(host)).toEqual(["Empty", docked(5_000), "Empty"])
      expect(fedCards(host)).toEqual([5_000])
      expect(host.store.get("jollity.wg.docked")).toBeNull()
    })

    it("posts the live card to the feed after one call deadline when no footer call ever answers", async () => {
      // Given
      await withChain(noGameLeft(), nextGameAt(5_000))
      const setRoomFooter = vi
        .fn<WorkerHost["chat"]["setRoomFooter"]>(() => new Promise(() => {}))
        .mockResolvedValueOnce("set")
      const host = footerHost(setRoomFooter)
      const tick = await started(host)

      // When
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      let fedAfterOneDeadline: number[]
      try {
        const polled = tick(host)
        await vi.advanceTimersByTimeAsync(46_000)
        fedAfterOneDeadline = fedCards(host)
        await vi.advanceTimersByTimeAsync(45_000)
        await polled
      } finally {
        vi.useRealTimers()
      }
      await flush()

      // Then
      expect(fedAfterOneDeadline).toEqual([5_000])
      expect(footers(host)).toEqual(["Empty", docked(5_000), "Empty"])
    })

    it("keeps the next game in the footer when the empty footer of no game left never answers", async () => {
      // Given
      await withChain(nextGameAt(5_000), noGameLeft(), nextGameAt(6_000))
      const setRoomFooter = vi
        .fn<WorkerHost["chat"]["setRoomFooter"]>(async (_room, footer) => (typeof footer === "string" ? new Promise(() => {}) : "set"))
        .mockResolvedValueOnce("set")
      const host = footerHost(setRoomFooter)
      const tick = await started(host)

      // When
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        const polled = tick(host)
        await vi.advanceTimersByTimeAsync(90_000)
        await polled
      } finally {
        vi.useRealTimers()
      }
      await flush()
      await poll(tick, host)

      // Then
      expect(footers(host)).toEqual(["Empty", docked(5_000), "Empty", docked(6_000)])
      expect(fedCards(host)).toEqual([5_000])
    })

    it("posts the finished game when the record of its dock could not be written", async () => {
      // Given
      await withChain(nextGameAt(5_000), nextGameAt(6_000))
      const host = welcomedHost()
      const write = host.storage.writeJSON
      host.storage.writeJSON = vi.fn(async (key: string, value: unknown) =>
        key === "jollity.wg.docked" ? Promise.reject(new Error("refused")) : write(key, value),
      ) as WorkerHost["storage"]["writeJSON"]
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(fedCards(host)).toEqual([5_000])
      expect(footers(host)).toEqual(["Empty", docked(5_000), docked(6_000)])
    })

    it("keeps the card a poll docked when the boot dock of the same game fails late", async () => {
      // Given
      await withChain(nextGameAt(5_000))
      let answerBoot!: (outcome: RoomFooterOutcome) => void
      const setRoomFooter = vi
        .fn<WorkerHost["chat"]["setRoomFooter"]>()
        .mockReturnValueOnce(new Promise((resolve) => (answerBoot = resolve)))
        .mockResolvedValue("set")
      const host = footerHost(setRoomFooter)
      host.store.set("jollity.wg.docked", 5_000)
      await started(host)

      // When
      answerBoot("failed")
      await flush()

      // Then
      expect(footers(host)).toEqual([docked(5_000), docked(5_000)])
      expect(fedCards(host)).toEqual([])
    })

    it("keeps the finished game in the record when the live card moves to the feed in the same poll", async () => {
      // Given
      await withChain(nextGameAt(5_000), nextGameAt(6_000))
      const host = footerHost(cardFooterAnswers("unsupported", 6_000))
      const tick = await started(host)

      // When
      await poll(tick, host)

      // Then
      expect(fedCards(host)).toEqual([5_000, 6_000])
      expect(host.store.get("jollity.wg.announced")).toEqual([5_000, 6_000])
    })
  })
})

describe("delivering the rules works", () => {
  it("posts the rules as plain text, and the ones with a picture as intro cards, and remembers each", async () => {
    // Given
    const { deliverIntro } = await import("./index")
    const host = fakeHost()

    // When
    await deliverIntro(host, 0)

    // Then
    expect(postedRules(host)).toEqual(TEXT_RULES)
    expect(postedPictures(host)).toEqual(PICTURES)
    expect(postedAlts(host, "jollity.intro")).toEqual(PICTURE_RULES)
    expect(host.store.get("jollity.wg.intro.v3")).toBe(8)
  })

  it("draws an intro card as its rule over its picture from the worker archive", async () => {
    // Given
    const handler = await renderHandler(welcomedHost())
    const send = vi.fn()

    // When
    handler({ messageId: "m1", messageType: "jollity.intro", payload: encPayload({ image: PICTURES[0] }) }, send, () => () => {})

    // Then
    const card = send.mock.calls[0]![0]
    const [panel, words] = card.value.children
    expect(card.tag).toBe("Column")
    expect(panel.value.children[0].value.props).toEqual({
      source: { tag: "Archive", value: PICTURES[0] },
      fit: "Cover",
    })
    expect(words.value.children[0].value.children).toEqual([{ tag: "String", value: { text: FIRST_PICTURE_RULE.text } }])
  })

  it.each([
    ["a picture no rule names", encPayload({ image: "chat-intro/gone.png" })],
    ["a picture that is not a string", encPayload({ image: 0 })],
    ["the position of a rule, as the first build posted it", encPayload({ index: 0 })],
    ["no picture", encPayload({})],
    ["bytes that are not JSON", new Uint8Array([0xff, 0x00, 0x7b])],
  ])("draws nothing for an intro card with %s", async (_label, payload) => {
    // Given
    const handler = await renderHandler(welcomedHost())
    const send = vi.fn()

    // When
    handler({ messageId: "m1", messageType: "jollity.intro", payload }, send, () => () => {})

    // Then
    expect(send).toHaveBeenCalledWith({ tag: "Nil" })
  })

  it("carries on from where a restart stopped it", async () => {
    // Given
    const { deliverIntro } = await import("./index")
    const host = fakeHost()
    host.store.set("jollity.wg.intro.v3", 4)

    // When
    await deliverIntro(host, 0)

    // Then
    expect(postedRules(host)).toEqual(TEXT_RULES)
    expect(postedPictures(host)).toEqual(PICTURES.slice(4))
  })
})

describe("delivering the rules fails", () => {
  it("stops, and posts the rest later, when the host refuses a message", async () => {
    // Given
    const { deliverIntro } = await import("./index")
    const host = fakeHost({
      chat: { ...fakeHost().chat, postMessage: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("busy")) },
    })

    // When
    const delivery = deliverIntro(host, 0)

    // Then
    await expect(delivery).rejects.toThrow("busy")
    expect(host.store.get("jollity.wg.intro.v3")).toBe(1)
  })
})

describe("the chain poll works", () => {
  it("posts one card for the running game, however often it polls", async () => {
    // Given
    const game = running()
    await withChain(chainRead({ running: game }), chainRead({ running: game }))
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([{ gamePlayTime: game.gamePlayTime }])
    expect(postedAlts(host, "jollity.gamecard")).toEqual([cardCopy.GAME_CARD_ALT])
  })

  it("posts the cards of the games since the first one that the chat does not have, oldest first, played or missed by the attendance list", async () => {
    // Given
    const game = running()
    const chain = await withChain(chainRead({ running: game }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([5, 2, 4, 3], 3, [3, 5]))
    const { tick } = await import("./index")
    const host = announcedHost(game)

    // When
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([3, 4, 5].map((index) => ({ gamePlayTime: pastPlayTime(index) })))
    expect(host.store.get(pastRecap(3))).toMatchObject({ gameIndex: 3, registered: true, results: { endedAt: pastPlayTime(3), earned: 0 } })
    expect(host.store.get(pastRecap(4))).toMatchObject({ gameIndex: 4, registered: false, results: null })
    expect(host.store.get(pastRecap(5))).toMatchObject({ gameIndex: 5, registered: true, results: { endedAt: pastPlayTime(5) } })
    expect(host.store.has(pastRecap(2))).toBe(false)
    expect(host.store.get("jollity.wg.backfilled")).toBe(5)
  })

  it("posts every past game when no game is running", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3], 3))
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([{ gamePlayTime: pastPlayTime(3) }])
  })

  it("posts no past card for a game the worker already announced or recorded, nor for the running one", async () => {
    // Given
    const game = running({ index: 7 })
    const chain = await withChain(chainRead({ running: game }))
    const history = pastGames([3, 4, 5, 6], 3)
    history.history.set(7, game.gamePlayTime)
    vi.mocked(chain.readPastGames).mockResolvedValue(history)
    const { tick } = await import("./index")
    const host = announcedHost(game)
    host.store.set(pastRecap(3), { cancelled: false, results: null, gamesToMembership: null })
    host.store.set("jollity.wg.announced", [pastPlayTime(4), game.gamePlayTime])
    host.store.set("jollity.wg.games", [
      { index: 5, gamePlayTime: pastPlayTime(5) + 1, airdropsScheduled: 1, endsAt: pastPlayTime(5) + 600, registered: false, memberBefore: false },
    ])

    // When
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([{ gamePlayTime: pastPlayTime(6) }])
    expect(host.store.get("jollity.wg.backfilled")).toBe(6)
  })

  it("posts each past card once across polls and restarts", async () => {
    // Given
    const game = running()
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3, 4], 3))
    const first = await import("./index")
    const host = announcedHost(game)

    // When
    await first.tick(host)
    await first.tick(host)
    vi.resetModules()
    const restarted = await withChain(chainRead({ running: game }))
    vi.mocked(restarted.readPastGames).mockResolvedValue(pastGames([3, 4], 3))
    const second = await import("./index")
    await second.tick(host)

    // Then
    expect(postedCards(host)).toEqual([3, 4].map((index) => ({ gamePlayTime: pastPlayTime(index) })))
  })

  it("posts at most three past cards a poll, and the rest on the next", async () => {
    // Given
    const game = running({ index: 8 })
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3, 4, 5, 6, 7], 3))
    const { tick } = await import("./index")
    const host = announcedHost(game)

    // When
    await tick(host)
    const firstPoll = postedCards(host).length
    const firstWatermark = host.store.get("jollity.wg.backfilled")
    await tick(host)

    // Then
    expect(firstPoll).toBe(3)
    expect(firstWatermark).toBe(5)
    expect(postedCards(host)).toEqual([3, 4, 5, 6, 7].map((index) => ({ gamePlayTime: pastPlayTime(index) })))
  })

  it("reads the past games no more until a new game runs once none is left to post", async () => {
    // Given
    const game = running({ index: 7 })
    const next = running({ index: 8 })
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }), chainRead({ running: next }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3], 3))
    const { tick } = await import("./index")
    const host = announcedHost(game)

    // When
    await tick(host)
    await tick(host)
    const sameGame = vi.mocked(chain.readPastGames).mock.calls.length
    await tick(host)

    // Then
    expect(sameGame).toBe(1)
    expect(chain.readPastGames).toHaveBeenCalledTimes(2)
  })

  it("posts no past card for a player with no first game", async () => {
    // Given
    const game = running()
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3, 4], null))
    const { tick } = await import("./index")
    const host = announcedHost(game)

    // When
    await tick(host)
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([])
    expect(host.store.has("jollity.wg.backfilled")).toBe(false)
    expect(chain.readPastGames).toHaveBeenCalledTimes(1)
  })

  it("posts no past card while the past games or a record it checks cannot be read", async () => {
    // Given
    const game = running()
    const reads = Array.from({ length: 5 }, () => chainRead({ running: game }))
    const chain = await withChain(...reads)
    vi.mocked(chain.readPastGames).mockResolvedValueOnce(null)
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3], 3))
    const { tick } = await import("./index")
    const host = announcedHost(game)
    const read = host.storage.readJSON
    let failing: string | null = pastRecap(3)
    host.storage.readJSON = vi.fn(async (key: string) => {
      if (key === failing) throw new Error("no storage")
      return read(key)
    }) as WorkerHost["storage"]["readJSON"]

    // When
    await tick(host)
    await tick(host)
    failing = "jollity.wg.announced"
    await tick(host)
    const postedWhileFailing = postedCards(host).length
    const pastReads = vi.mocked(chain.readPastGames).mock.calls.length
    vi.mocked(host.storage.writeJSON).mockClear()
    failing = "jollity.wg.backfilled"
    await tick(host)
    const readsAfterFailedWatermark = vi.mocked(chain.readPastGames).mock.calls.length
    const watermarkWrites = vi.mocked(host.storage.writeJSON).mock.calls.filter(([key]) => key === "jollity.wg.backfilled")
    failing = null
    await tick(host)

    // Then
    expect(postedWhileFailing).toBe(0)
    expect(readsAfterFailedWatermark).toBe(pastReads)
    expect(watermarkWrites).toEqual([])
    expect(postedCards(host)).toEqual([{ gamePlayTime: pastPlayTime(3) }])
    expect(host.store.get("jollity.wg.backfilled")).toBe(3)
  })

  it("reads the outcome of the last attended game from the chain and makes up the older ones", async () => {
    // Given
    const game = running()
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3, 4], 3, [3], 4))
    const outcome = { cancelled: false, gamesToMembership: null, gameIndex: 4, registered: true, memberBefore: null, results: { ...RESULTS, endedAt: pastPlayTime(4), passed: false, earned: 5 } }
    vi.mocked(chain.readOutcome).mockResolvedValue(outcome)
    const { tick } = await import("./index")
    const host = announcedHost(game)

    // When
    await tick(host)
    const recapBeforeSettle = host.store.has(pastRecap(4))
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([3, 4].map((index) => ({ gamePlayTime: pastPlayTime(index) })))
    expect(recapBeforeSettle).toBe(false)
    expect(host.store.get(pastRecap(3))).toMatchObject({ gameIndex: 3, results: { earned: 0 } })
    expect(host.store.get(pastRecap(4))).toEqual(outcome)
    expect(chain.readOutcome).toHaveBeenCalledWith(
      expect.anything(),
      ADDRESS,
      { index: 4, gamePlayTime: pastPlayTime(4), airdropsScheduled: 0, endsAt: pastPlayTime(4), registered: true, memberBefore: null },
    )
    expect(host.store.get("jollity.wg.backfilled")).toBe(4)
  })

  it("posts no past card for a listed game whose play time has not come by the chain clock, with no game running", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null, clockOffsetMs: 7_200_000 }))
    const playedByChainClock = nowSeconds() + 3600
    const past = pastGames([3, 4], 3)
    past.history.set(3, playedByChainClock)
    past.history.set(4, nowSeconds() + 86_400)
    vi.mocked(chain.readPastGames).mockResolvedValue(past)
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([{ gamePlayTime: playedByChainClock }])
  })

  it("moves the watermark past a closing run of skipped games in one write", async () => {
    // Given
    const game = running()
    const chain = await withChain(chainRead({ running: game }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3, 4], 3))
    const { tick } = await import("./index")
    const host = announcedHost(game)
    host.store.set("jollity.wg.announced", [pastPlayTime(3), pastPlayTime(4), game.gamePlayTime])

    // When
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([])
    expect(vi.mocked(host.storage.writeJSON).mock.calls.filter(([key]) => key === "jollity.wg.backfilled")).toEqual([["jollity.wg.backfilled", 4]])
  })

  it("posts the card of the running game once per run while the announced write fails", async () => {
    // Given
    const game = running()
    await withChain(...Array.from({ length: 4 }, () => chainRead({ running: game })))
    const { tick } = await import("./index")
    const host = fakeHost()
    const write = host.storage.writeJSON
    let refuse = true
    host.storage.writeJSON = vi.fn(async (key: string, value: unknown) => {
      if (refuse && key === "jollity.wg.announced") throw new Error("quota")
      return write(key, value)
    })

    // When
    for (let poll = 0; poll < 3; poll++) await tick(host)
    const whileRefused = postedCards(host).length
    refuse = false
    await tick(host)

    // Then
    expect(whileRefused).toBe(1)
    expect(postedCards(host)).toEqual([{ gamePlayTime: game.gamePlayTime }])
    expect(host.store.get("jollity.wg.announced")).toEqual([game.gamePlayTime])
  })

  it("posts the card once when the announced claim lands after its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      // Given
      const game = running()
      await withChain(chainRead({ running: game }), chainRead({ running: game }))
      const { tick } = await import("./index")
      const host = fakeHost()
      const write = host.storage.writeJSON
      let lateOnce = true
      host.storage.writeJSON = vi.fn(async (key: string, value: unknown) => {
        await write(key, value)
        if (key === "jollity.wg.announced" && lateOnce) {
          lateOnce = false
          await new Promise(() => {})
        }
      })

      // When
      const first = tick(host)
      await vi.advanceTimersByTimeAsync(46_000)
      await first
      await tick(host)

      // Then
      expect(postedCards(host)).toEqual([{ gamePlayTime: game.gamePlayTime }])
    } finally {
      vi.useRealTimers()
    }
  })

  it("posts one card when the host answers the post after its deadline", async () => {
    // Given
    const game = running()
    await withChain(chainRead({ running: game }), chainRead({ running: game }))
    const { tick } = await import("./index")
    const { CallDeadlineError } = await import("./state")
    const host = fakeHost()
    vi.mocked(host.chat.postMessage).mockRejectedValueOnce(new CallDeadlineError("No answer within 45000ms."))

    // When
    await tick(host)
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([{ gamePlayTime: game.gamePlayTime }])
  })

  it("posts the card again after a prompt refusal", async () => {
    // Given
    const game = running()
    await withChain(chainRead({ running: game }), chainRead({ running: game }), chainRead({ running: game }))
    const { tick } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.chat.postMessage).mockRejectedValueOnce(new Error("refused"))

    // When
    await tick(host)
    await tick(host)
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([{ gamePlayTime: game.gamePlayTime }, { gamePlayTime: game.gamePlayTime }])
  })

  it("does not post a game again when the next game swings back to it", async () => {
    // Given
    const a = running()
    const b = running({ index: 8, gamePlayTime: a.gamePlayTime + 86_400 })
    await withChain(chainRead({ running: a }), chainRead({ running: b }), chainRead({ running: a }))
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)
    await tick(host)
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([{ gamePlayTime: a.gamePlayTime }, { gamePlayTime: b.gamePlayTime }])
  })

  it("reads the play time an older worker announced as already announced", async () => {
    // Given
    const game = running()
    await withChain(chainRead({ running: game }))
    const { tick } = await import("./index")
    const host = fakeHost()
    host.store.set("jollity.wg.announced", game.gamePlayTime)

    // When
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([])
  })

  it("posts the card of the next scheduled game once the running one is over", async () => {
    // Given
    const next = nowSeconds() + 86_400
    await withChain(
      chainRead({
        running: running({ phase: "settling" }),
        upcoming: [{ gamePlayTime: next, registrationStarts: next - 3600, registrationEnds: next - 90, reportingEnds: next + 600 }],
      }),
    )
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)

    // Then
    expect(postedCards(host)).toEqual([{ gamePlayTime: next }])
  })

  it("does not read the outcome of a game the chain is still running", async () => {
    // Given
    const chain = await withChain(chainRead({ running: running() }))
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)

    // Then
    expect(chain.readOutcome).not.toHaveBeenCalled()
    expect([...host.store.keys()].filter((key) => key.startsWith("jollity.wg.recap:"))).toEqual([])
  })

  it("reads the outcome of a game once the chain has moved past it, and once only", async () => {
    // Given
    const game = running()
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: null }), chainRead({ running: null }))
    const outcome: StoredOutcome = { cancelled: false, results: null, gamesToMembership: 2 }
    vi.mocked(chain.readOutcome).mockResolvedValue(outcome)
    const { tick } = await import("./index")
    const host = fakeHost()
    await tick(host)

    // When
    await tick(host)
    await tick(host)

    // Then
    const seen: SeenGame = {
      index: 7,
      gamePlayTime: game.gamePlayTime,
      airdropsScheduled: 1,
      endsAt: game.reportingEnds,
      registered: false,
      memberBefore: false,
    }
    expect(chain.readOutcome).toHaveBeenCalledTimes(1)
    expect(chain.readOutcome).toHaveBeenCalledWith(expect.anything(), ADDRESS, seen)
    expect(host.store.get(`jollity.wg.recap:${game.gamePlayTime}`)).toEqual(outcome)
  })

  it("records a cancelled game as cancelled without reading an outcome", async () => {
    // Given
    const chain = await withChain(chainRead({ running: running({ phase: "cancelled" }) }))
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)

    // Then
    expect(chain.readOutcome).not.toHaveBeenCalled()
    const [stored] = [...host.store.entries()].filter(([key]) => key.startsWith("jollity.wg.recap:")).map(([, value]) => value)
    expect(stored).toEqual({ cancelled: true, results: null, gamesToMembership: null, gameIndex: 7, registered: false, memberBefore: false })
  })

  it("records the games a candidate has left on a cancelled game, so its card keeps the circles", async () => {
    // Given
    const chain = await withChain(chainRead({ running: running({ phase: "cancelled" }) }))
    vi.mocked(chain.readStanding).mockResolvedValue({ tag: "Candidate", gamesToMembership: 3 })
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)

    // Then
    const [stored] = [...host.store.entries()].filter(([key]) => key.startsWith("jollity.wg.recap:")).map(([, value]) => value)
    expect(stored).toMatchObject({ cancelled: true, gamesToMembership: 3 })
  })

  it("keeps the circles of a candidate on the card when a later read of the standing fails", async () => {
    // Given
    const game = running()
    const chain = await withChain(...Array.from({ length: 8 }, () => chainRead({ running: game })))
    vi.mocked(chain.readStanding).mockResolvedValueOnce({ tag: "Candidate", gamesToMembership: 3 }).mockResolvedValue(null)
    const host = welcomedHost()
    const handler = await renderHandler(host)
    const { tick } = await import("./index")

    // When
    for (let i = 0; i < 4; i++) await tick(host)
    const send = vi.fn()
    handler({ messageId: "m-standing", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, () => () => {})
    await flush()

    // Then
    expect(vi.mocked(chain.readStanding).mock.calls.length).toBeGreaterThan(1)
    expect(JSON.stringify(send.mock.calls.at(-1)![0])).toContain("3 games to Membership")
  })

  it("stores the outcome early once the chain has applied the player's attendance, before the game settles", async () => {
    // Given
    const game = running({ phase: "reporting", registered: true })
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    const outcome: StoredOutcome = { cancelled: false, results: RESULTS, gamesToMembership: null, gameIndex: 7, registered: true, memberBefore: false }
    vi.mocked(chain.readAttendance).mockResolvedValue({ gameIndex: 7, verdict: "passed", final: true, reported: true, personWeightNeeded: 0 })
    vi.mocked(chain.readOutcome).mockResolvedValue(outcome)
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)
    await tick(host)

    // Then
    expect(chain.readOutcome).toHaveBeenCalledTimes(1)
    expect(host.store.get(`jollity.wg.recap:${game.gamePlayTime}`)).toEqual({ ...outcome, early: true, reported: true })
  })

  it.each([
    [true, { reported: true }],
    [false, {}],
  ])("stores a failed early outcome with what the chain says of the report, when it says %s", async (reported, expected) => {
    // Given
    const game = running({ phase: "reporting", registered: true })
    const chain = await withChain(chainRead({ running: game }))
    const outcome: StoredOutcome = { cancelled: false, results: null, gamesToMembership: 2, gameIndex: 7, registered: true, memberBefore: false }
    vi.mocked(chain.readAttendance).mockResolvedValue({ gameIndex: 7, verdict: "failed", final: true, reported, personWeightNeeded: null })
    vi.mocked(chain.readOutcome).mockResolvedValue(outcome)
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)

    // Then
    expect(host.store.get(`jollity.wg.recap:${game.gamePlayTime}`)).toEqual({ ...outcome, early: true, ...expected })
  })

  it("keeps the report the chain held while the game ran for the outcome read after the settle", async () => {
    // Given
    const game = running({ phase: "reporting", registered: true })
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: null }))
    const outcome: StoredOutcome = { cancelled: false, results: null, gamesToMembership: 2, gameIndex: 7, registered: true, memberBefore: false }
    vi.mocked(chain.readAttendance).mockResolvedValue({ gameIndex: 7, verdict: "pending", final: false, reported: true, personWeightNeeded: 2 })
    vi.mocked(chain.readOutcome).mockResolvedValue(outcome)
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)
    const games = structuredClone(host.store.get("jollity.wg.games"))
    await tick(host)

    // Then
    expect(games).toMatchObject([{ index: 7, reported: true }])
    expect(host.store.get(`jollity.wg.recap:${game.gamePlayTime}`)).toEqual({ ...outcome, reported: true })
  })

  it("keeps the report of a final verdict whose early outcome could not be read", async () => {
    // Given
    const game = running({ phase: "reporting", registered: true })
    const chain = await withChain(chainRead({ running: game }))
    vi.mocked(chain.readAttendance).mockResolvedValue({ gameIndex: 7, verdict: "failed", final: true, reported: true, personWeightNeeded: null })
    vi.mocked(chain.readOutcome).mockResolvedValue(null)
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)

    // Then
    expect(host.store.get("jollity.wg.games")).toMatchObject([{ index: 7, reported: true }])
  })

  it("stores nothing early while the votes can still swing the verdict, or before the chain applied it", async () => {
    // Given
    const game = running({ phase: "reporting", registered: true })
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    vi.mocked(chain.readAttendance)
      .mockResolvedValueOnce({ gameIndex: 7, verdict: "pending", final: false, reported: true, personWeightNeeded: 2 })
      .mockResolvedValueOnce({ gameIndex: 7, verdict: "passed", final: false, reported: true, personWeightNeeded: 0 })
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)
    await tick(host)

    // Then
    expect(chain.readOutcome).not.toHaveBeenCalled()
    expect([...host.store.keys()].filter((key) => key.startsWith("jollity.wg.recap:"))).toEqual([])
  })

  it("counts the collectibles of an early outcome again on every poll while the game reports", async () => {
    // Given
    const game = running({ phase: "reporting", registered: true })
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
    vi.mocked(chain.readEarned).mockResolvedValueOnce(2).mockResolvedValueOnce(3)
    vi.mocked(chain.readCollectables)
      .mockResolvedValueOnce({ items: [OCTOPUS, OCTOPUS], pending: 0 })
      .mockResolvedValueOnce({ items: [OCTOPUS, OCTOPUS], pending: 1 })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set(key, { cancelled: false, results: { ...RESULTS, earned: 1, collectables: [OCTOPUS] }, gamesToMembership: null, gameIndex: 7, early: true })
    const { tick } = await import("./index")

    // When
    await tick(host)
    const first = structuredClone(host.store.get(key))
    await tick(host)

    // Then: the second count grew while the chest could not deal it, so the pictures drawn stay
    expect(first).toMatchObject({ early: true, results: { earned: 2, collectables: [OCTOPUS, OCTOPUS] } })
    expect(host.store.get(key)).toMatchObject({ early: true, results: { earned: 3, collectables: [OCTOPUS, OCTOPUS] } })
    expect(chain.readOutcome).not.toHaveBeenCalled()
  })

  it("reads an early outcome once more when the game settles, and keeps counting from there", async () => {
    // Given
    const game = running({ phase: "reporting", registered: true })
    const chain = await withChain(chainRead({ running: null }))
    vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
    vi.mocked(chain.readEarned).mockResolvedValue(3)
    vi.mocked(chain.readCollectables).mockResolvedValue({ items: [OCTOPUS, OCTOPUS, OCTOPUS], pending: 0 })
    const settled = { ...RESULTS, membership: { member: true, justBecameMember: true, gamesToMembership: null } }
    vi.mocked(chain.readOutcome).mockResolvedValue({ cancelled: false, results: settled, gamesToMembership: null, gameIndex: 7, registered: true, memberBefore: false })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: { ...RESULTS, earned: 2, collectables: [OCTOPUS, OCTOPUS] }, gamesToMembership: null, gameIndex: 7, early: true })
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    const stored = host.store.get(key) as StoredOutcome
    expect(stored.early).toBeUndefined()
    expect(stored.results).toMatchObject({ membership: { justBecameMember: true }, earned: 3, collectables: [OCTOPUS, OCTOPUS, OCTOPUS] })
  })

  it("claims a won prize the chain would pay by itself", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    const game = running()
    const claimable = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: true, claimable: true }
    vi.mocked(chain.readPrize).mockResolvedValueOnce({ prize: claimable, drawIndex: 0 })
    const host = fakeHost()
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(`jollity.wg.recap:${game.gamePlayTime}`, { cancelled: false, results: { ...RESULTS, prize: { ...claimable, phase: "waiting", won: false, claimable: false } }, gamesToMembership: null, gameIndex: 7 })
    const autoClaim = vi.fn()
    const { tick } = await import("./index")

    // When
    await tick(host, autoClaim)

    // Then
    expect(autoClaim).toHaveBeenCalledWith(7, 0)
  })

  it("leaves a payable win to the app until the game has settled", async () => {
    // Given: an early outcome, the game still reporting, and a win the chain would pay
    const game = running({ phase: "reporting", registered: true })
    const chain = await withChain(chainRead({ running: game }))
    const claimable = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 300, phase: "drawn" as const, won: true, claimable: true }
    vi.mocked(chain.readPrize).mockResolvedValueOnce({ prize: claimable, drawIndex: 0 })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set(key, { cancelled: false, results: { ...RESULTS, earned: 0, prize: { ...claimable, phase: "waiting", won: false, claimable: false } }, gamesToMembership: null, gameIndex: 7, early: true })
    const autoClaim = vi.fn()
    const { tick } = await import("./index")

    // When
    await tick(host, autoClaim)

    // Then: the card has the win to show, and the claim waits for the settle
    expect(host.store.get(key)).toMatchObject({ results: { prize: { won: true, claimable: true } } })
    expect(autoClaim).not.toHaveBeenCalled()
  })

  it("does not claim a win the chain will not pay a non-member", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    const game = running()
    const membersOnly = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: true, claimable: false, membersOnly: true }
    vi.mocked(chain.readPrize).mockResolvedValueOnce({ prize: membersOnly, drawIndex: 0 })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: { ...RESULTS, prize: { ...membersOnly, phase: "waiting", won: false, membersOnly: undefined } }, gamesToMembership: null, gameIndex: 7 })
    const autoClaim = vi.fn()
    const { tick } = await import("./index")

    // When
    await tick(host, autoClaim)

    // Then
    expect(autoClaim).not.toHaveBeenCalled()
    expect(host.store.get(key)).toMatchObject({ results: { prize: { membersOnly: true, claimable: false } } })
  })

  it("asks for a claim by itself once per game, and not while one is under way", async () => {
    // Given
    const { autoClaimFor } = await import("./index")
    const states = new Map<number, { kind: "busy" }>([[8, { kind: "busy" }]])
    const claims = { claim: vi.fn(async () => {}), state: vi.fn((game: number) => states.get(game)) }
    const autoClaim = autoClaimFor(claims)

    // When
    autoClaim(7, 0)
    autoClaim(7, 0)
    autoClaim(8, 1)

    // Then
    expect(claims.claim).toHaveBeenCalledTimes(1)
    expect(claims.claim).toHaveBeenCalledWith(7, 0)
  })

  it("keeps the sign-up of a tracked game current, since a player signs up after the card", async () => {
    // Given
    const game = running()
    await withChain(chainRead({ running: game }), chainRead({ running: { ...game, registered: true } }))
    const { tick } = await import("./index")
    const host = fakeHost()
    await tick(host)

    // When
    await tick(host)

    // Then
    expect(host.store.get("jollity.wg.games")).toMatchObject([{ index: 7, registered: true }])
  })

  it("reads the prize of a stored win over a stale sign-up flag", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    const game = running()
    const claimable = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: true, claimable: true }
    vi.mocked(chain.readPrize).mockResolvedValueOnce({ prize: claimable, drawIndex: 0 })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: false, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: { ...RESULTS, prize: claimable }, gamesToMembership: null, gameIndex: 7, registered: true, memberBefore: false, drawIndex: 0 })
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(chain.readPrize).toHaveBeenCalledWith(expect.anything(), ADDRESS, expect.objectContaining({ index: 7 }), { drawIndex: 0 })
  })

  it("reads the prize again until its draw is over, and stores the fresh reading", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }), chainRead({ running: null }))
    const game = running()
    const claimable = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: true, claimable: true }
    const over = { ...claimable, phase: "over" as const, claimable: false }
    vi.mocked(chain.readPrize).mockResolvedValueOnce({ prize: over, drawIndex: 0 })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: { ...RESULTS, prize: claimable }, gamesToMembership: null, gameIndex: 7 })
    const { tick } = await import("./index")

    // When
    await tick(host)
    await tick(host)

    // Then
    expect(chain.readPrize).toHaveBeenCalledTimes(1)
    expect(host.store.get(key)).toMatchObject({ results: { prize: over } })
    expect(chain.readOutcome).not.toHaveBeenCalled()
  })

  it("counts once what a player who reported and did not pass earned, with no chest and no prize read", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }), chainRead({ running: null }))
    const game = running()
    vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
    vi.mocked(chain.readEarned).mockResolvedValue(2)
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: null, gamesToMembership: 2, gameIndex: 7, registered: true, reported: true })
    const { tick } = await import("./index")

    // When
    await tick(host)
    await tick(host)

    // Then
    expect(host.store.get(key)).toMatchObject({ results: null, reported: true, earned: 2 })
    expect(chain.readEarned).toHaveBeenCalledTimes(1)
    expect(chain.readEarned).toHaveBeenCalledWith(expect.anything(), expect.anything(), ADDRESS, 7)
    expect(chain.readCollectables).not.toHaveBeenCalled()
    expect(chain.readPrize).not.toHaveBeenCalled()
  })

  it("counts nothing for a player whose report never landed, or a cancelled game", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    const game = running()
    vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
    const host = fakeHost()
    host.store.set("jollity.wg.games", [
      { index: 6, gamePlayTime: game.gamePlayTime - 60, airdropsScheduled: 0, endsAt: game.reportingEnds, registered: true, memberBefore: false },
      { index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 0, endsAt: game.reportingEnds, registered: true, memberBefore: false },
    ])
    host.store.set(`jollity.wg.recap:${game.gamePlayTime - 60}`, { cancelled: true, results: null, gamesToMembership: null, gameIndex: 6, reported: true })
    host.store.set(`jollity.wg.recap:${game.gamePlayTime}`, { cancelled: false, results: null, gamesToMembership: null, gameIndex: 7, registered: true })
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(chain.readEarned).not.toHaveBeenCalled()
  })

  it("reads a failed count of a player who did not pass again on a later poll, and logs it once", async () => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      const chain = await withChain(chainRead({ running: null }), chainRead({ running: null }), chainRead({ running: null }))
      const game = running()
      vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
      vi.mocked(chain.readEarned).mockResolvedValueOnce(null).mockResolvedValueOnce(2)
      const host = fakeHost()
      const key = `jollity.wg.recap:${game.gamePlayTime}`
      host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 0, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
      host.store.set(key, { cancelled: false, results: null, gamesToMembership: null, gameIndex: 7, registered: true, reported: true })
      const { tick } = await import("./index")

      // When
      await tick(host)
      const unread = structuredClone(host.store.get(key))
      await tick(host)
      const withinWindow = vi.mocked(chain.readEarned).mock.calls.length
      vi.setSystemTime(Date.now() + 11 * 60_000)
      await tick(host)

      // Then
      expect(unread).not.toHaveProperty("earned")
      expect(withinWindow).toBe(1)
      expect(host.store.get(key)).toMatchObject({ earned: 2 })
      expect(workerLogTexts(host).filter((text) => text.includes("could not be counted"))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("counts an early outcome of a player who did not pass on every poll, and once more at the settle", async () => {
    // Given
    const game = running({ phase: "reporting", registered: true })
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }), chainRead({ running: null }))
    vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
    vi.mocked(chain.readEarned).mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3)
    vi.mocked(chain.readOutcome).mockResolvedValue({ cancelled: false, results: null, gamesToMembership: 2, gameIndex: 7, registered: true, memberBefore: false })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 0, endsAt: game.reportingEnds, registered: true, memberBefore: false, reported: true }])
    host.store.set(key, { cancelled: false, results: null, gamesToMembership: 2, gameIndex: 7, registered: true, memberBefore: false, early: true, reported: true })
    const { tick } = await import("./index")

    // When
    await tick(host)
    const first = structuredClone(host.store.get(key))
    await tick(host)
    const second = structuredClone(host.store.get(key))
    await tick(host)

    // Then
    expect(first).toMatchObject({ early: true, earned: 1 })
    expect(second).toMatchObject({ early: true, earned: 2 })
    expect(host.store.get(key)).toMatchObject({ results: null, reported: true, earned: 3 })
    expect(host.store.get(key)).not.toHaveProperty("early")
  })

  it("stores the picture of each collectible once the chest deals every claim, and reads it again a minute later while claims are pending", async () => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    const chain = await withChain(...Array.from({ length: 4 }, () => chainRead({ running: null })))
    const game = running()
    vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
    vi.mocked(chain.readEarned).mockResolvedValue(2)
    vi.mocked(chain.readCollectables)
      .mockResolvedValueOnce({ items: [OCTOPUS], pending: 1 })
      .mockResolvedValueOnce({ items: [OCTOPUS], pending: 1 })
      .mockResolvedValueOnce({ items: [OCTOPUS, OCTOPUS], pending: 0 })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 0, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: RESULTS, gamesToMembership: null, gameIndex: 7 })
    const { tick } = await import("./index")
    const recapWrites = () => vi.mocked(host.storage.writeJSON).mock.calls.filter(([written]) => written === key).length

    // When
    await tick(host)
    const counted = host.store.get(key)
    const countedWrites = recapWrites()
    await tick(host)
    const tooSoon = vi.mocked(chain.readCollectables).mock.calls.length
    vi.setSystemTime(Date.now() + 61_000)
    await tick(host)
    const stillPendingWrites = recapWrites()
    vi.setSystemTime(Date.now() + 61_000)
    await tick(host)
    vi.useRealTimers()

    // Then
    expect(counted).toMatchObject({ results: { earned: 2, collectables: null } })
    expect(tooSoon).toBe(1)
    expect(stillPendingWrites).toBe(countedWrites)
    expect(workerLogTexts(host).filter((text) => text === "Game 7 earned 2 collectibles.")).toHaveLength(1)
    expect(chain.readEarned).toHaveBeenCalledTimes(1)
    expect(chain.readCollectables).toHaveBeenCalledTimes(3)
    expect(host.store.get(key)).toMatchObject({ results: { earned: 2, collectables: [OCTOPUS, OCTOPUS] } })
  })

  it("stores an empty chest once it deals every claim, so the card settles and the chest is not read again", async () => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    const chain = await withChain(chainRead({ running: null }), chainRead({ running: null }))
    const game = running()
    vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
    vi.mocked(chain.readEarned).mockResolvedValue(2)
    vi.mocked(chain.readCollectables).mockResolvedValue({ items: [], pending: 0 })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 0, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: RESULTS, gamesToMembership: null, gameIndex: 7 })
    const { tick, settledCard } = await import("./index")

    // When
    await tick(host)
    vi.setSystemTime(Date.now() + 61_000)
    await tick(host)
    vi.useRealTimers()

    // Then
    expect(host.store.get(key)).toMatchObject({ results: { earned: 2, collectables: [] } })
    expect(settledCard(host.store.get(key) as never, UNSEEN)).toBe(true)
    expect(chain.readCollectables).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["answers nothing", () => Promise.resolve(null), "the chest read failed"],
    ["throws", () => Promise.reject(new Error("the hub hung up")), "the hub hung up"],
  ])("logs a chest read that %s once, and reads the chest again only after the booking retry wait", async (_, failing, reason) => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      const chain = await withChain(chainRead({ running: null }), chainRead({ running: null }), chainRead({ running: null }))
      const game = running()
      vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
      vi.mocked(chain.readEarned).mockResolvedValue(2)
      vi.mocked(chain.readCollectables).mockImplementation(failing)
      const host = fakeHost()
      const key = `jollity.wg.recap:${game.gamePlayTime}`
      host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 0, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
      host.store.set(key, { cancelled: false, results: RESULTS, gamesToMembership: null, gameIndex: 7 })
      const { tick } = await import("./index")

      // When
      await tick(host)
      vi.setSystemTime(Date.now() + 61_000)
      await tick(host)
      const withinWindow = vi.mocked(chain.readCollectables).mock.calls.length
      vi.setSystemTime(Date.now() + 10 * 60_000)
      await tick(host)

      // Then
      expect(withinWindow).toBe(1)
      expect(chain.readCollectables).toHaveBeenCalledTimes(2)
      expect(workerLogTexts(host).filter((text) => text === `The collectibles of game 7 could not be drawn: ${reason}.`)).toHaveLength(1)
      expect(host.store.get(key)).toMatchObject({ results: { earned: 2, collectables: null } })
    } finally {
      vi.useRealTimers()
    }
  })

  it("stores how many collectibles made a new member once Asset Hub answers, and asks again after the retry wait", async () => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    const chain = await withChain(chainRead({ running: null }), chainRead({ running: null }))
    const game = running()
    const newMember = { ...RESULTS, membership: { member: true, justBecameMember: true, gamesToMembership: null } }
    vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
    vi.mocked(chain.readEarned).mockResolvedValueOnce(null).mockResolvedValueOnce(3)
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 0, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: newMember, gamesToMembership: null, gameIndex: 7 })
    const { tick } = await import("./index")

    // When
    await tick(host)
    const afterFailure = host.store.get(key)
    vi.setSystemTime(Date.now() + 11 * 60_000)
    await tick(host)
    vi.useRealTimers()

    // Then
    expect(afterFailure).toEqual({ cancelled: false, results: newMember, gamesToMembership: null, gameIndex: 7 })
    expect(chain.readEarned).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), ADDRESS, 7)
    expect(host.store.get(key)).toMatchObject({ results: { earned: 3 } })
  })

  it("keeps the count it just stored when the same poll stores a prize change", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    const game = running()
    const waiting = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 3600, phase: "waiting" as const, won: false, claimable: false }
    const drawn = { ...waiting, phase: "drawn" as const, won: true, claimable: true }
    vi.mocked(chain.readPrize).mockResolvedValueOnce({ prize: drawn, drawIndex: 0 })
    vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
    vi.mocked(chain.readEarned).mockResolvedValue(3)
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    const newMember = { ...RESULTS, prize: waiting, membership: { member: true, justBecameMember: true, gamesToMembership: null } }
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: newMember, gamesToMembership: null, gameIndex: 7 })
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(host.store.get(key)).toMatchObject({ results: { earned: 3, prize: drawn } })
    expect(chain.readEarned).toHaveBeenCalledTimes(1)
  })

  it("waits the booking retry before counting again after a failed read, and logs the failure once", async () => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      const chain = await withChain(chainRead({ running: null }), chainRead({ running: null }), chainRead({ running: null }))
      const game = running()
      vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
      vi.mocked(chain.readEarned).mockResolvedValue(null)
      const host = fakeHost()
      const key = `jollity.wg.recap:${game.gamePlayTime}`
      const newMember = { ...RESULTS, membership: { member: true, justBecameMember: true, gamesToMembership: null } }
      host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 0, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
      host.store.set(key, { cancelled: false, results: newMember, gamesToMembership: null, gameIndex: 7 })
      const { tick } = await import("./index")

      // When
      await tick(host)
      vi.setSystemTime(Date.now() + 9 * 60_000)
      await tick(host)
      const withinWindow = vi.mocked(chain.readEarned).mock.calls.length
      vi.setSystemTime(Date.now() + 2 * 60_000)
      await tick(host)

      // Then
      expect(withinWindow).toBe(1)
      expect(chain.readEarned).toHaveBeenCalledTimes(2)
      expect(workerLogTexts(host).filter((text) => text.includes("could not be counted"))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("counts a new member game the poll no longer tracks when its card is drawn", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    const game = running({ gamePlayTime: nowSeconds() - 7 * 86_400 })
    vi.mocked(chain.connectAssetHub).mockResolvedValue({} as never)
    vi.mocked(chain.readEarned).mockResolvedValue(2)
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    const newMember = { ...RESULTS, membership: { member: true, justBecameMember: true, gamesToMembership: null } }
    host.store.set("jollity.wg.games", [])
    host.store.set(key, { cancelled: false, results: newMember, gamesToMembership: null, gameIndex: 3 })
    const handler = await renderHandler(host)

    // When
    handler({ messageId: "m8", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, vi.fn(), () => () => {})
    await flush()
    await flush()

    // Then
    expect(chain.readEarned).toHaveBeenCalledWith(expect.anything(), expect.anything(), ADDRESS, 3)
    expect(host.store.get(key)).toMatchObject({ results: { earned: 2 } })
  })

  it("keeps the stored prize when reading it again fails", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    const game = running()
    const claimable = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: true, claimable: true }
    vi.mocked(chain.readPrize).mockResolvedValueOnce(undefined)
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    const stored = { cancelled: false, results: { ...RESULTS, prize: claimable }, gamesToMembership: null, gameIndex: 7 }
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, stored)
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(chain.readPrize).toHaveBeenCalledTimes(1)
    expect(host.store.get(key)).toEqual(stored)
  })

  it("asks the chain whether a win was claimed once its winning ticket is gone, and stores the answer", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }), chainRead({ running: null }))
    const game = running()
    const claimable = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: true, claimable: true }
    const ticketGone = { ...claimable, ticket: "", won: false, claimable: false }
    vi.mocked(chain.readPrize).mockResolvedValue({ prize: ticketGone, drawIndex: 2 })
    vi.mocked(chain.readClaimed).mockResolvedValue(true)
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 3, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: { ...RESULTS, prize: claimable }, gamesToMembership: null, gameIndex: 7, drawIndex: 2 })
    const { tick } = await import("./index")

    // When
    await tick(host)
    await tick(host)

    // Then
    expect(chain.readClaimed).toHaveBeenCalledTimes(1)
    expect(chain.readClaimed).toHaveBeenCalledWith(expect.anything(), ADDRESS, 7, 2)
    expect(host.store.get(key)).toMatchObject({ results: { prize: { ...claimable, claimable: false, claimed: true } } })
    expect(workerLogTexts(host)).toContain("The prize of game 7 was claimed.")
  })

  it("leaves a win unclaimed when the claim read throws or cannot confirm the claim, and asks again on the next poll", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }), chainRead({ running: null }), chainRead({ running: null }))
    const game = running()
    const claimable = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: true, claimable: true }
    const ticketGone = { ...claimable, ticket: "", won: false, claimable: false }
    vi.mocked(chain.readPrize).mockResolvedValue({ prize: ticketGone, drawIndex: 0 })
    vi.mocked(chain.readClaimed).mockRejectedValueOnce(new Error("socket closed")).mockResolvedValueOnce(undefined).mockResolvedValueOnce(false)
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: { ...RESULTS, prize: claimable }, gamesToMembership: null, gameIndex: 7, drawIndex: 0 })
    const { tick } = await import("./index")

    // When: the claim read throws, then answers nothing, then answers no.
    await tick(host)
    await tick(host)
    await tick(host)

    // Then
    expect(chain.readClaimed).toHaveBeenCalledTimes(3)
    expect(host.store.get(key)).toMatchObject({ results: { prize: { ...claimable, claimable: false } } })
    expect(host.store.get(key)).not.toMatchObject({ results: { prize: { claimed: true } } })
  })

  it("stores the rest of the prize reading when the claim read throws", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    const game = running()
    const claimable = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: true, claimable: true }
    vi.mocked(chain.readPrize).mockResolvedValue({ prize: { ...claimable, ticket: "", won: false, claimable: false }, drawIndex: 0 })
    vi.mocked(chain.readClaimed).mockRejectedValue(new Error("socket closed"))
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: { ...RESULTS, prize: claimable }, gamesToMembership: null, gameIndex: 7, drawIndex: 0 })
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(host.store.get(key)).toMatchObject({ results: { prize: { ...claimable, claimable: false } } })
    expect(host.store.get(key)).not.toMatchObject({ results: { prize: { claimed: true } } })
  })

  it("does not ask about a claim for a ticket that never won", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    const game = running()
    const lost = { amountUsd: 200, ticket: "", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: false, claimable: false }
    vi.mocked(chain.readPrize).mockResolvedValue({ prize: lost, drawIndex: 0 })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: { ...RESULTS, prize: { ...lost, phase: "waiting" as const } }, gamesToMembership: null, gameIndex: 7, drawIndex: 0 })
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(chain.readClaimed).not.toHaveBeenCalled()
  })

  it("does not ask about a claim while the winning ticket is still on the chain", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    const game = running()
    const claimable = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: true, claimable: true }
    vi.mocked(chain.readPrize).mockResolvedValue({ prize: claimable, drawIndex: 0 })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: { ...RESULTS, prize: claimable }, gamesToMembership: null, gameIndex: 7, drawIndex: 0 })
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(chain.readPrize).toHaveBeenCalledTimes(1)
    expect(chain.readClaimed).not.toHaveBeenCalled()
  })

  it("reads an unread prize again and stores it", async () => {
    // Given
    const chain = await withChain(chainRead({ running: null }))
    const game = running()
    const drawn = { amountUsd: 200, ticket: "", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: false, claimable: false }
    vi.mocked(chain.readPrize).mockResolvedValueOnce({ prize: drawn, drawIndex: 0 })
    const host = fakeHost()
    const key = `jollity.wg.recap:${game.gamePlayTime}`
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(key, { cancelled: false, results: RESULTS, gamesToMembership: null, gameIndex: 7, prizeUnread: true })
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(host.store.get(key)).toEqual({ cancelled: false, results: { ...RESULTS, prize: drawn }, gamesToMembership: null, gameIndex: 7, drawIndex: 0 })
  })

  it("keeps tracking an older game while its prize draw can still change", async () => {
    // Given
    const next = running({ index: 11, gamePlayTime: nowSeconds() + 7200 })
    await withChain(chainRead({ running: next }))
    const host = fakeHost()
    const seenGame = (index: number) => ({ index, gamePlayTime: 1_700_000_000 + index, airdropsScheduled: 1, endsAt: 1_700_000_600, registered: true, memberBefore: false })
    host.store.set("jollity.wg.games", [seenGame(7), seenGame(8), seenGame(9), seenGame(10)])
    const drawn = { amountUsd: 200, ticket: "ab", drawAt: 1_700_003_600, phase: "drawn" as const, won: true, claimable: true }
    host.store.set(`jollity.wg.recap:${seenGame(7).gamePlayTime}`, { cancelled: false, results: { ...RESULTS, prize: drawn }, gamesToMembership: null })
    host.store.set(`jollity.wg.recap:${seenGame(8).gamePlayTime}`, { cancelled: false, results: null, gamesToMembership: null })
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect((host.store.get("jollity.wg.games") as { index: number }[]).map((game) => game.index)).toEqual([7, 9, 10, 11])
  })

  it("reads the membership once a minute rather than on every poll", async () => {
    // Given
    const chain = await withChain(chainRead(), chainRead(), chainRead(), chainRead())
    const host = fakeHost()
    const { tick } = await import("./index")

    // When
    for (let poll = 0; poll < 4; poll++) await tick(host)

    // Then
    expect(chain.readStanding).toHaveBeenCalledTimes(1)
  })

  it("reads membership for the banner of the card", async () => {
    // Given
    const chain = await withChain(chainRead())
    vi.mocked(chain.readStanding).mockResolvedValue({ tag: "Member", gamesToMembership: null })
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)

    // Then
    expect(chain.readStanding).toHaveBeenCalledWith(expect.anything(), ADDRESS)
    expect(host.store.get("jollity.wg.games")).toMatchObject([{ index: 7, memberBefore: true }])
  })
})

describe("reminder booking works", () => {
  const times = (host: WorkerHost) => vi.mocked(host.notifications.push).mock.calls.map(([input]) => input.scheduledAt)

  it("tells a registered player the game is starting, 5 minutes, 1 minute and 20 seconds out", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registered: true })

    // When
    await scheduleReminders(host, chainRead({ running: game }))
    await flush()

    // Then
    const start = game.gamePlayTime * 1000
    expect(times(host)).toEqual([start - 300_000, start - 60_000, start - 20_000])
    expect(pushedTexts(host)[0]).toMatch(/^Join the \w+ game\. The game starts in 5 min! Join for free to win amazing prizes!$/)
    expect(pushedTexts(host)[1]).toBe("Game starting now! The game is about to start! Join and get ready for fun and rewards!")
    expect(pushedTexts(host)[2]).toBe("Game Starts in 20 Seconds! The game is starting! Jump in!")
    expect(vi.mocked(host.notifications.push).mock.calls.map(([input]) => input.deeplink)).toEqual([
      "/?jollity-notification=reminder&moment=start-5m",
      "/?jollity-notification=reminder&moment=start-1m",
      "/?jollity-notification=reminder&moment=start-20s",
    ])
    expect(workerLogTexts(host)).toContain(
      `Notification booking for game at ${game.gamePlayTime} (registered true): 3 of 3 reminder ids, complete (3 with deeplink, 0 without).`,
    )
    expect(workerLogTexts(host).join(" ")).not.toMatch(/\b1\s*,\s*1\s*,\s*1\b/)
  })

  it("books a reminder without a deeplink when the host rejects the linked form", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registered: true })
    vi.mocked(host.notifications.push).mockRejectedValueOnce(new Error("deeplinks unsupported")).mockResolvedValue(42)

    // When
    await scheduleReminders(host, chainRead({ running: game }))
    await flush()

    // Then
    expect(host.notifications.push).toHaveBeenCalledTimes(4)
    expect(vi.mocked(host.notifications.push).mock.calls[0]?.[0].deeplink).toBe("/?jollity-notification=reminder&moment=start-5m")
    expect(vi.mocked(host.notifications.push).mock.calls[1]?.[0].deeplink).toBeUndefined()
    expect(workerLogTexts(host)).toContain(
      `Notification booking for game at ${game.gamePlayTime} (registered true): 3 of 3 reminder ids, complete (2 with deeplink, 1 without).`,
    )
  })

  it("tells an unregistered player registration is open, in a few seconds, and warns an hour and ten minutes before it closes", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })

      // When
      await scheduleReminders(host, chainRead({ running: game }))

      // Then
      expect(times(host)).toEqual([Date.now() + 5_000, game.registrationEnds * 1000 - 3_600_000, game.registrationEnds * 1000 - 600_000])
      expect(pushedTexts(host)).toEqual([OPENS_NOTICE, HOUR_NOTICE, TEN_MINUTES_NOTICE])
    } finally {
      vi.useRealTimers()
    }
  })

  it("books no closing notice on a window no longer than its lead, an hour now and five minutes next, since the opening notice stands in for it", async () => {
    // Given
    const { remindersFor } = await import("./index")
    const closesAt = nowSeconds() + 3000
    const next = closesAt + 86_400
    const read = chainRead({
      running: running({ registrationStarts: closesAt - 3600, registrationEnds: closesAt }),
      upcoming: [{ gamePlayTime: next, registrationStarts: next - 90 - 300, registrationEnds: next - 90, reportingEnds: next + 600 }],
    })

    // When
    const moments = remindersFor(read)?.reminders.map((reminder) => reminder.moment)

    // Then
    expect(moments).toEqual([`opens:${read.running!.gamePlayTime}`, `close-10m:${read.running!.gamePlayTime}`, `opens:${next}`])
  })

  it("announces the next scheduled game in a few seconds while no game runs, and an hour and ten minutes before its registration closes", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const next = nowSeconds() + 86_400

      // When
      await scheduleReminders(
        host,
        chainRead({ running: null, upcoming: [{ gamePlayTime: next, registrationStarts: next - 7200, registrationEnds: next - 90, reportingEnds: next + 600 }] }),
      )

      // Then
      expect(times(host)).toEqual([Date.now() + 5_000, (next - 90 - 3600) * 1000, (next - 90 - 600) * 1000])
      expect(pushedTexts(host)).toEqual([OPENS_NOTICE, HOUR_NOTICE, TEN_MINUTES_NOTICE])
    } finally {
      vi.useRealTimers()
    }
  })

  it("holds the next game's opening notice until ten minutes after the settling game ends, and books it in a few seconds once they have passed", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { remindersFor } = await import("./index")
      const settledAt = nowSeconds()
      const next = settledAt + 86_400
      const settling = running({ phase: "settling", reportingEnds: settledAt })
      const upcoming = { gamePlayTime: next, registrationStarts: settledAt - 60, registrationEnds: next - 90, reportingEnds: next + 600 }

      // When
      const afterSettlement = remindersFor(chainRead({ running: settling, upcoming: [upcoming] }))
      const quietOver = remindersFor(chainRead({ running: { ...settling, reportingEnds: settledAt - 600 }, upcoming: [upcoming] }))

      // Then
      expect(afterSettlement?.reminders[0]?.at).toBe((settledAt + 600) * 1000)
      expect(quietOver?.reminders[0]?.at).toBe(Date.now() + 5_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it("books a fresh worker's opening notice in a few seconds while the running game is being cancelled", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { remindersFor } = await import("./index")
      const next = nowSeconds() + 86_400
      const cancelled = running({ phase: "cancelled" })
      const upcoming = { gamePlayTime: next, registrationStarts: next - 7200, registrationEnds: next - 90, reportingEnds: next + 600 }

      // When
      const due = remindersFor(chainRead({ running: cancelled, upcoming: [upcoming] }))

      // Then
      expect(due?.reminders[0]?.at).toBe(Date.now() + 5_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(["shuffle", "reporting"] as const)("holds the opening notice of the next game until ten minutes after a game in %s starts settling", async (phase) => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { remindersFor } = await import("./index")
      const next = nowSeconds() + 86_400
      const game = running({ phase })
      const upcoming = { gamePlayTime: next, registrationStarts: next - 7200, registrationEnds: next - 90, reportingEnds: next + 600 }

      // When
      const due = remindersFor(chainRead({ running: game, upcoming: [upcoming] }))

      // Then
      expect(due?.reminders[0]?.at).toBe((game.reportingEnds + 600) * 1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not re-book a held opening notice earlier after the next game becomes current", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const settledAt = nowSeconds()
      const next = settledAt + 86_400
      const upcoming = { gamePlayTime: next, registrationStarts: settledAt - 60, registrationEnds: next - 90, reportingEnds: next + 600 }
      const settling = running({ phase: "settling", reportingEnds: settledAt })
      await scheduleReminders(host, chainRead({ running: settling, upcoming: [upcoming] }))

      // When
      await scheduleReminders(
        host,
        chainRead({ running: running({ gamePlayTime: next, registrationEnds: next - 90 }), upcoming: [] }),
      )

      // Then
      expect(times(host)).toEqual([(settledAt + 600) * 1000, (next - 90 - 3600) * 1000, (next - 90 - 600) * 1000])
    } finally {
      vi.useRealTimers()
    }
  })

  it("delays a fresh worker's opening notice from the latest stored game when registration is current", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const settledAt = nowSeconds()
      const next = settledAt + 86_400
      host.store.set("jollity.wg.games", [
        { index: 7, gamePlayTime: settledAt - 600, airdropsScheduled: 1, endsAt: settledAt, registered: true, memberBefore: true },
      ] satisfies SeenGame[])

      // When
      await scheduleReminders(
        host,
        chainRead({ running: running({ index: 8, gamePlayTime: next, registrationEnds: next - 90 }), upcoming: [] }),
      )

      // Then
      expect(times(host)).toEqual([(settledAt + 600) * 1000, (next - 90 - 3600) * 1000, (next - 90 - 600) * 1000])
    } finally {
      vi.useRealTimers()
    }
  })

  it("delays a BetweenGames opening notice from the latest stored game", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const settledAt = nowSeconds()
      const next = settledAt + 86_400
      host.store.set("jollity.wg.games", [
        { index: 7, gamePlayTime: settledAt - 600, airdropsScheduled: 1, endsAt: settledAt, registered: true, memberBefore: true },
      ] satisfies SeenGame[])

      // When
      await scheduleReminders(
        host,
        chainRead({
          running: null,
          upcoming: [{ gamePlayTime: next, registrationStarts: settledAt - 60, registrationEnds: next - 90, reportingEnds: next + 600 }],
        }),
      )

      // Then
      expect(times(host)).toEqual([(settledAt + 600) * 1000, (next - 90 - 3600) * 1000, (next - 90 - 600) * 1000])
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a refused opening notice's later time when retrying after the next game becomes current", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const settledAt = nowSeconds()
      const next = settledAt + 86_400
      const upcoming = { gamePlayTime: next, registrationStarts: settledAt - 60, registrationEnds: next - 90, reportingEnds: next + 600 }
      const refused = new Error("notifications refused")
      vi.mocked(host.notifications.push).mockRejectedValueOnce(refused).mockRejectedValueOnce(refused).mockResolvedValue(41)
      await scheduleReminders(host, chainRead({ running: running({ phase: "settling", reportingEnds: settledAt }), upcoming: [upcoming] }))
      const heldAt = (settledAt + 600) * 1000

      // When
      await scheduleReminders(
        host,
        chainRead({ running: running({ index: 8, gamePlayTime: next, registrationEnds: next - 90 }), upcoming: [] }),
        false,
        true,
      )

      // Then
      expect(vi.mocked(host.notifications.push).mock.calls.at(-1)?.[0].scheduledAt).toBe(heldAt)
      expect(host.store.get("jollity.wg.notifs")).toMatchObject({
        moments: { [`opens:${next}`]: { id: 41, at: heldAt } },
        complete: true,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("books the opening notice when the record read takes longer than its few seconds", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given: a store that answers six seconds late
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const read = host.storage.readJSON
      host.storage.readJSON = vi.fn(async (key: string) => {
        vi.setSystemTime(Date.now() + 6_000)
        return read(key)
      }) as WorkerHost["storage"]["readJSON"]
      const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
      const opensAt = Date.now() + 5_000

      // When
      await scheduleReminders(host, chainRead({ running: game }))

      // Then
      expect(times(host)).toEqual([opensAt, game.registrationEnds * 1000 - 3_600_000, game.registrationEnds * 1000 - 600_000])
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels the ids of a record that kept no moments, and books afresh", async () => {
    // Given: the record of a worker that stored ids alone
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
    host.store.set("jollity.wg.notifs", { gamePlayTime: game.gamePlayTime, registered: false, ids: [9, 10], complete: true })

    // When
    await scheduleReminders(host, chainRead({ running: game }))

    // Then
    expect(vi.mocked(host.notifications.cancel).mock.calls.map(([id]) => id)).toEqual([9, 10])
    expect(host.notifications.push).toHaveBeenCalledTimes(3)
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ complete: true, ids: [1, 1, 1] })
  })

  it("books the notices of a game an older worker announced once its registration opens, and cancels nothing", async () => {
    // Given: the complete record an older worker left for the announced game, whose registration is now open
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const next = nowSeconds() + 86_400
    host.store.set("jollity.wg.notifs", {
      gamePlayTime: next,
      registered: false,
      hostReminds: false,
      ids: [9],
      moments: { opens: { id: 9, at: Date.now() - 12_000 } },
      stale: [],
      complete: true,
    })

    // When
    await scheduleReminders(host, chainRead({ running: running({ gamePlayTime: next, registrationEnds: next - 90 }) }))

    // Then
    expect(pushedTexts(host)).toEqual([OPENS_NOTICE, HOUR_NOTICE, TEN_MINUTES_NOTICE])
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ complete: true, ids: [1, 1, 1] })
  })

  it("books the opening and closing notices of every scheduled game, and keeps them when that game becomes the running one", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given: a game closing its registration within the hour and two more on the schedule
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const game = running({ registrationEnds: nowSeconds() + 1800 })
      const second = game.gamePlayTime + 86_400
      const third = second + 86_400
      const schedule = [
        { gamePlayTime: second, registrationStarts: second - 7200, registrationEnds: second - 90, reportingEnds: second + 600 },
        { gamePlayTime: third, registrationStarts: third - 7200, registrationEnds: third - 90, reportingEnds: third + 600 },
      ]
      for (const id of [41, 42, 43, 44, 45, 46, 47, 48]) vi.mocked(host.notifications.push).mockResolvedValueOnce(id)
      await scheduleReminders(host, chainRead({ running: game, upcoming: schedule }))
      const opened = Date.now() + 5_000

      // When: a day on, the second game is the one in registration
      vi.setSystemTime(second * 1000 - 7000 * 1000)
      await scheduleReminders(
        host,
        chainRead({ running: running({ index: 8, gamePlayTime: second, registrationEnds: second - 90 }), upcoming: schedule.slice(1) }),
      )

      // Then: the second game opens ten minutes after the first settles, the third ten minutes after the second
      expect(times(host)).toEqual([
        opened,
        (game.registrationEnds - 600) * 1000,
        (game.reportingEnds + 600) * 1000,
        (second - 90 - 3600) * 1000,
        (second - 90 - 600) * 1000,
        (second + 600 + 600) * 1000,
        (third - 90 - 3600) * 1000,
        (third - 90 - 600) * 1000,
      ])
      expect(host.notifications.cancel).not.toHaveBeenCalled()
      expect(host.store.get("jollity.wg.notifs")).toMatchObject({ gamePlayTime: second, complete: true, ids: [43, 44, 45, 46, 47, 48] })
    } finally {
      vi.useRealTimers()
    }
  })

  it("books the opening notice of each scheduled game after the game before it on the schedule, and only the first after the stored one", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given: three games on the schedule, and the last game played stored
      const { remindersFor } = await import("./index")
      const settledAt = nowSeconds() - 60
      const first = settledAt + 3000
      const second = first + 1200
      const third = second + 1200
      const schedule = [first, second, third].map((gamePlayTime) => ({
        gamePlayTime,
        registrationStarts: gamePlayTime - 390,
        registrationEnds: gamePlayTime - 90,
        reportingEnds: gamePlayTime + 600,
      }))

      // When
      const afterStored = remindersFor(chainRead({ running: null, upcoming: schedule }), false, settledAt)
      const freshWorker = remindersFor(chainRead({ running: null, upcoming: schedule }))

      // Then
      const opens = (due: ReturnType<typeof remindersFor>) => due?.reminders.filter((reminder) => reminder.moment.startsWith("opens:")).map((reminder) => reminder.at)
      expect(opens(afterStored)).toEqual([(settledAt + 600) * 1000, (first + 600 + 600) * 1000, (second + 600 + 600) * 1000])
      expect(opens(freshWorker)).toEqual([Date.now() + 5_000, (first + 600 + 600) * 1000, (second + 600 + 600) * 1000])
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels the notices of a game that leaves the schedule", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const next = nowSeconds() + 86_400
      const schedule = [{ gamePlayTime: next, registrationStarts: next - 7200, registrationEnds: next - 90, reportingEnds: next + 600 }]
      vi.mocked(host.notifications.push).mockResolvedValueOnce(41).mockResolvedValueOnce(42).mockResolvedValueOnce(43)
      await scheduleReminders(host, chainRead({ running: null, upcoming: schedule }))

      // When: the game is rescheduled a day later
      const later = next + 86_400
      await scheduleReminders(
        host,
        chainRead({ running: null, upcoming: [{ gamePlayTime: later, registrationStarts: later - 7200, registrationEnds: later - 90, reportingEnds: later + 600 }] }),
      )

      // Then
      expect(vi.mocked(host.notifications.cancel).mock.calls.map(([id]) => id).sort()).toEqual([41, 42, 43])
      expect(times(host).slice(3)).toEqual([Date.now() + 5_000, (later - 90 - 3600) * 1000, (later - 90 - 600) * 1000])
      expect(host.store.get("jollity.wg.notifs")).toMatchObject({ gamePlayTime: later, complete: true, ids: [1, 1, 1] })
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels the notices of a game withdrawn from the schedule while the next game stays", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const next = nowSeconds() + 86_400
    const after = next + 86_400
    const schedule = [
      { gamePlayTime: next, registrationStarts: next - 7200, registrationEnds: next - 90, reportingEnds: next + 600 },
      { gamePlayTime: after, registrationStarts: after - 7200, registrationEnds: after - 90, reportingEnds: after + 600 },
    ]
    for (const id of [41, 42, 43, 44, 45, 46]) vi.mocked(host.notifications.push).mockResolvedValueOnce(id)
    await scheduleReminders(host, chainRead({ running: null, upcoming: schedule }))

    // When: the second game is withdrawn
    await scheduleReminders(host, chainRead({ running: null, upcoming: schedule.slice(0, 1) }))

    // Then
    expect(vi.mocked(host.notifications.cancel).mock.calls).toEqual([[44], [45], [46]])
    expect(host.notifications.push).toHaveBeenCalledTimes(6)
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ gamePlayTime: next, complete: true, ids: [41, 42, 43] })
  })

  it("keeps the notices of the scheduled games when the player signs up for the running one", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
    const next = game.gamePlayTime + 86_400
    const schedule = [{ gamePlayTime: next, registrationStarts: next - 7200, registrationEnds: next - 90, reportingEnds: next + 600 }]
    for (const id of [41, 42, 43, 44, 45, 46]) vi.mocked(host.notifications.push).mockResolvedValueOnce(id)
    await scheduleReminders(host, chainRead({ running: game, upcoming: schedule }))

    // When
    await scheduleReminders(host, chainRead({ running: { ...game, registered: true }, upcoming: schedule }))

    // Then: the three notices of the running game go, the three of the next game stay
    expect(vi.mocked(host.notifications.cancel).mock.calls.map(([id]) => id)).toEqual([41, 42, 43])
    expect(host.notifications.push).toHaveBeenCalledTimes(9)
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ registered: true, complete: true, ids: [44, 45, 46, 1, 1, 1] })
  })

  it("leaves the booking incomplete when a push times out, and does not push that moment again on the retry", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const { CallDeadlineError } = await import("./state")
      const host = fakeHost()
      const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
      vi.mocked(host.notifications.push).mockRejectedValueOnce(new CallDeadlineError("No answer within 45000ms."))
      await scheduleReminders(host, chainRead({ running: game }))
      const recordAfterTheTimeout = host.store.get("jollity.wg.notifs")

      // When
      vi.setSystemTime(Date.now() + 11 * 60_000)
      await scheduleReminders(host, chainRead({ running: game }))

      // Then
      expect(recordAfterTheTimeout).toMatchObject({ complete: false, ids: [1, 1] })
      expect(host.notifications.push).toHaveBeenCalledTimes(3)
      expect(workerLogTexts(host)).toContain(
        `Notification booking for game at ${game.gamePlayTime} (registered false): 2 of 3 reminder ids, incomplete; retry scheduled (2 with deeplink, 0 without).`,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("leaves the booking incomplete when the push without a deeplink times out, and does not push that moment again on the retry", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const { CallDeadlineError } = await import("./state")
      const host = fakeHost()
      const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
      vi.mocked(host.notifications.push)
        .mockRejectedValueOnce(new Error("deeplinks unsupported"))
        .mockRejectedValueOnce(new CallDeadlineError("No answer within 45000ms."))
      await scheduleReminders(host, chainRead({ running: game }))
      const recordAfterTheTimeout = host.store.get("jollity.wg.notifs")

      // When
      vi.setSystemTime(Date.now() + 11 * 60_000)
      await scheduleReminders(host, chainRead({ running: game }))

      // Then
      expect(recordAfterTheTimeout).toMatchObject({ complete: false, ids: [1, 1] })
      expect(host.notifications.push).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it("swaps the reminders when the player signs up, cancelling the opening notice and both closing notices first", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
    for (const id of [41, 42, 43]) vi.mocked(host.notifications.push).mockResolvedValueOnce(id)
    await scheduleReminders(host, chainRead({ running: game }))

    // When
    await scheduleReminders(host, chainRead({ running: { ...game, registered: true } }))

    // Then
    expect(vi.mocked(host.notifications.cancel).mock.calls.map(([id]) => id)).toEqual([41, 42, 43])
    const cancelled = vi.mocked(host.notifications.cancel).mock.invocationCallOrder[0]!
    const rebooked = vi.mocked(host.notifications.push).mock.invocationCallOrder[3]!
    expect(cancelled).toBeLessThan(rebooked)
    expect(pushedTexts(host)).toHaveLength(6)
  })

  it("books only the reminder whose push failed again ten minutes later, and cancels none", async () => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registered: true })
    vi.mocked(host.notifications.push)
      .mockResolvedValueOnce(41)
      .mockRejectedValueOnce(new Error("deeplink rejected"))
      .mockRejectedValueOnce(new Error("no permission"))
    await scheduleReminders(host, chainRead({ running: game }))
    await flush()

    // When
    await scheduleReminders(host, chainRead({ running: game }))
    const pushesBeforeTheWait = vi.mocked(host.notifications.push).mock.calls.length
    vi.setSystemTime(Date.now() + 11 * 60_000)
    await scheduleReminders(host, chainRead({ running: game }))
    vi.useRealTimers()

    // Then
    const start = game.gamePlayTime * 1000
    expect(pushesBeforeTheWait).toBe(4)
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(host.notifications.push).toHaveBeenCalledTimes(5)
    expect(times(host).at(-1)).toBe(start - 60_000)
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ complete: true, ids: [41, 1, 1] })
    expect(workerLogTexts(host)).toContain(
      `Notification booking for game at ${game.gamePlayTime} (registered true): 2 of 3 reminder ids, incomplete; retry scheduled (2 with deeplink, 0 without).`,
    )
  })

  it("books the reminders once when the claim write lands after its deadline, without waiting for the retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      // Given: the first write of the record lands, but answers after the deadline
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const write = host.storage.writeJSON
      let lateOnce = true
      host.storage.writeJSON = vi.fn(async (key: string, value: unknown) => {
        await write(key, value)
        if (key === "jollity.wg.notifs" && lateOnce) {
          lateOnce = false
          await new Promise(() => {})
        }
      })
      const read = chainRead({ running: running({ registered: true }) })
      const first = scheduleReminders(host, read)
      await vi.advanceTimersByTimeAsync(46_000)
      await first
      const pushedOnTheClaim = vi.mocked(host.notifications.push).mock.calls.length

      // When
      vi.setSystemTime(Date.now() + 11 * 60_000)
      await scheduleReminders(host, read)
      vi.setSystemTime(Date.now() + 11 * 60_000)
      await scheduleReminders(host, read)

      // Then
      expect(pushedOnTheClaim).toBe(3)
      expect(host.notifications.push).toHaveBeenCalledTimes(3)
      expect(host.store.get("jollity.wg.notifs")).toMatchObject({ complete: true, ids: [1, 1, 1] })
    } finally {
      vi.useRealTimers()
    }
  })

  it("a booking killed inside its push loop books the moments it never reached on the retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      // Given: the record a worker left after its first push, killed before the second
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const game = running({ registered: true })
      const start = game.gamePlayTime * 1000
      host.store.set("jollity.wg.notifs", {
        gamePlayTime: game.gamePlayTime,
        registered: true,
        hostReminds: false,
        ids: [9],
        moments: {
          [`start-5m:${game.gamePlayTime}`]: { id: 9, at: start - 300_000 },
          [`start-1m:${game.gamePlayTime}`]: { id: null, at: start - 60_000, pushing: true },
          [`start-20s:${game.gamePlayTime}`]: { id: null, at: start - 20_000 },
        },
        stale: [],
        complete: false,
        retryAt: Date.now() - 1,
      })

      // When
      await scheduleReminders(host, chainRead({ running: game }))

      // Then: the one whose push started may be booked, so only the untouched one goes
      expect(times(host)).toEqual([start - 20_000])
    } finally {
      vi.useRealTimers()
    }
  })

  it("never books a reminder twice when a push answers after the deadline, leaving the opening notice that hung and the two closing notices", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const live: number[] = []
      let next = 1
      vi.mocked(host.notifications.push)
        .mockImplementationOnce(() => {
          live.push(next++)
          return new Promise(() => {})
        })
        .mockImplementation(async () => {
          live.push(next)
          return next++
        })
      vi.mocked(host.notifications.cancel).mockImplementation(async (id: number) => {
        live.splice(live.indexOf(id), 1)
      })
      const read = chainRead({ running: running({ registered: false }) })
      const first = scheduleReminders(host, read)
      await vi.advanceTimersByTimeAsync(46_000)
      await first

      // When
      vi.setSystemTime(Date.now() + 11 * 60_000)
      await scheduleReminders(host, read)

      // Then
      expect(live).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a Register tap during the poll's booking leaves three live reminders", async () => {
    // Given
    const { scheduleReminders, remindersInPlace } = await import("./index")
    const host = fakeHost()
    const live = new Set<number>()
    let next = 1
    vi.mocked(host.notifications.push).mockImplementation(async () => {
      await flush()
      const id = next++
      live.add(id)
      return id
    })
    vi.mocked(host.notifications.cancel).mockImplementation(async (id: number) => {
      live.delete(id)
    })
    const game = running({ registered: false })

    // When: the poll books for the sign-up under way while the gate of the tap books too
    await Promise.all([scheduleReminders(host, chainRead({ running: { ...game, registered: true } })), remindersInPlace(host, chainRead({ running: game }), false)])

    // Then
    expect(live.size).toBe(3)
  })

  it("a refused cancel is tried again ten minutes later, with no change of booking", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
      vi.mocked(host.notifications.push).mockResolvedValueOnce(1).mockResolvedValueOnce(41)
      await scheduleReminders(host, chainRead({ running: game }))
      vi.mocked(host.notifications.cancel).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("busy"))
      const registered = chainRead({ running: { ...game, registered: true } })
      await scheduleReminders(host, registered)

      // When
      vi.setSystemTime(Date.now() + 11 * 60_000)
      await scheduleReminders(host, registered)

      // Then
      expect(vi.mocked(host.notifications.cancel).mock.calls.filter(([id]) => id === 41)).toHaveLength(2)
      expect(host.notifications.push).toHaveBeenCalledTimes(6)
      expect(host.store.get("jollity.wg.notifs")).toMatchObject({ complete: true, stale: [] })
    } finally {
      vi.useRealTimers()
    }
  })

  it("a refused cancel waits for the retry rather than the next poll", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
      vi.mocked(host.notifications.push).mockResolvedValueOnce(1).mockResolvedValueOnce(41)
      await scheduleReminders(host, chainRead({ running: game }))
      vi.mocked(host.notifications.cancel).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("busy"))
      const registered = chainRead({ running: { ...game, registered: true } })
      await scheduleReminders(host, registered)

      // When
      vi.setSystemTime(Date.now() + 60_000)
      await scheduleReminders(host, registered)

      // Then
      expect(vi.mocked(host.notifications.cancel).mock.calls.filter(([id]) => id === 41)).toHaveLength(1)
      expect(host.notifications.push).toHaveBeenCalledTimes(6)
      expect(host.store.get("jollity.wg.notifs")).toMatchObject({ complete: false, stale: [{ id: 41 }] })
    } finally {
      vi.useRealTimers()
    }
  })

  it("a refused cancel is tried again on the next booking", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })
    vi.mocked(host.notifications.push).mockResolvedValueOnce(41)
    await scheduleReminders(host, chainRead({ running: game }))
    vi.mocked(host.notifications.cancel).mockRejectedValueOnce(new Error("busy"))
    await scheduleReminders(host, chainRead({ running: { ...game, registered: true } }))

    // When: the host takes over the reminder of the registered player
    await scheduleReminders(host, chainRead({ running: { ...game, registered: true } }), true)

    // Then
    expect(vi.mocked(host.notifications.cancel).mock.calls.filter(([id]) => id === 41)).toHaveLength(2)
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ hostReminds: true, ids: [], stale: [] })
  })

  it("keeps the booked reminders through a poll that could not read the registration", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registered: true })
    await scheduleReminders(host, chainRead({ running: game }))

    // When
    await scheduleReminders(host, chainRead({ running: { ...game, registered: null } }))

    // Then
    expect(host.notifications.push).toHaveBeenCalledTimes(3)
    expect(host.notifications.cancel).not.toHaveBeenCalled()
  })

  it("skips the reminders already due", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registered: true, gamePlayTime: nowSeconds() + 120, registrationEnds: nowSeconds() + 30 })

    // When
    await scheduleReminders(host, chainRead({ running: game }))

    // Then
    expect(times(host)).toEqual([game.gamePlayTime * 1000 - 60_000, game.gamePlayTime * 1000 - 20_000])
  })

  it("books the reminder of an unregistered player on the device clock too", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })

      // When
      await scheduleReminders(host, chainRead({ running: game, clockOffsetMs: -600_000 }))

      // Then
      expect(times(host)).toEqual([
        Date.now() + 5_000,
        game.registrationEnds * 1000 + 600_000 - 3_600_000,
        game.registrationEnds * 1000 + 600_000 - 600_000,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("does nothing for the game and sign-up already booked", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registered: true })
    await scheduleReminders(host, chainRead({ running: game }))

    // When
    await scheduleReminders(host, chainRead({ running: game }))

    // Then
    expect(host.notifications.push).toHaveBeenCalledTimes(3)
    expect(host.notifications.cancel).not.toHaveBeenCalled()
  })

  it("does nothing once a booked reminder has fired", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      // Given
      const { scheduleReminders } = await import("./index")
      const host = fakeHost()
      const game = running({ registered: true })
      await scheduleReminders(host, chainRead({ running: game }))
      const writes = () => vi.mocked(host.storage.writeJSON).mock.calls.filter(([key]) => key === "jollity.wg.notifs").length
      const writesOfTheBooking = writes()

      // When: the reminder five minutes out has fired
      vi.setSystemTime(game.gamePlayTime * 1000 - 4 * 60_000)
      await scheduleReminders(host, chainRead({ running: game }))

      // Then
      expect(writes()).toBe(writesOfTheBooking)
      expect(host.notifications.push).toHaveBeenCalledTimes(3)
      expect(host.notifications.cancel).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels the reminders of a registered player whose game moves, and books the new ones", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registered: true })
    vi.mocked(host.notifications.push).mockResolvedValueOnce(41).mockResolvedValueOnce(42).mockResolvedValueOnce(43)
    await scheduleReminders(host, chainRead({ running: game }))

    // When: the game is moved a day later
    const later = game.gamePlayTime + 86_400
    await scheduleReminders(host, chainRead({ running: { ...game, gamePlayTime: later } }))

    // Then
    expect(vi.mocked(host.notifications.cancel).mock.calls.map(([id]) => id).sort()).toEqual([41, 42, 43])
    expect(times(host).slice(3)).toEqual([later * 1000 - 300_000, later * 1000 - 60_000, later * 1000 - 20_000])
  })

  const bookedNotices = (host: WorkerHost & { store: Map<string, unknown> }) =>
    host.store.get("jollity.wg.notifs") as Required<Scheduled>

  const appRegistration = (gameIndex: number, phase: GameRegistration["phase"]): GameRegistration => ({
    gameIndex,
    phase,
    surface: "app",
    at: Date.now(),
    attempt: Date.now(),
  })

  async function chatHoldingTheOpeningNotice() {
    const game = running()
    const previousGameEnd = nowSeconds() - 120
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    const { tick } = await import("./index")
    const host = fakeHost()
    host.store.set("jollity.wg.games", [
      { index: game.index - 1, gamePlayTime: previousGameEnd - 600, airdropsScheduled: 0, endsAt: previousGameEnd, registered: false, memberBefore: false },
    ])
    vi.mocked(host.notifications.push).mockResolvedValueOnce(41).mockResolvedValueOnce(42).mockResolvedValueOnce(43)
    await tick(host)
    const opening = `opens:${game.gamePlayTime}`
    return { chain, game, host, opening, held: bookedNotices(host).moments[opening], opensAt: (previousGameEnd + 600) * 1000, tick }
  }

  it.each(["registering", "sent", "registered"] as const)(
    "cancels the opening notice on the poll that finds the sign-up of the app %s, with the chain still reading the player out",
    async (phase) => {
      // Given
      const { chain, game, held, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
      host.store.set(GAME_REGISTRATION_KEY, appRegistration(game.index, phase))

      // When
      await tick(host)

      // Then
      expect(chain.readGame).toHaveBeenCalledTimes(2)
      expect(held).toMatchObject({ id: 41, at: opensAt })
      expect(host.notifications.cancel).toHaveBeenCalledWith(41)
      expect(bookedNotices(host).registered).toBe(true)
      expect(Object.keys(bookedNotices(host).moments)).not.toContain(opening)
    },
  )

  it("cancels the opening notice on the poll that finds the sign-up of the app, with the chain unable to read the player", async () => {
    // Given
    const { chain, game, host, opening, tick } = await chatHoldingTheOpeningNotice()
    vi.mocked(chain.readGame).mockReset()
    vi.mocked(chain.readGame).mockResolvedValueOnce(chainRead({ running: { ...game, registered: null } }))
    host.store.set(GAME_REGISTRATION_KEY, appRegistration(game.index, "sent"))

    // When
    await tick(host)

    // Then
    expect(host.notifications.cancel).toHaveBeenCalledWith(41)
    expect(bookedNotices(host).registered).toBe(true)
    expect(Object.keys(bookedNotices(host).moments)).not.toContain(opening)
  })

  it.each(["sent", "registered"] as const)("cancels the opening notice on the poll that finds the sign-up of Humanity %s", async (phase) => {
    // Given
    const { game, host, opening, tick } = await chatHoldingTheOpeningNotice()
    vi.mocked(host.storage.readProductJSON).mockResolvedValue({ ...appRegistration(game.index, phase), surface: "humanity" })

    // When
    await tick(host)

    // Then
    expect(host.notifications.cancel).toHaveBeenCalledWith(41)
    expect(bookedNotices(host).registered).toBe(true)
    expect(Object.keys(bookedNotices(host).moments)).not.toContain(opening)
  })

  it("keeps the opening notice booked while the sign-up of Humanity is still at the signer", async () => {
    // Given
    const { game, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
    vi.mocked(host.storage.readProductJSON).mockResolvedValue({ ...appRegistration(game.index, "registering"), surface: "humanity" })

    // When
    await tick(host)

    // Then
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(bookedNotices(host).registered).toBe(false)
    expect(bookedNotices(host).moments[opening]).toMatchObject({ id: 41, at: opensAt })
  })

  it.each([
    ["failed", 0, "failed"],
    ["for another game", 1, "registered"],
  ] as const)("keeps the opening notice booked for a sign-up of Humanity %s", async (_case, gameAhead, phase) => {
    // Given
    const { game, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
    vi.mocked(host.storage.readProductJSON).mockResolvedValue({ ...appRegistration(game.index + gameAhead, phase), surface: "humanity" })

    // When
    await tick(host)

    // Then
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(bookedNotices(host).registered).toBe(false)
    expect(bookedNotices(host).moments[opening]).toMatchObject({ id: 41, at: opensAt })
  })

  it("cancels the opening notice for a sign-up of Humanity while the record of the app cannot be read", async () => {
    // Given
    const { game, host, opening, tick } = await chatHoldingTheOpeningNotice()
    vi.mocked(host.storage.readJSON).mockImplementation(async (key: string) => {
      if (key === GAME_REGISTRATION_KEY) throw new Error("busy")
      return (host.store.has(key) ? host.store.get(key) : null) as never
    })
    vi.mocked(host.storage.readProductJSON).mockResolvedValue({ ...appRegistration(game.index, "registered"), surface: "humanity" })

    // When
    await tick(host)

    // Then
    expect(host.notifications.cancel).toHaveBeenCalledWith(41)
    expect(bookedNotices(host).registered).toBe(true)
    expect(Object.keys(bookedNotices(host).moments)).not.toContain(opening)
  })

  it("books the opening notice while Humanity storage refuses the read", async () => {
    // Given
    const game = running()
    const previousGameEnd = nowSeconds() - 120
    await withChain(chainRead({ running: game }))
    const { tick } = await import("./index")
    const host = fakeHost()
    host.store.set("jollity.wg.games", [
      { index: game.index - 1, gamePlayTime: previousGameEnd - 600, airdropsScheduled: 0, endsAt: previousGameEnd, registered: false, memberBefore: false },
    ])
    vi.mocked(host.storage.readProductJSON).mockRejectedValue(new Error("AccessNotGranted"))
    vi.mocked(host.notifications.push).mockResolvedValueOnce(41).mockResolvedValueOnce(42).mockResolvedValueOnce(43)

    // When
    await tick(host)

    // Then
    expect(bookedNotices(host).registered).toBe(false)
    expect(bookedNotices(host).moments[`opens:${game.gamePlayTime}`]).toMatchObject({ id: 41, at: (previousGameEnd + 600) * 1000 })
  })

  it("keeps the opening notice booked for a player with no sign-up of the app", async () => {
    // Given
    const { chain, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()

    // When
    await tick(host)

    // Then
    expect(chain.readGame).toHaveBeenCalledTimes(2)
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(bookedNotices(host).registered).toBe(false)
    expect(bookedNotices(host).moments[opening]).toMatchObject({ id: 41, at: opensAt })
  })

  it("leaves the registration record unread once the chain reads the player in", async () => {
    // Given
    const { chain, game, host, tick } = await chatHoldingTheOpeningNotice()
    vi.mocked(chain.readGame).mockReset()
    vi.mocked(chain.readGame).mockResolvedValueOnce(chainRead({ running: { ...game, registered: true } }))
    vi.mocked(host.storage.readJSON).mockClear()

    // When
    await tick(host)

    // Then
    expect(chain.readGame).toHaveBeenCalledTimes(1)
    expect(host.storage.readJSON).not.toHaveBeenCalledWith(GAME_REGISTRATION_KEY)
  })

  it("leaves the registration record unread with no game to sign up for", async () => {
    // Given
    const { chain, host, tick } = await chatHoldingTheOpeningNotice()
    vi.mocked(chain.readGame).mockReset()
    vi.mocked(chain.readGame).mockResolvedValueOnce(chainRead({ running: null }))
    vi.mocked(host.storage.readJSON).mockClear()

    // When
    await tick(host)

    // Then
    expect(chain.readGame).toHaveBeenCalledTimes(1)
    expect(host.storage.readJSON).not.toHaveBeenCalledWith(GAME_REGISTRATION_KEY)
  })

  it("keeps the opening notice booked when the sign-up of the app names another game", async () => {
    // Given
    const { chain, game, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
    host.store.set(GAME_REGISTRATION_KEY, appRegistration(game.index - 1, "sent"))

    // When
    await tick(host)

    // Then
    expect(chain.readGame).toHaveBeenCalledTimes(2)
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(bookedNotices(host).registered).toBe(false)
    expect(bookedNotices(host).moments[opening]).toMatchObject({ id: 41, at: opensAt })
  })

  it("keeps the opening notice booked when the sign-up of the app failed", async () => {
    // Given
    const { chain, game, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
    host.store.set(GAME_REGISTRATION_KEY, appRegistration(game.index, "failed"))

    // When
    await tick(host)

    // Then
    expect(chain.readGame).toHaveBeenCalledTimes(2)
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(bookedNotices(host).registered).toBe(false)
    expect(bookedNotices(host).moments[opening]).toMatchObject({ id: 41, at: opensAt })
  })

  it("keeps the opening notice booked for a registering record the chat left behind", async () => {
    // Given
    const { chain, game, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
    host.store.set(GAME_REGISTRATION_KEY, { ...appRegistration(game.index, "registering"), surface: "chat" })

    // When
    await tick(host)

    // Then
    expect(chain.readGame).toHaveBeenCalledTimes(2)
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(bookedNotices(host).registered).toBe(false)
    expect(bookedNotices(host).moments[opening]).toMatchObject({ id: 41, at: opensAt })
  })

  it("cancels the opening notice for a sent record the chat left behind, since that sign-up may still land", async () => {
    // Given
    const { game, host, opening, tick } = await chatHoldingTheOpeningNotice()
    host.store.set(GAME_REGISTRATION_KEY, { ...appRegistration(game.index, "sent"), surface: "chat" })

    // When
    await tick(host)

    // Then
    expect(host.notifications.cancel).toHaveBeenCalledWith(41)
    expect(bookedNotices(host).registered).toBe(true)
    expect(Object.keys(bookedNotices(host).moments)).not.toContain(opening)
  })

  it("keeps the opening notice booked when the sign-up of the app is past its lifetime", async () => {
    // Given
    const { chain, game, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
    host.store.set(GAME_REGISTRATION_KEY, { ...appRegistration(game.index, "sent"), at: Date.now() - SENT_TTL_MS - 1_000 })

    // When
    await tick(host)

    // Then
    expect(chain.readGame).toHaveBeenCalledTimes(2)
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(bookedNotices(host).registered).toBe(false)
    expect(bookedNotices(host).moments[opening]).toMatchObject({ id: 41, at: opensAt })
  })

  it("leaves the booking still when the sign-up of the app cannot be read, with the chain reading the player out", async () => {
    // Given
    const { chain, game, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: game.gamePlayTime, startsAt: game.gamePlayTime * 1000 - 60_000, outcome: "held", at: Date.now() })
    vi.mocked(host.storage.readJSON).mockImplementation(async (key: string) => {
      if (key === GAME_REGISTRATION_KEY) throw new Error("busy")
      return (host.store.has(key) ? host.store.get(key) : null) as never
    })

    // When
    await tick(host)

    // Then
    expect(chain.readGame).toHaveBeenCalledTimes(2)
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(host.notifications.push).toHaveBeenCalledTimes(3)
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ outcome: "held" })
    expect(host.store.get("jollity.wg.host-reminder")).not.toHaveProperty("outSeen")
    expect(bookedNotices(host).moments[opening]).toMatchObject({ id: 41, at: opensAt })
  })

  it("pushes the opening notice no second time when the sign-up of the app cannot be read after it rang", async () => {
    // Given
    const { chain, game, host, opening, tick } = await chatHoldingTheOpeningNotice()
    vi.mocked(chain.readGame).mockResolvedValueOnce(chainRead({ running: game }))
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000)
      host.store.set(GAME_REGISTRATION_KEY, appRegistration(game.index, "registering"))
      await tick(host)
      const momentsOfTheLivePoll = Object.keys(bookedNotices(host).moments)
      const pushesOfTheLivePoll = vi.mocked(host.notifications.push).mock.calls.length
      vi.mocked(host.storage.readJSON).mockImplementation(async (key: string) => {
        if (key === GAME_REGISTRATION_KEY) throw new Error("busy")
        return (host.store.has(key) ? host.store.get(key) : null) as never
      })

      // When
      await tick(host)

      // Then
      expect(chain.readGame).toHaveBeenCalledTimes(3)
      expect(momentsOfTheLivePoll).not.toContain(opening)
      expect(Object.keys(bookedNotices(host).moments)).not.toContain(opening)
      expect(host.notifications.push).toHaveBeenCalledTimes(pushesOfTheLivePoll)
    } finally {
      vi.useRealTimers()
    }
  })

  it("books the opening notice again once the sign-up of the app has failed", async () => {
    // Given
    const { chain, game, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
    vi.mocked(chain.readGame).mockResolvedValueOnce(chainRead({ running: game }))
    host.store.set(GAME_REGISTRATION_KEY, appRegistration(game.index, "sent"))
    await tick(host)
    expect(Object.keys(bookedNotices(host).moments)).not.toContain(opening)
    host.store.set(GAME_REGISTRATION_KEY, appRegistration(game.index, "failed"))

    // When
    await tick(host)

    // Then
    expect(chain.readGame).toHaveBeenCalledTimes(3)
    expect(bookedNotices(host).registered).toBe(false)
    expect(bookedNotices(host).moments[opening]).toMatchObject({ id: 1, at: opensAt })
  })

  it("books the opening notice again once a sign-up the page cancelled it for has failed", async () => {
    // Given
    const { game, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
    const { [opening]: cancelled, ...moments } = bookedNotices(host).moments
    host.store.set("jollity.wg.notifs", { ...bookedNotices(host), moments, ids: bookedNotices(host).ids.filter((id) => id !== cancelled!.id) })
    host.store.set(GAME_REGISTRATION_KEY, appRegistration(game.index, "failed"))

    // When
    await tick(host)

    // Then
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(bookedNotices(host).registered).toBe(false)
    expect(bookedNotices(host).moments[opening]).toMatchObject({ id: 1, at: opensAt })
  })

  it("books no opening notice the page cancelled while the sign-up of the app is sent past its lifetime", async () => {
    // Given
    const { game, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
    const { [opening]: cancelled, ...moments } = bookedNotices(host).moments
    host.store.set("jollity.wg.notifs", { ...bookedNotices(host), moments, ids: bookedNotices(host).ids.filter((id) => id !== cancelled!.id) })
    host.store.set(GAME_REGISTRATION_KEY, { ...appRegistration(game.index, "sent"), at: Date.now() - SENT_TTL_MS - 1_000 })
    vi.mocked(host.notifications.push).mockClear()

    // When
    await tick(host)

    // Then
    expect(host.notifications.cancel).not.toHaveBeenCalled()
    expect(host.notifications.push).not.toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: opensAt }))
    expect(bookedNotices(host).registered).toBe(false)
    expect(Object.keys(bookedNotices(host).moments)).not.toContain(opening)
  })

  it("books the opening notice again for a failed sign-up of the app past its lifetime", async () => {
    // Given
    const { game, host, opening, opensAt, tick } = await chatHoldingTheOpeningNotice()
    const { [opening]: cancelled, ...moments } = bookedNotices(host).moments
    host.store.set("jollity.wg.notifs", { ...bookedNotices(host), moments, ids: bookedNotices(host).ids.filter((id) => id !== cancelled!.id) })
    host.store.set(GAME_REGISTRATION_KEY, { ...appRegistration(game.index, "failed"), at: Date.now() - SENT_TTL_MS - 1_000 })

    // When
    await tick(host)

    // Then
    expect(bookedNotices(host).registered).toBe(false)
    expect(bookedNotices(host).moments[opening]).toMatchObject({ id: 1, at: opensAt })
  })

  it("keeps the reminder the host holds while the sign-up of the app is on its way, past the second read of not registered", async () => {
    // Given
    const { chain, game, host, opening, tick } = await chatHoldingTheOpeningNotice()
    vi.mocked(chain.readGame).mockResolvedValueOnce(chainRead({ running: game }))
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: game.gamePlayTime, startsAt: game.gamePlayTime * 1000 - 60_000, outcome: "held", at: Date.now() })
    host.store.set(GAME_REGISTRATION_KEY, appRegistration(game.index, "registering"))

    // When
    await tick(host)
    await tick(host)

    // Then
    expect(chain.readGame).toHaveBeenCalledTimes(3)
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ outcome: "held" })
    expect(host.notifications.cancel).toHaveBeenCalledWith(41)
    expect(host.notifications.push).toHaveBeenCalledTimes(3)
    expect(bookedNotices(host)).toMatchObject({ registered: true, hostReminds: true })
    expect(Object.keys(bookedNotices(host).moments)).not.toContain(opening)
  })

  it("asks the host for the reminder on the poll that finds the sign-up of the app, when no ask is on record", async () => {
    // Given
    const { game, host, tick } = await chatHoldingTheOpeningNotice()
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    host.store.set(GAME_REGISTRATION_KEY, appRegistration(game.index, "sent"))

    // When
    await tick(host)

    // Then
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "held" })
  })

  it("lets another product register for the next game only once its own reminders are booked", async () => {
    // Given: the reminders of the game before, still ahead, with no poll since
    const { remindersInPlace, scheduleReminders } = await import("./index")
    const host = fakeHost()
    const first = running({ registered: true })
    vi.mocked(host.notifications.push).mockResolvedValueOnce(41).mockResolvedValueOnce(42).mockResolvedValueOnce(43)
    await scheduleReminders(host, chainRead({ running: first }))
    const next = first.gamePlayTime + 86_400

    // When
    const notice = await remindersInPlace(
      host,
      chainRead({ running: running({ index: 8, gamePlayTime: next, registrationEnds: next - 90, registered: false }) }),
      false,
    )

    // Then
    expect(notice).toBeNull()
    expect(vi.mocked(host.notifications.cancel).mock.calls.map(([id]) => id).sort()).toEqual([41, 42, 43])
    expect(times(host).slice(3)).toEqual([next * 1000 - 300_000, next * 1000 - 60_000, next * 1000 - 20_000])
    expect(Object.keys((host.store.get("jollity.wg.notifs") as { moments: object }).moments)).toEqual([
      `start-5m:${next}`,
      `start-1m:${next}`,
      `start-20s:${next}`,
    ])
  })

  it("books on the device clock when the chain clock runs behind", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registered: true })

    // When
    await scheduleReminders(host, chainRead({ running: game, clockOffsetMs: -600_000 }))

    // Then
    expect(times(host)[0]).toBe(game.gamePlayTime * 1000 + 600_000 - 300_000)
  })
})

describe("the card works", () => {
  it("Register hands the player to the app while the card knows no game", async () => {
    // Given
    const host = welcomedHost()
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    const teardown = handler(
      { messageId: "m1", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: nowSeconds() + 3600 }) },
      vi.fn(),
      (listener) => {
        press = listener
        return () => {}
      },
    )

    // When
    press!("jollity.register", undefined)
    await flush()

    // Then
    expect(host.navigate).toHaveBeenCalledWith("/")
    teardown?.()
  })

  it("Register signs up from the chat for the game of the card, which says You're in once the sign-up is on the wire", async () => {
    // Given
    const game = running()
    await withChain(chainRead({ running: game }))
    const engine = await signupEngineWith(async (options) => {
      options.onBroadcast?.()
      return { ok: true }
    })
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    const handler = await renderHandler(host)
    const send = vi.fn()
    let press: ActionListener | undefined
    handler({ messageId: "m1", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.register", undefined)
    await flush()

    // Then
    // the SDK picks the returning route itself; the chat hands it the host's capabilities
    expect(engine.register).toHaveBeenCalledWith(
      expect.objectContaining({ signer: expect.anything(), submit: expect.any(Function) }),
      expect.any(Uint8Array),
      expect.anything(),
    )
    expect(host.navigate).not.toHaveBeenCalled()
    expect(JSON.stringify(send.mock.calls.at(-1)![0])).toContain("You're in")
  })

  it("Register signs up when the host refuses a past reminder, while preserving the refusal record", async () => {
    // Given
    const game = running()
    await withChain(chainRead({ running: game }))
    const engine = await signupEngineWith(async (options) => {
      options.onBroadcast?.()
      return { ok: true }
    })
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    vi.mocked(host.game.remindNextGame).mockImplementation(async (_startsAt, onError) => {
      onError?.("Domain.V1: StartsInPast")
      return "starts-in-past"
    })
    const handler = await renderHandler(host)
    const send = vi.fn()
    let press: ActionListener | undefined
    handler({ messageId: "m1-past", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.register", undefined)
    for (let step = 0; step < 4; step++) await flush()

    // Then
    expect(engine.register).toHaveBeenCalled()
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "starts-in-past" })
    expect(JSON.stringify(send.mock.calls.at(-1)![0])).toContain("You're in")
    expect(JSON.stringify(send.mock.calls)).not.toContain("You just missed this one")
  })

  it("does not remember an optimistic sent state as confirmed registration after the sign-up fails", async () => {
    // Given
    const game = running({ registered: false })
    await withChain(chainRead({ running: game }))
    await signupEngineWith(async (options) => {
      options.onBroadcast?.()
      return { ok: false, error: "HostRejected" } as never
    })
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    const handler = await renderHandler(host)
    const send = vi.fn()
    let press: ActionListener | undefined
    handler({ messageId: "m1-failed", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.register", undefined)
    for (let step = 0; step < 6; step++) await flush()

    // Then
    const last = JSON.stringify(send.mock.calls.at(-1)![0])
    expect(last).toContain("Couldn't sign you up")
    expect(last).toContain("I'll be there")
    expect(last).not.toContain("You're in")
  })

  it("keeps the host reminder while a sign-up is on its way, though the chain still reads the player as out", async () => {
    // Given
    const game = running({ registered: false })
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }), chainRead({ running: game }))
    await signupEngineWith(() => new Promise(() => {}))
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m6", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()
    press!("jollity.register", undefined)
    await flush()
    await flush()
    const { tick } = await import("./index")

    // When
    await tick(host)
    await tick(host)

    // Then
    expect(chain.readGame).toHaveBeenCalledTimes(3)
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "held" })
  })

  it("keeps the host reminder while a sign-up is on its way, though the host refused to write its record", async () => {
    // Given
    const game = running({ registered: false })
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }), chainRead({ running: game }))
    await signupEngineWith(() => new Promise(() => {}))
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")
    vi.mocked(host.storage.writeJSON).mockImplementation(async (key, value) => {
      if (key === GAME_REGISTRATION_KEY) throw new Error("refused")
      host.store.set(key, value)
    })
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m6", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()
    press!("jollity.register", undefined)
    await flush()
    await flush()
    const { tick } = await import("./index")

    // When
    await tick(host)
    await tick(host)

    // Then
    expect(host.store.has(GAME_REGISTRATION_KEY)).toBe(false)
    expect(chain.readGame).toHaveBeenCalledTimes(3)
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "held" })
  })

  it.each([false, null] as const)("keeps the host reminder when a sign-up fails against an unconfirmed %s read", async (registered) => {
    // Given
    const game = running({ registered })
    await withChain(chainRead({ running: game }), chainRead({ running: game }))
    await signupEngineWith(async () => ({ ok: false, error: "Boom" }) as never)
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m10", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.register", undefined)
    for (let step = 0; step < 6; step++) await flush()

    // Then
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "held" })
  })

  it("a signer request the host never answers ends the sign-up failed without treating the last read as confirmation", async () => {
    // Given
    const game = running({ registered: false })
    await withChain(...Array.from({ length: 4 }, () => chainRead({ running: game })))
    await signupEngineWith(async () => ({ ok: true }))
    const accounts = signingAccounts()
    vi.mocked(accounts.signer).mockReturnValueOnce(new Promise(() => {}))
    const host = welcomedHost({ accounts, entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")
    const handler = await renderHandler(host)
    const send = vi.fn()
    let press: ActionListener | undefined
    handler({ messageId: "m11", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
      press = listener
      return () => {}
    })
    await flush()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

    try {
      // When
      press!("jollity.register", undefined)
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      // Then
      expect(host.game.cancelNextGame).not.toHaveBeenCalled()
      expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "held", outSeen: true })
      expect(JSON.stringify(send.mock.calls.at(-1)![0])).toContain("Couldn't sign you up")
    } finally {
      vi.useRealTimers()
    }
  })

  it("counts a chain read once when a failed sign-up lands before that poll checks the reminder", async () => {
    // Given
    const game = running({ registered: false })
    await withChain(chainRead({ running: game }), chainRead({ running: game }), chainRead({ running: game }))
    let finishRegistration!: () => void
    await signupEngineWith(
      () =>
        new Promise((resolve) => {
          finishRegistration = () => resolve({ ok: false, error: "HostRejected" } as never)
        }),
    )
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m11-gap", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()
    press!("jollity.register", undefined)
    while (!finishRegistration) await flush()

    const read = host.storage.readJSON
    let reachedAnnouncement!: () => void
    const atAnnouncement = new Promise<void>((resolve) => (reachedAnnouncement = resolve))
    let continuePoll!: () => void
    const announcementMayContinue = new Promise<void>((resolve) => (continuePoll = resolve))
    let holdAnnouncement = true
    host.storage.readJSON = vi.fn(async (key: string) => {
      if (holdAnnouncement && key === "jollity.wg.announced") {
        holdAnnouncement = false
        reachedAnnouncement()
        await announcementMayContinue
      }
      return read(key)
    }) as WorkerHost["storage"]["readJSON"]
    const { tick } = await import("./index")
    const polling = tick(host)
    await atAnnouncement

    // When: the failed sign-up observes the poll's false read before that same poll checks the reminder.
    finishRegistration()
    while (!(host.store.get("jollity.wg.host-reminder") as { outSeen?: boolean } | undefined)?.outSeen) await flush()
    continuePoll()
    await polling
    const cancelsAfterTheSharedRead = vi.mocked(host.game.cancelNextGame).mock.calls.length
    await tick(host)

    // Then: only the later chain read is confirmation.
    expect(cancelsAfterTheSharedRead).toBe(0)
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(1)
  })

  it("a tap after a timed-out sign-up signs up again", async () => {
    // Given
    const game = running({ registered: false })
    await withChain(...Array.from({ length: 4 }, () => chainRead({ running: game })))
    const engine = await signupEngineWith(async () => ({ ok: true }))
    const accounts = signingAccounts()
    vi.mocked(accounts.signer).mockReturnValueOnce(new Promise(() => {}))
    const host = welcomedHost({ accounts, entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m12", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

    try {
      press!("jollity.register", undefined)
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      // When
      press!("jollity.register", undefined)
      await vi.advanceTimersByTimeAsync(1_000)

      // Then
      expect(accounts.signer).toHaveBeenCalledTimes(2)
      expect(engine.register).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the reminder that both timed-out asks of a tap may have set, until a later poll confirms the sign-up went nowhere", async () => {
    // Given
    const game = running({ registered: false })
    await withChain(...Array.from({ length: 4 }, () => chainRead({ running: game })))
    await signupEngineWith(async () => ({ ok: true }))
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    vi.mocked(host.game.remindNextGame).mockReturnValue(new Promise(() => {}))
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m13", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

    try {
      // When
      press!("jollity.register", undefined)
      await vi.advanceTimersByTimeAsync(100_000)

      // Then
      expect(host.game.remindNextGame).toHaveBeenCalledTimes(2)
      expect(host.game.cancelNextGame).not.toHaveBeenCalled()
      expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "failed", outSeen: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it("a hand-off to the app keeps the reminder the gate asked for", async () => {
    // Given: a host that hands over no signer, so the app takes the sign-up over
    const game = running({ registered: false })
    await withChain(chainRead({ running: game }), chainRead({ running: game }))
    await signupEngineWith(async () => ({ ok: true }))
    const host = welcomedHost({ entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m14", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.register", undefined)
    for (let step = 0; step < 6; step++) await flush()

    // Then
    expect(host.navigate).toHaveBeenCalled()
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "held" })
  })

  it("draws the card under the pill of the host for the game whose reminder it holds", async () => {
    // Given
    const soon = nowSeconds() + 200
    const game = running({ registered: true, gamePlayTime: soon, registrationEnds: soon - 90, playEnds: soon + 144, reportingEnds: soon + 600, phase: "shuffle" })
    await withChain(chainRead({ running: game }), chainRead({ running: game }))
    const host = welcomedHost()
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: game.gamePlayTime, outcome: "held", startsAt: game.gamePlayTime * 1000 })
    const handler = await renderHandler(host)
    const send = vi.fn()

    // When
    handler({ messageId: "m9", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, () => () => {})
    await flush()

    // Then
    const drawn = JSON.stringify(send.mock.calls.at(-1)![0])
    expect(drawn).toContain("Game starting soon")
    expect(drawn).not.toContain("Left to join")
  })

  it("Register signs up for the running game before the card has read the stored games", async () => {
    // Given
    const game = running()
    await withChain(chainRead({ running: game }))
    const engine = await signupEngineWith(async () => ({ ok: true }))
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    const write = host.storage.writeJSON
    host.storage.writeJSON = vi.fn(async (key: string, value: unknown) => {
      if (key !== "jollity.wg.games") await write(key, value)
    })
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m5", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.register", undefined)
    await flush()

    // Then
    expect(engine.register).toHaveBeenCalled()
    expect(host.navigate).not.toHaveBeenCalled()
  })

  it("Register signs up at once and never asks on the card, even when the draw ticket could not be made", async () => {
    // Given
    const game = running()
    await withChain(chainRead({ running: game }))
    let options: RegisterOptions | undefined
    await signupEngineWith(async (given) => {
      options = given
      given.onDraws?.({ entered: 0, skipped: "draw #0 is Drawing", kind: "closed", scheduled: 1, waitedMs: 0, retries: 0 })
      return { ok: true }
    })
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    const handler = await renderHandler(host)
    const send = vi.fn()
    let press: ActionListener | undefined
    handler({ messageId: "m2", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.register", undefined)
    await flush()

    // Then
    expect(options).toBeDefined()
    expect(options).not.toHaveProperty("confirmWithoutDraws")
    for (const call of send.mock.calls) expect(JSON.stringify(call[0])).not.toContain("without the draw")
  })


  it("How it works, on the older welcome card, sets the flag, then opens /nux", async () => {
    // Given
    const host = welcomedHost()
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m0", messageType: "jollity.welcome", payload: encPayload({ v: 1 }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })

    // When
    press!("jollity.tutorial", undefined)
    await flush()

    // Then
    expect(host.store.get("jollity.showTutorial")).toBe(true)
    expect(host.navigate).toHaveBeenCalledWith("/nux")
    const writes = vi.mocked(host.storage.writeJSON).mock
    const wrote = writes.invocationCallOrder[writes.calls.findIndex(([key]) => key === "jollity.showTutorial")]!
    const navigated = vi.mocked(host.navigate).mock.invocationCallOrder[0]!
    expect(wrote).toBeLessThan(navigated)
  })

  it("sends Set up your member name to the Humanity card in Pocket", async () => {
    // Given
    const host = welcomedHost()
    const gamePlayTime = nowSeconds() - 3600
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime }])
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m4", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.username", undefined)
    await flush()

    // Then
    expect(host.navigate).toHaveBeenCalledWith("polkadotapp://pocket/open?product=peopl.paseo&card=humanity")
  })

  it("sends Open Collectibles to the New tab of the stash product of the network", async () => {
    // Given
    const host = welcomedHost()
    const gamePlayTime = nowSeconds() - 3600
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime }])
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m5", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.stash", undefined)
    await flush()

    // Then
    expect(host.navigate).toHaveBeenCalledWith("polkadot://stash.paseo/?open=new")
  })

  it("draws the stored results, and the won ticket once the app says the draw is seen", async () => {
    // Given
    const host = welcomedHost()
    const gamePlayTime = nowSeconds() - 3600
    const results = {
      endedAt: gamePlayTime + 600,
      passed: true,
      collectables: null,
      prize: { amountUsd: 200, ticket: "ab", drawAt: gamePlayTime + 1200, phase: "drawn" as const, won: true, claimable: false },
      membership: { member: true, justBecameMember: false, gamesToMembership: null },
      seen: UNSEEN,
    }
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime, registered: true }])
    host.store.set(`jollity.wg.recap:${gamePlayTime}`, { cancelled: false, results, gamesToMembership: null })
    const handler = await renderHandler(host)
    const draw = async () => {
      const send = vi.fn()
      const teardown = handler(
        { messageId: "m4", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) },
        send,
        () => () => {},
      )
      await flush()
      teardown?.()
      return JSON.stringify(send.mock.calls.at(-1)![0])
    }

    // When
    const before = await draw()
    host.store.set("jollity.seen:7", { chest: false, draw: true })
    const after = await draw()

    // Then
    expect(before).toContain("You got Membership!")
    expect(before).not.toContain("You won the prize")
    expect(after).toContain("You won the prize")
  })

  it("trades Set up your member name for the note on the card of a new member whose full username the People chain holds", async () => {
    // Given
    const host = newMemberHost()
    const query = await peopleHolding({ full_username: new TextEncoder().encode("carol"), lite_username: new TextEncoder().encode("carol.01") })
    const handler = await renderHandler(host)
    const send = vi.fn()

    // When
    const teardown = handler(GAME_CARD_REQUEST, send, () => () => {})
    await vi.waitFor(() => expect(JSON.stringify(send.mock.calls.at(-1)?.[0])).toContain(cardCopy.NAME_UPGRADED), { timeout: 3_000 })
    teardown?.()

    // Then
    expect(JSON.stringify(send.mock.calls.at(-1)![0])).not.toContain(cardCopy.MEMBER_NAME)
    expect(query.Resources.Consumers.getValue).toHaveBeenCalledWith(PEOPLE_ROOT, expect.anything())
  })

  it("redraws the settled card of a new member once a poll finds the full username set", async () => {
    // Given
    const host = newMemberHost()
    const query = await peopleHolding({ full_username: null, lite_username: new TextEncoder().encode("carol.01") })
    const handler = await renderHandler(host)
    const send = vi.fn()
    const teardown = handler(GAME_CARD_REQUEST, send, () => () => {})
    await vi.waitFor(() => expect(query.Resources.Consumers.getValue).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(JSON.stringify(send.mock.calls.at(-1)?.[0])).toContain(cardCopy.MEMBER_NAME))
    await flush()
    query.Resources.Consumers.getValue.mockResolvedValue(consumerRecord({ full_username: new TextEncoder().encode("carol"), lite_username: new TextEncoder().encode("carol.01") }))
    const { tick } = await import("./index")

    try {
      // When
      for (let beat = 2; beat <= 4; beat++) await tick(host)
      const betweenMemberReads = query.Resources.Consumers.getValue.mock.calls.length
      await tick(host)

      // Then
      await vi.waitFor(() => expect(JSON.stringify(send.mock.calls.at(-1)?.[0])).toContain(cardCopy.NAME_UPGRADED), { timeout: 3_000 })
      expect(betweenMemberReads).toBe(1)
      expect(query.Resources.Consumers.getValue).toHaveBeenCalledTimes(2)
    } finally {
      teardown?.()
    }
  })

  it("stops asking the People chain for the full username once a poll finds it set", async () => {
    // Given
    const host = newMemberHost()
    const query = await peopleHolding({ full_username: new TextEncoder().encode("carol"), lite_username: new TextEncoder().encode("carol.01") })
    const { tick } = await import("./index")

    // When
    for (let beat = 1; beat <= 5; beat++) await tick(host)

    // Then
    expect(query.Resources.Consumers.getValue).toHaveBeenCalledTimes(1)
  })

  it("never asks the People chain for the full username of a player who is not a member", async () => {
    // Given
    const host = newMemberHost()
    const query = await peopleHolding({ full_username: new TextEncoder().encode("carol"), lite_username: new TextEncoder().encode("carol.01") }, false)
    const { tick } = await import("./index")

    // When
    for (let beat = 1; beat <= 5; beat++) await tick(host)

    // Then
    expect(query.Resources.Consumers.getValue).not.toHaveBeenCalled()
  })

  it("finds the game of an old card from its stored outcome once the games list has moved on", async () => {
    // Given
    const host = welcomedHost()
    const gamePlayTime = nowSeconds() - 30 * 86_400
    const won = { amountUsd: 200, ticket: "ab", drawAt: gamePlayTime + 1200, phase: "drawn" as const, won: true, claimable: false }
    host.store.set(`jollity.wg.recap:${gamePlayTime}`, { cancelled: false, results: { ...RESULTS, prize: won }, gamesToMembership: null, gameIndex: 7 })
    host.store.set("jollity.seen:7", { chest: true, draw: true })
    const handler = await renderHandler(host)
    const send = vi.fn()

    // When
    handler({ messageId: "m7", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) }, send, () => () => {})
    await flush()

    // Then
    expect(JSON.stringify(send.mock.calls.at(-1)![0])).toContain("You won the prize")
  })

  it("waits for the first chain poll before drawing a live card", async () => {
    // Given
    const chain = await import("./chain")
    vi.mocked(chain.connect).mockReturnValueOnce(new Promise(() => {}))
    const host = welcomedHost()
    const handler = await renderHandler(host)
    const send = vi.fn()

    // When
    handler({ messageId: "m8", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: nowSeconds() - 60 }) }, send, () => () => {})
    await flush()

    // Then
    expect(send).not.toHaveBeenCalled()
  })

  it("draws a live card once the chain is read, while the rest of the poll is still running", async () => {
    // Given
    const game = running()
    await withChain(chainRead({ running: game }))
    const host = welcomedHost({ notifications: { push: vi.fn(() => new Promise<number>(() => {})), cancel: vi.fn() } })
    const handler = await renderHandler(host)
    const send = vi.fn()

    // When
    handler({ messageId: "m12", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, () => () => {})
    await flush()

    // Then
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("draws a card with a stored outcome without waiting for the first chain poll", async () => {
    // Given
    const chain = await import("./chain")
    vi.mocked(chain.connect).mockReturnValueOnce(new Promise(() => {}))
    const host = welcomedHost()
    const gamePlayTime = nowSeconds() - 3600
    host.store.set(`jollity.wg.recap:${gamePlayTime}`, { cancelled: false, results: RESULTS, gamesToMembership: null, gameIndex: 7 })
    const handler = await renderHandler(host)
    const send = vi.fn()

    // When
    handler({ messageId: "m10", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) }, send, () => () => {})
    await flush()

    // Then
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("sends nothing from a storage read that lands after the card was closed", async () => {
    // Given
    const host = welcomedHost()
    const handler = await renderHandler(host)
    let release: (value: null) => void = () => {}
    host.storage.readJSON = vi.fn(() => new Promise((resolve) => (release = resolve))) as WorkerHost["storage"]["readJSON"]
    const send = vi.fn()

    // When
    const teardown = handler({ messageId: "m11", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: nowSeconds() - 3600 }) }, send, () => () => {})
    teardown?.()
    for (let read = 0; read < 3; read++) {
      release(null)
      await flush()
    }

    // Then
    expect(send).not.toHaveBeenCalled()
  })

  it("stops reading and drawing once the card can no longer change", async () => {
    // Given
    const host = welcomedHost()
    const gamePlayTime = nowSeconds() - 3600
    host.store.set(`jollity.wg.recap:${gamePlayTime}`, { cancelled: true, results: null, gamesToMembership: null, gameIndex: 7 })
    const handler = await renderHandler(host)
    vi.useFakeTimers()

    // When
    handler({ messageId: "m13", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) }, vi.fn(), () => () => {})
    await vi.advanceTimersByTimeAsync(100)
    const readsAfterTheFirstDraw = vi.mocked(host.storage.readJSON).mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    const readsLater = vi.mocked(host.storage.readJSON).mock.calls.length
    vi.useRealTimers()

    // Then
    expect(readsLater).toBe(readsAfterTheFirstDraw)
  })

  it("redraws a stored miss as played once the app writes that the report landed", async () => {
    // Given
    const host = welcomedHost()
    const gamePlayTime = nowSeconds() - 3600
    host.store.set(`jollity.wg.recap:${gamePlayTime}`, { cancelled: false, results: null, gamesToMembership: null, gameIndex: 7, registered: true })
    const handler = await renderHandler(host)
    const send = vi.fn()
    vi.useFakeTimers()
    handler({ messageId: "m14", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) }, send, () => () => {})
    await vi.advanceTimersByTimeAsync(100)
    const firstFace = JSON.stringify(send.mock.lastCall)

    // When
    host.store.set("jollity.seen:7", { chest: false, draw: false, report: true })
    await vi.advanceTimersByTimeAsync(4_000)
    vi.useRealTimers()

    // Then
    expect(firstFace).toContain("You missed the game or didn't pass.")
    expect(JSON.stringify(send.mock.lastCall)).toContain("You played but didn't pass.")
  })

  it("counts a miss the app says was reported from its card, then draws the count and settles", async () => {
    // Given
    const host = welcomedHost()
    const gamePlayTime = nowSeconds() - 3600
    const key = `jollity.wg.recap:${gamePlayTime}`
    host.store.set(key, { cancelled: false, results: null, gamesToMembership: null, gameIndex: 7, registered: true })
    host.store.set("jollity.seen:7", { chest: false, draw: false, report: true })
    const chain = await withChain()
    vi.mocked(chain.connectAssetHub).mockResolvedValueOnce({} as never)
    vi.mocked(chain.readEarned).mockResolvedValueOnce(2)
    const handler = await renderHandler(host)
    const send = vi.fn()
    vi.useFakeTimers()

    // When
    handler({ messageId: "m15", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) }, send, () => () => {})
    await vi.advanceTimersByTimeAsync(100)
    const firstFace = JSON.stringify(send.mock.lastCall)
    await vi.advanceTimersByTimeAsync(4_000)
    const readsWhenCounted = vi.mocked(host.storage.readJSON).mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    const readsLater = vi.mocked(host.storage.readJSON).mock.calls.length
    vi.useRealTimers()

    // Then
    expect(firstFace).not.toContain("You earned")
    expect(host.store.get(key)).toMatchObject({ earned: 2 })
    expect(JSON.stringify(send.mock.lastCall)).toContain("You earned 2 collectibles.")
    expect(readsLater).toBe(readsWhenCounted)
  })

  it("sends a card again only when its face changes", async () => {
    // Given
    const host = welcomedHost()
    const gamePlayTime = nowSeconds() - 3600
    host.store.set(`jollity.wg.recap:${gamePlayTime}`, { cancelled: false, results: RESULTS, gamesToMembership: null, gameIndex: 7 })
    const handler = await renderHandler(host)
    const send = vi.fn()
    vi.useFakeTimers()

    // When
    const teardown = handler({ messageId: "m9", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) }, send, () => () => {})
    await vi.advanceTimersByTimeAsync(5_000)
    teardown?.()
    vi.useRealTimers()

    // Then
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("draws nothing until it has read what storage holds for the card", async () => {
    // Given
    const host = welcomedHost()
    const handler = await renderHandler(host)
    const send = vi.fn()

    // When
    handler({ messageId: "m5", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: nowSeconds() }) }, send, () => () => {})

    // Then
    expect(send).not.toHaveBeenCalled()
  })

  it("does not draw from its timer while storage is still being read", async () => {
    // Given
    const host = welcomedHost()
    const handler = await renderHandler(host)
    host.storage.readJSON = vi.fn(() => new Promise(() => {})) as WorkerHost["storage"]["readJSON"]
    const send = vi.fn()
    vi.useFakeTimers()
    const readsBeforeCard = vi.mocked(host.storage.readJSON).mock.calls.length

    // When
    const teardown = handler(
      { messageId: "m6", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: nowSeconds() }) },
      send,
      () => () => {},
    )
    vi.advanceTimersByTime(6_500)
    teardown?.()
    vi.useRealTimers()

    // Then
    expect(send).not.toHaveBeenCalled()
    expect(vi.mocked(host.storage.readJSON).mock.calls.length - readsBeforeCard).toBe(1)
  })

  describe("the camera line", () => {
    const cameraKey = () => `jollity.camera.v1:${productAccount()}`

    async function registeredCard(host: ReturnType<typeof welcomedHost>) {
      const game = running({ registered: true })
      await withChain(chainRead({ running: game }))
      const handler = await renderHandler(host)
      const send = vi.fn()
      let press: ActionListener | undefined
      handler({ messageId: "m-camera", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
        press = listener
        return () => {}
      })
      await flush()
      return { send, press: press!, card: () => JSON.stringify(send.mock.calls.at(-1)![0]) }
    }

    it("is drawn from a stored off", async () => {
      // Given
      const host = welcomedHost()
      host.store.set(cameraKey(), "off")

      // When
      const { card } = await registeredCard(host)

      // Then
      expect(card()).toContain("You're in")
      expect(card()).toContain("Camera is off. Turn it on to play.")
      expect(card()).toContain("Turn on")
      expect(card()).toContain("jollity.turn-on-camera")
    })

    it.each([
      ["a stored on", "on"],
      ["an empty key", undefined],
      ["a value it does not know", "denied"],
    ])("is not drawn from %s", async (_name, stored) => {
      // Given
      const host = welcomedHost()
      if (stored) host.store.set(cameraKey(), stored)

      // When
      const { card } = await registeredCard(host)

      // Then
      expect(card()).toContain("You're in")
      expect(card()).not.toContain("Camera is off")
    })

    it("is not drawn from a read that failed", async () => {
      // Given
      const host = welcomedHost()
      host.store.set(cameraKey(), "off")
      const read = host.storage.readJSON
      host.storage.readJSON = vi.fn(async (key: string) => {
        if (key === cameraKey()) throw new Error("storage down")
        return read(key)
      }) as WorkerHost["storage"]["readJSON"]

      // When
      const { card } = await registeredCard(host)

      // Then
      expect(card()).toContain("You're in")
      expect(card()).not.toContain("Camera is off")
    })

    it("keeps the line it last read when a later sync cannot read storage", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
      try {
        // Given
        const host = welcomedHost()
        host.store.set(cameraKey(), "off")
        const { card } = await registeredCard(host)
        const read = host.storage.readJSON
        let failedReads = 0
        host.storage.readJSON = vi.fn(async (key: string) => {
          if (key !== cameraKey()) return read(key)
          failedReads += 1
          throw new Error("storage down")
        }) as WorkerHost["storage"]["readJSON"]

        // When
        await vi.advanceTimersByTimeAsync(3_000)
        await flush()

        // Then
        expect(failedReads).toBeGreaterThan(0)
        expect(card()).toContain("Camera is off. Turn it on to play.")
      } finally {
        vi.useRealTimers()
      }
    })

    it("asks for the camera on a tap of Turn on, and the line goes once it is allowed", async () => {
      // Given
      const host = welcomedHost()
      host.store.set(cameraKey(), "off")
      const { press, card } = await registeredCard(host)

      // When
      press("jollity.turn-on-camera", undefined)
      await flush()

      // Then
      expect(host.permissions.requestDevice).toHaveBeenCalledWith("Camera")
      expect(host.store.get(cameraKey())).toBe("on")
      expect(card()).not.toContain("Camera is off. Turn it on to play.")
    })

    it("keeps the line when a tap of Turn on is refused", async () => {
      // Given
      const host = welcomedHost({ permissions: { requestDevice: vi.fn().mockResolvedValue(false) } })
      host.store.set(cameraKey(), "off")
      const { press, card } = await registeredCard(host)

      // When
      press("jollity.turn-on-camera", undefined)
      await flush()

      // Then
      expect(host.store.get(cameraKey())).toBe("off")
      expect(card()).toContain("Camera is off. Turn it on to play.")
    })

    it("stores no answer when the host call fails", async () => {
      // Given
      const host = welcomedHost({ permissions: { requestDevice: vi.fn().mockRejectedValue(new Error("gone")) } })
      const { press } = await registeredCard(host)

      // When
      press("jollity.turn-on-camera", undefined)
      await flush()

      // Then
      expect(host.store.has(cameraKey())).toBe(false)
    })

    it("stores no answer when the host answers with a failure", async () => {
      // Given
      const host = welcomedHost({ permissions: { requestDevice: vi.fn().mockResolvedValue(undefined) } })
      host.store.set(cameraKey(), "on")
      const { press, card } = await registeredCard(host)

      // When
      press("jollity.turn-on-camera", undefined)
      await flush()

      // Then
      expect(host.permissions.requestDevice).toHaveBeenCalledWith("Camera")
      expect(host.store.get(cameraKey())).toBe("on")
      expect(card()).not.toContain("Camera is off")
    })

    it("stores no answer when the host does not answer in time", async () => {
      // Given
      const requestDevice = vi.fn((kind: string) => (kind === "Camera" ? new Promise<boolean>(() => {}) : Promise.resolve(true)))
      const host = welcomedHost({ permissions: { requestDevice } })
      host.store.set(cameraKey(), "on")
      const { press, card } = await registeredCard(host)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        // When
        press("jollity.turn-on-camera", undefined)
        await vi.advanceTimersByTimeAsync(30_000)

        // Then
        expect(requestDevice).toHaveBeenCalledWith("Camera")
        expect(host.store.get(cameraKey())).toBe("on")
        expect(card()).not.toContain("Camera is off")
      } finally {
        vi.useRealTimers()
      }
    })

    it.each([
      [true, "on"],
      [false, "off"],
      [undefined, "unknown"],
    ])("stores a late answer of %s as %s once the wait is over", async (granted, stored) => {
      // Given
      let answer: (granted: boolean | undefined) => void = () => {}
      const requestDevice = vi.fn((kind: string) =>
        kind === "Camera" ? new Promise<boolean | undefined>((resolve) => (answer = resolve)) : Promise.resolve(true),
      )
      const host = welcomedHost({ permissions: { requestDevice } })
      host.store.set(cameraKey(), "unknown")
      const { press } = await registeredCard(host)
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        press("jollity.turn-on-camera", undefined)
        await vi.advanceTimersByTimeAsync(30_000)

        // When
        answer(granted)
        await vi.advanceTimersByTimeAsync(0)

        // Then
        expect(host.store.get(cameraKey())).toBe(stored)
      } finally {
        vi.useRealTimers()
      }
    })

    it("keeps the line when the answer cannot be stored", async () => {
      // Given
      const host = welcomedHost()
      host.store.set(cameraKey(), "off")
      const { press, card } = await registeredCard(host)
      const write = host.storage.writeJSON
      host.storage.writeJSON = vi.fn(async (key: string, value: unknown) => {
        if (key === cameraKey()) throw new Error("storage down")
        return write(key, value)
      }) as WorkerHost["storage"]["writeJSON"]

      // When
      press("jollity.turn-on-camera", undefined)
      await flush()

      // Then
      expect(host.permissions.requestDevice).toHaveBeenCalledWith("Camera")
      expect(host.store.get(cameraKey())).toBe("off")
      expect(card()).toContain("Camera is off. Turn it on to play.")
    })

    it("does not bring the line back from a read that began before the answer", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
      try {
        // Given
        const host = welcomedHost()
        host.store.set(cameraKey(), "off")
        const { press, card } = await registeredCard(host)
        const read = host.storage.readJSON
        let land: ((stale: string) => void) | undefined
        host.storage.readJSON = vi.fn((key: string) =>
          key === cameraKey() ? new Promise((resolve) => (land = resolve)) : read(key),
        ) as WorkerHost["storage"]["readJSON"]
        await vi.advanceTimersByTimeAsync(3_000)
        await flush()

        // When
        press("jollity.turn-on-camera", undefined)
        await flush()
        land!("off")
        await flush()

        // Then
        expect(host.store.get(cameraKey())).toBe("on")
        expect(card()).not.toContain("Camera is off")
      } finally {
        vi.useRealTimers()
      }
    })

    it("is in the first frame of a card that can draw it", async () => {
      // Given
      const host = welcomedHost()
      host.store.set(cameraKey(), "off")

      // When
      const { send } = await registeredCard(host)

      // Then
      expect(send).toHaveBeenCalled()
      for (const [frame] of send.mock.calls) expect(JSON.stringify(frame)).toContain("Camera is off. Turn it on to play.")
    })

    it("is in the first frame of the registered face when a poll moves the card there", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
      try {
        // Given
        const host = welcomedHost()
        host.store.set(cameraKey(), "off")
        const game = running({ registered: false, drawOpen: false })
        await withChain(chainRead({ running: game }), chainRead({ running: { ...game, registered: true } }))
        const handler = await renderHandler(host)
        const send = vi.fn()
        handler({ messageId: "m-camera-next", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, () => () => {})
        await flush()
        const framesBefore = send.mock.calls.length

        // When
        await vi.advanceTimersByTimeAsync(15_000)
        await flush()
        await vi.advanceTimersByTimeAsync(1_000)
        await flush()

        // Then
        expect(JSON.stringify(send.mock.calls[0]![0])).toContain("Opening soon")
        expect(host.storage.readJSON).toHaveBeenCalledWith(cameraKey())
        const frames = send.mock.calls.slice(framesBefore).map(([frame]) => JSON.stringify(frame))
        expect(frames.length).toBeGreaterThan(0)
        for (const frame of frames) expect(frame).toContain("Camera is off. Turn it on to play.")
      } finally {
        vi.useRealTimers()
      }
    })

    it("is not read for a card on the next game face", async () => {
      // Given
      const host = welcomedHost()
      host.store.set(cameraKey(), "off")
      const game = running({ registered: false, drawOpen: false })
      await withChain(chainRead({ running: game }))
      const handler = await renderHandler(host)
      const send = vi.fn()

      // When
      handler({ messageId: "m-camera-idle", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, () => () => {})
      await flush()

      // Then
      expect(JSON.stringify(send.mock.calls.at(-1)![0])).toContain("Opening soon")
      expect(host.storage.readJSON).not.toHaveBeenCalledWith(cameraKey())
    })

    it("is not read for a settled card", async () => {
      // Given
      const host = welcomedHost()
      host.store.set(cameraKey(), "off")
      const gamePlayTime = nowSeconds() - 3600
      host.store.set(`jollity.wg.recap:${gamePlayTime}`, { cancelled: false, results: RESULTS, gamesToMembership: null, gameIndex: 7 })
      const handler = await renderHandler(host)
      const send = vi.fn()

      // When
      handler({ messageId: "m-camera-settled", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) }, send, () => () => {})
      await flush()

      // Then
      expect(send).toHaveBeenCalledTimes(1)
      expect(host.storage.readJSON).not.toHaveBeenCalledWith(cameraKey())
    })
  })

  it("draws the card once it has read what storage holds for it", async () => {
    // Given
    const host = welcomedHost()
    const handler = await renderHandler(host)
    const send = vi.fn()

    // When
    handler({ messageId: "m5", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: nowSeconds() }) }, send, () => () => {})
    await flush()

    // Then
    expect(send).toHaveBeenCalledTimes(1)
  })

  describe("the Not registered face", () => {
    const REFUSAL = "HostFailure: alarms and notifications are both turned off"
    const NOTICE = "Enable notifications to register."

    type DrawnNode = { tag: string; value?: { text?: string; props?: { clickAction?: string; enabled?: boolean }; children?: DrawnNode[] } }
    const childrenOf = (node: DrawnNode) => node.value?.children ?? []
    const draws = (node: DrawnNode, word: string): boolean =>
      node.tag === "String" ? node.value?.text === word : childrenOf(node).some((child) => draws(child, word))
    const buttonsUnder = (node: DrawnNode): NonNullable<NonNullable<DrawnNode["value"]>["props"]>[] =>
      node.tag === "Button" ? [node.value!.props!] : childrenOf(node).flatMap(buttonsUnder)

    it("shows the notifications line beside a live Register and posts nothing, after a Register tap the host refuses", async () => {
      // Given
      const game = running({ registered: false })
      await withChain(...Array.from({ length: 8 }, () => chainRead({ running: game })))
      const engine = await signupEngineWith(async () => ({ ok: true }))
      const host = welcomedHost({
        accounts: signingAccounts(),
        entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)),
        permissions: { requestDevice: vi.fn(async (kind: string) => kind === "Camera") },
      })
      vi.mocked(host.game.remindNextGame).mockImplementation(async (_startsAt, onError) => {
        onError?.(REFUSAL)
        return "failed"
      })
      const handler = await renderHandler(host)
      const send = vi.fn()
      let press: ActionListener | undefined
      handler({ messageId: "m-blocked", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
        press = listener
        return () => {}
      })
      await flush()

      // When
      press!("jollity.register", undefined)
      for (let step = 0; step < 6; step++) await flush()

      // Then
      const card = send.mock.calls.at(-1)![0] as DrawnNode
      expect(draws(card, "Not registered")).toBe(true)
      expect(draws(card, NOTICE)).toBe(true)
      expect(JSON.stringify(card)).toContain("chat-card/bell-off.png")
      expect(draws(card, "Enable")).toBe(false)
      expect(buttonsUnder(card)).toEqual([expect.objectContaining({ clickAction: "jollity.register", enabled: true })])
      expect(engine.register).not.toHaveBeenCalled()
      expect(postedRules(host)).toEqual([])
    })

    it("signs up on a second Register tap once the phone grants the notifications and the host holds the reminder", async () => {
      // Given
      const game = running({ registered: false })
      await withChain(...Array.from({ length: 12 }, () => chainRead({ running: game })))
      const engine = await signupEngineWith(async (options) => {
        options.onBroadcast?.()
        return { ok: true }
      })
      let notificationsGranted = false
      const host = welcomedHost({
        accounts: signingAccounts(),
        entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)),
        permissions: { requestDevice: vi.fn(async (kind: string) => kind === "Camera" || (kind === "Notifications" && notificationsGranted)) },
      })
      vi.mocked(host.game.remindNextGame).mockImplementation(async (_startsAt, onError) => {
        if (notificationsGranted) return "held"
        onError?.(REFUSAL)
        return "failed"
      })
      const handler = await renderHandler(host)
      const send = vi.fn()
      let press: ActionListener | undefined
      handler({ messageId: "m-granted", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
        press = listener
        return () => {}
      })
      await flush()
      press!("jollity.register", undefined)
      for (let step = 0; step < 6; step++) await flush()
      expect(draws(send.mock.calls.at(-1)![0] as DrawnNode, "Not registered")).toBe(true)
      notificationsGranted = true

      // When
      press!("jollity.register", undefined)
      for (let step = 0; step < 6; step++) await flush()

      // Then
      expect(engine.register).toHaveBeenCalledTimes(1)
      const card = send.mock.calls.at(-1)![0] as DrawnNode
      expect(draws(card, "Not registered")).toBe(false)
      expect(JSON.stringify(card)).toContain("You're in")
    })
  })
})

describe("the card fails", () => {
  it("a card posted before the chain reads renders as ended", async () => {
    // Given
    const host = welcomedHost()
    const handler = await renderHandler(host)
    const send = vi.fn()

    // When
    handler(
      { messageId: "m2", messageType: "jollity.gamecard", payload: encPayload({ state: 0, deadlineSec: 1, gameKey: "g74:1" }) },
      send,
      () => () => {},
    )

    // Then
    expect(JSON.stringify(send.mock.calls[0]![0])).toContain("This game has ended.")
  })
})

describe("a card settles", () => {
  it("keeps a card syncing until its collectibles are counted, and pictured when the game earned some", async () => {
    // Given
    const { settledCard } = await import("./index")
    const uncounted = { cancelled: false, results: RESULTS, gamesToMembership: null, gameIndex: 7 }
    const counted = { ...uncounted, results: { ...RESULTS, earned: 2 } }
    const pictured = { ...uncounted, results: { ...RESULTS, earned: 2, collectables: [OCTOPUS, OCTOPUS] } }
    const empty = { ...uncounted, results: { ...RESULTS, earned: 0 } }

    // When
    const states = [uncounted, counted, pictured, empty].map((outcome) => settledCard(outcome, UNSEEN))

    // Then
    expect(states).toEqual([false, false, true, true])
  })

  it("settles a pictured card whether or not the app marked its chest seen, since the collectibles open in the stash", async () => {
    // Given
    const { settledCard } = await import("./index")
    const newMember = { ...RESULTS, earned: 1, collectables: [OCTOPUS], membership: { member: true, justBecameMember: true, gamesToMembership: null } }
    const member = { ...RESULTS, earned: 1, collectables: [OCTOPUS], seen: { chest: false, draw: false } }

    // When
    const settled = [newMember, member].map((results) => settledCard({ cancelled: false, results, gamesToMembership: null, gameIndex: 7 }, UNSEEN))

    // Then
    expect(settled).toEqual([true, true])
  })

  it("keeps the missed card of a registered player syncing until a report says they played and their collectibles are counted, and a cancelled one never", async () => {
    // Given
    const { settledCard } = await import("./index")
    const missed: StoredOutcome = { cancelled: false, results: null, gamesToMembership: null, gameIndex: 7, registered: true }

    // When
    const unreported = settledCard(missed, UNSEEN)
    const reportedByTheApp = settledCard({ ...missed, earned: 2 }, { ...UNSEEN, report: true })
    const reportedByTheChain = settledCard({ ...missed, reported: true, earned: 0 }, UNSEEN)
    const uncounted = settledCard({ ...missed, reported: true }, UNSEEN)
    const uncountedByTheApp = settledCard(missed, { ...UNSEEN, report: true })
    const cancelled = settledCard({ ...missed, cancelled: true }, UNSEEN)
    const neverRegistered = settledCard({ ...missed, registered: false }, UNSEEN)

    // Then
    expect([unreported, reportedByTheApp, reportedByTheChain, uncounted, uncountedByTheApp, cancelled, neverRegistered]).toEqual([false, true, true, false, false, true, true])
  })
})

describe("the reminder gate of Register works", () => {
  const unregistered = () => chainRead({ running: running({ registered: false }) })

  it("tells a player who refused the reminders twice to turn them on, and asks again on the next tap", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    const read = unregistered()
    vi.mocked(host.game.remindNextGame).mockResolvedValueOnce("denied").mockResolvedValueOnce("denied").mockResolvedValueOnce("held")

    // When
    const refused = await remindersInPlace(host, read, true)
    const asksOfTheFirstTap = vi.mocked(host.game.remindNextGame).mock.calls.length
    const held = await remindersInPlace(host, read, true)

    // Then
    expect(refused).toBe("Enable notifications to register.")
    expect(asksOfTheFirstTap).toBe(2)
    expect(held).toBeNull()
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(3)
    expect(host.notifications.push).not.toHaveBeenCalled()
  })

  it("asks once more when the host fails, and lets the player register on the second answer", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValueOnce("failed").mockResolvedValueOnce("held")

    // When
    const notice = await remindersInPlace(host, unregistered(), true)

    // Then
    expect(notice).toBeNull()
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(2)
  })

  it("takes one fresh chain read before refusing that there is no game to join", async () => {
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    const freshRead = vi.fn().mockResolvedValue(unregistered())
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")

    const notice = await remindersInPlace(host, null, true, () => {}, freshRead)

    expect(notice).toBeNull()
    expect(freshRead).toHaveBeenCalledTimes(1)
  })

  it("waits for the answer to an ask the app has under way, and lets the player register once the host holds the reminder", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      // Given
      const { remindersInPlace } = await import("./index")
      const host = fakeHost()
      const read = unregistered()
      const gamePlayTime = read.running!.gamePlayTime
      const startsAt = gamePlayTime * 1000 - 60_000
      host.store.set("jollity.wg.host-reminder", { gamePlayTime, startsAt, outcome: "asking", at: Date.now() })

      // When
      const gate = remindersInPlace(host, read, true)
      await vi.advanceTimersByTimeAsync(20_000)
      host.store.set("jollity.wg.host-reminder", { gamePlayTime, startsAt, outcome: "held", at: Date.now() })
      await vi.advanceTimersByTimeAsync(2_000)

      // Then
      expect(await gate).toBeNull()
      expect(host.game.remindNextGame).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("asks over an ask the record has shown for longer than a host call may take", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    const read = unregistered()
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: read.running!.gamePlayTime, outcome: "asking", at: Date.now() - 60_000 })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")

    // When
    const notice = await remindersInPlace(host, read, true)

    // Then
    expect(notice).toBeNull()
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
  })

  it("lets the player register on a held reminder that a failed read hid from the ask", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    const read = unregistered()
    const gamePlayTime = read.running!.gamePlayTime
    host.store.set("jollity.wg.host-reminder", { gamePlayTime, startsAt: gamePlayTime * 1000 - 60_000, outcome: "held", at: Date.now() })
    const readJSON = host.storage.readJSON
    let reads = 0
    host.storage.readJSON = vi.fn(async (key: string) => {
      if (key === "jollity.wg.host-reminder" && ++reads === 2) throw new Error("busy")
      return readJSON(key)
    }) as WorkerHost["storage"]["readJSON"]

    // When
    const notice = await remindersInPlace(host, read, true)

    // Then
    expect(notice).toBeNull()
    expect(host.game.remindNextGame).not.toHaveBeenCalled()
  })

  it("asks again on a dropped reminder that a failed read hid from the first ask", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    const read = unregistered()
    const gamePlayTime = read.running!.gamePlayTime
    host.store.set("jollity.wg.host-reminder", { gamePlayTime, startsAt: gamePlayTime * 1000 - 60_000, outcome: "dropped", at: Date.now() })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    const readJSON = host.storage.readJSON
    let reads = 0
    host.storage.readJSON = vi.fn(async (key: string) => {
      if (key === "jollity.wg.host-reminder" && ++reads === 2) throw new Error("busy")
      return readJSON(key)
    }) as WorkerHost["storage"]["readJSON"]

    // When
    const notice = await remindersInPlace(host, read, true)

    // Then
    expect(notice).toBeNull()
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
  })

  it("stops waiting once a host call would have answered, even on a claim dated ahead of the clock", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      // Given
      const { remindersInPlace } = await import("./index")
      const host = fakeHost()
      const read = unregistered()
      const gamePlayTime = read.running!.gamePlayTime
      host.store.set("jollity.wg.host-reminder", { gamePlayTime, startsAt: gamePlayTime * 1000 - 60_000, outcome: "asking", at: Date.now() + 3_600_000 })
      vi.mocked(host.game.remindNextGame).mockResolvedValue("held")

      // When
      const gate = remindersInPlace(host, read, true)
      await vi.advanceTimersByTimeAsync(46_000)

      // Then
      expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
      expect(await gate).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels a reminder the host held after the deadline of the first ask, with no answer to the second, once the player is read out twice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      // Given
      const { remindersInPlace, keepHostReminder } = await import("./index")
      const host = fakeHost()
      let hostHolds = false
      vi.mocked(host.game.remindNextGame)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) =>
              setTimeout(() => {
                hostHolds = true
                resolve("held")
              }, 50_000),
            ),
        )
        .mockReturnValueOnce(new Promise(() => {}))
      vi.mocked(host.game.cancelNextGame).mockImplementation(async () => {
        hostHolds = false
        return "dropped"
      })
      const out = unregistered()
      const gate = remindersInPlace(host, out, true)
      await vi.advanceTimersByTimeAsync(46_000)
      await vi.advanceTimersByTimeAsync(46_000)
      const notice = await gate
      await vi.advanceTimersByTimeAsync(10_000)

      // When: the player never signs up
      for (let poll = 0; poll < 3; poll++) {
        await keepHostReminder(host, out)
        await vi.advanceTimersByTimeAsync(15_000)
      }

      // Then
      expect(notice).toBe("Enable notifications to register.")
      expect(hostHolds).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels a reminder whose held answer could not be recorded", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")
    const write = host.storage.writeJSON
    let writes = 0
    host.storage.writeJSON = vi.fn(async (key: string, value: unknown) => {
      if (key === "jollity.wg.host-reminder" && ++writes === 2) throw new Error("storage full")
      await write(key, value)
    })
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))
    const recorded = host.store.get("jollity.wg.host-reminder")
    const out = chainRead({ running: { ...game, registered: false } })

    // When
    await keepHostReminder(host, out)
    const cancelsAfterOne = vi.mocked(host.game.cancelNextGame).mock.calls.length
    await keepHostReminder(host, out)

    // Then
    expect(recorded).toMatchObject({ outcome: "asking" })
    expect(cancelsAfterOne).toBe(0)
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(1)
  })

  it("records a held answer that lands after its ask was given up on and dropped, and cancels it for a player who stays out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      // Given
      const { keepHostReminder } = await import("./index")
      const host = fakeHost()
      let hostHolds = false
      vi.mocked(host.game.remindNextGame).mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              hostHolds = true
              resolve("held")
            }, 80_000),
          ),
      )
      vi.mocked(host.game.cancelNextGame).mockImplementation(async () => {
        hostHolds = false
        return "dropped"
      })
      const game = running({ registered: true })
      const asking = keepHostReminder(host, chainRead({ running: game }))
      await vi.advanceTimersByTimeAsync(46_000)
      await asking
      const out = chainRead({ running: { ...game, registered: false } })
      await keepHostReminder(host, out)
      await keepHostReminder(host, out)
      const dropped = host.store.get("jollity.wg.host-reminder")

      // When: the host answers held after the drop
      await vi.advanceTimersByTimeAsync(40_000)
      const late = host.store.get("jollity.wg.host-reminder")
      await keepHostReminder(host, out)
      await keepHostReminder(host, out)

      // Then
      expect(dropped).toMatchObject({ outcome: "dropped" })
      expect(late).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "held" })
      expect(hostHolds).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("lets Register proceed from a stored StartsInPast refusal without asking again", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    const read = unregistered()
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: read.running!.gamePlayTime, outcome: "starts-in-past", at: Date.now() })

    // When
    const notice = await remindersInPlace(host, read, true)

    // Then
    expect(notice).toBeNull()
    expect(host.game.remindNextGame).not.toHaveBeenCalled()
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: read.running!.gamePlayTime, outcome: "starts-in-past" })
  })

  it("books the notifications again on a Register tap inside the retry window of a failed booking", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    const read = unregistered()
    host.store.set("jollity.wg.notifs", { gamePlayTime: read.running!.gamePlayTime, registered: true, hostReminds: false, ids: [], complete: false, retryAt: Date.now() + 60_000 })

    // When
    const notice = await remindersInPlace(host, read, false)

    // Then
    expect(notice).toBeNull()
    expect(host.notifications.push).toHaveBeenCalledTimes(3)
  })

  it("asks the host again on a Register tap after it answered unsupported, so an updated app is noticed", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    const read = unregistered()
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: read.running!.gamePlayTime, outcome: "unsupported", at: Date.now() })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")

    // When
    const notice = await remindersInPlace(host, read, true)

    // Then
    expect(notice).toBeNull()
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
  })

  it("asks the host again and signs up when the answer of the host could not be recorded", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    const read = unregistered()
    vi.mocked(host.game.remindNextGame).mockResolvedValueOnce("denied").mockResolvedValue("held")
    const write = host.storage.writeJSON
    let writes = 0
    host.storage.writeJSON = vi.fn(async (key: string, value: unknown) => {
      if (key === "jollity.wg.host-reminder" && ++writes === 2) throw new Error("storage full")
      await write(key, value)
    })

    // When
    const notice = await remindersInPlace(host, read, true)

    // Then
    expect(host.permissions.requestDevice).toHaveBeenCalledWith("Notifications")
    expect(notice).toBeNull()
  })

  it("says notifications are required when the host fails on both asks", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValue("failed")

    // When
    const notice = await remindersInPlace(host, unregistered(), true)

    // Then
    expect(notice).toBe("Enable notifications to register.")
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(2)
  })

  it("goes on with the sign-up on a record of another game, which a claim the storage refused leaves behind, once the host holds the next ask", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    const read = unregistered()
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: read.running!.gamePlayTime - 3600, outcome: "unsupported", at: Date.now() })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    const write = host.storage.writeJSON
    let refused = false
    host.storage.writeJSON = vi.fn(async (key: string, value: unknown) => {
      if (key === "jollity.wg.host-reminder" && !refused) {
        refused = true
        throw new Error("storage full")
      }
      await write(key, value)
    })

    // When
    const notice = await remindersInPlace(host, read, true)

    // Then
    expect(notice).toBeNull()
  })

  it("keeps the game product from registering in a host that cannot remind", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()

    // When
    const notice = await remindersInPlace(host, unregistered(), true)

    // Then
    expect(notice).toBe("Update to new version to register.")
    expect(host.notifications.push).not.toHaveBeenCalled()
  })

  it("lets another product register on the notifications the chat books, when the host cannot remind", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()

    // When
    const notice = await remindersInPlace(host, unregistered(), false)

    // Then
    expect(notice).toBeNull()
    expect(host.permissions.requestDevice).toHaveBeenCalledWith("Notifications")
    expect(host.notifications.push).toHaveBeenCalledTimes(3)
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ registered: true, complete: true })
  })

  it("lets another product register when only the cancel of an old reminder was refused", async () => {
    // Given
    const { remindersInPlace, scheduleReminders } = await import("./index")
    const host = fakeHost()
    const read = unregistered()
    vi.mocked(host.notifications.push).mockResolvedValueOnce(41)
    await scheduleReminders(host, read)
    vi.mocked(host.notifications.cancel).mockRejectedValueOnce(new Error("busy"))

    // When
    const notice = await remindersInPlace(host, read, false)

    // Then
    expect(notice).toBeNull()
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ registered: true, complete: false, stale: [{ id: 41 }] })
  })

  it("lets another product register when only the hour notice of a later game was refused", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    const next = nowSeconds() + 86_400
    const read = chainRead({
      running: running({ registered: false }),
      upcoming: [{ gamePlayTime: next, registrationStarts: next - 7200, registrationEnds: next - 90, reportingEnds: next + 600 }],
    })
    vi.mocked(host.notifications.push)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockRejectedValue(new Error("no permission"))

    // When
    const notice = await remindersInPlace(host, read, false)

    // Then
    expect(notice).toBeNull()
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ registered: true, complete: false, ids: [1, 1, 1] })
  })

  it.each([
    ["the host fails on both asks", "failed", "ask-failed"],
    ["the player refused twice", "denied", "reminders-denied"],
  ] as const)("names notifications as what the sign-up needs when %s", async (_name, answer, reason) => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValue(answer)
    const reportBlocked = vi.fn()

    // When
    await remindersInPlace(host, unregistered(), true, reportBlocked)

    // Then
    expect(reportBlocked).toHaveBeenCalledWith(reason, "notifications")
  })

  it("names notifications as what the sign-up needs when another product cannot book them", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.notifications.push).mockRejectedValue(new Error("notifications are off"))
    const reportBlocked = vi.fn()

    // When
    await remindersInPlace(host, unregistered(), false, reportBlocked)

    // Then
    expect(reportBlocked).toHaveBeenCalledWith("notifications-not-booked", "notifications")
  })

  it("names no need when the gate could not read the game", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const reportBlocked = vi.fn()

    // When
    await remindersInPlace(fakeHost(), null, true, reportBlocked)

    // Then
    expect(reportBlocked).toHaveBeenCalledWith("chain-unread", undefined)
  })

  it("keeps another product from registering when its notifications cannot be booked", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.notifications.push).mockRejectedValue(new Error("notifications are off"))

    // When
    const notice = await remindersInPlace(host, unregistered(), false)

    // Then
    expect(notice).toBe("Enable notifications to register.")
  })

  it("says the sign-up failed while the game cannot be read", async () => {
    // Given
    const { remindersInPlace } = await import("./index")

    // When
    const notice = await remindersInPlace(fakeHost(), null, false)

    // Then
    expect(notice).toBe("Couldn't sign you up.")
  })

  it("says the sign-up failed, with nothing to wait on, when the chain has no game open for sign-up", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const reportBlocked = vi.fn()

    // When
    const notice = await remindersInPlace(fakeHost(), chainRead({ running: null }), false, reportBlocked)

    // Then
    expect(notice).toBe("Couldn't sign you up.")
    expect(reportBlocked).toHaveBeenCalledWith("no-game-to-join", undefined)
  })

  it.each([
    ["the host cannot remind", "unsupported", "Update to new version to register.", "reminders-unsupported", "update"],
    ["the player refuses the reminder", "denied", "Enable notifications to register.", "reminders-denied", "notifications"],
  ] as const)("keeps the game product from registering when %s on the ask after a refused claim", async (_name, answer, notice, reason, needs) => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValue(answer)
    const write = host.storage.writeJSON
    let refused = false
    host.storage.writeJSON = vi.fn(async (key: string, value: unknown) => {
      if (key === "jollity.wg.host-reminder" && !refused) {
        refused = true
        throw new Error("storage full")
      }
      await write(key, value)
    })
    const reportBlocked = vi.fn()

    // When
    const answered = await remindersInPlace(host, unregistered(), true, reportBlocked)

    // Then
    expect(answered).toBe(notice)
    expect(reportBlocked).toHaveBeenCalledWith(reason, needs)
  })

  it("keeps the game product from registering, with nothing to wait on, when the storage refuses every claim", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    host.storage.writeJSON = vi.fn(async () => {
      throw new Error("storage full")
    })
    const reportBlocked = vi.fn()

    // When
    const notice = await remindersInPlace(host, unregistered(), true, reportBlocked)

    // Then
    expect(notice).toBe("Couldn't sign you up.")
    expect(reportBlocked).toHaveBeenCalledWith("reminder-unanswered", undefined)
  })

  it("keeps the game product from registering, with nothing to wait on, when the only record it can keep is of another game", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: unregistered().running!.gamePlayTime + 86_400, outcome: "held" })
    const write = host.storage.writeJSON
    host.storage.writeJSON = vi.fn(async (key: string, value: unknown) => {
      if (key === "jollity.wg.host-reminder") throw new Error("storage full")
      await write(key, value)
    })
    const reportBlocked = vi.fn()

    // When
    const notice = await remindersInPlace(host, unregistered(), true, reportBlocked)

    // Then
    expect(notice).toBe("Couldn't sign you up.")
    expect(reportBlocked).toHaveBeenCalledWith("reminder-unanswered", undefined)
  })

  it("says the sign-up failed, with nothing to wait on, when the phone fails to answer for the notifications", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost({ permissions: { requestDevice: vi.fn().mockRejectedValue(new Error("busy")) } as unknown as WorkerHost["permissions"] })
    host.storage.writeJSON = vi.fn(async () => {
      throw new Error("storage full")
    })
    const reportBlocked = vi.fn()

    // When
    const notice = await remindersInPlace(host, unregistered(), true, reportBlocked)

    // Then
    expect(notice).toBe("Couldn't sign you up.")
    expect(reportBlocked).toHaveBeenCalledWith("permission-failed", undefined)
  })

  it("asks the phone for the notifications once while it has granted them", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost()
    host.storage.writeJSON = vi.fn(async () => {
      throw new Error("storage full")
    })

    // When
    await remindersInPlace(host, unregistered(), true)
    await remindersInPlace(host, unregistered(), true)

    // Then
    expect(host.permissions.requestDevice).toHaveBeenCalledTimes(1)
  })

  it("asks for the notifications when no reminder record exists, and names the need on a refusal", async () => {
    // Given
    const { remindersInPlace } = await import("./index")
    const host = fakeHost({ permissions: { requestDevice: vi.fn().mockResolvedValue(false) } as unknown as WorkerHost["permissions"] })
    host.storage.writeJSON = vi.fn(async () => {
      throw new Error("storage full")
    })
    const reportBlocked = vi.fn()

    // When
    const notice = await remindersInPlace(host, unregistered(), true, reportBlocked)

    // Then
    expect(host.permissions.requestDevice).toHaveBeenCalledWith("Notifications")
    expect(notice).toBe("Enable notifications to register.")
    expect(reportBlocked).toHaveBeenCalledWith("no-record", "notifications")
  })
})

describe("the host reminder works", () => {
  function remindingHost() {
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")
    return host
  }

  it("asks the host to remind a registered player once, a minute ahead of the start on the device clock, whatever the chain clock reads", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    const read = chainRead({ running: game, clockOffsetMs: -600_000 })

    // When
    const first = await keepHostReminder(host, read)
    const second = await keepHostReminder(host, read)

    // Then
    expect([first, second]).toEqual([true, true])
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
    expect(host.game.remindNextGame).toHaveBeenCalledWith(game.gamePlayTime * 1000 - 60_000, expect.any(Function))
    expect(workerLogTexts(host)).toContain(`Game reminder for game at ${game.gamePlayTime} answered held.`)
  })

  it("asks again when the game moves", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))

    // When
    await keepHostReminder(host, chainRead({ running: { ...game, gamePlayTime: game.gamePlayTime + 3600 } }))

    // Then
    expect(vi.mocked(host.game.remindNextGame).mock.calls.map(([at]) => at)).toEqual([
      game.gamePlayTime * 1000 - 60_000,
      (game.gamePlayTime + 3600) * 1000 - 60_000,
    ])
  })

  it("drops the reminder when the game is called off", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))

    // When
    const holds = await keepHostReminder(host, chainRead({ running: { ...game, phase: "cancelled" } }))

    // Then
    expect(holds).toBe(false)
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(1)
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "dropped" })
  })

  it("asks nothing of a player who is not registered", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()

    // When
    const holds = await keepHostReminder(host, chainRead({ running: running({ registered: false }) }))

    // Then
    expect(holds).toBe(false)
    expect(host.game.remindNextGame).not.toHaveBeenCalled()
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
  })

  it("does not ask a host without the service again for the same game", async () => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    const { keepHostReminder } = await import("./index")
    const host = fakeHost()
    const read = chainRead({ running: running({ registered: true }) })

    // When
    await keepHostReminder(host, read)
    vi.setSystemTime(Date.now() + 11 * 60_000)
    await keepHostReminder(host, read)
    vi.useRealTimers()

    // Then
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
  })

  it.each(["failed", "denied"] as const)("asks again ten minutes after the host answered %s", async (answer) => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    const { keepHostReminder } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValueOnce(answer).mockResolvedValue("held")
    const read = chainRead({ running: running({ registered: true }) })
    await keepHostReminder(host, read)

    // When
    const soon = await keepHostReminder(host, read)
    vi.setSystemTime(Date.now() + 11 * 60_000)
    const later = await keepHostReminder(host, read)
    vi.useRealTimers()

    // Then
    expect([soon, later]).toEqual([false, true])
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(2)
  })

  it("tries a failed cancel again ten minutes later, not on every poll", async () => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))
    vi.mocked(host.game.cancelNextGame).mockResolvedValueOnce("failed")
    const out = chainRead({ running: { ...game, registered: false } })
    await keepHostReminder(host, out)
    await keepHostReminder(host, out)

    // When
    await keepHostReminder(host, out)
    const cancelsBeforeTheWait = vi.mocked(host.game.cancelNextGame).mock.calls.length
    vi.setSystemTime(Date.now() + 11 * 60_000)
    await keepHostReminder(host, out)
    vi.useRealTimers()

    // Then
    expect(cancelsBeforeTheWait).toBe(1)
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(2)
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "dropped" })
  })

  it("books no start notification on a poll once the host holds the reminder", async () => {
    // Given
    const game = running({ registered: true })
    await withChain(chainRead({ running: game }))
    const { tick } = await import("./index")
    const host = remindingHost()

    // When
    await tick(host)

    // Then
    expect(host.game.remindNextGame).toHaveBeenCalledWith(game.gamePlayTime * 1000 - 60_000, expect.any(Function))
    expect(host.notifications.push).not.toHaveBeenCalled()
  })

  it("keeps the reminder through a poll that could not read the registration", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))

    // When
    const holds = await keepHostReminder(host, chainRead({ running: { ...game, registered: null } }))

    // Then
    expect(holds).toBe(true)
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
  })

  it("keeps the reminder through one BetweenGames read while its game is still ahead", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))

    // When
    const first = await keepHostReminder(host, chainRead({ running: null }))
    const cancelsAfterOne = vi.mocked(host.game.cancelNextGame).mock.calls.length
    const second = await keepHostReminder(host, chainRead({ running: null }))

    // Then
    expect([first, second]).toEqual([true, false])
    expect(cancelsAfterOne).toBe(0)
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(1)
  })

  it("names settled cleanup game-over and a missing running game no-game", async () => {
    const { reminderCancelWhy } = await import("./index")
    const game = running({ registered: true })

    expect(reminderCancelWhy(game.gamePlayTime, { ...game, phase: "settling" })).toBe("game-over")
    expect(reminderCancelWhy(game.gamePlayTime, null)).toBe("no-game")
    expect(reminderCancelWhy(game.gamePlayTime, { ...game, registered: false })).toBe("unregistered")
  })

  it.each(["shuffle", "reporting"] as const)("keeps the reminder once the game reaches %s", async (phase) => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))

    // When
    const holds = await keepHostReminder(host, chainRead({ running: { ...game, phase } }))

    // Then
    expect(holds).toBe(true)
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
  })

  it("takes a cancel a host answers unsupported as done", async () => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("unsupported")
    const out = chainRead({ running: { ...game, registered: false } })
    await keepHostReminder(host, out)

    // When
    await keepHostReminder(host, out)
    vi.setSystemTime(Date.now() + 11 * 60_000)
    await keepHostReminder(host, out)
    vi.useRealTimers()

    // Then
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(1)
    expect(workerLogEntries(host)).toContainEqual(["info", "Game reminder cancel answered unsupported."])
  })

  it("cancels a game called off on every poll, though the chat never asked for its reminder", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const calledOff = chainRead({ running: running({ registered: true, phase: "cancelled" }) })

    // When
    await keepHostReminder(host, calledOff)
    await keepHostReminder(host, calledOff)

    // Then
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(2)
  })

  it("a called-off game is cancelled on every poll even after a dropped record", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true, phase: "cancelled" })
    let hostHolds = true
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: game.gamePlayTime, outcome: "held", startsAt: 1, at: 1 })
    vi.mocked(host.game.cancelNextGame).mockImplementationOnce(async () => {
      // the app's own ask lands while the chat's cancel is in flight
      hostHolds = true
      host.store.set("jollity.wg.host-reminder", { gamePlayTime: game.gamePlayTime, outcome: "held", startsAt: 1, at: 2 })
      return "dropped"
    })
    vi.mocked(host.game.cancelNextGame).mockImplementation(async () => {
      hostHolds = false
      return "dropped"
    })
    const off = chainRead({ running: game })

    // When
    await keepHostReminder(host, off)
    await keepHostReminder(host, off)

    // Then
    expect(hostHolds).toBe(false)
  })

  it("the gate waits for an in-flight cancel before it reads the record", async () => {
    // Given
    const { keepHostReminder, remindersInPlace } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))
    const out = chainRead({ running: { ...game, registered: false } })
    await keepHostReminder(host, out)
    let answerCancel: (outcome: "dropped") => void = () => {}
    vi.mocked(host.game.cancelNextGame).mockReturnValueOnce(new Promise((resolve) => (answerCancel = resolve)))
    const cancelling = keepHostReminder(host, out)
    await flush()

    // When: the player taps Register while the cancel is in flight
    const gate = remindersInPlace(host, out, true)
    await flush()
    const asksDuringTheCancel = vi.mocked(host.game.remindNextGame).mock.calls.length
    answerCancel("dropped")
    await cancelling

    // Then
    expect(await gate).toBeNull()
    expect(asksDuringTheCancel).toBe(1)
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(2)
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "held" })
  })

  it("asks again when the player registers again for a game whose reminder was dropped", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))
    await keepHostReminder(host, chainRead({ running: { ...game, registered: false } }))
    await keepHostReminder(host, chainRead({ running: { ...game, registered: false } }))

    // When
    const holds = await keepHostReminder(host, chainRead({ running: game }))

    // Then
    expect(holds).toBe(true)
    expect(host.game.remindNextGame).toHaveBeenCalledTimes(2)
  })

  it("drops the reminder of the old start when the host fails to move it", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))
    vi.mocked(host.game.remindNextGame).mockResolvedValueOnce("failed")

    // When
    const holds = await keepHostReminder(host, chainRead({ running: { ...game, gamePlayTime: game.gamePlayTime + 3600 } }))

    // Then
    expect(holds).toBe(false)
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(1)
  })

  it("asks nothing for a game the app already got the reminder of", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: game.gamePlayTime, outcome: "held" })

    // When
    const holds = await keepHostReminder(host, chainRead({ running: game }))

    // Then
    expect(holds).toBe(true)
    expect(host.game.remindNextGame).not.toHaveBeenCalled()
  })

  it("does not take a held reminder of another game through a poll that could not read the registration", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))

    // When
    const holds = await keepHostReminder(
      host,
      chainRead({ running: { ...game, gamePlayTime: game.gamePlayTime + 3600, registered: null } }),
    )

    // Then
    expect(holds).toBe(false)
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
  })

  it("drops the reminder once the game settles, and stays quiet after", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))
    const settled = chainRead({ running: { ...game, phase: "settling" } })

    // When
    await keepHostReminder(host, settled)
    await keepHostReminder(host, settled)

    // Then
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(1)
    expect(host.store.get("jollity.wg.host-reminder")).toMatchObject({ gamePlayTime: game.gamePlayTime, outcome: "dropped" })
  })

  it("keeps the reminder through one read of not registered, and drops it on the second", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))
    const out = chainRead({ running: { ...game, registered: false } })

    // When
    const first = await keepHostReminder(host, out)
    const cancelsAfterOne = vi.mocked(host.game.cancelNextGame).mock.calls.length
    const second = await keepHostReminder(host, out)

    // Then
    expect([first, second]).toEqual([true, false])
    expect(cancelsAfterOne).toBe(0)
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(1)
  })

  it("forgets a read of not registered once a later poll reads the player registered", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    const out = chainRead({ running: { ...game, registered: false } })
    await keepHostReminder(host, chainRead({ running: game }))
    await keepHostReminder(host, out)
    await keepHostReminder(host, chainRead({ running: game }))

    // When
    await keepHostReminder(host, out)

    // Then
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
  })

  it("asks again after a failure with the start it sent first, though its clock reading moved", async () => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    const { keepHostReminder } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValueOnce("failed").mockResolvedValue("held")
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))

    // When
    vi.setSystemTime(Date.now() + 11 * 60_000)
    await keepHostReminder(host, chainRead({ running: game, clockOffsetMs: -4_000 }))
    vi.useRealTimers()

    // Then
    expect(vi.mocked(host.game.remindNextGame).mock.calls.map(([at]) => at)).toEqual([
      game.gamePlayTime * 1000 - 60_000,
      game.gamePlayTime * 1000 - 60_000,
    ])
  })

  it("asks again with the same start after the reminder of a lost sign-up was dropped", async () => {
    // Given: the gate asked, the sign-up went nowhere, and two polls read the player out
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game, clockOffsetMs: 0 }), true)
    const out = chainRead({ running: { ...game, registered: false }, clockOffsetMs: 0 })
    await keepHostReminder(host, out)
    await keepHostReminder(host, out)

    // When: the player signs up, read with the chain clock a block later
    await keepHostReminder(host, chainRead({ running: game, clockOffsetMs: -4_321 }), true)

    // Then
    const starts = vi.mocked(host.game.remindNextGame).mock.calls.map(([startsAt]) => startsAt)
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(1)
    expect(starts).toEqual([game.gamePlayTime * 1000 - 60_000, game.gamePlayTime * 1000 - 60_000])
  })

  it("sends the start the app recorded for the game", async () => {
    // Given
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    const recorded = game.gamePlayTime * 1000 + 2_500
    host.store.set("jollity.wg.host-reminder", {
      gamePlayTime: game.gamePlayTime,
      startsAt: recorded,
      outcome: "failed",
      at: Date.now() - 11 * 60_000,
    })

    // When
    await keepHostReminder(host, chainRead({ running: game }))
    vi.useRealTimers()

    // Then
    expect(host.game.remindNextGame).toHaveBeenCalledWith(recorded, expect.any(Function))
  })

  it("waits on an ask the record shows still under way", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    const game = running({ registered: true })
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: game.gamePlayTime, outcome: "asking", at: Date.now() })

    // When
    const holds = await keepHostReminder(host, chainRead({ running: game }))

    // Then
    expect(holds).toBe(false)
    expect(host.game.remindNextGame).not.toHaveBeenCalled()
  })

  it("asks nothing when it cannot record the start first", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    host.storage.writeJSON = vi.fn().mockRejectedValue(new Error("full"))

    // When
    const holds = await keepHostReminder(host, chainRead({ running: running({ registered: true }) }))

    // Then
    expect(holds).toBe(false)
    expect(host.game.remindNextGame).not.toHaveBeenCalled()
  })

  it("cancels nothing when a first ask fails with no reminder held", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValue("failed")

    // When
    await keepHostReminder(host, chainRead({ running: running({ registered: true }) }))

    // Then
    expect(host.game.cancelNextGame).not.toHaveBeenCalled()
  })

  it("asks nothing when it cannot read what it asked before", async () => {
    // Given
    const { keepHostReminder } = await import("./index")
    const host = remindingHost()
    host.storage.readJSON = vi.fn().mockRejectedValue(new Error("busy")) as WorkerHost["storage"]["readJSON"]

    // When
    const holds = await keepHostReminder(host, chainRead({ running: running({ registered: true }) }))

    // Then
    expect(holds).toBe(false)
    expect(host.game.remindNextGame).not.toHaveBeenCalled()
  })

  it("books no notification for a registered player the host reminds, and cancels the ones booked before", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.notifications.push).mockResolvedValueOnce(41).mockResolvedValueOnce(42).mockResolvedValueOnce(43)
    const read = chainRead({ running: running({ registered: true }) })
    await scheduleReminders(host, read)

    // When
    await scheduleReminders(host, read, true)

    // Then
    expect(host.notifications.push).toHaveBeenCalledTimes(3)
    expect(vi.mocked(host.notifications.cancel).mock.calls.map(([id]) => id)).toEqual([41, 42, 43])
  })

  it("still warns an unregistered player when the host serves the reminder", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const game = running({ registrationEnds: nowSeconds() + 3 * 3600 })

    // When
    await scheduleReminders(host, chainRead({ running: game }), true)

    // Then
    expect(pushedTexts(host)).toEqual([OPENS_NOTICE, HOUR_NOTICE, TEN_MINUTES_NOTICE])
  })
})

describe("the worker without storage fails safe", () => {
  function hostWithoutStorage() {
    return fakeHost({
      storage: {
        readJSON: vi.fn().mockRejectedValue(new Error("no storage")) as WorkerHost["storage"]["readJSON"],
        writeJSON: vi.fn().mockRejectedValue(new Error("no storage")),
        readProductJSON: vi.fn().mockRejectedValue(new Error("no storage")) as WorkerHost["storage"]["readProductJSON"],
      },
    })
  }

  it("posts no rules when it cannot remember posting them", async () => {
    // Given
    const host = hostWithoutStorage()
    const { deliverIntro } = await import("./index")

    // When
    await deliverIntro(host, 0)
    await deliverIntro(host, 0)

    // Then
    expect(host.chat.postText).not.toHaveBeenCalled()
  })

  it("posts no card, books no reminder and stores no outcome when a read fails", async () => {
    // Given
    const chain = await withChain(chainRead({ running: running({ registered: true }) }))
    const host = fakeHost()
    host.store.set("jollity.wg.games", [{ index: 6, gamePlayTime: 1_700_000_000, airdropsScheduled: 0, endsAt: 1_700_000_600, registered: true, memberBefore: false }])
    const read = host.storage.readJSON
    host.storage.readJSON = vi.fn((key: string) =>
      key === "jollity.wg.games" ? read(key) : Promise.reject(new Error("busy")),
    ) as WorkerHost["storage"]["readJSON"]
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(host.chat.postMessage).not.toHaveBeenCalled()
    expect(host.notifications.push).not.toHaveBeenCalled()
    expect(chain.readOutcome).not.toHaveBeenCalled()
  })

  it("leaves the tracked games alone when reading them fails", async () => {
    // Given
    await withChain(chainRead({ running: running() }))
    const host = fakeHost()
    const tracked = [{ index: 6, gamePlayTime: 1_700_000_000, airdropsScheduled: 0, endsAt: 1_700_000_600, registered: true, memberBefore: false }]
    host.store.set("jollity.wg.games", tracked)
    const read = host.storage.readJSON
    host.storage.readJSON = vi.fn((key: string) =>
      key === "jollity.wg.games" ? Promise.reject(new Error("busy")) : read(key),
    ) as WorkerHost["storage"]["readJSON"]
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(host.store.get("jollity.wg.games")).toEqual(tracked)
  })
})

describe("the worker's telemetry is sent", () => {
  /** Points the freshly imported telemetry at a list instead of Sentry. */
  async function capture(): Promise<TelemetryRecord[]> {
    const telemetry = await import("./telemetry")
    const events: TelemetryRecord[] = []
    telemetry.configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      product: "dim2.paseo",
      fetchImpl: async (_url, init) => {
        events.push(...decodeTelemetryEnvelope(init.body))
      },
    })
    return events
  }
  const metrics = (events: TelemetryRecord[], name: string) => {
    const records = telemetryRecords(events, name, "metric")
    expect(records.every((record) => record.value === 1)).toBe(true)
    return records
  }
  const logs = (events: TelemetryRecord[], name: string) => telemetryRecords(events, name, "log")
  const eventsNamed = (events: TelemetryRecord[], name: string) => telemetryRecords(events, name, "event")
  const transactions = (events: TelemetryRecord[], name: string) => telemetryRecords(events, name, "transaction")

  it("signs up, and files no sign-up failure, when the prize claim of the poll spends the nonce while the sign-up proves", async () => {
    // Given
    const events = await capture()
    const game = running()
    const last = running({ index: 6, gamePlayTime: game.gamePlayTime - 24 * 3600 })
    const chain = await withChain(chainRead({ running: game }))
    const claimable = { amountUsd: 200, ticket: "ab", drawAt: last.gamePlayTime + 3600, phase: "drawn" as const, won: true, claimable: true }
    vi.mocked(chain.readPrize).mockResolvedValue({ prize: claimable, drawIndex: 0 })
    vi.mocked(chain.readClaimed).mockResolvedValue(false)
    let signUpProving: () => void = () => {}
    const proving = new Promise<void>((resolve) => (signUpProving = resolve))
    let claimLanded: () => void = () => {}
    const landed = new Promise<void>((resolve) => (claimLanded = resolve))
    const answers: Array<(options: RegisterOptions) => Promise<{ ok: true }>> = [
      async () => {
        signUpProving()
        await landed
        return { ok: false, error: new GameRegistrationError("sign", "Stale", { retryable: true }).message, code: "Stale" } as never
      },
      async (options) => (options.onBroadcast?.(), { ok: true }),
    ]
    const engine = await signupEngineWith((options) => answers.shift()!(options))
    const claimPrize = vi.fn(async () => {
      await proving
      setTimeout(claimLanded, 0)
      return { ok: false, error: "NotEligibleForAirdrop" }
    })
    Object.assign(engine, { claimPrize, prizeBalances: vi.fn().mockResolvedValue([]) })
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    host.store.set("jollity.wg.games", [{ index: 6, gamePlayTime: last.gamePlayTime, airdropsScheduled: 1, endsAt: last.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(`jollity.wg.recap:${last.gamePlayTime}`, { cancelled: false, results: { ...RESULTS, prize: { ...claimable, phase: "waiting", won: false, claimable: false } }, gamesToMembership: null, gameIndex: 6 })
    const handler = await renderHandler(host)
    const send = vi.fn()
    let pressRegister: ActionListener | undefined
    handler({ messageId: "m1", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
      pressRegister = listener
      return () => {}
    })
    await flush()

    // When
    pressRegister!("jollity.register", undefined)
    for (let step = 0; step < 16; step++) await flush()

    // Then
    expect(claimPrize).toHaveBeenCalledTimes(1)
    expect(engine.register).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(send.mock.calls.at(-1)![0])).toContain("You're in")
    expect(events.filter((record) => record.tags["failure.kind"] === "signup-failed")).toEqual([])
  })

  it("sends chat.start once, with the room status, the footer and whether storage works, for the player", async () => {
    // Given
    const events = await capture()
    await withChain(chainRead())
    const { main } = await import("./index")

    // When
    await main(welcomedHost())
    await flush()
    await flush()

    // Then
    const start = metrics(events, "chat.start")
    expect(start).toHaveLength(1)
    expect(start[0]!.tags).toMatchObject({
      surface: "chat",
      room_status: "New",
      footer: "set",
      storage_ok: "true",
      "host.app": "Polkadot Mobile",
      "host.app_version": "1.4.2",
    })
    expect(start[0]!.value).toBe(1)
    expect(start[0]!.tags["user.id"]).toBe(ADDRESS)
  })

  it("sends chat.start even when the host never answers the footer, and when the room cannot register", async () => {
    // Given
    vi.useFakeTimers()
    try {
      const events = await capture()
      await withChain()
      const { main } = await import("./index")
      const silent = welcomedHost()
      silent.chat.setRoomFooter = vi.fn(() => new Promise(() => {})) as never
      const refused = welcomedHost()
      refused.chat.registerRoom = vi.fn().mockRejectedValue(new Error("registerRoom failed"))

      // When
      await main(silent)
      await vi.advanceTimersByTimeAsync(60_000)
      const afterSilent = metrics(events, "chat.start").map((event) => event.tags)
      await main(refused)
      await vi.advanceTimersByTimeAsync(60_000)

      // Then
      expect(afterSilent).toEqual([expect.objectContaining({ room_status: "New", footer: "no-answer" })])
      expect(metrics(events, "chat.start").map((event) => event.tags)).toContainEqual(expect.objectContaining({ room_status: "failed", footer: "skipped" }))
      expect(eventsNamed(events, "host-call-failed: registerRoom")).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("says storage is not ok when the host gives the worker none", async () => {
    // Given
    const events = await capture()
    await withChain()
    const { main } = await import("./index")
    const host = welcomedHost()
    host.storage.readJSON = vi.fn().mockRejectedValue(new Error("no storage in this runtime"))

    // When
    await main(host)
    await flush()
    await flush()

    // Then
    expect(metrics(events, "chat.start")[0]!.tags.storage_ok).toBe("false")
    const failed = metrics(events, "chat.storage.read_failed")
    expect(failed.map((event) => event.tags.key_class)).toContain("jollity.wg.intro.v3")
    expect(logs(events, "chat.storage.read_failed")[0]!.contexts!.detail!.error).toBe("Error: no storage in this runtime")
  })

  it("counts the bot registration, unsupported being an answer and not a failure", async () => {
    // Given
    const events = await capture()
    await withChain()
    const { main } = await import("./index")
    const host = welcomedHost()
    host.chat.registerBot = vi.fn().mockRejectedValue(new Error("registerBot failed: Unsupported"))

    // When
    await main(host)
    await flush()

    // Then
    expect(metrics(events, "chat.bot.register").map((event) => [event.value, event.tags.outcome])).toEqual([[1, "unsupported"]])
  })

  it("records notification permission, booking, intro delivery and a posted card", async () => {
    // Given
    const events = await capture()
    const game = running({ registered: true })
    await withChain(chainRead({ running: game }))
    const { deliverIntro, main, scheduleReminders, tick } = await import("./index")
    const host = fakeHost({ chat: { ...fakeHost().chat, setRoomFooter: vi.fn().mockResolvedValue("unsupported") } })

    // When
    await deliverIntro(host, 0)
    await scheduleReminders(host, chainRead({ running: game }))
    const welcomed = welcomedHost()
    await main(welcomed)
    await tick(host)
    await flush()
    await flush()

    // Then
    expect(metrics(events, "chat.intro.posted")).toHaveLength(INTRO.length)
    expect(metrics(events, "chat.notif.permission").map((event) => event.tags.outcome)).toContain("granted")
    expect(metrics(events, "chat.notif.book")).toContainEqual(expect.objectContaining({ value: 1, tags: expect.objectContaining({ complete: "true", with_deeplink: "3" }) }))
    expect(metrics(events, "chat.card.posted").map((event) => event.tags.outcome)).toContain("sent")
  })

  it("does not fall back or retry a notification push refused for permission", async () => {
    // Given
    const events = await capture()
    await withChain()
    const { main, remindersInPlace, scheduleReminders } = await import("./index")
    const host = welcomedHost({ permissions: { requestDevice: vi.fn().mockResolvedValue(true) } })
    await main(host)
    await flush()
    await flush()
    host.notifications.push = vi.fn().mockRejectedValue(new Error("notifications permission denied"))

    // When
    await scheduleReminders(host, chainRead({ running: running({ registered: true }) }))
    const pushesAfterRefusal = vi.mocked(host.notifications.push).mock.calls.length
    await scheduleReminders(host, chainRead({ running: running({ registered: true }) }))
    await flush()

    // Then
    const failures = metrics(events, "chat.notif.push")
    expect(failures).toHaveLength(3)
    expect(failures.every((event) => event.tags.form === "deeplink")).toBe(true)
    expect(failures.every((event) => event.tags.permission === "not-granted")).toBe(true)
    const failureLogs = logs(events, "chat.notif.push")
    expect(failureLogs).toHaveLength(failures.length)
    expect(failureLogs.every((event) => event.contexts?.detail?.error === "Error: notifications permission denied")).toBe(true)
    expect(metrics(events, "chat.notif.book").at(-1)!.tags.permission).toBe("not-granted")
    expect(host.notifications.push).toHaveBeenCalledTimes(pushesAfterRefusal)
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ complete: false, permissionRefused: true })
    expect(host.store.get("jollity.wg.notifs")).not.toHaveProperty("retryAt")

    vi.mocked(host.permissions.requestDevice).mockResolvedValue(true)
    vi.mocked(host.notifications.push).mockResolvedValue(41)
    await expect(remindersInPlace(host, chainRead({ running: running({ registered: false }) }), false)).resolves.toBeNull()
    expect(host.notifications.push).toHaveBeenCalledTimes(pushesAfterRefusal + 3)
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ complete: true })
    expect(host.store.get("jollity.wg.notifs")).not.toHaveProperty("permissionRefused")
  })

  it("keeps a failed notification request distinct from a declined permission", async () => {
    // Given
    const events = await capture()
    await withChain()
    const { main } = await import("./index")
    const host = welcomedHost({ permissions: { requestDevice: vi.fn().mockRejectedValue(new TypeError("host bridge unavailable")) } })

    // When
    await main(host)
    await flush()
    await flush()

    // Then
    expect(metrics(events, "chat.notif.permission")).toContainEqual(
      expect.objectContaining({
        value: 1,
        tags: expect.objectContaining({ outcome: "failed", error_class: "TypeError" }),
      }),
    )
    expect(logs(events, "chat.notif.permission")).toContainEqual(
      expect.objectContaining({ contexts: { detail: { error: "TypeError: host bridge unavailable" } } }),
    )
    expect(workerLogTexts(host)).toContain("Notification permission request failed (TypeError).")
  })

  it("counts a device answer the host failed to give as not granted", async () => {
    // Given
    const events = await capture()
    await withChain()
    const { main } = await import("./index")
    const host = welcomedHost({ permissions: { requestDevice: vi.fn().mockResolvedValue(undefined) } })

    // When
    await main(host)
    await flush()
    await flush()

    // Then
    expect(metrics(events, "chat.notif.permission")).toContainEqual(
      expect.objectContaining({ value: 1, tags: expect.objectContaining({ outcome: "not-granted" }) }),
    )
    expect(workerLogTexts(host)).toContain("Notification permission not granted.")
  })

  describe("the camera ask", () => {
    async function tapTurnOn(answer: () => Promise<boolean | undefined>) {
      const game = running({ registered: true })
      await withChain(chainRead({ running: game }))
      const requestDevice = vi.fn((kind: string) => (kind === "Camera" ? answer() : Promise.resolve(true)))
      const host = welcomedHost({ permissions: { requestDevice } })
      host.store.set(`jollity.camera.v1:${productAccount()}`, "off")
      const handler = await renderHandler(host)
      let press: ActionListener | undefined
      handler({ messageId: "m-camera-count", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, vi.fn(), (listener) => {
        press = listener
        return () => {}
      })
      await flush()
      return () => press!("jollity.turn-on-camera", undefined)
    }

    it.each([
      ["an allowed camera", async () => true, "granted"],
      ["a declined camera", async () => false, "not-granted"],
      ["an answer the host failed to give", async () => undefined, "failed"],
    ])("counts %s", async (_name, answer, outcome) => {
      // Given
      const events = await capture()
      const tap = await tapTurnOn(answer)

      // When
      tap()
      await flush()

      // Then
      expect(metrics(events, "chat.camera.permission").map((event) => event.tags.outcome)).toEqual([outcome])
    })

    it("counts a host call that threw with its class", async () => {
      // Given
      const events = await capture()
      const tap = await tapTurnOn(() => Promise.reject(new TypeError("host bridge unavailable")))

      // When
      tap()
      await flush()

      // Then
      expect(metrics(events, "chat.camera.permission")).toEqual([
        expect.objectContaining({ value: 1, tags: expect.objectContaining({ outcome: "failed", error_class: "TypeError" }) }),
      ])
      expect(logs(events, "chat.camera.permission")).toContainEqual(
        expect.objectContaining({ contexts: { detail: { error: "TypeError: host bridge unavailable" } } }),
      )
    })

    it("counts an ask the host never answered", async () => {
      // Given
      const events = await capture()
      const tap = await tapTurnOn(() => new Promise<boolean>(() => {}))
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        // When
        tap()
        await vi.advanceTimersByTimeAsync(30_000)

        // Then
        expect(metrics(events, "chat.camera.permission").map((event) => event.tags.outcome)).toEqual(["timed-out"])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it("records rejected notification cancels with permission state and reason", async () => {
    // Given
    const events = await capture()
    await withChain()
    const { main, scheduleReminders } = await import("./index")
    const host = welcomedHost({ permissions: { requestDevice: vi.fn().mockResolvedValue(false) } })
    await main(host)
    await flush()
    await flush()
    const read = chainRead({ running: running({ registered: true }) })
    await scheduleReminders(host, read)
    host.notifications.cancel = vi.fn().mockRejectedValue(new Error("cancel refused"))

    // When
    await scheduleReminders(host, read, true)
    await flush()

    // Then
    const failures = metrics(events, "chat.notif.cancel").filter((event) => event.tags.outcome === "failed")
    expect(failures.length).toBeGreaterThan(0)
    expect(failures.every((event) => event.tags.permission === "not-granted")).toBe(true)
    const failureLogs = logs(events, "chat.notif.cancel")
    expect(failureLogs).toHaveLength(failures.length)
    expect(failureLogs.every((event) => event.contexts?.detail?.error === "Error: cancel refused")).toBe(true)
  })

  it("counts MalformedFrame message refusals against the native host version", async () => {
    // Given
    const events = await capture()
    const telemetry = await import("./telemetry")
    const { deliverIntro } = await import("./index")
    telemetry.setChatHost({ name: "Polkadot Mobile", version: "1.4.2" })
    const firstPicture = INTRO.findIndex((rule) => rule.image)
    const host = fakeHost()
    host.store.set("jollity.wg.intro.v3", firstPicture)
    host.chat.postMessage = vi.fn().mockRejectedValue(
      new Error("chat.postMessage failed", {
        cause: { tag: "Domain", value: { tag: "V1", value: { tag: "MalformedFrame", value: { reason: "wrong codec" } } } },
      }),
    )

    // When
    await expect(deliverIntro(host, 0)).rejects.toThrow("chat.postMessage failed")
    await flush()

    // Then
    expect(metrics(events, "chat.message.malformed_frame")).toContainEqual(
      expect.objectContaining({
        value: 1,
        tags: expect.objectContaining({
          message_type: "jollity.intro",
          "host.app": "Polkadot Mobile",
          "host.app_version": "1.4.2",
        }),
      }),
    )
  })

  it("caps detailed MalformedFrame events and records that further refusals were suppressed", async () => {
    // Given
    const events = await capture()
    const { deliverIntro } = await import("./index")
    const firstPicture = INTRO.findIndex((rule) => rule.image)
    const host = fakeHost()
    host.store.set("jollity.wg.intro.v3", firstPicture)
    host.chat.postMessage = vi.fn().mockRejectedValue(
      new Error("chat.postMessage failed", {
        cause: { tag: "Domain", value: { tag: "V1", value: { tag: "MalformedFrame" } } },
      }),
    )

    // When
    for (let attempt = 0; attempt < 8; attempt++) await expect(deliverIntro(host, 0)).rejects.toThrow("chat.postMessage failed")
    await flush()

    // Then
    expect(metrics(events, "chat.message.malformed_frame")).toHaveLength(5)
    expect(metrics(events, "chat.message.malformed_frame.suppressed")).toEqual([
      expect.objectContaining({ tags: expect.objectContaining({ message_type: "jollity.intro", after: "5" }) }),
    ])
  })

  it("records outcome success and read failure, plus an earned-count failure", async () => {
    // Given
    const events = await capture()
    const game = running()
    const chain = await withChain(
      chainRead({ running: game }),
      chainRead({ running: null }),
      chainRead({ running: null }),
      chainRead({ running: null }),
    )
    vi.mocked(chain.readOutcome)
      .mockResolvedValueOnce({ cancelled: false, results: null, gamesToMembership: 2, gameIndex: game.index })
      .mockResolvedValueOnce(null)
    const { tick } = await import("./index")
    const host = fakeHost()

    // When: remember one game, settle it, then force the stored outcome away and prove the failed read.
    await tick(host)
    await tick(host)
    host.store.delete(`jollity.wg.recap:${game.gamePlayTime}`)
    await tick(host)

    // And: a played outcome whose earned count cannot be read.
    host.store.set(`jollity.wg.recap:${game.gamePlayTime}`, {
      cancelled: false,
      results: RESULTS,
      gamesToMembership: null,
      gameIndex: game.index,
    })
    vi.mocked(chain.connectAssetHub).mockResolvedValue(null)
    await tick(host)
    await flush()

    // Then
    expect(metrics(events, "chat.outcome").map((event) => event.tags.outcome)).toContain("missed")
    expect(metrics(events, "chat.outcome.read_failed").map((event) => event.tags.stage)).toContain("outcome")
    expect(metrics(events, "chat.earned.failed").map((event) => event.tags.stage)).toContain("count")
  })

  it("counts a claim read that throws as a failed outcome read of the claim", async () => {
    // Given
    const events = await capture()
    const chain = await withChain(chainRead({ running: null }))
    const game = running()
    const claimable = { amountUsd: 200, ticket: "ab", drawAt: game.gamePlayTime + 3600, phase: "drawn" as const, won: true, claimable: true }
    vi.mocked(chain.readPrize).mockResolvedValue({ prize: { ...claimable, ticket: "", won: false, claimable: false }, drawIndex: 0 })
    vi.mocked(chain.readClaimed).mockRejectedValue(new Error("socket closed"))
    const host = fakeHost()
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime: game.gamePlayTime, airdropsScheduled: 1, endsAt: game.reportingEnds, registered: true, memberBefore: false }])
    host.store.set(`jollity.wg.recap:${game.gamePlayTime}`, { cancelled: false, results: { ...RESULTS, prize: claimable }, gamesToMembership: null, gameIndex: 7, drawIndex: 0 })
    const { tick } = await import("./index")

    // When
    await tick(host)
    await flush()

    // Then
    expect(metrics(events, "chat.outcome.read_failed").map((event) => [event.tags.stage, event.tags["game.index"]])).toEqual([["claim", "7"]])
  })

  it("keeps a settling deadline in the poll failure streak after counting the outcome read", async () => {
    // Given
    const events = await capture()
    const game = running()
    const chain = await withChain(chainRead({ running: game }), ...Array.from({ length: 3 }, () => chainRead({ running: null })))
    const { CallDeadlineError } = await import("./state")
    vi.mocked(chain.readOutcome).mockRejectedValue(new CallDeadlineError("No answer within 45000ms."))
    const { tick } = await import("./index")
    const host = fakeHost()

    // When: remember the game, then fail its settlement three polls in a row.
    for (let i = 0; i < 4; i++) await tick(host)
    await flush()

    // Then: the outcome detail is bounded to once per game, while the poll reports the third deadline.
    expect(metrics(events, "chat.outcome.read_failed")).toHaveLength(1)
    expect(metrics(events, "chat.poll.failed").map((event) => [event.tags.stage, event.tags.reason])).toEqual([["settle", "deadline"]])
  })

  it("sends every answer to a reminder ask with its reason, and why Register is blocked after the second ask", async () => {
    // Given
    const events = await capture()
    const { remindersInPlace } = await import("./index")
    const { CallDeadlineError } = await import("./state")
    const host = fakeHost()
    const read = chainRead({ running: running({ registered: false }) })
    vi.mocked(host.game.remindNextGame)
      .mockRejectedValueOnce(new Error("the host dropped the call"))
      .mockImplementationOnce(async (_startsAt, onError) => {
        onError?.("HostFailure: notifications are off")
        return "failed"
      })
      .mockRejectedValueOnce(new CallDeadlineError("No answer within 45000ms."))
      .mockImplementationOnce(async (_startsAt, onError) => {
        onError?.("Domain.V1: StartsInPast")
        return "starts-in-past"
      })

    // When
    await remindersInPlace(host, read, true)
    host.store.clear()
    await remindersInPlace(host, read, true)
    await flush()

    // Then
    const asks = metrics(events, "chat.reminder.ask")
    expect(asks.map((event) => [event.tags.outcome, event.tags.retry])).toEqual([
      ["failed", "true"],
      ["failed", "true"],
      ["failed", "true"],
      ["starts-in-past", "true"],
    ])
    expect(logs(events, "chat.reminder.ask").map((log) => log.contexts!.detail!.error)).toEqual([
      "Error: the host dropped the call",
      "HostFailure: notifications are off",
      "Error: No answer within 45000ms.",
      "Domain.V1: StartsInPast",
    ])
    const blocked = metrics(events, "chat.register.blocked")
    expect(blocked.map((event) => [event.tags.reason, event.tags.retried])).toEqual([["ask-failed", "true"]])
  })

  it("draws Not registered and the way back on the card after a Register tap the failed ask blocked", async () => {
    // Given
    const events = await capture()
    const game = running({ registered: false })
    await withChain(chainRead({ running: game }))
    await signupEngineWith(async () => ({ ok: true }))
    const host = welcomedHost({ accounts: signingAccounts(), entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)) })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("failed")
    const handler = await renderHandler(host)
    const send = vi.fn()
    let press: ActionListener | undefined
    handler({ messageId: "m1-blocked", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.register", undefined)
    for (let step = 0; step < 6; step++) await flush()

    // Then
    expect(metrics(events, "chat.register.blocked").map((event) => event.tags.reason)).toEqual(["ask-failed"])
    const card = JSON.stringify(send.mock.calls.at(-1)![0])
    expect(card).toContain("Not registered")
    expect(card).toContain("Enable notifications to register.")
    expect(card).not.toContain("Next game")
    expect(card).toContain("jollity.register")
  })

  it("asks for the camera on a Register tap, and signs up whatever the answer", async () => {
    // Given
    const game = running({ registered: false })
    await withChain(chainRead({ running: game }))
    await signupEngineWith(async () => ({ ok: true }))
    const host = welcomedHost({
      accounts: signingAccounts(),
      entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)),
      permissions: { requestDevice: vi.fn().mockResolvedValue(false) },
    })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("failed")
    const handler = await renderHandler(host)
    const send = vi.fn()
    let press: ActionListener | undefined
    handler({ messageId: "m1-camera", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.register", undefined)
    for (let step = 0; step < 6; step++) await flush()

    // Then
    expect(host.permissions.requestDevice).toHaveBeenCalledWith("Camera")
    expect(host.game.remindNextGame).toHaveBeenCalled()
    const card = JSON.stringify(send.mock.calls.at(-1)![0])
    expect(card).toContain("Camera is off. Turn it on to play.")
  })

  describe("while the camera is asked", () => {
    const BUSY_REGISTER = '"loading":true'

    async function registerCard() {
      let answer: (granted: boolean | undefined) => void = () => {}
      const requestDevice = vi.fn((kind: string) =>
        kind === "Camera"
          ? new Promise<boolean | undefined>((resolve) => {
              answer = resolve
            })
          : Promise.resolve(true),
      )
      const game = running({ registered: false })
      await withChain(chainRead({ running: game }))
      await signupEngineWith(async () => ({ ok: true }))
      const host = welcomedHost({
        accounts: signingAccounts(),
        entropy: vi.fn().mockResolvedValue(new Uint8Array(32).fill(3)),
        permissions: { requestDevice },
      })
      vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
      const handler = await renderHandler(host)
      const send = vi.fn()
      let press: ActionListener | undefined
      handler({ messageId: "m1-asking", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
        press = listener
        return () => {}
      })
      await flush()
      return {
        host,
        press: press!,
        answer: (granted: boolean | undefined) => answer(granted),
        cameraAsks: () => requestDevice.mock.calls.filter(([kind]) => kind === "Camera").length,
        card: () => JSON.stringify(send.mock.calls.at(-1)![0]),
      }
    }

    it("a second tap of Register starts no second ask, and the sign-up runs once when the ask ends", async () => {
      // Given
      const { host, press, answer, cameraAsks } = await registerCard()

      // When
      press("jollity.register", undefined)
      press("jollity.register", undefined)
      await flush()
      const remindersBeforeTheAnswer = vi.mocked(host.game.remindNextGame).mock.calls.length
      answer(true)
      for (let step = 0; step < 6; step++) await flush()

      // Then
      expect(cameraAsks()).toBe(1)
      expect(remindersBeforeTheAnswer).toBe(0)
      expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
    })

    it("a tap of Register during the ask of Turn on starts no second ask, and signs up when the ask ends", async () => {
      // Given
      const { host, press, answer, cameraAsks } = await registerCard()

      // When
      press("jollity.turn-on-camera", undefined)
      press("jollity.register", undefined)
      await flush()
      answer(false)
      for (let step = 0; step < 6; step++) await flush()

      // Then
      expect(cameraAsks()).toBe(1)
      expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
    })

    it("Register shows busy from the tap", async () => {
      // Given
      const { press, card } = await registerCard()
      const before = card()

      // When
      press("jollity.register", undefined)

      // Then
      expect(before).not.toContain(BUSY_REGISTER)
      expect(card()).toContain(BUSY_REGISTER)
    })

    it("Register stops showing busy when the ask ends with no answer", async () => {
      // Given
      const { press, answer, card } = await registerCard()
      press("jollity.turn-on-camera", undefined)
      await flush()

      // When
      answer(undefined)
      await flush()

      // Then
      expect(card()).not.toContain(BUSY_REGISTER)
    })

    it("the sign-up runs at the deadline when the host never answers", async () => {
      // Given
      const { host, press } = await registerCard()
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      try {
        // When
        press("jollity.register", undefined)
        await vi.advanceTimersByTimeAsync(29_000)
        const remindersBeforeTheDeadline = vi.mocked(host.game.remindNextGame).mock.calls.length
        await vi.advanceTimersByTimeAsync(2_000)

        // Then
        expect(remindersBeforeTheDeadline).toBe(0)
        expect(host.game.remindNextGame).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it("sends the reason of a cancel the host refused when the game is called off", async () => {
    // Given
    const events = await capture()
    const { keepHostReminder } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    vi.mocked(host.game.cancelNextGame).mockImplementation(async (onError) => {
      onError?.("Domain.V1: busy")
      return "failed"
    })
    const game = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: game }))

    // When
    await keepHostReminder(host, chainRead({ running: { ...game, phase: "cancelled" } }))
    await flush()

    // Then
    expect(metrics(events, "chat.reminder.cancel").map((event) => event.tags.outcome)).toEqual(["failed"])
    expect(logs(events, "chat.reminder.cancel").map((log) => log.contexts!.detail!.error)).toEqual(["Domain.V1: busy"])
  })

  it("sends the reason of a refused cancel of the reminder a moved game replaces", async () => {
    // Given
    const events = await capture()
    const { keepHostReminder } = await import("./index")
    const host = fakeHost()
    const game = running({ registered: true })
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: game.gamePlayTime, startsAt: game.gamePlayTime * 1000 - 60_000, outcome: "held", at: Date.now() })
    vi.mocked(host.game.remindNextGame).mockImplementation(async (_startsAt, onError) => {
      onError?.("HostFailure: busy")
      return "failed"
    })
    vi.mocked(host.game.cancelNextGame).mockImplementation(async (onError) => {
      onError?.("Domain.V1: busy")
      return "failed"
    })

    // When
    await keepHostReminder(host, chainRead({ running: { ...game, gamePlayTime: game.gamePlayTime + 600 } }), true)
    await flush()

    // Then
    expect(metrics(events, "chat.reminder.cancel").map((event) => [event.tags.outcome, event.tags.why])).toEqual([["failed", "replace"]])
    expect(logs(events, "chat.reminder.cancel").map((log) => log.contexts!.detail!.error)).toEqual(["Domain.V1: busy"])
  })

  it("sends nothing for the cancel of the reminder a moved game replaces when the host drops it", async () => {
    // Given
    const events = await capture()
    const { keepHostReminder } = await import("./index")
    const host = fakeHost()
    const game = running({ registered: true })
    host.store.set("jollity.wg.host-reminder", { gamePlayTime: game.gamePlayTime, startsAt: game.gamePlayTime * 1000 - 60_000, outcome: "held", at: Date.now() })
    vi.mocked(host.game.remindNextGame).mockResolvedValue("failed")
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")

    // When
    await keepHostReminder(host, chainRead({ running: { ...game, gamePlayTime: game.gamePlayTime + 600 } }), true)
    await flush()

    // Then
    expect(host.game.cancelNextGame).toHaveBeenCalledTimes(1)
    expect(metrics(events, "chat.reminder.cancel")).toHaveLength(0)
  })

  it("labels cleanup of an older reminder game-over when the chain already shows the next game", async () => {
    // Given
    const events = await capture()
    const { keepHostReminder } = await import("./index")
    const host = fakeHost()
    vi.mocked(host.game.remindNextGame).mockResolvedValue("held")
    vi.mocked(host.game.cancelNextGame).mockResolvedValue("dropped")
    const oldGame = running({ registered: true })
    await keepHostReminder(host, chainRead({ running: oldGame }))
    const nextGame = { ...oldGame, index: oldGame.index + 1, gamePlayTime: oldGame.gamePlayTime + 3600, registered: false }

    // When
    await keepHostReminder(host, chainRead({ running: nextGame }))
    await flush()

    // Then
    expect(metrics(events, "chat.reminder.cancel").map((event) => event.tags.why)).toEqual(["game-over"])
  })

  it("counts the card face once per change, and the navigation that came of a press", async () => {
    // Given
    const events = await capture()
    const host = welcomedHost()
    const gamePlayTime = nowSeconds() - 3600
    host.store.set("jollity.wg.games", [{ index: 7, gamePlayTime }])
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m3", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.stash", undefined)
    await flush()

    // Then
    const shown = metrics(events, "chat.card.shown")
    expect(shown).toHaveLength(1)
    expect(shown[0]!.tags).toMatchObject({ game: "7", slot: expect.any(String) })
    expect(metrics(events, "chat.nav").map((event) => event.tags)).toEqual([expect.objectContaining({ target: "stash", ok: "true" })])
    expect(transactions(events, "chat.card.first_draw_ms")[0]!.measurements?.["chat.card.first_draw_ms"]?.value).toEqual(expect.any(Number))
  })

  it("sends the error text when the host cannot navigate", async () => {
    // Given
    const events = await capture()
    const host = welcomedHost()
    host.navigate = vi.fn().mockRejectedValue(new Error("navigateTo is not available"))
    const handler = await renderHandler(host)
    let press: ActionListener | undefined
    handler({ messageId: "m1", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: nowSeconds() + 3600 }) }, vi.fn(), (listener) => {
      press = listener
      return () => {}
    })
    await flush()

    // When
    press!("jollity.open", undefined)
    await flush()

    // Then
    expect(metrics(events, "chat.nav")[0]!.tags).toMatchObject({ target: "app", ok: "false" })
    expect(eventsNamed(events, "host-call-failed: navigate")[0]!.contexts!.failure).toEqual({ target: "app", error: "Error: navigateTo is not available" })
  })

  it("counts a card held for more than 10 seconds, once", async () => {
    // Given
    vi.useFakeTimers()
    try {
      const events = await capture()
      const host = welcomedHost()
      host.storage.readJSON = vi.fn(() => new Promise(() => {})) as never
      const { main } = await import("./index")
      await main(host)
      await vi.advanceTimersByTimeAsync(0)
      const handler = vi.mocked(host.renderer.onRender).mock.calls[0]![0]
      handler({ messageId: "m1", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: nowSeconds() + 3600 }) }, vi.fn(), () => () => {})

      // When
      await vi.advanceTimersByTimeAsync(9_000)
      const early = metrics(events, "chat.card.held").length
      await vi.advanceTimersByTimeAsync(30_000)

      // Then
      expect(early).toBe(0)
      expect(metrics(events, "chat.card.held").map((event) => event.tags.reason)).toEqual(["storage not read yet"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("counts failing polls only from the third in a row, and once", async () => {
    // Given
    const events = await capture()
    const chain = await withChain()
    vi.mocked(chain.connect).mockResolvedValue(null)
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)
    await tick(host)
    const early = metrics(events, "chat.poll.failed").length
    await tick(host)
    await tick(host)
    await flush()

    // Then
    expect(early).toBe(0)
    expect(metrics(events, "chat.poll.failed").map((event) => [event.tags.stage, event.tags.reason])).toEqual([["connect", "no-client"]])
  })

  it("keeps the reason of a failing poll a fixed word and the error text in the detail", async () => {
    // Given
    const events = await capture()
    const chain = await withChain()
    vi.mocked(chain.connect).mockResolvedValue({} as never)
    vi.mocked(chain.readGame).mockRejectedValue(new Error("x".repeat(500)))
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    for (let i = 0; i < 3; i++) await tick(host)
    await flush()

    // Then
    const failed = metrics(events, "chat.poll.failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]!.tags).toMatchObject({ stage: "read", reason: "threw" })
    expect(logs(events, "chat.poll.failed")[0]!.contexts!.detail!.error).toMatch(/^Error: x+$/)
    expect(transactions(events, "chat.poll.duration_ms")).toHaveLength(3)
  })

  it("samples poll duration instead of sending one event for every healthy poll", async () => {
    // Given
    const events = await capture()
    await withChain(...Array.from({ length: 25 }, () => chainRead({ running: null })))
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    for (let i = 0; i < 25; i++) await tick(host)
    await flush()

    // Then: the first three establish startup behavior and the twentieth is the periodic sample.
    expect(transactions(events, "chat.poll.duration_ms").map((event) => event.tags.sample)).toEqual(["initial", "initial", "initial", "interval"])
  })
})

describe("a claim the storage refuses is kept in memory", () => {
  async function capture(): Promise<TelemetryRecord[]> {
    const telemetry = await import("./telemetry")
    const events: TelemetryRecord[] = []
    telemetry.configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      product: "dim2.paseo",
      fetchImpl: async (_url, init) => {
        events.push(...decodeTelemetryEnvelope(init.body))
      },
    })
    return events
  }
  const metrics = (events: TelemetryRecord[], name: string) => {
    const records = telemetryRecords(events, name, "metric")
    expect(records.every((record) => record.value === 1)).toBe(true)
    return records
  }
  const logs = (events: TelemetryRecord[], name: string) => telemetryRecords(events, name, "log")
  /** A host whose writes of these keys fail while `refusing.on` is true. */
  function refusing(host: ReturnType<typeof fakeHost>, ...keys: string[]) {
    const refusal = { on: true }
    const write = host.storage.writeJSON
    host.storage.writeJSON = vi.fn(async (key: string, value: unknown) => {
      if (refusal.on && keys.includes(key)) throw new Error("quota")
      return write(key, value)
    })
    return refusal
  }

  it("books each reminder moment once per run while the booking record cannot be written", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    refusing(host, "jollity.wg.notifs")
    const read = chainRead({ running: running({ registered: true }) })

    // When
    await scheduleReminders(host, read)
    const afterFirst = vi.mocked(host.notifications.push).mock.calls.length
    await scheduleReminders(host, read)
    await scheduleReminders(host, read)

    // Then
    expect(afterFirst).toBe(3)
    expect(host.notifications.push).toHaveBeenCalledTimes(3)
  })

  it("persists the remembered booking once the storage takes writes again, without booking again", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    const refusal = refusing(host, "jollity.wg.notifs")
    const read = chainRead({ running: running({ registered: true }) })
    await scheduleReminders(host, read)

    // When
    refusal.on = false
    await scheduleReminders(host, read)

    // Then
    expect(host.notifications.push).toHaveBeenCalledTimes(3)
    expect(host.store.get("jollity.wg.notifs")).toMatchObject({ complete: true, ids: [1, 1, 1] })
  })

  it("keeps the booking record readable for the register gate while storage refuses it", async () => {
    // Given
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    refusing(host, "jollity.wg.notifs")
    const read = chainRead({ running: running({ registered: true }) })

    // When
    await scheduleReminders(host, read)
    await scheduleReminders(host, read, false, true)

    // Then
    expect(host.notifications.push).toHaveBeenCalledTimes(3)
  })

  it("counts each reminder booked under a memory claim, and reports the refused write once", async () => {
    // Given
    const events = await capture()
    const { scheduleReminders } = await import("./index")
    const host = fakeHost()
    refusing(host, "jollity.wg.notifs")
    const read = chainRead({ running: running({ registered: true }) })

    // When
    await scheduleReminders(host, read)
    await scheduleReminders(host, read)
    await flush()

    // Then
    const failed = metrics(events, "chat.storage.write_failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]!.tags.key_class).toBe("jollity.wg.notifs")
    expect(logs(events, "chat.storage.write_failed")[0]!.contexts!.detail!.error).toBe("Error: quota")
    const memory = metrics(events, "chat.post.memory_claim")
    expect(memory).toHaveLength(3)
    expect(memory[0]!.tags).toMatchObject({ claim: "memory", what: "reminder" })
  })

  it("posts each past card once per run while the watermark write fails, tagged as a memory claim", async () => {
    // Given
    const events = await capture()
    const game = running()
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3], 3))
    const { tick } = await import("./index")
    const host = announcedHost(game)
    refusing(host, "jollity.wg.backfilled")

    // When
    await tick(host)
    await tick(host)
    await flush()

    // Then
    expect(postedCards(host)).toEqual([{ gamePlayTime: pastPlayTime(3) }])
    expect(metrics(events, "chat.post.memory_claim").map((event) => event.tags.what)).toEqual(["card"])
    expect(metrics(events, "chat.card.backfilled").map((event) => event.tags.outcome)).toEqual(["missed"])
  })

  it("posts a refused past card again on the next poll", async () => {
    // Given
    const events = await capture()
    const game = running()
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3, 4], 3, [3, 4]))
    const { tick } = await import("./index")
    const host = announcedHost(game)
    vi.mocked(host.chat.postMessage).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("busy"))

    // When
    await tick(host)
    const watermarkAfterRefusal = host.store.get("jollity.wg.backfilled")
    const recapAfterRefusal = host.store.get(pastRecap(4))
    await tick(host)
    await flush()

    // Then
    expect(watermarkAfterRefusal).toBe(3)
    expect(recapAfterRefusal).toBeNull()
    expect(postedCards(host)).toEqual([3, 4, 4].map((index) => ({ gamePlayTime: pastPlayTime(index) })))
    expect(host.store.get("jollity.wg.backfilled")).toBe(4)
    expect(metrics(events, "chat.card.backfilled").map((event) => event.tags.outcome)).toEqual(["played", "failed", "played"])
    expect(logs(events, "chat.card.backfilled")[0]!.contexts!.detail!.error).toBe("Error: busy")
  })

  it("takes the row of the last attended game back when its card is refused, and posts it on the next poll", async () => {
    // Given
    const events = await capture()
    const game = running()
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3], 3, [3], 3))
    const { tick } = await import("./index")
    const host = announcedHost(game)
    vi.mocked(host.chat.postMessage).mockRejectedValueOnce(new Error("busy"))

    // When
    await tick(host)
    const rowsAfterRefusal = (host.store.get("jollity.wg.games") as SeenGame[]).map((row) => row.index)
    const watermarkAfterRefusal = host.store.get("jollity.wg.backfilled")
    await tick(host)
    await flush()

    // Then
    expect(rowsAfterRefusal).toEqual([game.index])
    expect(watermarkAfterRefusal).toBe(0)
    expect(postedCards(host)).toEqual([3, 3].map((index) => ({ gamePlayTime: pastPlayTime(index) })))
    expect((host.store.get("jollity.wg.games") as SeenGame[]).map((row) => row.index)).toEqual([game.index, 3])
    expect(metrics(events, "chat.card.backfilled").map((event) => event.tags.outcome)).toEqual(["failed", "pending"])
  })

  it("holds the card of the last attended game until its row can be stored", async () => {
    // Given
    const game = running()
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }), chainRead({ running: game }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3], 3, [3], 3))
    const { tick } = await import("./index")
    const host = announcedHost(game)
    const refusal = refusing(host, "jollity.wg.games")

    // When
    await tick(host)
    const postedWhileRefused = postedCards(host).length
    const watermarkWhileRefused = host.store.get("jollity.wg.backfilled")
    refusal.on = false
    await tick(host)

    // Then
    expect(postedWhileRefused).toBe(0)
    expect(watermarkWhileRefused).toBe(0)
    expect(postedCards(host)).toEqual([{ gamePlayTime: pastPlayTime(3) }])
  })

  it("never posts again a past card whose post hit its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      // Given
      const events = await capture()
      const game = running()
      const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
      vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3], 3))
      const { tick } = await import("./index")
      const host = announcedHost(game)
      vi.mocked(host.chat.postMessage).mockImplementationOnce(() => new Promise(() => {}))

      // When
      const first = tick(host)
      await vi.advanceTimersByTimeAsync(46_000)
      await first
      await tick(host)
      vi.useRealTimers()
      await flush()

      // Then
      expect(postedCards(host)).toEqual([{ gamePlayTime: pastPlayTime(3) }])
      expect(host.store.get("jollity.wg.backfilled")).toBe(3)
      expect(metrics(events, "chat.card.backfilled").map((event) => event.tags.outcome)).toEqual(["timed-out"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("holds a past card until its outcome can be stored, and gives the claim back", async () => {
    // Given
    const events = await capture()
    const game = running()
    const chain = await withChain(chainRead({ running: game }), chainRead({ running: game }))
    vi.mocked(chain.readPastGames).mockResolvedValue(pastGames([3], 3, [3]))
    const { tick } = await import("./index")
    const host = announcedHost(game)
    const refusal = refusing(host, pastRecap(3))

    // When
    await tick(host)
    const postedWhileRefused = postedCards(host).length
    const watermarkWhileRefused = host.store.get("jollity.wg.backfilled")
    refusal.on = false
    await tick(host)
    await flush()

    // Then
    expect(postedWhileRefused).toBe(0)
    expect(watermarkWhileRefused).toBe(0)
    expect(postedCards(host)).toEqual([{ gamePlayTime: pastPlayTime(3) }])
    expect(metrics(events, "chat.card.backfilled").map((event) => event.tags.outcome)).toEqual(["failed", "played"])
  })

  it("posts the card once per run while the claim write fails, tagged as a memory claim", async () => {
    // Given
    const events = await capture()
    const game = running()
    await withChain(...Array.from({ length: 3 }, () => chainRead({ running: game })))
    const { tick } = await import("./index")
    const host = fakeHost()
    refusing(host, "jollity.wg.announced")

    // When
    await tick(host)
    await tick(host)
    await flush()

    // Then
    expect(postedCards(host)).toEqual([{ gamePlayTime: game.gamePlayTime }])
    expect(metrics(events, "chat.storage.write_failed").filter((e) => e.tags.key_class === "jollity.wg.announced")).toHaveLength(1)
    const memory = metrics(events, "chat.post.memory_claim")
    expect(memory).toHaveLength(1)
    expect(memory[0]!.tags).toMatchObject({ claim: "memory", what: "card" })
  })

  it("does not tag a card posted under a claim that landed", async () => {
    // Given
    const events = await capture()
    const game = running()
    await withChain(chainRead({ running: game }))
    const { tick } = await import("./index")
    const host = fakeHost()

    // When
    await tick(host)
    await flush()

    // Then
    expect(metrics(events, "chat.post.memory_claim")).toHaveLength(0)
  })
})

async function turnFailureEvents() {
  const telemetry = await import("./telemetry")
  const events: { message?: string; tags: Record<string, string> }[] = []
  telemetry.configureTelemetry({
    dsn: "https://k@o1.ingest.de.sentry.io/1",
    product: "dim2.paseo",
    fetchImpl: async (_url, init) => {
      events.push(JSON.parse(init.body.split("\n")[2]!))
    },
  })
  return events
}

describe("the TURN pass of the chat works", () => {
  const ISSUER = NETWORK_CONFIG.paseo.deviceUniquenessBackendUrl
  const NOW = 1_800_000_000_000
  const ACCOUNT = Uint8Array.of(7)
  const KEY = turnPassKey("dim2.paseo", ACCOUNT, [ISSUER])
  const PASS = { turn: [{ urls: "turn:relay.example:3478", username: "u", credential: "p" }] }
  const playerHost = (overrides: Partial<WorkerHost> = {}) => welcomedHost({ productAccount: vi.fn().mockResolvedValue(ACCOUNT), ...overrides })
  const gameAt = (secondsFromNow: number, overrides: Partial<RunningGame> = {}) => {
    const gamePlayTime = NOW / 1000 + secondsFromNow
    return running({ registered: true, phase: "shuffle", gamePlayTime, playEnds: gamePlayTime + 151, reportingEnds: gamePlayTime + 600, ...overrides })
  }
  const passing = () => vi.fn().mockResolvedValue({ pass: { ...PASS, expiresAtWallMs: NOW + 1_795_000 } })

  it("fetches a pass for a registered player whose game starts within 15 minutes, stamped on the chain clock", async () => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost({ turnPass: passing() })
    const read = chainRead({ running: gameAt(4 * 60), clockOffsetMs: -600_000 })

    // When
    await keepTurnPass(host, read, NOW)

    // Then
    expect(host.turnPass).toHaveBeenCalledWith({ productId: "dim2.paseo", account: ACCOUNT, issuer: ISSUER, timestamp: (NOW - 600_000) / 1000 })
  })

  it("fetches a pass for a live game with turns left", async () => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost({ turnPass: passing() })

    // When
    await keepTurnPass(host, chainRead({ running: gameAt(-60, { phase: "reporting" }) }), NOW)

    // Then
    expect(host.turnPass).toHaveBeenCalledOnce()
  })

  it.each([
    ["with under 10 minutes left", { ...PASS, expiresAtWallMs: NOW + 10 * 60_000 - 1 }],
    ["that is malformed", { username: "u" }],
  ])("replaces a stored pass %s", async (_what, stored) => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost({ turnPass: passing() })
    host.store.set(KEY, stored)

    // When
    await keepTurnPass(host, chainRead({ running: gameAt(300) }), NOW)

    // Then
    expect(host.turnPass).toHaveBeenCalledOnce()
  })

  it.each([
    ["another player", turnPassKey("dim2.paseo", Uint8Array.of(8), [ISSUER])],
    ["another issuer", turnPassKey("dim2.paseo", ACCOUNT, [NETWORK_CONFIG.previewnet.deviceUniquenessBackendUrl])],
  ])("fetches a pass of its own while only %s has one", async (_what, otherKey) => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost({ turnPass: passing() })
    host.store.set(otherKey, { ...PASS, expiresAtWallMs: NOW + 20 * 60_000 })

    // When
    await keepTurnPass(host, chainRead({ running: gameAt(300) }), NOW)

    // Then
    expect(host.turnPass).toHaveBeenCalledOnce()
  })

  it("tries again a minute after a failed try", async () => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost()
    const read = chainRead({ running: gameAt(300) })
    await keepTurnPass(host, read, NOW)

    // When
    await keepTurnPass(host, read, NOW + 60_000)

    // Then
    expect(host.turnPass).toHaveBeenCalledTimes(2)
  })

  it("does not hold the poll on a pass the host never answers", async () => {
    // Given
    await withChain(chainRead({ running: gameAt(Math.floor((Date.now() - NOW) / 1000) + 300) }))
    const { tick } = await import("./index")
    const host = playerHost({ turnPass: vi.fn(() => new Promise<never>(() => {})) })

    // When
    await tick(host)
    await flush()

    // Then
    expect(host.turnPass).toHaveBeenCalledOnce()
  })

  it("keeps the pass under the key the app reads", async () => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost({ turnPass: passing() })

    // When
    await keepTurnPass(host, chainRead({ running: gameAt(300) }), NOW)

    // Then
    expect(host.store.get(KEY)).toEqual({ ...PASS, expiresAtWallMs: NOW + 1_795_000 })
  })

  it("sends one failure event per failed try, named by the cause code of the app", async () => {
    // Given
    const events = await turnFailureEvents()
    const { keepTurnPass } = await import("./index")
    const host = playerHost({
      turnPass: vi.fn().mockResolvedValue({ stage: "proof", cause: "grant-missing", reason: "no lite grant" }),
    })

    // When
    await keepTurnPass(host, chainRead({ running: gameAt(300) }), NOW)
    await flush()

    // Then
    const failures = events.filter((event) => event.message?.startsWith("chat-turn-pass-failed"))
    expect(failures).toHaveLength(1)
    expect(failures[0]!.message).toBe("chat-turn-pass-failed: grant-missing")
    expect(failures[0]!.tags).toMatchObject({ "failure.kind": "chat-turn-pass-failed", "failure.reason": "grant-missing", "turn.stage": "proof" })
  })

  it("sends no failure event for a proof the host was too slow to give", async () => {
    // Given
    const events = await turnFailureEvents()
    const { keepTurnPass } = await import("./index")
    const host = playerHost({
      turnPass: vi.fn().mockResolvedValue({ stage: "proof", cause: "timeout", reason: "no proof in 5000ms" }),
    })

    // When
    await keepTurnPass(host, chainRead({ running: gameAt(300) }), NOW)
    await flush()

    // Then
    expect(events.filter((event) => event.message?.startsWith("chat-turn-pass-failed"))).toHaveLength(0)
  })
})

describe("the TURN pass of the chat fails", () => {
  const ISSUER = NETWORK_CONFIG.paseo.deviceUniquenessBackendUrl
  const NOW = 1_800_000_000_000
  const ACCOUNT = Uint8Array.of(7)
  const playerHost = (overrides: Partial<WorkerHost> = {}) => welcomedHost({ productAccount: vi.fn().mockResolvedValue(ACCOUNT), ...overrides })
  const gameAt = (secondsFromNow: number, overrides: Partial<RunningGame> = {}) => {
    const gamePlayTime = NOW / 1000 + secondsFromNow
    return running({ registered: true, phase: "shuffle", gamePlayTime, playEnds: gamePlayTime + 151, reportingEnds: gamePlayTime + 600, ...overrides })
  }

  it.each([
    ["a player who is not registered", gameAt(300, { registered: false })],
    ["a registration the chain could not read", gameAt(300, { registered: null })],
    ["a game more than 15 minutes away", gameAt(15 * 60 + 1)],
    ["a game with no turns left", gameAt(-151, { phase: "reporting" })],
    ["a game that is settling", gameAt(-60, { phase: "settling" })],
    ["a game that was called off", gameAt(300, { phase: "cancelled" })],
  ])("fetches no pass for %s", async (_what, game) => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost()

    // When
    await keepTurnPass(host, chainRead({ running: game }), NOW)

    // Then
    expect(host.turnPass).not.toHaveBeenCalled()
  })

  it("fetches no pass while the stored one has 10 minutes or more left", async () => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost()
    host.store.set(turnPassKey("dim2.paseo", ACCOUNT, [ISSUER]), { turn: [], expiresAtWallMs: NOW + 10 * 60_000 })

    // When
    await keepTurnPass(host, chainRead({ running: gameAt(300) }), NOW)

    // Then
    expect(host.turnPass).not.toHaveBeenCalled()
  })

  it("fetches no pass while the host names no player", async () => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = welcomedHost()

    // When
    await keepTurnPass(host, chainRead({ running: gameAt(300) }), NOW)

    // Then
    expect(host.turnPass).not.toHaveBeenCalled()
  })

  it("does not try again within a minute of a failed try", async () => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost()
    const read = chainRead({ running: gameAt(300) })
    await keepTurnPass(host, read, NOW)

    // When
    await keepTurnPass(host, read, NOW + 60_000 - 1)

    // Then
    expect(host.turnPass).toHaveBeenCalledOnce()
  })

  it("fetches no pass when host storage cannot be read, since the app could not read it either", async () => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost()
    host.storage.readJSON = vi.fn().mockRejectedValue(new Error("no storage")) as WorkerHost["storage"]["readJSON"]

    // When
    await keepTurnPass(host, chainRead({ running: gameAt(300) }), NOW)

    // Then
    expect(host.turnPass).not.toHaveBeenCalled()
  })

  it("does not try again within a minute of a pass it could not keep", async () => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost({ turnPass: vi.fn().mockResolvedValue({ pass: { turn: [], expiresAtWallMs: NOW + 1_795_000 } }) })
    host.storage.writeJSON = vi.fn().mockRejectedValue(new Error("no storage"))
    const read = chainRead({ running: gameAt(300) })
    await keepTurnPass(host, read, NOW)

    // When
    await keepTurnPass(host, read, NOW + 60_000 - 1)

    // Then
    expect(host.turnPass).toHaveBeenCalledOnce()
  })

  it("files a pass it could not keep as a failure", async () => {
    // Given
    const events = await turnFailureEvents()
    const { keepTurnPass } = await import("./index")
    const host = playerHost({ turnPass: vi.fn().mockResolvedValue({ pass: { turn: [], expiresAtWallMs: NOW + 1_795_000 } }) })
    host.storage.writeJSON = vi.fn().mockRejectedValue(new Error("no storage"))

    // When
    await keepTurnPass(host, chainRead({ running: gameAt(300) }), NOW)
    await flush()

    // Then
    const failures = events.filter((event) => event.message?.startsWith("chat-turn-pass-failed"))
    expect(failures).toHaveLength(1)
    expect(failures[0]!.tags).toMatchObject({ "failure.reason": "write-failed", "turn.stage": "store" })
  })

  it("starts no second fetch while one is on its way", async () => {
    // Given
    const { keepTurnPass } = await import("./index")
    const host = playerHost({ turnPass: vi.fn(() => new Promise<never>(() => {})) })
    const read = chainRead({ running: gameAt(300) })
    void keepTurnPass(host, read, NOW)
    await flush()

    // When
    await keepTurnPass(host, read, NOW + 2 * 60_000)

    // Then
    expect(host.turnPass).toHaveBeenCalledOnce()
  })
})

describe("Humanity's Membership news in the room works", () => {
  const LITE = { full_username: null, lite_username: new TextEncoder().encode("carol.01") }
  const FULL = { full_username: new TextEncoder().encode("carol"), lite_username: new TextEncoder().encode("carol.01") }
  const membershipPosts = (host: WorkerHost) => postedMessages(host, "jollity.membership").map(({ payload }) => decPayload<{ text: string; status: string; claim?: boolean }>(payload))
  const RECORD_KEY = `jollity.membership.chat:${ADDRESS}`
  /** A host whose last read saw a candidate, so the next member read is a promotion. */
  const candidateBefore = () => {
    const host = welcomedHost()
    host.store.set(PLAYER_NAME_KEY, "carol.01")
    host.store.set(RECORD_KEY, { version: 1, standing: "other", claimable: false, restoredPending: false, announced: [] })
    return host
  }

  it("congratulates a new member with Claim username while the name is numbered", async () => {
    // Given
    const host = candidateBefore()
    await peopleHolding(LITE)
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(membershipPosts(host)).toEqual([{ text: "Congratulations, you are a Polkadot Member! Claim your username.", status: "ready", claim: true }])
    expect(host.store.get(RECORD_KEY)).toMatchObject({ standing: "member", announced: ["membership", "claim"] })
  })

  it("holds the news of a new member until the people ring holds their key, then says it once with Claim username", async () => {
    // Given
    const host = candidateBefore()
    await peopleHolding(LITE)
    const chain = await import("./chain")
    vi.mocked(chain.readNameReady).mockResolvedValue(false)
    const { tick } = await import("./index")

    // When
    await tick(host)
    const whileQueued = membershipPosts(host)
    vi.mocked(chain.readNameReady).mockResolvedValue(true)
    for (let beat = 0; beat < 4; beat++) await tick(host)

    // Then
    expect(whileQueued).toEqual([])
    expect(membershipPosts(host)).toEqual([{ text: "Congratulations, you are a Polkadot Member! Claim your username.", status: "ready", claim: true }])
  })

  it("congratulates a new member who already has their name without the button", async () => {
    // Given
    const host = candidateBefore()
    await peopleHolding(FULL)
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(membershipPosts(host)).toEqual([{ text: "Congratulations, you are a Polkadot Member!", status: "ready" }])
  })

  it("waits, and offers no claim, while the name cannot be read", async () => {
    // Given
    const host = candidateBefore()
    const chain = await peopleHolding(LITE).then(() => import("./chain"))
    vi.mocked(chain.connect).mockResolvedValue({} as never)
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(membershipPosts(host)).toEqual([])
    expect(host.store.get(RECORD_KEY)).toMatchObject({ standing: "other" })
  })

  it("says a membership is paused once, and that it is back", async () => {
    // Given
    const host = welcomedHost()
    host.store.set(RECORD_KEY, { version: 1, standing: "member", claimable: false, restoredPending: false, announced: ["membership"] })
    const chain = await withChain(chainRead({ running: null }), chainRead({ running: null }))
    vi.mocked(chain.readStanding).mockResolvedValue({ tag: "Suspended", gamesToMembership: null })
    const { tick } = await import("./index")

    // When
    await tick(host)

    // Then
    expect(membershipPosts(host).map(({ status }) => status)).toEqual(["paused"])
    expect(host.store.get(RECORD_KEY)).toMatchObject({ standing: "suspended", announced: ["membership", "suspended"] })
  })

  it("draws the posted line with its picture and Claim username, and opens the Humanity card on tap", async () => {
    // Given
    const host = candidateBefore()
    await peopleHolding(LITE)
    const handler = await renderHandler(host)
    const send = vi.fn()
    let tap: ActionListener | undefined
    const payload = encPayload({ text: "Congratulations, you are a Polkadot Member! Claim your username.", status: "ready", claim: true })

    // When
    handler({ messageId: "m9", messageType: "jollity.membership", payload }, send, (listener) => {
      tap = listener
      return () => {}
    })
    tap?.("jollity.username", undefined)

    // Then
    const tree = JSON.stringify(send.mock.calls.at(-1)?.[0])
    expect(tree).toContain("chat-card/member-ready.png")
    expect(tree).toContain("Claim username")
    await vi.waitFor(() => expect(host.navigate).toHaveBeenCalledWith(expect.stringContaining("pocket/open")))
  })

  it("greys Claim username out as Claimed, and ignores the tap, once the poll finds the name set", async () => {
    // Given
    const host = candidateBefore()
    await peopleHolding(FULL)
    const { tick } = await import("./index")
    await tick(host)
    const handler = await renderHandler(host)
    const send = vi.fn()
    let tap: ActionListener | undefined
    const payload = encPayload({ text: "Congratulations, you are a Polkadot Member! Claim your username.", status: "ready", claim: true })

    // When
    handler({ messageId: "m9", messageType: "jollity.membership", payload }, send, (listener) => {
      tap = listener
      return () => {}
    })
    tap?.("jollity.username", undefined)

    // Then
    const tree = JSON.stringify(send.mock.calls.at(-1)?.[0])
    expect(tree).toContain('"Claimed"')
    expect(tree).not.toContain("Claim username")
    expect(host.navigate).not.toHaveBeenCalled()
  })
})
