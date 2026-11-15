// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tests the narrowing in chain.ts against a mocked individuality SDK.
 *
 * The tests check what a game read and an outcome read become, and which
 * account and chain the reads ask for.
 */
import { isMemberStanding } from "./membership/chat"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkerHost } from "./host"
import { decodeTelemetryEnvelope, telemetryRecords, type TelemetryRecord } from "./testing/telemetry-envelope"

vi.mock("@parity/product-sdk-individuality", () => ({
  fromPapi: vi.fn((client: unknown, api: unknown) => ({ individuality: api, raw: { individuality: client } })),
  confirmClaim: vi.fn(),
  readCurrentGame: vi.fn(),
  readPersonhoodState: vi.fn(),
  readPrizeStatus: vi.fn(),
}))

vi.mock("@parity/product-sdk-nfts", () => ({ getClaims: vi.fn(), preimageSource: vi.fn(), getVerifiedArtwork: vi.fn() }))

vi.mock("@jollity/collectables", async (original) => ({
  ...(await original<typeof import("@jollity/collectables")>()),
  readChestPinned: vi.fn(),
}))

vi.mock("polkadot-api", async (original) => ({
  ...(await original<typeof import("polkadot-api")>()),
  createClient: vi.fn(() => ({ getUnsafeApi: () => ({ query: {} }) })),
}))

const ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
const at = { blockHash: "0x00", blockNumber: 1 }

const CASH = { decimals: 6, symbol: "0x43415348" }

function people(chainNowMs = Date.now()) {
  return {
    client: {},
    chain: {},
    api: {
      query: {
        Timestamp: { Now: { getValue: vi.fn().mockResolvedValue(BigInt(chainNowMs)) } },
        Assets: { Metadata: { getValue: vi.fn().mockResolvedValue(CASH) } },
      },
    },
  } as never
}

function storage(entries: [string, unknown][] = []) {
  const store = new Map<string, unknown>(entries)
  return {
    store,
    storage: {
      readJSON: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
      writeJSON: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value)
      }),
    },
  } as unknown as Pick<WorkerHost, "storage"> & { store: Map<string, unknown> }
}

const game = {
  index: 7,
  phase: "Registration",
  nextDeadline: 1_800_000_000 - 90,
  registrationEnds: 1_800_000_000 - 90,
  shuffleDeadline: 1_800_000_000 - 30,
  gamePlayTime: 1_800_000_000,
  reportingEnds: 1_800_000_600,
  maxGroupSize: 6,
  rounds: 2,
  playerCount: null,
  pendingAttendance: 0,
  airdropsScheduled: 2,
}

function draw(phase: string, outcome: unknown = { tag: "Unchecked" }, event: unknown = null) {
  return { at, eventId: "0x01", phase, outcome, entropy: null, event }
}

async function withDrawList(draws: unknown[]) {
  const sdk = await import("@parity/product-sdk-individuality")
  vi.mocked(sdk.readPrizeStatus).mockResolvedValue({
    ok: true,
    value: { tag: "Draws", at, gameIndex: 7, drawCountFrom: "caller", game: null, draws },
  } as never)
  return sdk
}

const withDraws = (...phases: string[]) => withDrawList(phases.map((phase) => draw(phase)))

const seenGame = {
  index: 7,
  gamePlayTime: 1_800_000_000,
  airdropsScheduled: 2,
  endsAt: 1_800_000_600,
  registered: true,
  memberBefore: false,
}

const candidate = { tag: "Candidate", score: 1, personhoodThreshold: 3, gamesRemaining: 2 }
const member = { tag: "Member", activeWeeks: 3, lastAttendedGame: 7 }

/** The score row behind a personhood state: a member is recognized, and MembershipReady has reached personhood unrecognized. */
function standingOf(state: unknown) {
  const tag = (state as { tag: string }).tag
  const recognized = tag === "Member" || tag === "Caution"
  return { recognition: recognized ? "Recognized" : "NotRecognized", reachedPersonhood: recognized || tag === "MembershipReady" }
}

