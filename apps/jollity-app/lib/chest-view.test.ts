// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The chest doorway over a fake engine, for the one ordering the page depends
 * on: a chest opened for game N before the pallet settled it.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GameEngine, PalletGame } from "@jollity/protocol"

const readChestPinned = vi.hoisted(() => vi.fn())
vi.mock("./engine", () => ({
  resolveDevEngine: () => null,
  resolveHostEngine: async () => null,
  resolveScarcityChain: async () => ({}),
}))
vi.mock("./scarcity", () => ({ readChestPinned }))

import { makeSource } from "./game-source"
import { READ_ATTEMPT_MS } from "./read-retry"
import { SETTLE_TIMEOUT_MS } from "@individuality/game-outcome"

const PLAYER = "5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw"
const game = (index: number) => ({ index, state: { type: "PlayerProcess" } }) as unknown as PalletGame

afterEach(() => {
  vi.useRealTimers()
})

describe("chest view works", () => {
  it("treats game N as the latest once it settles, though the player still named N - 1 before", async () => {
    // Given
    let settled = false
    const watchers: Array<(next: PalletGame | undefined) => void> = []
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(92),
      watchGame: (cb: (next: PalletGame | undefined) => void) => {
        watchers.push(cb)
        return () => {}
      },
      participant: vi.fn(async () => ({ last_attended_game: settled ? 92 : 91 })),
    } as unknown as GameEngine
    readChestPinned.mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 })
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.chestView({ gameIndex: 92 })
    // until the read after the settle, the only one that asks for the participant
    await vi.waitFor(() => {
      settled = true
      for (const watcher of watchers) watcher(game(93))
      expect(engine.participant).toHaveBeenCalled()
    })
    await view

    // Then
    expect(readChestPinned).toHaveBeenLastCalledWith(expect.anything(), PLAYER, 92, { latestGame: true })
  })
})

const EMPTY = { gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 }
const ARRIVED = {
  ...EMPTY,
  items: [{ hash: "0x01", proof: null, state: "earned", name: "Hare", rarity: "common", image: "", collection: "Sports", choices: [] }],
}

describe("chest view before the game settles works", () => {
  const openGame = (unsubscribed: { value: boolean }) =>
    ({
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(92),
      watchGame: () => () => {
        unsubscribed.value = true
      },
      participant: vi.fn(async () => ({ last_attended_game: 91 })),
    }) as unknown as GameEngine

  it("opens on the claims co-players' votes awarded, and stops waiting for the settle", async () => {
    // Given
    vi.useFakeTimers()
    const unsubscribed = { value: false }
    const engine = openGame(unsubscribed)
    readChestPinned.mockReset()
    readChestPinned.mockResolvedValueOnce(EMPTY).mockResolvedValue(ARRIVED)
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.chestView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(6_000)
    const opened = await view

    // Then
    expect(opened?.settling).toBe(true)
    expect(opened?.items).toHaveLength(1)
    expect(readChestPinned).toHaveBeenCalledTimes(2)
    expect(readChestPinned).toHaveBeenCalledWith(expect.anything(), PLAYER, 92, { latestGame: true })
    expect(engine.participant).not.toHaveBeenCalled()
    expect(unsubscribed.value).toBe(true)
  })

  it("keeps reading when a read before the settle fails", async () => {
    // Given
    vi.useFakeTimers()
    readChestPinned.mockReset()
    readChestPinned.mockRejectedValueOnce(new Error("collections: timeout")).mockResolvedValue(ARRIVED)
    const source = makeSource("ws", openGame({ value: false }), { player: PLAYER })

    // When
    const view = source.chestView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(6_000)

    // Then
    expect((await view)?.settling).toBe(true)
  })

  it("waits for the settle when asked for what the settle adds", async () => {
    // Given
    vi.useFakeTimers()
    let current: PalletGame | undefined = game(92)
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => current,
      watchGame: () => () => {},
      participant: async () => ({ last_attended_game: current ? 91 : 92 }),
    } as unknown as GameEngine
    readChestPinned.mockReset()
    readChestPinned.mockResolvedValue(ARRIVED)
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.chestView({ gameIndex: 92, afterSettle: true })
    await vi.advanceTimersByTimeAsync(6_000)
    const before = readChestPinned.mock.calls.length
    current = undefined
    await vi.advanceTimersByTimeAsync(5_000)
    const opened = await view

    // Then
    expect(before).toBe(0)
    expect(opened?.settling).toBeUndefined()
    expect(readChestPinned).toHaveBeenCalledTimes(1)
  })
})

