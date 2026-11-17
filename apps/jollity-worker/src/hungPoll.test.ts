// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChainRead, RunningGame } from "./chain"
import type { WorkerHost } from "./host"

vi.mock("./signup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./signup")>()),
  signupEngine: vi.fn(),
}))

vi.mock("./chain", () => ({
  connect: vi.fn(),
  playerAddress: vi.fn(),
  readGame: vi.fn(),
  readStanding: vi.fn(),
  readOutcome: vi.fn(),
  readAttendance: vi.fn(),
  readPrize: vi.fn(),
  readClaimed: vi.fn(),
  connectAssetHub: vi.fn(),
  readEarned: vi.fn(),
  readCollectables: vi.fn(),
}))

const ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"

function fakeHost(): WorkerHost & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    chat: {
      registerBot: vi.fn().mockResolvedValue("New"),
      registerRoom: vi.fn().mockResolvedValue("New"),
      postMessage: vi.fn().mockResolvedValue(undefined),
      postText: vi.fn().mockResolvedValue(undefined),
      setRoomFooter: vi.fn().mockResolvedValue("set"),
    },
    renderer: { onRender: vi.fn(() => () => {}) },
    notifications: { push: vi.fn(() => new Promise<number>(() => {})), cancel: vi.fn() },
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
  }
}

function running(): RunningGame {
  const gamePlayTime = Math.floor(Date.now() / 1000) + 2 * 3600
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

const chainRead = (): ChainRead => ({ running: running(), upcoming: [], clockOffsetMs: 0, member: null })

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe("the poll survives a call that never answers", () => {
  it("gives up on a hung push and polls again", async () => {
    // Only the host-call deadline is virtual. This file has its own module
    // graph, so no worker loop or module state from the boot tests exists here.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const chain = await import("./chain")
      vi.mocked(chain.connect).mockResolvedValue({} as never)
      vi.mocked(chain.playerAddress).mockResolvedValue(ADDRESS)
      vi.mocked(chain.readStanding).mockResolvedValue({ tag: "Candidate", gamesToMembership: null })
      vi.mocked(chain.connectAssetHub).mockResolvedValue(null)
      vi.mocked(chain.readGame).mockResolvedValueOnce(chainRead()).mockResolvedValueOnce(chainRead())
      const host = fakeHost()
      const { tick } = await import("./index")

      const first = tick(host)
      await vi.advanceTimersByTimeAsync(0)
      expect(chain.readGame).toHaveBeenCalledTimes(1)
      expect(host.notifications.push).toHaveBeenCalledTimes(1)
      for (let pushes = 2; pushes <= 3; pushes++) {
        await vi.advanceTimersByTimeAsync(45_000)
        expect(chain.readGame).toHaveBeenCalledTimes(1)
        expect(host.notifications.push).toHaveBeenCalledTimes(pushes)
      }
      await vi.advanceTimersByTimeAsync(45_000)
      await first
      await tick(host)

      expect(chain.readGame).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