async function personhood(state: unknown, lastAttendedGame: number | null) {
  const sdk = await withDrawList([])
  vi.mocked(sdk.readPersonhoodState).mockResolvedValue({
    ok: true,
    value: {
      tag: "Resolved",
      at,
      accountAddress: ADDRESS,
      alias: null,
      state,
      metrics: {},
      participant: { lastAttendedGame, streak: { tag: "Attended", count: 1 }, ...standingOf(state) },
    },
  } as never)
  return { sdk, chain: await import("./chain") }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe("game reading works", () => {
  it("narrows the running game, its registration and the next schedule", async () => {
    // Given
    const sdk = await withDraws("Registering", "Registering")
    vi.mocked(sdk.readCurrentGame).mockResolvedValue({
      ok: true,
      value: {
        tag: "Running",
        at,
        game,
        registration: { tag: "Registered" },
        upcoming: [{ gamePlayTime: 1_800_086_400, rounds: 2, maxGroupSize: 6, airdrops: [], timeline: { registrationStarts: 1_800_080_000, registrationEnds: 1_800_086_000, reportingEnds: 1_800_087_000 } }],
        durations: { registration: 3600 },
      },
    } as never)
    const { readGame } = await import("./chain")

    // When
    const read = await readGame(storage(), people(Date.now()), ADDRESS)

    // Then
    expect(sdk.readCurrentGame).toHaveBeenCalledWith(expect.anything(), {
      players: [{ tag: "Account", accountAddress: ADDRESS }],
    })
    expect(read?.running).toEqual({
      index: 7,
      phase: "registration",
      registrationStarts: 1_800_000_000 - 90 - 3600,
      registrationEnds: 1_800_000_000 - 90,
      gamePlayTime: 1_800_000_000,
      playEnds: 1_800_000_151,
      reportingEnds: 1_800_000_600,
      airdropsScheduled: 2,
      registered: true,
      drawOpen: true,
    })
    expect(sdk.readPrizeStatus).toHaveBeenCalledWith(expect.anything(), { game: { index: 7, airdropsScheduled: 2 } })
    expect(read?.upcoming).toEqual([
      // opens when the running game ends (#1699), not at the schedule projection 1_800_080_000
      { gamePlayTime: 1_800_086_400, registrationStarts: 1_800_000_600, registrationEnds: 1_800_086_000, reportingEnds: 1_800_087_000 },
    ])
  })

  it("keeps the draw closed while one does not take entries yet, as Opening soon", async () => {
    // Given
    const sdk = await withDraws("Registering", "Upcoming")
    vi.mocked(sdk.readCurrentGame).mockResolvedValue({
      ok: true,
      value: { tag: "Running", at, game, registration: { tag: "NotRegistered" }, upcoming: [], durations: {} },
    } as never)
    const { readGame } = await import("./chain")

    // When
    const read = await readGame(storage(), people(), ADDRESS)

    // Then
    expect(read?.running?.drawOpen).toBe(false)
  })

  it("keeps an unreadable registration apart from a missing one", async () => {
    // Given
    const sdk = await withDraws("Registering")
    for (const tag of ["NotRegistered", "Unknown", "Unchecked"]) {
      vi.mocked(sdk.readCurrentGame).mockResolvedValueOnce({
        ok: true,
        value: { tag: "Running", at, game, registration: { tag }, upcoming: [], durations: {} },
      } as never)
    }
    const { readGame } = await import("./chain")

    // When
    const notRegisteredRead = await readGame(storage(), people(), ADDRESS)
    const unknownRead = await readGame(storage(), people(), ADDRESS)
    const uncheckedRead = await readGame(storage(), people(), ADDRESS)

    // Then
    expect(notRegisteredRead?.running?.registered).toBe(false)
    expect(unknownRead?.running?.registered).toBe(null)
    expect(uncheckedRead?.running?.registered).toBe(null)
  })

  it("reads no registration without an address, and none between games", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-individuality")
    vi.mocked(sdk.readCurrentGame).mockResolvedValue({
      ok: true,
      value: { tag: "BetweenGames", at, lastGameIndex: 7, upcoming: [], durations: {} },
    } as never)
    const { readGame } = await import("./chain")

    // When
    const read = await readGame(storage(), people(), null)

    // Then
    expect(sdk.readCurrentGame).toHaveBeenCalledWith(expect.anything())
    expect(read).toMatchObject({ running: null, upcoming: [], member: null })
    expect(Math.abs(read!.clockOffsetMs)).toBeLessThan(5_000)
  })

  it("measures the chain clock against the device clock", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-individuality")
    vi.mocked(sdk.readCurrentGame).mockResolvedValue({
      ok: true,
      value: { tag: "BetweenGames", at, lastGameIndex: null, upcoming: [], durations: {} },
    } as never)
    const { readGame } = await import("./chain")
    const chainNowMs = Date.now() - 3_600_000

    // When
    const read = await readGame(storage(), people(chainNowMs), null)

    // Then
    expect(read!.clockOffsetMs).toBeLessThanOrEqual(-3_600_000)
    expect(read!.clockOffsetMs).toBeGreaterThan(-3_605_000)
  })

  it("reads the chain clock at the best block, as the app does", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-individuality")
    vi.mocked(sdk.readCurrentGame).mockResolvedValue({
      ok: true,
      value: { tag: "BetweenGames", at, lastGameIndex: null, upcoming: [], durations: {} },
    } as never)
    const { readGame } = await import("./chain")
    const chain = people(Date.now()) as unknown as { api: { query: { Timestamp: { Now: { getValue: ReturnType<typeof vi.fn> } } } } }

    // When
    await readGame(storage(), chain as never, null)

    // Then
    expect(chain.api.query.Timestamp.Now.getValue).toHaveBeenCalledWith({ at: "best" })
  })

  it("stores the offset of a good clock read", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-individuality")
    vi.mocked(sdk.readCurrentGame).mockResolvedValue({
      ok: true,
      value: { tag: "BetweenGames", at, lastGameIndex: null, upcoming: [], durations: {} },
    } as never)
    const { readGame } = await import("./chain")
    const { CLOCK_OFFSET_KEY } = await import("./state")
    const host = storage()

    // When
    const read = await readGame(host, people(Date.now() - 3_600_000), null)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Then
    expect(host.store.get(CLOCK_OFFSET_KEY)).toBe(read!.clockOffsetMs)
  })

  it("uses the stored offset when the clock read fails, and counts the failure with the error text", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-individuality")
    vi.mocked(sdk.readCurrentGame).mockResolvedValue({
      ok: true,
      value: { tag: "BetweenGames", at, lastGameIndex: null, upcoming: [], durations: {} },
    } as never)
    const { readGame } = await import("./chain")
    const { CLOCK_OFFSET_KEY } = await import("./state")
    const { configureTelemetry } = await import("./telemetry")
    const sent: TelemetryRecord[] = []
    configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      fetchImpl: async (_url, init) => {
        sent.push(...decodeTelemetryEnvelope(init.body))
      },
    })
    const chain = people() as unknown as { api: { query: { Timestamp: { Now: { getValue: ReturnType<typeof vi.fn> } } } } }
    chain.api.query.Timestamp.Now.getValue.mockRejectedValue(new Error("no best block"))

    // When
    const read = await readGame(storage([[CLOCK_OFFSET_KEY, -600_000]]), chain as never, null)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Then
    expect(read!.clockOffsetMs).toBe(-600_000)
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "metric",
        name: "chat.clock_offset_failed",
        value: 1,
        tags: expect.objectContaining({ reason: "read-failed", fallback: "stored" }),
      }),
      expect.objectContaining({ kind: "log", name: "chat.clock_offset_failed", contexts: { detail: { error: "Error: no best block" } } }),
    ])
  })

  it("reads no game when the clock read fails and no offset is stored", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-individuality")
    vi.mocked(sdk.readCurrentGame).mockResolvedValue({
      ok: true,
      value: { tag: "BetweenGames", at, lastGameIndex: null, upcoming: [], durations: {} },
    } as never)
    const { readGame } = await import("./chain")
    const { configureTelemetry } = await import("./telemetry")
    const sent: TelemetryRecord[] = []
    configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      fetchImpl: async (_url, init) => {
        sent.push(...decodeTelemetryEnvelope(init.body))
      },
    })
    const chain = people() as unknown as { api: { query: { Timestamp: { Now: { getValue: ReturnType<typeof vi.fn> } } } } }
    chain.api.query.Timestamp.Now.getValue.mockRejectedValue(new Error("no best block"))

    // When
    const read = await readGame(storage(), chain as never, null)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Then
    expect(read).toBeNull()
    expect(sent).toContainEqual(
      expect.objectContaining({
        kind: "metric",
        name: "chat.clock_offset_failed",
        tags: expect.objectContaining({ reason: "read-failed", fallback: "none" }),
      }),
    )
  })
})

