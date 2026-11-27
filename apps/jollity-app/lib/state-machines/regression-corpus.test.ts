// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { calculateSnapshot, hostSeat } from "@jollity/game-chain/game"
import type { GameTimingInfo } from "@jollity/game-chain"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PlayerId } from "../game-source"
import { voteForRound } from "../round-vote"
import type { StoredVotes } from "../game-votes"
import { payoffHandedOff, reportLanded, resetGameTraceForTests } from "../journeys/game-trace"
import { createPayoffScreenRunner, executeCollectablesCommands, type CollectablesCommandHandlers } from "../payoff-screen-runner"
import { resetPayoffSessionsForTest } from "../payoff-session"
import { journeysNamed, recorded, resetRecorded } from "../telemetry/testing"
import type { TurnVotes } from "../game-roster"
import {
  castTap,
  emptyTurnBooks,
  remountClockState,
  restoreBooks,
  tickBooks,
  type TurnBooks,
  type TurnWorld,
} from "../turn-books"
import { markVideoRoleSeen } from "../video-role-history"

vi.mock("../telemetry", async () => (await import("../telemetry/testing")).fakeTelemetryModule())

/**
 * Named, deterministic reproductions promoted from the step 0/1 review and
 * the formal runs. These are deliberately sequence bodies, not copies of the
 * formal/model harnesses. `it.fails` means the named issue is still open: a
 * fix makes CI fail until the case is converted into a permanent regression.
 */
