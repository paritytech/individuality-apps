// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { endOfPlayAccepted, isNoDrawCollectables, reachedEndOfPlay } from "./end-of-play"

describe("a game with no prize draw ends on its own collectables page (suite run 46143137392, game 127)", () => {
  const base = "http://localhost:3000"
  it("accepts /collectables?game=<this game> as the end of play", () => {
    expect(isNoDrawCollectables(`${base}/collectables?game=127`, 127)).toBe(true)
    expect(reachedEndOfPlay(`${base}/collectables?game=127`, 127)).toBe(true)
    expect(endOfPlayAccepted(`${base}/collectables?game=127`, 127)).toBe(true)
    expect(isNoDrawCollectables(`${base}/collectables?x=1&game=127`, 127)).toBe(true)
  })
  it("refuses another game's collectables, a bare one, a lookalike path and an unknown game", () => {
    expect(endOfPlayAccepted(`${base}/collectables?game=126`, 127)).toBe(false)
    expect(endOfPlayAccepted(`${base}/collectables`, 127)).toBe(false)
    expect(endOfPlayAccepted(`${base}/collectables?game=1270`, 127)).toBe(false)
    expect(endOfPlayAccepted(`${base}/collectables-old?game=127`, 127)).toBe(false)
    expect(endOfPlayAccepted(`${base}/collectables?game=127`, null)).toBe(false)
  })
  it("keeps /prize-draw and /chest, and does not widen to /game or /connection-help", () => {
    expect(reachedEndOfPlay(`${base}/prize-draw`, 127)).toBe(true)
    expect(endOfPlayAccepted(`${base}/chest`, 127)).toBe(true)
    expect(reachedEndOfPlay(`${base}/chest`, 127)).toBe(false)
    expect(endOfPlayAccepted(`${base}/game`, 127)).toBe(false)
    expect(endOfPlayAccepted(`${base}/connection-help`, 127)).toBe(false)
  })
})