describe("past games reading works", () => {
  beforeEach(async () => {
    await personhood(candidate, null)
  })

  function pastGames(
    query: {
      history?: [number, number | bigint][]
      attended?: number[]
      player?: { first_game: number }
      archived?: { type: string; value: { first_game: number } }
    },
  ) {
    return {
      client: {},
      chain: {},
      api: {
        query: {
          Game: {
            GameHistory: { getEntries: vi.fn().mockResolvedValue((query.history ?? []).map(([index, value]) => ({ keyArgs: [index], value }))) },
            PlayerAttendanceHistory: { getValue: vi.fn().mockResolvedValue(query.attended ?? []) },
            Players: { getValue: vi.fn().mockResolvedValue(query.player) },
            ArchivedPlayers: { getValue: vi.fn().mockResolvedValue(query.archived) },
          },
        },
      },
    } as never
  }

  it("reads the history, the attended games and the smallest first game the chain names", async () => {
    // Given
    const chain = await import("./chain")
    const archived = { type: "Kickable", value: { first_game: 4 } }

    // When
    const fromAttendance = await chain.readPastGames(
      pastGames({ history: [[3, 1_800_000_000], [4, 1_800_086_400n]], attended: [3], player: { first_game: 5 }, archived }),
      ADDRESS,
    )
    const fromPlayer = await chain.readPastGames(pastGames({ attended: [6], player: { first_game: 5 }, archived }), ADDRESS)
    const fromArchive = await chain.readPastGames(pastGames({ attended: [6], player: { first_game: 5 }, archived: { ...archived, value: { first_game: 2 } } }), ADDRESS)

    // Then
    expect(fromAttendance).toEqual({
      first: 3,
      attended: new Set([3]),
      history: new Map([[3, 1_800_000_000], [4, 1_800_086_400]]),
      lastAttended: null,
    })
    expect(fromPlayer?.first).toBe(4)
    expect(fromArchive?.first).toBe(2)
  })

  it("names no first game for a player the chain holds nothing for", async () => {
    // Given
    const chain = await import("./chain")

    // When
    const past = await chain.readPastGames(pastGames({ history: [[3, 1_800_000_000]] }), ADDRESS)

    // Then
    expect(past?.first).toBeNull()
  })

  it("names the last game the score row says the player attended", async () => {
    // Given
    const { chain } = await personhood(member, 7)

    // When
    const past = await chain.readPastGames(pastGames({}), ADDRESS)

    // Then
    expect(past?.lastAttended).toBe(7)
  })

  it("is null when the personhood read fails", async () => {
    // Given
    const { sdk, chain } = await personhood(member, 7)
    vi.mocked(sdk.readPersonhoodState).mockResolvedValue({ ok: false, error: new Error("down") } as never)

    // When
    const past = await chain.readPastGames(pastGames({}), ADDRESS)

    // Then
    expect(past).toBeNull()
  })

  it("asks for the account of the player at the best block", async () => {
    // Given
    const chain = await import("./chain")
    const people = pastGames({}) as unknown as { api: { query: { Game: Record<string, { getValue: unknown; getEntries: unknown }> } } }
    const account = { type: "Account", value: ADDRESS }

    // When
    await chain.readPastGames(people as never, ADDRESS)

    // Then
    const game = people.api.query.Game
    expect(game.GameHistory!.getEntries).toHaveBeenCalledWith({ at: "best" })
    expect(game.PlayerAttendanceHistory!.getValue).toHaveBeenCalledWith(account, { at: "best" })
    expect(game.Players!.getValue).toHaveBeenCalledWith(account, { at: "best" })
    expect(game.ArchivedPlayers!.getValue).toHaveBeenCalledWith(account, { at: "best" })
  })

  it("is null when a read fails, and counts it once as a failed history read", async () => {
    // Given
    const chain = await import("./chain")
    const { configureTelemetry } = await import("./telemetry")
    const sent: TelemetryRecord[] = []
    configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      fetchImpl: async (_url, init) => {
        sent.push(...decodeTelemetryEnvelope(init.body))
      },
    })
    const down = pastGames({}) as unknown as { api: { query: { Game: { GameHistory: { getEntries: ReturnType<typeof vi.fn> } } } } }
    down.api.query.Game.GameHistory.getEntries.mockRejectedValue(new Error("down"))

    // When
    const first = await chain.readPastGames(down as never, ADDRESS)
    const second = await chain.readPastGames(down as never, ADDRESS)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Then
    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(telemetryRecords(sent, "chat.outcome.read_failed", "metric")).toEqual([
      expect.objectContaining({ tags: expect.objectContaining({ stage: "history" }) }),
    ])
    expect(telemetryRecords(sent, "chat.outcome.read_failed", "log")).toEqual([
      expect.objectContaining({ contexts: { detail: { error: "Error: down" } } }),
    ])
  })
})

