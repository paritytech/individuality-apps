// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The collectables screen doorway over a fake engine, for the one ordering the page depends
 * on: a collectables screen opened for game N before the pallet settled it.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GameEngine, PalletGame } from "@jollity/protocol"

const readCollectablesPinned = vi.hoisted(() => vi.fn())
vi.mock("./engine", () => ({
  resolveDevEngine: () => null,
  resolveHostEngine: async () => null,
  resolveScarcityChain: async () => ({}),
}))
vi.mock("./scarcity", () => ({ readCollectablesPinned }))

import { makeSource } from "./game-source"
import { READ_ATTEMPT_MS } from "./read-retry"
import { SETTLE_TIMEOUT_MS } from "@individuality/game-outcome"

const PLAYER = "5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw"
const game = (index: number) => ({ index, state: { type: "PlayerProcess" } }) as unknown as PalletGame

afterEach(() => {
  vi.useRealTimers()
})

describe("collectables view works", () => {
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
    readCollectablesPinned.mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 })
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    // until the read after the settle, the only one that asks for the participant
    await vi.waitFor(() => {
      settled = true
      for (const watcher of watchers) watcher(game(93))
      expect(engine.participant).toHaveBeenCalled()
    })
    await view

    // Then
    expect(readCollectablesPinned).toHaveBeenLastCalledWith(expect.anything(), PLAYER, 92, { latestGame: true })
  })
})

const EMPTY = { gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 }
const ARRIVED = {
  ...EMPTY,
  items: [{ hash: "0x01", proof: null, state: "earned", name: "Hare", rarity: "common", image: "", collection: "Sports", choices: [] }],
}

describe("collectables view before the game settles works", () => {
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
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValueOnce(EMPTY).mockResolvedValue(ARRIVED)
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(6_000)
    const opened = await view

    // Then
    expect(opened?.settling).toBe(true)
    expect(opened?.items).toHaveLength(1)
    expect(readCollectablesPinned).toHaveBeenCalledTimes(2)
    expect(readCollectablesPinned).toHaveBeenCalledWith(expect.anything(), PLAYER, 92, { latestGame: true })
    expect(engine.participant).not.toHaveBeenCalled()
    expect(unsubscribed.value).toBe(true)
  })

  it("keeps reading when a read before the settle fails", async () => {
    // Given
    vi.useFakeTimers()
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockRejectedValueOnce(new Error("collections: timeout")).mockResolvedValue(ARRIVED)
    const source = makeSource("ws", openGame({ value: false }), { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
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
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(ARRIVED)
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92, afterSettle: true })
    await vi.advanceTimersByTimeAsync(6_000)
    const before = readCollectablesPinned.mock.calls.length
    current = undefined
    await vi.advanceTimersByTimeAsync(5_000)
    const opened = await view

    // Then
    expect(before).toBe(0)
    expect(opened?.settling).toBeUndefined()
    expect(readCollectablesPinned).toHaveBeenCalledTimes(1)
  })
})

describe("a collectables screen kept up to date through a long settle works", () => {
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
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(ARRIVED)
    const source = makeSource("ws", engine, { player: PLAYER })
    const onItems = vi.fn()
    let done = false

    // When the first wait gives up, then a vote lands, then the game settles
    void source.watchCollectables!({ gameIndex: 92, shown: ["0x01"], onItems, signal: new AbortController().signal }).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 10_000)
    readCollectablesPinned.mockResolvedValue({ ...ARRIVED, items: [...ARRIVED.items, late] })
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

describe("a collectables screen kept up to date before its game settles works", () => {
  it("reads when a vote for the player lands, hands over each new claim once, and stops at the settle", async () => {
    // Given a collectables screen showing 0x01, and 0x02 awarded with a co-player's report
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
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValueOnce(ARRIVED).mockResolvedValue({ ...ARRIVED, items: [...ARRIVED.items, second] })
    const source = makeSource("ws", engine, { player: PLAYER })
    const onItems = vi.fn()

    // When the row is first seen, a block passes, and then a vote moves it
    const done = source.watchCollectables!({ gameIndex: 92, shown: ["0x01"], onItems, signal: new AbortController().signal })
    await vi.advanceTimersByTimeAsync(0)
    for (const row of rows) row({ yes_person: 0 })
    await vi.advanceTimersByTimeAsync(6_000)
    const beforeTheVote = readCollectablesPinned.mock.calls.length
    for (const row of rows) row({ yes_person: 1 })
    await vi.advanceTimersByTimeAsync(0)
    for (const watcher of watchers) watcher(game(93))
    await done

    // Then
    expect(beforeTheVote).toBe(1)
    expect(onItems.mock.calls).toEqual([[[second]]])
    expect(readCollectablesPinned).toHaveBeenCalledTimes(2)
    expect(readCollectablesPinned).toHaveBeenCalledWith(expect.anything(), PLAYER, 92, {
      latestGame: true,
      except: new Set(["0x01", "0x02"]),
    })
    expect(unwatched).toBe(true)
  })
})

describe("collectables view over a silent watch works", () => {
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
    readCollectablesPinned.mockClear()
    readCollectablesPinned.mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 })
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
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
    expect(readCollectablesPinned).toHaveBeenCalledWith(expect.anything(), PLAYER, 92, { latestGame: true })
    expect(unsubscribed).toBe(true)
    expect(reads).toBe(settledReads)
  })
})

