// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  CONNECTION_STAGE_DURATION,
  DIAL_ENDS_BEFORE,
  PRE_CONNECTION_TIME,
  ROUND_GAP,
  WAITING_ROOM_AVAILABLE_BEFORE,
} from "./constants"
import {
  calculateSnapshot,
  gameDuration,
  hostSeat,
  roundDuration,
  roundStart,
  turnsInRound,
  turnsPerRound,
  type GameTimingInfo,
} from "./stateMachine"

describe("calculateSnapshot", () => {
  // a cap of 3 -> 3 seats x 12s = 36s per round, 2 rounds + one 7s gap = 79s
  const info: GameTimingInfo = {
    gameDate: 1000,
    reportEnds: 2000,
    rounds: 2,
    maxGroupSize: 3,
  }

  it("computes durations", () => {
    expect(roundDuration(info)).toBe(36)
    expect(gameDuration(info)).toBe(79)
    expect(roundStart(info, 0)).toBe(0)
    expect(roundStart(info, 1)).toBe(43)
    expect(gameDuration({ ...info, rounds: 1 })).toBe(36)
    expect(gameDuration({ ...info, rounds: 0 })).toBe(0)
  })

  it("walks idle -> waiting room -> preconnect -> round 0", () => {
    const lead = WAITING_ROOM_AVAILABLE_BEFORE
    expect(calculateSnapshot(1000 - lead - 1, info).kind).toBe("idle")
    expect(calculateSnapshot(1000 - lead, info)).toEqual({
      kind: "waiting-room",
      secondsToStart: lead,
      preconnectRound: null,
    })
    // round 0 pre-connects for the whole connection stage, which opens
    // inside the waiting room
    expect(calculateSnapshot(1000 - CONNECTION_STAGE_DURATION - 1, info)).toEqual({
      kind: "waiting-room",
      secondsToStart: CONNECTION_STAGE_DURATION + 1,
      preconnectRound: null,
    })
    expect(calculateSnapshot(1000 - CONNECTION_STAGE_DURATION, info)).toEqual({
      kind: "waiting-room",
      secondsToStart: CONNECTION_STAGE_DURATION,
      preconnectRound: 0,
    })
  })

  it("starts the round-0 preconnect at T-64", () => {
    expect(DIAL_ENDS_BEFORE).toBe(3)
    expect(CONNECTION_STAGE_DURATION).toBe(64)
    expect(calculateSnapshot(1000 - 64, info)).toMatchObject({ preconnectRound: 0 })
    expect(calculateSnapshot(1000 - 64.5, info)).toMatchObject({ preconnectRound: null })
  })

  it("leaves a ROUND_GAP between two rounds", () => {
    // round 0 ends at t=36, round 1 starts at t=43
    expect(ROUND_GAP).toBe(7)
    expect(calculateSnapshot(1036, info)).toEqual({
      kind: "between-rounds",
      nextRound: 1,
      secondsToNextRound: 7,
      gapDuration: 7,
      preconnectRound: 1,
    })
    expect(calculateSnapshot(1039.5, info)).toMatchObject({
      kind: "between-rounds",
      secondsToNextRound: 3.5,
    })
    expect(calculateSnapshot(1042, info)).toMatchObject({
      kind: "between-rounds",
      secondsToNextRound: 1,
    })
    // the first second after the gap is round 1, turn 0, introduction
    expect(calculateSnapshot(1043, info)).toMatchObject({
      kind: "round",
      round: 1,
      hostPosition: 0,
      stage: "introduction",
      stageRemaining: 2,
      turnElapsed: 0,
    })
  })

  it("computes host rotation and stages within a round", () => {
    // t=0: round 0, host 0, introduction (2s)
    expect(calculateSnapshot(1000, info)).toMatchObject({
      kind: "round",
      round: 0,
      hostPosition: 0,
      stage: "introduction",
      stageRemaining: 2,
    })
    // t=2..10: gameplay (8s)
    expect(calculateSnapshot(1002, info)).toMatchObject({
      stage: "gameplay",
      stageRemaining: 8,
    })
    // t=10..12: ending
    expect(calculateSnapshot(1011, info)).toMatchObject({
      stage: "ending",
      stageRemaining: 1,
    })
    // t=12: host 1 introduction
    expect(calculateSnapshot(1012, info)).toMatchObject({
      hostPosition: 1,
      stage: "introduction",
    })
    // t=35: last second of round 0, host 2 ending
    expect(calculateSnapshot(1035, info)).toMatchObject({
      round: 0,
      hostPosition: 2,
      stage: "ending",
    })
  })

  it("preconnects the next round PRE_CONNECTION_TIME before it starts", () => {
    // round 0 ends at t=36
    const preconnectAt = 1000 + 36 - PRE_CONNECTION_TIME
    expect(calculateSnapshot(preconnectAt - 1, info)).toMatchObject({
      round: 0,
      preconnectRound: null,
    })
    expect(calculateSnapshot(preconnectAt, info)).toMatchObject({
      round: 0,
      preconnectRound: 1,
    })
    // no round 2 exists — nothing to preconnect at the end of round 1
    expect(calculateSnapshot(preconnectAt + 36 + ROUND_GAP, info)).toMatchObject({
      round: 1,
      preconnectRound: null,
    })
  })

  it("transitions to reporting after the last round, then finished", () => {
    // the last round has no gap after it
    expect(calculateSnapshot(1078, info)).toMatchObject({ kind: "round", round: 1, hostPosition: 2 })
    expect(calculateSnapshot(1079, info)).toEqual({
      kind: "reporting",
      secondsToReportEnd: 921,
    })
    expect(calculateSnapshot(2000, info)).toEqual({ kind: "finished" })
  })

  it("reports the stage duration alongside the remaining time", () => {
    expect(calculateSnapshot(1000, info)).toMatchObject({
      stage: "introduction",
      stageDuration: 2,
    })
    expect(calculateSnapshot(1002, info)).toMatchObject({
      stage: "gameplay",
      stageDuration: 8,
    })
    expect(calculateSnapshot(1011, info)).toMatchObject({
      stage: "ending",
      stageDuration: 2,
    })
  })

  it("lists the turns per round from the group cap", () => {
    // the cap is the turn count, whatever the sign-up count is
    const base: GameTimingInfo = {
      gameDate: 1000,
      reportEnds: 2000,
      rounds: 2,
      maxGroupSize: 6,
    }
    expect(turnsInRound(base)).toBe(6)
    expect(turnsPerRound(base)).toEqual([6, 6])
    expect(turnsPerRound({ ...base, rounds: 3 })).toEqual([6, 6, 6])
    expect(turnsPerRound({ ...base, rounds: 0 })).toEqual([])
    expect(turnsPerRound({ ...base, maxGroupSize: 2 })).toEqual([2, 2])
    // the per-round value is what the snapshot reports for that round
    expect(calculateSnapshot(1079, base)).toMatchObject({ round: 1, turnsThisRound: 6 })
  })

  it("reports the turn count, the turn length and the time inside the turn", () => {
    // a cap of 6 -> 6 turns x 12s = 72s rounds, whether 6 players signed up
    // or 4. A group of 4 wraps back to its first two seats (hostSeat).
    const six: GameTimingInfo = {
      gameDate: 1000,
      reportEnds: 3000,
      rounds: 2,
      maxGroupSize: 6,
    }
    expect(roundDuration(six)).toBe(72)
    // 72 + 7 + 72
    expect(gameDuration(six)).toBe(151)
    expect(calculateSnapshot(1000, six)).toMatchObject({
      round: 0,
      hostPosition: 0,
      turnsThisRound: 6,
      turnDuration: 12,
      turnElapsed: 0,
    })
    // t=54: turn 4, 6s in. A group of 4 has no seat 4: seat 0 hosts it
    expect(calculateSnapshot(1054, six)).toMatchObject({
      round: 0,
      hostPosition: 4,
      turnsThisRound: 6,
      turnDuration: 12,
      turnElapsed: 6,
    })
    // t=71: the last second of the last seat's turn
    expect(calculateSnapshot(1071, six)).toMatchObject({
      round: 0,
      hostPosition: 5,
      stage: "ending",
      turnElapsed: 11,
    })
    // t=72..79: the gap. t=79: round 1 starts on seat 0 with the clock reset
    expect(calculateSnapshot(1072, six)).toMatchObject({ kind: "between-rounds", nextRound: 1 })
    expect(calculateSnapshot(1079, six)).toMatchObject({
      round: 1,
      hostPosition: 0,
      turnElapsed: 0,
    })
  })

  it("follows a smaller group cap", () => {
    // a game scheduled with a cap of 2 plays two turns a round
    const two: GameTimingInfo = {
      gameDate: 1000,
      reportEnds: 2000,
      rounds: 2,
      maxGroupSize: 2,
    }
    expect(roundDuration(two)).toBe(24)
    expect(calculateSnapshot(1000, two)).toMatchObject({
      round: 0,
      hostPosition: 0,
      turnsThisRound: 2,
      turnDuration: 12,
    })
    expect(calculateSnapshot(1023, two)).toMatchObject({
      round: 0,
      hostPosition: 1,
      stage: "ending",
    })
    expect(calculateSnapshot(1024, two)).toMatchObject({ kind: "between-rounds" })
    expect(calculateSnapshot(1031, two)).toMatchObject({
      round: 1,
      hostPosition: 0,
    })
  })
})