describe("name readiness reading works", () => {
  const RING = "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652020202020"

  function ringChain(recognition: unknown, member?: unknown, included = 0) {
    const members = vi.fn().mockResolvedValue(member)
    const query = {
      Score: { Participants: { getValue: vi.fn().mockResolvedValue(recognition === undefined ? undefined : { recognition }) } },
      People: { People: { getValue: vi.fn().mockResolvedValue({ key: "0xd6" }) } },
      Members: { Members: { getValue: members }, RingKeysStatus: { getValue: vi.fn().mockResolvedValue({ included }) } },
    }
    return { people: { client: {}, chain: {}, api: { query } } as never, members }
  }
  const included = { type: "Included", value: { ring_index: 67, ring_page: 0, ring_position: 22 } }

  it("is not ready while the member key waits in the onboarding queue", async () => {
    const chain = await import("./chain")
    const { people, members } = ringChain({ type: "Recognized", value: 126n }, { type: "Onboarding", value: { queue_page: 0, queued_at: 1n } })

    expect(await chain.readNameReady(people, ADDRESS)).toBe(false)
    expect(members).toHaveBeenCalledWith(RING, "0xd6", { at: "best" })
  })

  it("is not ready before Score.register, with no person behind the participant", async () => {
    const chain = await import("./chain")

    expect(await chain.readNameReady(ringChain({ type: "NotRecognized" }).people, ADDRESS)).toBe(false)
    expect(await chain.readNameReady(ringChain(undefined).people, ADDRESS)).toBe(false)
  })

  it("is not ready while the ring root does not cover the key's slot yet", async () => {
    const chain = await import("./chain")

    expect(await chain.readNameReady(ringChain({ type: "Recognized", value: 126n }, included, 22).people, ADDRESS)).toBe(false)
  })

  it("is ready once the key is included under a root that covers it", async () => {
    const chain = await import("./chain")

    expect(await chain.readNameReady(ringChain({ type: "Recognized", value: 126n }, included, 23).people, ADDRESS)).toBe(true)
  })

  it("is null when the chain does not answer", async () => {
    const chain = await import("./chain")
    const { people, members } = ringChain({ type: "Recognized", value: 126n })
    members.mockRejectedValue(new Error("down"))

    expect(await chain.readNameReady(people, ADDRESS)).toBeNull()
  })
})

describe("game reading fails", () => {
  it("is null when the read fails", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-individuality")
    vi.mocked(sdk.readCurrentGame).mockResolvedValue({ ok: false, error: new Error("down") } as never)
    const { readGame } = await import("./chain")

    // When
    const read = await readGame(storage(), people(), ADDRESS)

    // Then
    expect(read).toBeNull()
  })
})