describe("state-machine regression corpus", () => {
  const G = 1_000_000
  const STRIDE = 4
  const timing: GameTimingInfo = { gameDate: G, reportEnds: G + 200, rounds: 2, maxGroupSize: STRIDE }
  const ME = "me"
  const B = "bob"
  const C = "carol"
  const D = "dave"
  const seats: PlayerId[][] = [
    [ME, B, C, D],
    [C, ME, D, B],
  ]

  const candidates = (round: number, roundTurn: number): PlayerId[] =>
    seats[round].filter((id, seat) => seat !== hostSeat(roundTurn, seats[round].length) && id !== ME)
  const world = (books: TurnBooks, renderedVotes: TurnVotes = books.turnVotes, banned = books.banned): TurnWorld => ({
    stride: STRIDE,
    candidates,
    host: (round, roundTurn) => seats[round][hostSeat(roundTurn, seats[round].length)] ?? "none",
    banned,
    renderedVotes,
  })
  const tick = (
    books: TurnBooks,
    at: number,
    options: { coldStartedAt?: number; restorePending?: boolean; viaDoor?: boolean; renderedVotes?: TurnVotes; banned?: ReadonlySet<PlayerId> } = {},
  ): TurnBooks =>
    tickBooks(
      books,
      calculateSnapshot(at, timing),
      {
        timing,
        state: { ready: true, coldStartedAt: options.coldStartedAt },
        restorePending: options.restorePending ?? false,
        frozeAway: false,
        chainSeen: () => true,
        viaDoor: () => options.viaDoor ?? false,
      },
      world(books, options.renderedVotes, options.banned),
    ).books
  const stored = (books: TurnBooks): StoredVotes => ({
    gameIndex: 7,
    account: ME,
    turnVotes: books.turnVotes,
    banned: [...books.banned],
    overrides: {},
    autoSeals: books.autoSeals,
    firstOpenedTurn: books.firstOpenedTurn,
    videoRoleHistory: books.videoRoleHistory,
  })
  const seenFromZero = { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } }

  it("#1178: a ready relaunch before coldStartedAt still seals every missed turn", () => {
    let books: TurnBooks = { ...emptyTurnBooks(), videoRoleHistory: seenFromZero }
    books = tick(books, G + 40, { viaDoor: true })
    books = tick(books, G + 40.5, { viaDoor: true })
    books = tick(books, G + 41, { coldStartedAt: G + 40, viaDoor: true })
    books = tick(books, G + 53, { coldStartedAt: G + 40, viaDoor: true })
    expect([...books.sealed]).toEqual(expect.arrayContaining([0, 1, 2]))
  })

  it("#1470: a warm-clock remount preserves its first tick through restore", () => {
    const savedBooks: TurnBooks = {
      ...emptyTurnBooks(),
      autoSeals: { 0: [B, C] },
      firstOpenedTurn: 0,
      videoRoleHistory: seenFromZero,
    }
    const at = G + 39
    const snapshot = calculateSnapshot(at, timing)
    let books = emptyTurnBooks()
    let clockState = remountClockState(undefined, { ready: true }, snapshot, at, books.restoredFirstOpenedTurn)
    const boundary = clockState.boundarySecond
    books = tickBooks(books, snapshot, {
      timing,
      state: clockState.state,
      restorePending: false,
      frozeAway: false,
      chainSeen: () => true,
      viaDoor: () => false,
    }, world(books)).books
    books = restoreBooks(books, stored(savedBooks), false).books
    clockState = remountClockState(boundary, { ready: true }, snapshot, at + 0.5, books.restoredFirstOpenedTurn)
    books = tickBooks(books, snapshot, {
      timing,
      state: clockState.state,
      restorePending: false,
      frozeAway: false,
      chainSeen: () => true,
      viaDoor: () => false,
    }, world(books)).books

    expect([...books.sealed]).toEqual([0, 1, 2])
  })

  it.each([
    { where: "between rounds", load: G + 40, gapAt: G + 50, missed: [0, 1, 2] },
    { where: "in reporting", load: G + 100, gapAt: G + 105, missed: [0, 1, 2, 3, 4, 5, 6] },
  ])(
    "#1178: a ready relaunch whose load turn ends $where before coldStartedAt still seals earlier missed turns",
    ({ load, gapAt, missed }) => {
      let books: TurnBooks = { ...emptyTurnBooks(), videoRoleHistory: seenFromZero }
      books = tick(books, load, { viaDoor: true })
      books = tick(books, gapAt, { viaDoor: true })
      books = tick(books, gapAt + 0.5, { coldStartedAt: load, viaDoor: true })
      expect([...books.sealed]).toEqual(expect.arrayContaining(missed))
    },
  )

  it.fails("#1183 F1 — issue: render-lag auto classification; reason: a last-second Person tap must not be counted as an auto-seal", () => {
    let books: TurnBooks = { ...emptyTurnBooks(), videoRoleHistory: { [B]: { fromTurn: 0 } } }
    books = tick(books, G)
    const beforeTapRender = books.turnVotes
    books = castTap(books, 0, 0, B, "person").books
    books = tick(books, G + 12, { renderedVotes: beforeTapRender })
    expect(books.turnVotes[0]?.[B]).toBe("person")
    expect(books.autoSeals[0] ?? []).not.toContain(B)
  })

  it.fails("#1183 F2 — issue: pending observation replay; reason: a cold-frame boundary must bind to load turn 3, never replayed turn 0", () => {
    let first: TurnBooks = { ...emptyTurnBooks(), videoRoleHistory: { [B]: { fromTurn: 0 } } }
    first = tick(first, G)
    first = tick(first, G + 17)
    const saved = stored(first)

    let books = emptyTurnBooks()
    books = { ...books, videoRoleHistory: markVideoRoleSeen(books.videoRoleHistory, C, null).history }
    books = restoreBooks(books, saved, false).books
    books = tick(books, G + 37, { coldStartedAt: G + 37, viaDoor: true })
    expect(books.videoRoleHistory[C]).toEqual({ fromTurn: 3 })
    expect(books.turnVotes[1]?.[C]).toBeUndefined()
    expect(books.turnVotes[2]?.[C]).toBeUndefined()
  })

  describe("#1183 F3/F4 payoff session continuity", () => {
    beforeEach(() => {
      resetPayoffSessionsForTest()
      resetRecorded()
      resetGameTraceForTests()
    })

    it("F3: a collectables screen stall remains the final outcome when the hand-off ends the same payoff", () => {
      const collectables = createPayoffScreenRunner(71, "/collectables")
      collectables.send({ type: "payoff-stalled", stage: "chest.load" })
      collectables.send({ type: "collectables-result" })
      expect(collectables.send({ type: "collectables-continue" })).toEqual([
        { kind: "end-payoff", outcome: "stalled", cause: "handed-off", sendGameLog: true },
        { kind: "hand-off" },
      ])
    })

    it("F4: a fresh collectables screen session cannot end or log the already-closed payoff journey twice", () => {
      reportLanded(72)
      const handlers: CollectablesCommandHandlers = {
        collectablesOpened: () => {},
        collectablesShown: () => {},
        payoffStalled: () => {},
        payoffEnded: payoffHandedOff,
        handOff: () => {},
        loadCollectables: () => {},
      }
      const first = createPayoffScreenRunner(72, "/collectables")
      first.send({ type: "collectables-result" })
      const firstEnd = first.send({ type: "collectables-continue" })
      expect(firstEnd).toHaveLength(2)
      executeCollectablesCommands(firstEnd, handlers)

      const again = createPayoffScreenRunner(72, "/collectables")
      again.send({ type: "collectables-result" })
      const secondEnd = again.send({ type: "collectables-continue" })
      expect(secondEnd).toHaveLength(2)
      executeCollectablesCommands(secondEnd, handlers)

      expect(journeysNamed("payoff")).toHaveLength(1)
      expect(journeysNamed("payoff")[0]).toMatchObject({ ended: true, outcome: "shown" })
      expect(recorded.gameLogs.map((request) => request.stage)).toEqual(["report", "payoff"])
    })
  })

  it("#1199: same-document draw/collectables re-entry has a live Continue after the prior payoff ended", () => {
    resetPayoffSessionsForTest()
    const first = createPayoffScreenRunner(73, "/collectables")
    first.send({ type: "collectables-result" })
    first.send({ type: "collectables-continue" })
    const revisit = createPayoffScreenRunner(73, "/collectables")
    revisit.send({ type: "collectables-result" })
    expect(revisit.send({ type: "collectables-continue" })).toEqual([
      { kind: "end-payoff", outcome: "shown", cause: "handed-off", sendGameLog: true },
      { kind: "hand-off" },
    ])
  })

  it("#1223: the real round-vote command rejects frozen evidence but preserves #569 replay votes", () => {
    let books: TurnBooks = { ...emptyTurnBooks(), videoRoleHistory: seenFromZero }
    books = tick(books, G)
    books = tick(books, G + 13)
    expect(books.sealed.has(0)).toBe(true)
    const event = { turn: 0, round: 0, id: B, verdict: "person" as const }

    const replayBeforeConfirm = voteForRound(books, false, event, world(books))
    expect(replayBeforeConfirm.accepted).toBe(true)
    expect(replayBeforeConfirm.books.turnVotes[0]?.[B]).toBe("person")

    const replayAfterConfirm = voteForRound(books, true, event, world(books))
    expect(replayAfterConfirm.accepted).toBe(false)
    expect(replayAfterConfirm.books).toBe(books)
    expect(replayAfterConfirm.books.turnVotes[0]?.[B]).toBe("notperson")
  })

  it("formal lane-b P1 — a read released near the boundary does not leave turn 0 unsealed", () => {
    const savedBooks: TurnBooks = {
      ...emptyTurnBooks(),
      turnVotes: { 0: { [B]: "person" } },
      videoRoleHistory: seenFromZero,
      firstOpenedTurn: 0,
    }
    let books = tick(emptyTurnBooks(), G + 8.6, { coldStartedAt: G + 8.6, restorePending: true, viaDoor: true })
    books = tick(books, G + 11.6, { coldStartedAt: G + 8.6, viaDoor: true })
    books = restoreBooks(books, stored(savedBooks), true).books
    // The read lands at G+11.9. Its firstOpenedTurn matches the local value,
    // so React does not re-arm the tick; the next interval is already turn 1.
    books = tick(books, G + 12.1, { coldStartedAt: G + 8.6, viaDoor: true })
    books = tick(books, G + 30, { coldStartedAt: G + 8.6, viaDoor: true })
    expect(books.sealed.has(0)).toBe(true)
  })

  it("B3: a late joiner's slow restore cannot lose an attended turn across a throttled tick", () => {
    let books = tick(emptyTurnBooks(), G + 8, { coldStartedAt: G + 8, restorePending: true })
    books = tick(books, G + 11, { coldStartedAt: G + 8 })
    books = { ...books, videoRoleHistory: seenFromZero }

    // The empty stored read answers in turn 1 after the three-second release.
    books = restoreBooks(books, null, true).books
    // The next interval is throttled until turn 2, after turn 1 has ended.
    books = tick(books, G + 25, { coldStartedAt: G + 8 })

    expect(books.sealed.has(1)).toBe(true)
    expect(books.turnVotes[1]?.[C]).toBe("notperson")
    expect(books.turnVotes[1]?.[D]).toBe("notperson")
  })

  it("formal lane-b gap 1 — issue: backward step over T-0; reason: freeze recovery must seal missed turns 0 and 1", () => {
    let books = tick(emptyTurnBooks(), G + 2)
    books = tick(books, G - 5)
    books = tick(books, G + 25)
    expect(books.sealed.has(0) && books.sealed.has(1)).toBe(true)
  })

  it("formal lane-b gap 3 — issue: late-join backward replay; reason: a pre-load turn must remain verdict-free", () => {
    let books = tick(emptyTurnBooks(), G + 13, { coldStartedAt: G + 13 })
    books = tick(books, G + 5, { coldStartedAt: G + 13 })
    books = { ...books, videoRoleHistory: markVideoRoleSeen(books.videoRoleHistory, B, 0).history }
    books = tick(books, G + 14, { coldStartedAt: G + 13 })
    expect(books.turnVotes[0] ?? {}).toEqual({})
  })

  it("archive#1504 — issue: restored firstOpenedTurn floor; reason: a warm page seals from the first turn it opened itself, not the merged stored one", () => {
    let books: TurnBooks = { ...emptyTurnBooks(), videoRoleHistory: seenFromZero }
    books = tick(books, G + 57)
    books = restoreBooks(books, stored({ ...emptyTurnBooks(), autoSeals: { 0: [] }, firstOpenedTurn: 0, videoRoleHistory: seenFromZero }), false).books
    books = tick(books, G + 50)
    books = tick(books, G + 80)
    expect([...books.sealed].sort((a, b) => a - b)).toEqual([0, 4, 5])
    for (const turn of [1, 2, 3]) expect(books.turnVotes[turn] ?? {}).toEqual({})
  })

  it("archive#1504 — issue: restored floor via an in-turn backward step; reason: a page that opened turn 4 never seals below it", () => {
    for (const before of [[G + 57], [G + 57, G + 69]]) {
      let books: TurnBooks = { ...emptyTurnBooks(), videoRoleHistory: seenFromZero }
      for (const at of before) books = tick(books, at)
      books = restoreBooks(books, stored({ ...emptyTurnBooks(), autoSeals: { 0: [] }, firstOpenedTurn: 0, videoRoleHistory: seenFromZero }), false).books
      books = tick(books, G + 30)
      books = tick(books, G + 80)
      expect([...books.sealed].sort((a, b) => a - b), `ticks ${before.join(",")}`).toEqual([0, 4, 5])
      for (const turn of [1, 2, 3]) expect(books.turnVotes[turn] ?? {}).toEqual({})
    }
  })

  it.fails("formal lane-b gap 4 — issue: prompt-restore ban lag; reason: a stored ban is deliberate and must never enter autoSeals", () => {
    const savedBooks: TurnBooks = {
      ...emptyTurnBooks(),
      banned: new Set([C]),
      firstOpenedTurn: 0,
      videoRoleHistory: seenFromZero,
    }
    let books = restoreBooks(emptyTurnBooks(), stored(savedBooks), false).books
    books = tick(books, G + 40, { coldStartedAt: G + 40, banned: new Set() })
    for (const turn of [0, 1, 2]) expect(books.autoSeals[turn] ?? []).not.toContain(C)
  })
})
