// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Checks the chat card of a player who signed up.
 *
 * The app follows `Game.Players` at the best block and shows the player
 * registered from there. Finality trails the best block, so a worker that
 * reads at the finalized block keeps offering Register after the app has
 * moved on.
 *
 * The worker header says every outcome is drawn on the card, because a button
 * that only logs does nothing from the side of the player. A host that refuses
 * to open the intro from How to play is such an outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { INTRO, cardCopy } from "../src/card"
import type { ChainRead, RunningGame } from "../src/chain"
import type { ActionListener, RenderHandler, RenderNode, WorkerHost } from "../src/host"
import { encPayload } from "../src/renderer"

vi.mock("polkadot-api", async (original) => ({
  ...(await original<typeof import("polkadot-api")>()),
  createClient: vi.fn(),
}))

const ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
const FINALIZED = "0xf1"
const BEST = "0xb2"
const GAME_PLAY_TIME = 1_800_000_000

const rawGame = {
  index: 7,
  state: { type: "Registration", value: { player_count: 1 } },
  registration_ends: GAME_PLAY_TIME - 90,
  shuffle_deadline: GAME_PLAY_TIME - 30,
  game_date: GAME_PLAY_TIME,
  report_ends: GAME_PLAY_TIME + 600,
  max_group_size: 6,
  rounds: 2,
  pending_attendance: 0,
  airdrops_scheduled: 0,
}

const durations = { registration: 3600, shuffle: 60, post_shuffle_margin: 30, reporting: 600, player_process: 60 }

const atBest = (options: { at?: string } | undefined) => options?.at === BEST || options?.at === "best"

function peopleClient() {
  const api = {
    query: {
      Game: {
        GameIndex: { getValue: vi.fn(async () => 7) },
        Game: { getValue: vi.fn(async () => rawGame) },
        GameSchedules: { getValue: vi.fn(async () => []) },
        StoredPhaseDurations: { getValue: vi.fn(async () => durations) },
        Players: {
          getValue: vi.fn(async (key: { type: string; value: string }, options?: { at?: string }) =>
            key.type === "Account" && key.value === ADDRESS && atBest(options)
              ? { registered: true, sent_report: false }
              : undefined,
          ),
          watchValue: vi.fn(),
        },
      },
      Timestamp: { Now: { getValue: vi.fn(async () => BigInt(Date.now())) } },
    },
    constants: { Game: { DefaultPhaseDurations: vi.fn(async () => durations) } },
  }
  return {
    getUnsafeApi: () => api,
    getFinalizedBlock: vi.fn(async () => ({ hash: FINALIZED, number: 10 })),
    getBestBlocks: vi.fn(async () => [
      { hash: BEST, number: 12 },
      { hash: FINALIZED, number: 10 },
    ]),
  }
}