describe("outcome reading works", () => {
  it("is played when the player attended this game, and carries the games left", async () => {
    // Given
    const { chain } = await personhood(candidate, 7)

    // When
    const outcome = await chain.readOutcome(people(), ADDRESS, seenGame)

    // Then
    expect(outcome).toEqual({
      cancelled: false,
      gamesToMembership: 2,
      paused: false,
      missesLeft: null,
      gameIndex: 7,
      registered: true,
      memberBefore: false,
      results: {
        endedAt: 1_800_000_000,
        passed: true,
        collectables: null,
        prize: null,
        membership: { member: false, justBecameMember: false, gamesToMembership: 2 },
        seen: { chest: false, draw: false },
      },
    })
  })

  it("is missed when the player last attended another game", async () => {
    // Given
    const { chain } = await personhood({ tag: "Lite" }, 6)

    // When
    const outcome = await chain.readOutcome(people(), ADDRESS, seenGame)

    // Then
    expect(outcome).toEqual({ cancelled: false, results: null, gamesToMembership: null, paused: false, missesLeft: null, gameIndex: 7, registered: true, memberBefore: false })
  })

  it("keeps a member who missed inside the grace window a member, and pauses only one the chain suspended", async () => {
    // Given
    const metrics = { score: 2, personhoodThreshold: 3, misses: 2, allowedMisses: 5, window: 6 }
    const read = async (state: unknown) => {
      const { sdk, chain } = await personhood(state, 6)
      const resolved = await sdk.readPersonhoodState({} as never, { account: ADDRESS })
      if (resolved.ok && resolved.value.tag === "Resolved") Object.assign(resolved.value.metrics, metrics)
      return chain.readOutcome(people(), ADDRESS, { ...seenGame, memberBefore: true })
    }

    // When
    const inGrace = await read(member)
    const suspended = await read({ tag: "Suspended" })

    // Then
    expect(inGrace).toMatchObject({ results: null, paused: false, missesLeft: 3 })
    expect(suspended).toMatchObject({ results: null, paused: true, missesLeft: null })
  })

  it("greets a new member only when the game made one", async () => {
    // Given
    const { chain } = await personhood(member, 7)
    const justBecame = async (memberBefore: boolean | null) =>
      (await chain.readOutcome(people(), ADDRESS, { ...seenGame, memberBefore }))?.results?.membership.justBecameMember

    // When
    const fromNonMember = await justBecame(false)
    const fromMember = await justBecame(true)
    const fromUnread = await justBecame(null)

    // Then
    expect(fromNonMember).toBe(true)
    expect(fromMember).toBe(false)
    expect(fromUnread).toBe(false)
  })

  it("gives no count for a candidate with no games left, and waits on a draw that is still drawing", async () => {
    // Given
    const { chain } = await personhood({ tag: "Candidate", score: 3, personhoodThreshold: 3, gamesRemaining: 0 }, 7)
    const event = { prize: { assetId: { parents: 0, interior: null }, assetAmount: 200_000_000n }, drawTime: 1_800_003_600 }
    await withDrawList([draw("Drawing", { tag: "Unchecked" }, event)])

    // When
    const outcome = await chain.readOutcome(people(), ADDRESS, seenGame)

    // Then
    expect(outcome?.gamesToMembership).toBeNull()
    expect(outcome?.results?.prize).toMatchObject({ phase: "waiting", won: false })
  })

  it("closes the claim once the player has attended a later game", async () => {
    // Given
    const { chain } = await personhood(member, 8)
    const event = { prize: { assetId: { parents: 0, interior: null }, assetAmount: 200_000_000n }, drawTime: 1_800_003_600 }
    await withDrawList([draw("Claiming", { tag: "Won", ticket: "ab" }, event)])

    // When
    const reading = await chain.readPrize(people(), ADDRESS, seenGame)

    // Then
    expect(reading?.prize).toMatchObject({ won: true, phase: "drawn", claimable: false })
  })

  it("follows the draw still running when no ticket won, and keeps to the draw it read before", async () => {
    // Given
    const { chain } = await personhood(member, 7)
    const event = { prize: { assetId: { parents: 0, interior: null }, assetAmount: 200_000_000n }, drawTime: 1_800_003_600 }
    await withDrawList([draw("Gone", { tag: "NotWon" }, null), draw("Registering", { tag: "Unchecked" }, event)])

    // When
    const first = await chain.readPrize(people(), ADDRESS, seenGame)
    const pinned = await chain.readPrize(people(), ADDRESS, seenGame, { drawIndex: 0 })

    // Then
    expect(first).toMatchObject({ drawIndex: 1, prize: { phase: "waiting" } })
    expect(pinned).toMatchObject({ drawIndex: 0, prize: { phase: "over" } })
  })

  it("reads a win whose claim window has closed as not claimable", async () => {
    // Given
    const { chain } = await personhood(member, 7)
    const event = { prize: { assetId: { parents: 0, interior: null }, assetAmount: 200_000_000n }, drawTime: 1_800_003_600 }
    await withDrawList([draw("Settling", { tag: "Won", ticket: "ab" }, event)])

    // When
    const outcome = await chain.readOutcome(people(), ADDRESS, seenGame)

    // Then
    expect(outcome?.results?.prize).toMatchObject({ phase: "over", won: true, claimable: false })
  })

  it("reads the prize of the player, and a win in its claim window is claimable", async () => {
    // Given
    const { sdk, chain } = await personhood(member, 7)
    const event = { prize: { assetId: { parents: 0, interior: null }, assetAmount: 200_000_000n }, drawTime: 1_800_003_600 }
    await withDrawList([draw("Claiming", { tag: "NotWon" }, event), draw("Claiming", { tag: "Won", ticket: "ab" }, event)])

    // When
    const outcome = await chain.readOutcome(people(), ADDRESS, seenGame)

    // Then
    expect(sdk.readPrizeStatus).toHaveBeenCalledWith(expect.anything(), {
      registrant: { tag: "Account", accountAddress: ADDRESS },
      game: { index: 7, airdropsScheduled: 2 },
    })
    expect(outcome?.results?.prize).toEqual({
      amountUsd: 200,
      ticket: "ab",
      drawAt: 1_800_003_600,
      phase: "drawn",
      won: true,
      claimable: true,
    })
  })

  it("tells a winner the chain will not pay for not being a member, once it holds the game", async () => {
    // Given
    const { chain } = await personhood(candidate, 7)
    const event = { prize: { assetId: { parents: 0, interior: null }, assetAmount: 200_000_000n }, drawTime: 1_800_003_600 }
    await withDrawList([draw("Claiming", { tag: "Won", ticket: "ab" }, event)])

    // When
    const reading = await chain.readPrize(people(), ADDRESS, seenGame)

    // Then
    expect(reading?.prize).toMatchObject({ won: true, claimable: false, membersOnly: true })
  })

  it("lets a winner who reached personhood claim before the ring takes them in", async () => {
    // Given: MembershipReady, over the threshold and not recognized yet
    const { chain } = await personhood({ tag: "MembershipReady" }, 7)
    const event = { prize: { assetId: { parents: 0, interior: null }, assetAmount: 200_000_000n }, drawTime: 1_800_003_600 }
    await withDrawList([draw("Claiming", { tag: "Won", ticket: "ab" }, event)])

    // When
    const reading = await chain.readPrize(people(), ADDRESS, seenGame)

    // Then
    expect(reading?.prize).toMatchObject({ won: true, claimable: true })
    expect(reading?.prize.membersOnly).toBeUndefined()
  })

  it("judges no membership before the chain holds the game's attendance", async () => {
    // Given: the score row still names the game before
    const { chain } = await personhood(candidate, 6)
    const event = { prize: { assetId: { parents: 0, interior: null }, assetAmount: 200_000_000n }, drawTime: 1_800_003_600 }
    await withDrawList([draw("Claiming", { tag: "Won", ticket: "ab" }, event)])

    // When
    const reading = await chain.readPrize(people(), ADDRESS, seenGame)

    // Then
    expect(reading?.prize).toMatchObject({ won: true, claimable: false })
    expect(reading?.prize.membersOnly).toBeUndefined()
  })

  it("reads no prize for a player who neither signed up nor attended", async () => {
    // Given
    const { sdk, chain } = await personhood({ ...member, lastAttendedGame: 6 }, 6)

    // When
    const outcome = await chain.readOutcome(people(), ADDRESS, { ...seenGame, registered: false })

    // Then
    expect(outcome?.results).toBeNull()
    expect(outcome?.registered).toBe(false)
    expect(sdk.readPrizeStatus).not.toHaveBeenCalled()
  })

  it("is played, with the prize read, when the chain says the player attended but the stored sign-up says not", async () => {
    // Given
    const { sdk, chain } = await personhood(member, 7)

    // When
    const outcome = await chain.readOutcome(people(), ADDRESS, { ...seenGame, registered: false })

    // Then
    expect(outcome?.registered).toBe(true)
    expect(sdk.readPrizeStatus).toHaveBeenCalledWith(expect.anything(), {
      registrant: { tag: "Account", accountAddress: ADDRESS },
      game: { index: 7, airdropsScheduled: 2 },
    })
  })
})