describe("a chest kept up to date through a long settle works", () => {
  it("keeps watching past a settle wait that gave up, and hands over a claim that lands after it", async () => {
    // Given a game whose settle outlasts one wait (SETTLE_TIMEOUT_MS)
    vi.useFakeTimers()
    const watchers: Array<(next: PalletGame | undefined) => void> = []
    const rows: Array<(row: unknown) => void> = []
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(92),
      watchGame: (cb: (next: PalletGame | undefined) => void) => {
        watchers.push(cb)
        return () => {}
      },
      watchPlayerRow: (_who: string, cb: (row: unknown) => void) => {
        rows.push(cb)
        cb({ yes_person: 0 })
        return () => {}
      },
      participant: async () => ({ last_attended_game: 91 }),
    } as unknown as GameEngine
    const late = { ...ARRIVED.items[0]!, hash: "0x03", name: "Owl" }
    readChestPinned.mockReset()
    readChestPinned.mockResolvedValue(ARRIVED)
    const source = makeSource("ws", engine, { player: PLAYER })
    const onItems = vi.fn()
    let done = false

    // When the first wait gives up, then a vote lands, then the game settles
    void source.watchChest!({ gameIndex: 92, shown: ["0x01"], onItems, signal: new AbortController().signal }).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 10_000)
    readChestPinned.mockResolvedValue({ ...ARRIVED, items: [...ARRIVED.items, late] })
    rows.at(-1)!({ yes_person: 1 })
    await vi.advanceTimersByTimeAsync(0)
    const settledBefore = done
    for (const watcher of watchers) watcher(game(93))
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(onItems.mock.calls).toEqual([[[late]]])
    expect(settledBefore).toBe(false)
    expect(done).toBe(true)
  })
})

describe("a chest kept up to date before its game settles works", () => {
  it("reads when a vote for the player lands, hands over each new claim once, and stops at the settle", async () => {
    // Given a chest showing 0x01, and 0x02 awarded with a co-player's report
    vi.useFakeTimers()
    const watchers: Array<(next: PalletGame | undefined) => void> = []
    const rows: Array<(row: unknown) => void> = []
    let unwatched = false
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(92),
      watchGame: (cb: (next: PalletGame | undefined) => void) => {
        watchers.push(cb)
        return () => {}
      },
      watchPlayerRow: (_who: string, cb: (row: unknown) => void) => {
        rows.push(cb)
        return () => (unwatched = true)
      },
      participant: async () => ({ last_attended_game: 91 }),
    } as unknown as GameEngine
    const second = { ...ARRIVED.items[0]!, hash: "0x02", name: "Fox" }
    readChestPinned.mockReset()
    readChestPinned.mockResolvedValueOnce(ARRIVED).mockResolvedValue({ ...ARRIVED, items: [...ARRIVED.items, second] })
    const source = makeSource("ws", engine, { player: PLAYER })
    const onItems = vi.fn()

    // When the row is first seen, a block passes, and then a vote moves it
    const done = source.watchChest!({ gameIndex: 92, shown: ["0x01"], onItems, signal: new AbortController().signal })
    await vi.advanceTimersByTimeAsync(0)
    for (const row of rows) row({ yes_person: 0 })
    await vi.advanceTimersByTimeAsync(6_000)
    const beforeTheVote = readChestPinned.mock.calls.length
    for (const row of rows) row({ yes_person: 1 })
    await vi.advanceTimersByTimeAsync(0)
    for (const watcher of watchers) watcher(game(93))
    await done

    // Then
    expect(beforeTheVote).toBe(1)
    expect(onItems.mock.calls).toEqual([[[second]]])
    expect(readChestPinned).toHaveBeenCalledTimes(2)
    expect(readChestPinned).toHaveBeenCalledWith(expect.anything(), PLAYER, 92, {
      latestGame: true,
      except: new Set(["0x01", "0x02"]),
    })
    expect(unwatched).toBe(true)
  })
})

describe("chest view over a silent watch works", () => {
  it("opens once a later read finds the game settled, and then stops reading", async () => {
    // Given
    vi.useFakeTimers()
    let current: PalletGame | undefined = game(92)
    let lastAttended = 91
    let reads = 0
    let unsubscribed = false
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => {
        reads += 1
        return current
      },
      watchGame: () => () => {
        unsubscribed = true
      },
      participant: async () => ({ last_attended_game: lastAttended }),
    } as unknown as GameEngine
    readChestPinned.mockClear()
    readChestPinned.mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 })
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.chestView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(10_000)
    const waitingReads = reads
    current = undefined
    lastAttended = 92
    await vi.advanceTimersByTimeAsync(5_000)
    const opened = await view
    const settledReads = reads
    await vi.advanceTimersByTimeAsync(60_000)

    // Then
    // one read from makeSource (it freezes the clock's game window), then the
    // settle wait's own: the first at once, one every 5s after (at 5s and 10s)
    expect(waitingReads).toBe(4)
    expect(opened?.failed).toBeUndefined()
    expect(readChestPinned).toHaveBeenCalledWith(expect.anything(), PLAYER, 92, { latestGame: true })
    expect(unsubscribed).toBe(true)
    expect(reads).toBe(settledReads)
  })
})

describe("chest view for a game that never settles fails", () => {
  it("shows the chest as unreadable once the wait runs out with nothing arrived, rather than loading for ever", async () => {
    // Given
    vi.useFakeTimers()
    let unsubscribed = false
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(92),
      watchGame: () => () => {
        unsubscribed = true
      },
      participant: async () => ({ last_attended_game: 91 }),
    } as unknown as GameEngine
    readChestPinned.mockReset()
    readChestPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.chestView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(180_000)

    // Then
    expect((await view)?.failed).toMatch(/game 92 has not settled/)
    expect(unsubscribed).toBe(true)
    // only the reads before the settle, which found nothing
    expect(readChestPinned).toHaveBeenCalled()
    for (const call of readChestPinned.mock.calls) expect(call.slice(1)).toEqual([PLAYER, 92, { latestGame: true }])
  })
})

