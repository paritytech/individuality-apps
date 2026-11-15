// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { hostSeat } from "@jollity/game-chain/game"
import { roundLayout, turnLayout } from "./grid-layout"

describe("roundLayout (#546)", () => {
  it("puts you second and everyone else in seat order", () => {
    expect(roundLayout(6, 2)).toEqual([0, 2, 1, 3, 4, 5])
    expect(roundLayout(6, 5)).toEqual([0, 5, 1, 2, 3, 4])
  })

  it("keeps you second when you hold the first seat", () => {
    expect(roundLayout(6, 0)).toEqual([1, 0, 2, 3, 4, 5])
  })


  it("draws a group of one as just you, and nothing before the round seats you", () => {
    expect(roundLayout(1, 0)).toEqual([0])
    expect(roundLayout(6, -1)).toEqual([])
    expect(roundLayout(6, 6)).toEqual([])
  })
})

describe("turnLayout: the host top-left, you top-right", () => {
  /** which tiles changed place from one turn's layout to the next */
  const moved = (from: number[], to: number[]) => from.filter((seat, slot) => to[slot] !== seat).length

  it("brings each turn's host to the top-left by trading places with the host before", () => {
    // seats A0 B1 Y2 D3 E4 F5, you in seat 2
    expect(turnLayout(6, 2, 0)).toEqual([0, 2, 1, 3, 4, 5]) // A hosts, where the round starts
    expect(turnLayout(6, 2, 1)).toEqual([1, 2, 0, 3, 4, 5]) // B trades places with A
    expect(turnLayout(6, 2, 2)).toEqual([2, 1, 0, 3, 4, 5]) // your turn: you trade with B
    expect(turnLayout(6, 2, 3)).toEqual([3, 2, 0, 1, 4, 5]) // you back top-right, B into D's slot
    expect(turnLayout(6, 2, 4)).toEqual([4, 2, 0, 1, 3, 5])
    expect(turnLayout(6, 2, 5)).toEqual([5, 2, 0, 1, 3, 4])
  })

  it("moves two tiles a turn, three on the turn after yours, and keeps you top-right unless you host", () => {
    for (let you = 0; you < 6; you++) {
      for (let turn = 0; turn < 6; turn++) {
        const now = turnLayout(6, you, turn)
        expect(now[0]).toBe(turn)
        if (turn !== you) expect(now[1]).toBe(you)
        expect([...now].sort()).toEqual([0, 1, 2, 3, 4, 5])
        if (turn > 0) expect(moved(turnLayout(6, you, turn - 1), now)).toBeLessThanOrEqual(turn - 1 === you ? 3 : 2)
      }
    }
  })

  it("puts you top-left from the start when you host the first turn", () => {
    expect(turnLayout(6, 0, 0)).toEqual([0, 1, 2, 3, 4, 5])
    expect(turnLayout(6, 0, 1)).toEqual([1, 0, 2, 3, 4, 5])
  })

  it("clamps the turn to the round, and draws nothing before the round seats you", () => {
    expect(turnLayout(6, 2, -1)).toEqual(turnLayout(6, 2, 0))
    expect(turnLayout(6, 2, 9)).toEqual(turnLayout(6, 2, 5))
    expect(turnLayout(6, -1, 3)).toEqual([])
    expect(turnLayout(1, 0, 0)).toEqual([0])
  })

  it("draws a group of 4 in a game of six as four tiles, its hosts wrapping round them (#1347)", () => {
    // seats A0 B1 Y2 D3, you in seat 2; the round has six turns
    for (let turn = 0; turn < 4; turn++) expect(turnLayout(4, 2, turn, 6)).toEqual(turnLayout(4, 2, turn))
    expect(turnLayout(4, 2, 4, 6)).toEqual([0, 2, 3, 1]) // A hosts again, trading places with D
    expect(turnLayout(4, 2, 5, 6)).toEqual([1, 2, 3, 0]) // then B, trading with A
  })

  it("takes you to the top-left for a turn you host again, and back after it", () => {
    // you in seat 0 of a group of 4: you host turns 0 and 4
    expect(turnLayout(4, 0, 3, 6)).toEqual([3, 0, 1, 2])
    expect(turnLayout(4, 0, 4, 6)).toEqual([0, 3, 1, 2])
    expect(turnLayout(4, 0, 5, 6)).toEqual([1, 0, 3, 2])
  })

  it("clamps the turn to the round's turns, not its tiles", () => {
    expect(turnLayout(4, 2, 9, 6)).toEqual(turnLayout(4, 2, 5, 6))
    expect(turnLayout(4, 2, 5, 6)).not.toEqual(turnLayout(4, 2, 3, 6))
  })

  it("puts each turn's host top-left, has a tile for every player and none more, and moves at most three tiles", () => {
    for (let players = 2; players <= 6; players++)
      for (let you = 0; you < players; you++)
        for (let turn = 0; turn < 6; turn++) {
          const now = turnLayout(players, you, turn, 6)
          const host = hostSeat(turn, players)
          expect(now[0]).toBe(host)
          if (host !== you) expect(now[1]).toBe(you)
          expect([...now].sort()).toEqual(Array.from({ length: players }, (_, seat) => seat))
          if (turn > 0) expect(moved(turnLayout(players, you, turn - 1, 6), now)).toBeLessThanOrEqual(3)
        }
  })

  it("draws a group of one as just you, whichever empty chair hosts", () => {
    for (let turn = 0; turn < 6; turn++) expect(turnLayout(1, 0, turn, 6)).toEqual([0])
  })

  it("plays a game of four a round as four turns over four tiles (#1348)", () => {
    for (let you = 0; you < 4; you++)
      for (let turn = 0; turn < 4; turn++) expect(turnLayout(4, you, turn, 4)[0]).toBe(turn)
  })
})