describe("claim reading works", () => {
  it("is true when the chain confirms the claim of the account, for that game and draw", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-individuality")
    vi.mocked(sdk.confirmClaim).mockResolvedValue({ ok: true, value: { tag: "Claimed" } } as never)
    const chain = await import("./chain")

    // When
    const claimed = await chain.readClaimed(people(), ADDRESS, 7, 2)

    // Then
    expect(claimed).toBe(true)
    expect(sdk.confirmClaim).toHaveBeenCalledWith(expect.anything(), {
      gameIndex: 7,
      airdropIndex: 2,
      registrant: { tag: "Account", accountAddress: ADDRESS },
    })
  })

  it("is false when the chain answers anything but a claim", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-individuality")
    vi.mocked(sdk.confirmClaim).mockResolvedValue({ ok: true, value: { tag: "Unknown" } } as never)
    const chain = await import("./chain")

    // When
    const claimed = await chain.readClaimed(people(), ADDRESS, 7, 2)

    // Then
    expect(claimed).toBe(false)
  })
})

describe("earned reading works", () => {
  async function claims(lastAttendedGame: number | null, list: { gameIndex: number | null; state: string }[]) {
    const { chain } = await personhood(member, lastAttendedGame)
    const nfts = await import("@parity/product-sdk-nfts")
    vi.mocked(nfts.getClaims).mockResolvedValue({ ok: true, value: { claims: list } } as never)
    return chain
  }
  const hub = { getUnsafeApi: () => ({}) } as never

  it("counts the claims of the game the way the chest does, leaving out unprovable ones", async () => {
    // Given
    const chain = await claims(9, [
      { gameIndex: 7, state: "earned" },
      { gameIndex: 7, state: "claimed" },
      { gameIndex: 7, state: "unprovable" },
      { gameIndex: 8, state: "earned" },
    ])

    // When
    const earned = await chain.readEarned(people(), hub, ADDRESS, 7)

    // Then
    expect(earned).toBe(2)
  })

  it("counts a claim with no game for the last game the player attended", async () => {
    // Given
    const chain = await claims(7, [{ gameIndex: null, state: "claimable" }])

    // When
    const earned = await chain.readEarned(people(), hub, ADDRESS, 7)

    // Then
    expect(earned).toBe(1)
  })

  it("leaves a claim with no game out of an older game", async () => {
    // Given
    const chain = await claims(9, [{ gameIndex: null, state: "claimable" }])

    // When
    const earned = await chain.readEarned(people(), hub, ADDRESS, 7)

    // Then
    expect(earned).toBe(0)
  })

  it("is null when the claims cannot be read", async () => {
    // Given
    const { chain } = await personhood(member, 7)
    const nfts = await import("@parity/product-sdk-nfts")
    vi.mocked(nfts.getClaims).mockResolvedValue({ ok: false, error: new Error("down") } as never)

    // When
    const earned = await chain.readEarned(people(), hub, ADDRESS, 7)

    // Then
    expect(earned).toBeNull()
  })
})

describe("collectables reading works", () => {
  const HARE = "1".padStart(64, "0")
  const hub = { getUnsafeApi: () => ({}) } as never

  function choice(collectionId: number, name: string, rarity: "rare" | "common" = "common") {
    return { collectionId, collection: `Collection ${collectionId}`, name, rarity, image: `cid-${name}` }
  }

  async function chest(picks: { jollity: number; stash: number }) {
    const { chain } = await personhood(member, 7)
    const collectables = await import("@jollity/collectables")
    const choices = [choice(0, "Hare"), choice(1, "Pizza"), choice(2, "Acropolis", "rare")]
    vi.mocked(collectables.readChestPinned).mockResolvedValue({
      gameIndex: 7,
      items: [{ hash: HARE, proof: null, state: "claimable", ...choices[0]!, choices }],
      unprovable: 0,
      pending: 0,
      claimed: 0,
    })
    const readJSON = vi.fn().mockResolvedValue({ [`0x${HARE}`]: { collectionId: picks.jollity } })
    const readProductJSON = vi.fn().mockResolvedValue({ [`0x${HARE}`]: { collectionId: picks.stash } })
    const host = {
      preimages: vi.fn().mockResolvedValue(null),
      storage: { readJSON, readProductJSON },
    } as unknown as WorkerHost
    return { chain, host, readJSON, readProductJSON }
  }

  it("deals the collection Scarcity picked over the one Jollity picked", async () => {
    // Given
    const { chain, host, readJSON, readProductJSON } = await chest({ jollity: 1, stash: 2 })

    // When
    const read = await chain.readCollectables(host, people(), hub, ADDRESS, 7)

    // Then
    expect(read).toEqual({ items: [{ name: "Acropolis", rarity: "rare", image: "cid-Acropolis" }], pending: 0 })
    expect(readJSON).toHaveBeenCalledWith("jollity.chest")
    expect(readProductJSON).toHaveBeenCalledWith("stash.paseo", "stash.picks")
  })

  /** The art loader the worker hands the chest read, with the host lookup present and the SDK check answering `verified`. */
  async function artLoader(verified: unknown) {
    const { chain, host } = await chest({ jollity: 0, stash: 0 })
    vi.mocked(host.preimages).mockResolvedValue({} as never)
    const nfts = await import("@parity/product-sdk-nfts")
    vi.mocked(nfts.preimageSource).mockReturnValue(async () => null)
    vi.mocked(nfts.getVerifiedArtwork).mockResolvedValue(verified as never)
    await chain.readCollectables(host, people(), hub, ADDRESS, 7)
    const collectables = await import("@jollity/collectables")
    return vi.mocked(collectables.readChestPinned).mock.calls.at(-1)![3].loadArt
  }

  it("keeps the thumbnail CID of a manifest the host lookup verifies", async () => {
    // Given
    const manifest = new TextEncoder().encode(JSON.stringify({ assets: { thumbnail: { cid: "bafk-thumb" } } }))
    const loadArt = await artLoader({ ok: true, value: { tag: "Verified", bytes: manifest } })

    // When
    const picture = await loadArt("bafk-manifest")

    // Then
    expect(picture).toBe("bafk-thumb")
  })

  it.each([
    ["bytes that do not match the digest", { ok: true, value: { tag: "Mismatch" } }],
    ["a host that has no bytes", { ok: true, value: { tag: "Missing" } }],
    ["a check that fails", { ok: false, error: new Error("down") }],
  ])("keeps no picture for %s", async (_label, verified) => {
    // Given
    const loadArt = await artLoader(verified)

    // When
    const picture = await loadArt("bafk-manifest")

    // Then
    expect(picture).toBe("")
  })
})