describe("collectables view for a game that never settles fails", () => {
  it("shows the collectables screen as unreadable once the wait runs out with nothing arrived, rather than loading for ever", async () => {
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
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(180_000)

    // Then
    expect((await view)?.failed).toMatch(/game 92 has not settled/)
    expect(unsubscribed).toBe(true)
    // only the reads before the settle, which found nothing
    expect(readCollectablesPinned).toHaveBeenCalled()
    for (const call of readCollectablesPinned.mock.calls) expect(call.slice(1)).toEqual([PLAYER, 92, { latestGame: true }])
  })
})

describe("collectables view while co-players are still voting works", () => {
  it("answers a collectables screen with no claims while votes are still out, instead of waiting for the settle", async () => {
    // Given
    vi.useFakeTimers()
    const reporting = { index: 92, state: { type: "Reporting" } } as unknown as PalletGame
    const row = {
      registered: true,
      sent_report: true,
      yes_person: 0,
      no_not_person: 2,
      expected_max_vote_weight: 12,
      early_attendance_enactment: null,
    }
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => reporting,
      watchGame: (cb: (next: PalletGame | undefined) => void) => {
        cb(reporting)
        return () => {}
      },
      watchPlayerRow: (_who: string, cb: (next: unknown) => void) => {
        cb(row)
        return () => {}
      },
      participant: async () => ({ last_attended_game: 91 }),
      player: async () => row,
    } as unknown as GameEngine
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", engine, { player: PLAYER })
    let answered = false

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    void view.then(() => (answered = true))
    await vi.advanceTimersByTimeAsync(6_000)

    // Then
    expect(answered).toBe(true)
    const opened = await view
    expect(opened).toMatchObject({ items: [], voting: true })
    expect(opened?.failed).toBeUndefined()
  })
})

describe("collectables view with an unreadable participant fails", () => {
  it("shows the collectables screen as unreadable after its retries, rather than guessing an older game", async () => {
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
    readCollectablesPinned.mockClear()
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(4_000)

    // Then
    expect((await view)?.failed).toMatch(/People read failed/)
    expect(participant).toHaveBeenCalledTimes(3)
    expect(readCollectablesPinned).not.toHaveBeenCalled()
  })
})

describe("collectables view over a lost answer works", () => {
  it("reads the collectables again when a read never answers, and opens it", async () => {
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
    readCollectablesPinned.mockReset()
    readCollectablesPinned
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 1 })
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(READ_ATTEMPT_MS + 1_000)

    // Then
    const opened = await view
    expect(opened?.failed).toBeUndefined()
    expect(opened?.claimed).toBe(1)
    expect(readCollectablesPinned).toHaveBeenCalledTimes(2)
  })
})

describe("collectables view over answers that never come fails", () => {
  it("aborts a superseded collectables read without starting another attempt", async () => {
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(93),
      watchGame: () => () => {},
      participant: async () => ({ last_attended_game: 92 }),
    } as unknown as GameEngine
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockReturnValue(new Promise(() => {}))
    const source = makeSource("ws", engine, { player: PLAYER })
    const controller = new AbortController()
    const view = source.collectablesView({ gameIndex: 92, signal: controller.signal })
    await vi.waitFor(() => expect(readCollectablesPinned).toHaveBeenCalledTimes(1))

    controller.abort(new Error("newer chest read"))

    await expect(view).rejects.toThrow("newer chest read")
    expect(readCollectablesPinned).toHaveBeenCalledTimes(1)
  })

  it("shows the collectables screen as unreadable once every retry has run out", async () => {
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
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockReturnValue(new Promise(() => {}))
    const source = makeSource("ws", engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(3 * READ_ATTEMPT_MS + 4_000)

    // Then
    expect((await view)?.failed).toMatch(/no answer after 15 seconds/)
    expect(readCollectablesPinned).toHaveBeenCalledTimes(3)
  })
})