describe("hostSeat", () => {
  /** who hosts each turn of one round, and how many turns each seat hosts */
  const hosts = (turns: number, groupSize: number) => Array.from({ length: turns }, (_, turn) => hostSeat(turn, groupSize))
  const counts = (seats: number[], groupSize: number) =>
    Array.from({ length: groupSize }, (_, seat) => seats.filter((host) => host === seat).length)

  it("gives every turn of a cap-6 round a player host, for every group size from 2 to 6", () => {
    const table: Record<number, { order: number[]; hosted: number[] }> = {
      2: { order: [0, 1, 0, 1, 0, 1], hosted: [3, 3] },
      3: { order: [0, 1, 2, 0, 1, 2], hosted: [2, 2, 2] },
      // A B C D A B: the two extra turns fall on the lowest seats
      4: { order: [0, 1, 2, 3, 0, 1], hosted: [2, 2, 1, 1] },
      5: { order: [0, 1, 2, 3, 4, 0], hosted: [2, 1, 1, 1, 1] },
      6: { order: [0, 1, 2, 3, 4, 5], hosted: [1, 1, 1, 1, 1, 1] },
    }
    for (const [size, { order, hosted }] of Object.entries(table)) {
      const n = Number(size)
      const seats = hosts(6, n)
      expect(seats, `group of ${n}`).toEqual(order)
      expect(counts(seats, n), `group of ${n}`).toEqual(hosted)
      // every host is an occupied seat (0..n-1), never an empty chair
      expect(seats.every((seat) => seat >= 0 && seat < n), `group of ${n}`).toBe(true)
    }
  })

  it("leaves a group of one as it was: the player hosts turn 0, the empty chairs the rest", () => {
    // the solo case has its own screen; one player never hosts every turn
    expect(hosts(6, 1)).toEqual([0, 1, 2, 3, 4, 5])
    expect(hosts(6, 0)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("never hands a turn to the seat that hosted the turn before", () => {
    for (let cap = 2; cap <= 10; cap++)
      for (let n = 2; n <= cap; n++) {
        const seats = hosts(cap, n)
        for (let turn = 1; turn < cap; turn++) expect(seats[turn], `cap ${cap}, group of ${n}, turn ${turn}`).not.toBe(seats[turn - 1])
        // and every player hosts at least once a round
        expect(new Set(seats).size, `cap ${cap}, group of ${n}`).toBe(n)
      }
  })

  it("is the snapshot's turn mapped onto the group, so a group of 4 plays A B C D A B", () => {
    const six: GameTimingInfo = { gameDate: 1000, reportEnds: 3000, rounds: 1, maxGroupSize: 6 }
    const turns = [0, 12, 24, 36, 48, 60].map((at) => {
      const snap = calculateSnapshot(1000 + at, six)
      return snap.kind === "round" ? snap.hostPosition : -1
    })
    expect(turns).toEqual([0, 1, 2, 3, 4, 5])
    expect(turns.map((turn) => "ABCD"[hostSeat(turn, 4)]).join(" ")).toBe("A B C D A B")
  })
})