describe("outcome reading fails", () => {
  it("stores the results without the prize when the prize read fails, and marks the prize unread", async () => {
    // Given
    const { sdk, chain } = await personhood(member, 7)
    vi.mocked(sdk.readPrizeStatus).mockResolvedValue({ ok: false, error: new Error("down") } as never)

    // When
    const outcome = await chain.readOutcome(people(), ADDRESS, seenGame)

    // Then
    expect(outcome).toMatchObject({ prizeUnread: true, results: { passed: true, prize: null } })
  })

  it("is null when the personhood read fails", async () => {
    // Given
    const { sdk, chain } = await personhood(member, 7)
    vi.mocked(sdk.readPersonhoodState).mockResolvedValue({ ok: false, error: new Error("down") } as never)

    // When
    const outcome = await chain.readOutcome(people(), ADDRESS, seenGame)

    // Then
    expect(outcome).toBeNull()
  })
})

describe("claim reading fails", () => {
  it("is undefined when the read fails, and counts it as a failed outcome read of the claim", async () => {
    // Given
    const sdk = await import("@parity/product-sdk-individuality")
    vi.mocked(sdk.confirmClaim).mockResolvedValue({ ok: false, error: new Error("down") } as never)
    const chain = await import("./chain")
    const { configureTelemetry } = await import("./telemetry")
    const sent: TelemetryRecord[] = []
    configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      fetchImpl: async (_url, init) => {
        sent.push(...decodeTelemetryEnvelope(init.body))
      },
    })

    // When
    const claimed = await chain.readClaimed(people(), ADDRESS, 7, 2)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Then
    expect(claimed).toBeUndefined()
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "metric",
        name: "chat.outcome.read_failed",
        value: 1,
        tags: expect.objectContaining({ stage: "claim", "game.index": "7" }),
      }),
      expect.objectContaining({ kind: "log", name: "chat.outcome.read_failed", contexts: { detail: { error: "Error: down" } } }),
    ])
  })
})

describe("early verdict reading works", () => {
  const running = {
    index: 7,
    phase: "reporting" as const,
    registrationStarts: 0,
    registrationEnds: 0,
    gamePlayTime: 1_800_000_000,
    playEnds: 1_800_000_300,
    reportingEnds: 1_800_000_600,
    airdropsScheduled: 2,
    registered: true,
    drawOpen: null,
  }
  const row = (fields: Record<string, unknown> = {}) => ({
    registered: true,
    sent_report: true,
    yes_person: 1,
    no_not_person: 0,
    expected_max_vote_weight: 4,
    early_attendance_enactment: undefined,
    ...fields,
  })
  const peopleWithRow = (value: unknown) => {
    const getValue = vi.fn(async () => {
      if (value instanceof Error) throw value
      return value
    })
    const reads = people() as unknown as { api: { query: Record<string, unknown> } }
    reads.api.query.Game = { Players: { getValue } }
    return { reads: reads as never, getValue }
  }

  it("is final and passed once the pallet applied the attendance early", async () => {
    // Given
    const chain = await import("./chain")
    const { reads, getValue } = peopleWithRow(row({ yes_person: 4, early_attendance_enactment: { attendance: true } }))

    // When
    const view = await chain.readAttendance(reads, ADDRESS, running)

    // Then
    expect(view).toMatchObject({ gameIndex: 7, verdict: "passed", final: true })
    expect(getValue).toHaveBeenCalledWith({ type: "Account", value: ADDRESS }, { at: "best" })
  })

  it("is pending while the votes still to come can swing it", async () => {
    // Given
    const chain = await import("./chain")
    const { reads } = peopleWithRow(row())

    // When
    const view = await chain.readAttendance(reads, ADDRESS, running)

    // Then
    expect(view).toMatchObject({ verdict: "pending", final: false })
  })

  it("reads nothing before the game reports, and says a failed read is unknown", async () => {
    // Given
    const chain = await import("./chain")
    const { reads, getValue } = peopleWithRow(row())

    // When
    const before = await chain.readAttendance(reads, ADDRESS, { ...running, phase: "registration" })
    const failed = await chain.readAttendance(peopleWithRow(new Error("down")).reads, ADDRESS, running)

    // Then
    expect(before).toBeNull()
    expect(getValue).not.toHaveBeenCalled()
    expect(failed).toBeUndefined()
  })
})