describe("collectables seed works", () => {
  it("gives one player the same collectables seed for one game on every device, and a new one for another game or player", async () => {
    // Given
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => game(93),
      watchGame: () => () => {},
      participant: async () => ({ last_attended_game: 92 }),
    } as unknown as GameEngine
    readCollectablesPinned.mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 })
    const other = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"

    // When
    const [phone, desktop, otherGame, otherPlayer] = await Promise.all([
      makeSource("ws", engine, { player: PLAYER }).collectablesView({ gameIndex: 92 }),
      makeSource("ws", engine, { player: PLAYER }).collectablesView({ gameIndex: 92 }),
      makeSource("ws", engine, { player: PLAYER }).collectablesView({ gameIndex: 91 }),
      makeSource("ws", engine, { player: other }).collectablesView({ gameIndex: 92 }),
    ])

    // Then
    expect(desktop?.seed).toBe(phone?.seed)
    expect(otherGame?.seed).not.toBe(phone?.seed)
    expect(otherPlayer?.seed).not.toBe(phone?.seed)
  })
})

describe("collectables view of a player whose report never landed (#303)", () => {
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

  it("carries reportSent false for an empty collectables screen of a game they did not attend, with no URL hint", async () => {
    readCollectablesPinned.mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 })
    const view = await makeSource("ws", engineFor({ sent_report: false }), { player: PLAYER }).collectablesView({ gameIndex: 92 })
    expect(view?.attended).toBe(false)
    expect(view?.reportSent).toBe(false)
    const { emptyReason } = await import("./collectables-reason")
    expect(emptyReason(view!)).toBe("report-missed")
  })

  it("says nothing about the report when the chain has no player row", async () => {
    readCollectablesPinned.mockResolvedValue({ gameIndex: 92, items: [], unprovable: 0, pending: 0, claimed: 0 })
    const view = await makeSource("ws", engineFor(undefined), { player: PLAYER }).collectablesView({ gameIndex: 92 })
    expect(view?.reportSent).toBeUndefined()
  })
})