describe("chest view with an unreadable participant fails", () => {
  it("shows the chest as unreadable after its retries, rather than guessing an older game", async () => {
    // Given
    vi.useFakeTimers()
    const participant = vi.fn(async () => {
      throw new Error("People read failed")
    })
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(93),
      watchGame: () => () => {},
      participant,
    } as unknown as GameEngine
    readChestPinned.mockClear()
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.chestView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(4_000)

    // Then
    expect((await view)?.failed).toMatch(/People read failed/)
    expect(participant).toHaveBeenCalledTimes(3)
    expect(readChestPinned).not.toHaveBeenCalled()
  })
})

describe("chest view over a lost answer works", () => {
  it("reads the chest again when a read never answers, and opens it", async () => {
    // Given
    vi.useFakeTimers()
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(93),
      watchGame: () => () => {},
      participant: async () => ({ last_attended_game: 92 }),
    } as unknown as GameEngine
    readChestPinned.mockReset()
    readChestPinned
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 1 })
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.chestView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(READ_ATTEMPT_MS + 1_000)

    // Then
    const opened = await view
    expect(opened?.failed).toBeUndefined()
    expect(opened?.claimed).toBe(1)
    expect(readChestPinned).toHaveBeenCalledTimes(2)
  })
})

describe("chest view over answers that never come fails", () => {
  it("aborts a superseded chest read without starting another attempt", async () => {
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(93),
      watchGame: () => () => {},
      participant: async () => ({ last_attended_game: 92 }),
    } as unknown as GameEngine
    readChestPinned.mockReset()
    readChestPinned.mockReturnValue(new Promise(() => {}))
    const source = makeSource("ws", engine, { player: PLAYER })
    const controller = new AbortController()
    const view = source.chestView({ gameIndex: 92, signal: controller.signal })
    await vi.waitFor(() => expect(readChestPinned).toHaveBeenCalledTimes(1))

    controller.abort(new Error("newer chest read"))

    await expect(view).rejects.toThrow("newer chest read")
    expect(readChestPinned).toHaveBeenCalledTimes(1)
  })

  it("shows the chest as unreadable once every retry has run out", async () => {
    // Given
    vi.useFakeTimers()
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(93),
      watchGame: () => () => {},
      participant: async () => ({ last_attended_game: 92 }),
    } as unknown as GameEngine
    readChestPinned.mockReset()
    readChestPinned.mockReturnValue(new Promise(() => {}))
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.chestView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(3 * READ_ATTEMPT_MS + 4_000)

    // Then
    expect((await view)?.failed).toMatch(/no answer after 15 seconds/)
    expect(readChestPinned).toHaveBeenCalledTimes(3)
  })
})

describe("chest seed works", () => {
  it("gives one player the same chest seed for one game on every device, and a new one for another game or player", async () => {
    // Given
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(93),
      watchGame: () => () => {},
      participant: async () => ({ last_attended_game: 92 }),
    } as unknown as GameEngine
    readChestPinned.mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 })
    const other = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"

    // When
    const [phone, desktop, otherGame, otherPlayer] = await Promise.all([
      makeSource("ws", engine, { player: PLAYER }).chestView({ gameIndex: 92 }),
      makeSource("ws", engine, { player: PLAYER }).chestView({ gameIndex: 92 }),
      makeSource("ws", engine, { player: PLAYER }).chestView({ gameIndex: 91 }),
      makeSource("ws", engine, { player: other }).chestView({ gameIndex: 92 }),
    ])

    // Then
    expect(desktop?.seed).toBe(phone?.seed)
    expect(otherGame?.seed).not.toBe(phone?.seed)
    expect(otherPlayer?.seed).not.toBe(phone?.seed)
  })
})

describe("chest view of a player whose report never landed (#303)", () => {
  const engineFor = (row: { sent_report: boolean } | undefined) =>
    ({
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(93),
      watchGame: () => () => {},
      participant: async () => ({ last_attended_game: 91 }),
      player: async () => row,
    }) as unknown as GameEngine

  it("carries reportSent false for an empty chest of a game they did not attend, with no URL hint", async () => {
    readChestPinned.mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 })
    const view = await makeSource("ws", engineFor({ sent_report: false }), { player: PLAYER }).chestView({ gameIndex: 92 })
    expect(view?.attended).toBe(false)
    expect(view?.reportSent).toBe(false)
    const { emptyReason } = await import("./chest-reason")
    expect(emptyReason(view!)).toBe("report-missed")
  })

  it("says nothing about the report when the chain has no player row", async () => {
    readChestPinned.mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 })
    const view = await makeSource("ws", engineFor(undefined), { player: PLAYER }).chestView({ gameIndex: 92 })
    expect(view?.reportSent).toBeUndefined()
  })
})