describe("membership reading works", () => {
  it("counts a member at risk as a member for the banner", async () => {
    // Given
    const { chain } = await personhood({ tag: "Caution", misses: 1, allowedMisses: 1, window: 4, lastAttendedGame: 7 }, 7)

    // When
    const isMember = isMemberStanding(await chain.readStanding(people(), ADDRESS))

    // Then
    expect(isMember).toBe(true)
  })

  it("counts a player who reached personhood as a member before recognition", async () => {
    // Given
    const { chain } = await personhood({ tag: "MembershipReady" }, 7)

    // When
    const isMember = isMemberStanding(await chain.readStanding(people(), ADDRESS))
    const outcome = await chain.readOutcome(people(), ADDRESS, seenGame)

    // Then
    expect(isMember).toBe(true)
    expect(outcome?.results?.membership).toEqual({ member: true, justBecameMember: true, gamesToMembership: null })
  })

  it("does not count a candidate as a member for the banner", async () => {
    // Given
    const { chain } = await personhood(candidate, 7)

    // When
    const isMember = isMemberStanding(await chain.readStanding(people(), ADDRESS))

    // Then
    expect(isMember).toBe(false)
  })
})

describe("player address lookup works", () => {
  it("asks for the account the app plays as, which is the product account at the sign-up index", async () => {
    // Given
    const { playerAddress } = await import("./chain")
    const productAccount = vi.fn().mockResolvedValue(new Uint8Array(32))

    // When
    const address = await playerAddress({ productAccount } as unknown as WorkerHost)

    // Then
    expect(productAccount).toHaveBeenCalledWith("dim2.paseo", 1)
    expect(address).toMatch(/^5/)
  })
})

describe("People connection works", () => {
  it("falls back to the genesis of the network table when the host maps none", async () => {
    // Given
    const { connect } = await import("./chain")
    const chainProvider = vi.fn().mockResolvedValue({})
    const host = { peopleGenesis: vi.fn().mockResolvedValue(null), chainProvider } as unknown as WorkerHost

    // When
    const connection = await connect(host)

    // Then
    expect(connection).not.toBeNull()
    expect(chainProvider).toHaveBeenCalledWith("0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48")
  })
})

describe("People connection fails", () => {
  it("resolves null when the host serves no provider, and tries again on the next call", async () => {
    // Given
    const { connect } = await import("./chain")
    const chainProvider = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({})
    const host = { peopleGenesis: vi.fn().mockResolvedValue(null), chainProvider } as unknown as WorkerHost

    // When
    const missed = await connect(host)
    const retried = await connect(host)

    // Then
    expect(missed).toBeNull()
    expect(retried).not.toBeNull()
    expect(chainProvider).toHaveBeenCalledTimes(2)
  })
})

describe("a chain connect the host never answers", () => {
  const hung = () => new Promise<never>(() => {})

  it.each([
    ["People", "connect", "peopleGenesis", "people"],
    ["Asset Hub", "connectAssetHub", "assetHubGenesis", "asset-hub"],
  ] as const)("connects to %s again after a provider request that never answered", async (_name, call, genesis, chainName) => {
    // Given
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const events: TelemetryRecord[] = []
      const telemetry = await import("./telemetry")
      telemetry.configureTelemetry({
        dsn: "https://k@o1.ingest.de.sentry.io/1",
        fetchImpl: async (_url, init) => {
          events.push(...decodeTelemetryEnvelope(init.body))
        },
      })
      const chain = await import("./chain")
      const chainProvider = vi.fn().mockReturnValueOnce(hung()).mockResolvedValue({})
      const host = { [genesis]: vi.fn().mockResolvedValue("0x01"), chainProvider } as unknown as WorkerHost

      // When
      const first = chain[call](host)
      await vi.advanceTimersByTimeAsync(60_000)
      const missed = await first
      const retried = await chain[call](host)

      // Then
      expect(missed).toBeNull()
      expect(retried).not.toBeNull()
      expect(chainProvider).toHaveBeenCalledTimes(2)
      expect(telemetryRecords(events, "chat.chain.connect_failed", "metric")).toEqual([
        expect.objectContaining({ value: 1, tags: expect.objectContaining({ chain: chainName, reason: "deadline" }) }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ["People", "connect", "peopleGenesis"],
    ["Asset Hub", "connectAssetHub", "assetHubGenesis"],
  ] as const)("a late answer from an abandoned %s connect does not replace the newer client", async (_name, call, genesis) => {
    // Given
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const chain = await import("./chain")
      const { createClient } = await import("polkadot-api")
      let answerLate: (provider: unknown) => void = () => {}
      const chainProvider = vi
        .fn()
        .mockReturnValueOnce(new Promise((resolve) => (answerLate = resolve)))
        .mockResolvedValue({})
      const host = { [genesis]: vi.fn().mockResolvedValue("0x01"), chainProvider } as unknown as WorkerHost
      const first = chain[call](host)
      await vi.advanceTimersByTimeAsync(60_000)
      await first
      const newer = await chain[call](host)
      const clientsBefore = vi.mocked(createClient).mock.calls.length

      // When
      answerLate({})
      await vi.advanceTimersByTimeAsync(0)
      const after = await chain[call](host)

      // Then
      expect(after).toBe(newer)
      expect(vi.mocked(createClient).mock.calls.length).toBe(clientsBefore)
    } finally {
      vi.useRealTimers()
    }
  })
})