describe("collectables view while co-players vote on the player works", () => {
  const REPORTING = { index: 92, state: { type: "Reporting" } } as unknown as PalletGame
  const RESET = {
    registered: false,
    sent_report: false,
    yes_person: 0,
    no_not_person: 0,
    expected_max_vote_weight: 0,
    early_attendance_enactment: null,
  }
  const votedOn = (votes: { sent_report?: boolean; yes_person?: number; no_not_person: number; expected_max_vote_weight: number }) => ({
    registered: true,
    sent_report: true,
    yes_person: 0,
    early_attendance_enactment: null,
    ...votes,
  })
  const votingGame = (first: Record<string, unknown>, options?: { quiet?: boolean; onRowStop?: () => void }) => {
    let current: PalletGame | undefined = REPORTING
    let row: Record<string, unknown> = first
    const games = new Set<(next: PalletGame | undefined) => void>()
    const rows = new Set<(next: unknown) => void>()
    const stopped = { games: 0, rows: 0 }
    const engine = {
      kind: "chain",
      now: async () => 1_700_000_000,
      watchNow: () => () => {},
      game: async () => current,
      watchGame: (cb: (next: PalletGame | undefined) => void) => {
        games.add(cb)
        cb(current)
        return () => {
          stopped.games += 1
          games.delete(cb)
        }
      },
      watchPlayerRow: (_who: string, cb: (next: unknown) => void) => {
        rows.add(cb)
        if (!options?.quiet) cb(row)
        return () => {
          stopped.rows += 1
          rows.delete(cb)
          options?.onRowStop?.()
        }
      },
      participant: async () => ({ last_attended_game: 91 }),
      player: async () => row,
    } as unknown as GameEngine
    return {
      engine,
      stopped,
      watching: () => rows.size,
      moveRow: (next: Record<string, unknown>) => {
        row = next
        for (const cb of [...rows]) cb(next)
      },
      moveRowForFirstWatch: (next: Record<string, unknown>) => {
        row = next
        ;[...rows][0]?.(next)
      },
      settle: () => {
        current = { index: 93, state: { type: "Registration" } } as unknown as PalletGame
        for (const cb of [...games]) cb(current)
      },
    }
  }
  const opening = (view: Promise<unknown>) => {
    const state = { answered: false }
    void view.then(() => (state.answered = true))
    return state
  }

  it("says the collectables screen is empty for good once every vote is in and none was Person", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ no_not_person: 10, expected_max_vote_weight: 10 }))
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(6_000)
    const opened = await view

    // Then
    expect(opened).toMatchObject({ items: [], verdict: "failed", reportSent: true, attended: false })
    expect(opened?.voting).toBeUndefined()
    expect(opened?.settling).toBeUndefined()
  })

  it("keeps waiting on a failed verdict while votes are still out", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ no_not_person: 4, expected_max_vote_weight: 6 }))
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(6_000)
    const opened = await view

    // Then
    expect(opened).toMatchObject({ items: [], voting: true })
    expect(opened?.verdict).toBeUndefined()
  })

  it("does not answer voting on a read with claims not readable yet", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ no_not_person: 2, expected_max_vote_weight: 10 }))
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValueOnce({ ...EMPTY, pending: 1 }).mockResolvedValueOnce({ ...EMPTY, partial: true }).mockResolvedValue(ARRIVED)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    const state = opening(view)
    await vi.advanceTimersByTimeAsync(6_000)
    const early = state.answered
    chain.moveRow(votedOn({ no_not_person: 2, expected_max_vote_weight: 10, yes_person: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    chain.moveRow(votedOn({ no_not_person: 2, expected_max_vote_weight: 10, yes_person: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    const opened = await view

    // Then
    expect(early).toBe(false)
    expect(opened).toMatchObject({ settling: true })
    expect(opened?.voting).toBeUndefined()
  })

  it("holds while voting until a claim lands", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ no_not_person: 2, expected_max_vote_weight: 10 }))
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92, holdWhileVoting: true })
    const state = opening(view)
    await vi.advanceTimersByTimeAsync(6_000)
    const early = state.answered
    readCollectablesPinned.mockResolvedValue(ARRIVED)
    chain.moveRow(votedOn({ no_not_person: 2, expected_max_vote_weight: 10, yes_person: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    const opened = await view

    // Then
    expect(early).toBe(false)
    expect(opened).toMatchObject({ settling: true })
    expect(opened?.items).toHaveLength(1)
  })

  it("holds while voting until the last vote, then says the collectables screen is empty for good", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ no_not_person: 2, expected_max_vote_weight: 10 }))
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92, holdWhileVoting: true })
    const state = opening(view)
    await vi.advanceTimersByTimeAsync(6_000)
    const early = state.answered
    chain.moveRow(votedOn({ no_not_person: 10, expected_max_vote_weight: 10 }))
    await vi.advanceTimersByTimeAsync(0)
    const opened = await view

    // Then
    expect(early).toBe(false)
    expect(opened).toMatchObject({ items: [], verdict: "failed", reportSent: true })
    expect(chain.watching()).toBe(0)
  })

  it("says the votes went against a player whose co-players never finished voting, once the game settles", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ no_not_person: 2, expected_max_vote_weight: 12 }))
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92, holdWhileVoting: true })
    await vi.advanceTimersByTimeAsync(6_000)
    chain.moveRow(RESET)
    chain.settle()
    await vi.advanceTimersByTimeAsync(6_000)
    const opened = await view

    // Then
    expect(opened).toMatchObject({ items: [], verdict: "failed", reportSent: true })
    expect(opened?.failed).toBeUndefined()
  })

  it("keeps the settled reason for a player who never reported", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ sent_report: false, no_not_person: 2, expected_max_vote_weight: 12 }))
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92, holdWhileVoting: true })
    await vi.advanceTimersByTimeAsync(6_000)
    chain.moveRow(RESET)
    chain.settle()
    await vi.advanceTimersByTimeAsync(6_000)
    const opened = await view

    // Then
    expect(opened).toMatchObject({ items: [], reportSent: false })
    expect(opened?.verdict).toBeUndefined()
  })
  it("holds while voting past one settle wait", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ no_not_person: 2, expected_max_vote_weight: 12 }))
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const state = opening(source.collectablesView({ gameIndex: 92, holdWhileVoting: true }))
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 1_000)

    // Then
    expect(state.answered).toBe(false)
  })

  it("says the votes went against the player when the settle comes after a long hold", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ no_not_person: 2, expected_max_vote_weight: 12 }))
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92, holdWhileVoting: true })
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS + 1_000)
    chain.moveRow(RESET)
    chain.settle()
    await vi.advanceTimersByTimeAsync(6_000)
    const opened = await view

    // Then
    expect(opened).toMatchObject({ items: [], verdict: "failed", reportSent: true })
    expect(opened?.failed).toBeUndefined()
  })

  it("keeps reading when a Person vote is in and the claim is not read yet", async () => {
    // Given
    vi.useFakeTimers()
    const voted = votedOn({ yes_person: 1, no_not_person: 5, expected_max_vote_weight: 6 })
    const chain = votingGame(voted)
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    const state = opening(view)
    await vi.advanceTimersByTimeAsync(6_000)
    const early = state.answered
    readCollectablesPinned.mockResolvedValue(ARRIVED)
    chain.moveRow({ ...voted })
    await vi.advanceTimersByTimeAsync(0)
    const opened = await view

    // Then
    expect(early).toBe(false)
    expect(opened).toMatchObject({ settling: true })
    expect(opened?.items).toHaveLength(1)
  })

  it("answers voting when the votes arrive after the first read", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ no_not_person: 2, expected_max_vote_weight: 12 }), { quiet: true })
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    const state = opening(view)
    await vi.advanceTimersByTimeAsync(100)
    const early = state.answered
    chain.moveRow(votedOn({ no_not_person: 2, expected_max_vote_weight: 12 }))
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(early).toBe(false)
    expect(state.answered).toBe(true)
    expect(await view).toMatchObject({ items: [], voting: true })
  })

  it("says the collectables screen is empty for good when the last vote lands after the read", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ no_not_person: 2, expected_max_vote_weight: 12 }), { quiet: true })
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92, holdWhileVoting: true })
    const state = opening(view)
    await vi.advanceTimersByTimeAsync(100)
    chain.moveRow(votedOn({ no_not_person: 2, expected_max_vote_weight: 12 }))
    await vi.advanceTimersByTimeAsync(100)
    const early = state.answered
    chain.moveRowForFirstWatch(votedOn({ no_not_person: 12, expected_max_vote_weight: 12 }))
    await vi.advanceTimersByTimeAsync(0)

    // Then
    expect(early).toBe(false)
    expect(state.answered).toBe(true)
    expect(await view).toMatchObject({ items: [], verdict: "failed", reportSent: true })
  })

  it("keeps the settled reason for a player who would close attended", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ no_not_person: 0, expected_max_vote_weight: 12 }))
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92, holdWhileVoting: true })
    await vi.advanceTimersByTimeAsync(6_000)
    chain.moveRow(RESET)
    chain.settle()
    await vi.advanceTimersByTimeAsync(6_000)
    const opened = await view

    // Then
    expect(opened).toMatchObject({ items: [] })
    expect(opened?.verdict).toBeUndefined()
  })

  it("waits for the settle when every vote is in and the player did not fail", async () => {
    // Given
    vi.useFakeTimers()
    const chain = votingGame(votedOn({ yes_person: 0, no_not_person: 0, expected_max_vote_weight: 0 }))
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const state = opening(source.collectablesView({ gameIndex: 92 }))
    await vi.advanceTimersByTimeAsync(6_000)

    // Then
    expect(state.answered).toBe(false)
  })
  it("answers voting when the game settles as the read that found the votes out returns", async () => {
    // Given
    vi.useFakeTimers()
    let settleOnStop = true
    const chain = votingGame(votedOn({ no_not_person: 2, expected_max_vote_weight: 12 }), {
      onRowStop: () => {
        if (!settleOnStop) return
        settleOnStop = false
        chain.moveRow(RESET)
        chain.settle()
      },
    })
    readCollectablesPinned.mockReset()
    readCollectablesPinned.mockResolvedValue(EMPTY)
    const source = makeSource("ws", chain.engine, { player: PLAYER })

    // When
    const view = source.collectablesView({ gameIndex: 92 })
    await vi.advanceTimersByTimeAsync(0)
    const opened = await view

    // Then
    expect(opened).toMatchObject({ items: [], voting: true })
    expect(opened?.settling).toBeUndefined()
  })
})