function peopleHost(): WorkerHost {
  return {
    peopleGenesis: vi.fn().mockResolvedValue(`0x${"11".repeat(32)}`),
    chainProvider: vi.fn().mockResolvedValue({}),
  } as unknown as WorkerHost
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const nowSeconds = () => Math.floor(Date.now() / 1000)

function welcomedHost(overrides: Partial<WorkerHost> = {}): WorkerHost {
  const store = new Map<string, unknown>([["jollity.wg.intro.v3", INTRO.length]])
  return {
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

function registeredGame(secondsAway = 2 * 3600): RunningGame {
  const gamePlayTime = nowSeconds() + secondsAway
  return {
    index: 7,
    phase: "registration",
    registrationStarts: gamePlayTime - 90 - 2 * 3600,
    registrationEnds: gamePlayTime - 90,
    gamePlayTime,
    playEnds: gamePlayTime + 144,
    reportingEnds: gamePlayTime + 600,
    airdropsScheduled: 1,
    registered: true,
    drawOpen: true,
  }
}

function withChain(read: ChainRead) {
  vi.doMock("../src/chain", () => ({
    connect: vi.fn().mockResolvedValue({}),
    playerAddress: vi.fn().mockResolvedValue(ADDRESS),
    readGame: vi.fn().mockResolvedValue(read),
    readStanding: vi.fn().mockResolvedValue("Candidate"),
    readOutcome: vi.fn(),
    readPrize: vi.fn(),
  }))
}

async function renderHandler(host: WorkerHost): Promise<RenderHandler> {
  const { main } = await import("../src/index")
  await main(host)
  await flush()
  return vi.mocked(host.renderer.onRender).mock.calls[0]![0]
}

function textsIn(node: RenderNode, color: string): string[] {
  if (node.tag === "Text") {
    const own = node.value.props.color === color ? node.value.children.flatMap((child) => (child.tag === "String" ? [child.value.text] : [])) : []
    return [...own, ...node.value.children.flatMap((child) => textsIn(child, color))]
  }
  if (node.tag === "Column" || node.tag === "Row") return node.value.children.flatMap((child) => textsIn(child, color))
  return []
}

type HostAnswer = boolean | "throws"

async function pressStartPlaying(...answers: HostAnswer[]) {
  const game = registeredGame(-30)
  withChain({ running: game, upcoming: [], clockOffsetMs: 0, member: null })
  const navigate = vi.fn()
  for (const answer of answers) {
    if (answer === "throws") navigate.mockRejectedValueOnce(new Error("navigateTo unavailable"))
    else navigate.mockResolvedValueOnce(answer)
  }
  const host = welcomedHost({ navigate })
  const handler = await renderHandler(host)
  const send = vi.fn<(node: RenderNode) => void>()
  let press: ActionListener | undefined
  const teardown = handler({ messageId: "m1", messageType: "jollity.gamecard", payload: encPayload({ gamePlayTime: game.gamePlayTime }) }, send, (listener) => {
    press = listener
    return () => {}
  })
  await flush()
  const before = send.mock.calls.at(-1)![0]
  for (const _ of answers) {
    press!("jollity.open", undefined)
    await flush()
    await flush()
  }
  return { host, before, after: send.mock.calls.at(-1)![0], teardown }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.doUnmock("../src/chain")
})

describe("reading a sign-up made in the app works", () => {
  it("shows the player registered once the sign-up is in the best block the app reads, before it is finalized", async () => {
    // Given
    const papi = await import("polkadot-api")
    vi.mocked(papi.createClient).mockReturnValue(peopleClient() as never)
    const { connect, readGame } = await import("../src/chain")
    const people = await connect(peopleHost())

    // When
    const read = await readGame(welcomedHost(), people!, ADDRESS)

    // Then
    expect(read?.running?.index).toBe(7)
    expect(read?.running?.registered).toBe(true)
  })
})

describe("Start playing on the card of a registered player works", () => {
  it("asks the host to open the game from the card of a game already running", async () => {
    // Given
    const hostOpensIt = true

    // When
    const { host, before, after, teardown } = await pressStartPlaying(hostOpensIt)

    // Then
    expect(JSON.stringify(before)).toContain(cardCopy.START_PLAYING)
    expect(host.navigate).toHaveBeenCalledTimes(1)
    expect(textsIn(after, "FgError")).toEqual([])
    teardown?.()
  })
})

describe("Start playing on the card of a registered player fails", () => {
  it("draws an error notice on the card when the host does not open the game (#248)", async () => {
    // Given
    const hostOpensIt = false

    // When
    const { after, teardown } = await pressStartPlaying(hostOpensIt)

    // Then
    expect(textsIn(after, "FgError"), "error texts on the card after the host refused the game").not.toEqual([])
    teardown?.()
  })

  it("draws the same notice when the host throws instead of answering", async () => {
    // Given
    const hostAnswer = "throws" as const

    // When
    const { after, teardown } = await pressStartPlaying(hostAnswer)

    // Then
    expect(textsIn(after, "FgError")).toEqual([cardCopy.openFailed("Jollity")])
    teardown?.()
  })

  it("clears the notice once a later tap opens the game", async () => {
    // Given
    const refusedThenOpened: HostAnswer[] = [false, true]

    // When
    const { after, teardown } = await pressStartPlaying(...refusedThenOpened)

    // Then
    expect(textsIn(after, "FgError")).toEqual([])
    teardown?.()
  })
})
