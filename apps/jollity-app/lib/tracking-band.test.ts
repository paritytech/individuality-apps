// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { bandRows, episodeEnvelope, episodeLife, GRAIN_PX, nextEpisodeIn, paintBand, TRACKING } from "./tracking-band"

describe("the can't-reach static's episodes", () => {
  it("waits about 1.25 s on average at the game's amount", () => {
    const draws = Array.from({ length: 2000 }, (_, i) => (i + 0.5) / 2000)
    const mean = draws.reduce((sum, r) => sum + nextEpisodeIn(r), 0) / draws.length
    expect(mean).toBeGreaterThan(1.15)
    expect(mean).toBeLessThan(1.3)
  })

  it("waits longer the rarer the episodes", () => {
    expect(nextEpisodeIn(0.5, 0.35)).toBeGreaterThan(nextEpisodeIn(0.5, 1))
  })

  it("lasts 1.5 to 3.5 s", () => {
    expect(episodeLife(0)).toBe(1.5)
    expect(episodeLife(0.999)).toBeCloseTo(3.5, 1)
  })

  it("fades in over the first fifth and out over the last quarter", () => {
    expect(episodeEnvelope(0)).toBe(0)
    expect(episodeEnvelope(0.1)).toBeGreaterThan(0)
    expect(episodeEnvelope(0.1)).toBeLessThan(1)
    expect(episodeEnvelope(0.5)).toBe(1)
    expect(episodeEnvelope(0.9)).toBeLessThan(1)
    expect(episodeEnvelope(1)).toBe(0)
  })
})

describe("the band", () => {
  const peak = (rows: Float32Array) => rows.indexOf(Math.max(...rows))

  it("pulls hardest at its middle and not at all far from it", () => {
    const rows = bandRows(0, 500)
    const middle = peak(rows)
    expect(rows[middle]).toBeGreaterThan(0.7)
    expect(rows[(middle + GRAIN_PX / 2) % GRAIN_PX]).toBe(0)
  })

  it("is about the size of the game's value against the tile", () => {
    const rows = bandRows(0, 500)
    const pulled = rows.filter((f) => f > 0).length
    expect(pulled).toBeGreaterThan(TRACKING.size * GRAIN_PX * 0.5)
    expect(pulled).toBeLessThan(TRACKING.size * GRAIN_PX * 1.2)
  })

  it("crawls down the tile and wraps round it", () => {
    // the rows it pulls at all, whatever the jitter; seed 250 starts it a quarter down
    const pulled = (t: number) => [...bandRows(t, 250)].flatMap((f, y) => (f > 0 ? [y] : []))
    const middle = (t: number) => {
      const ys = pulled(t)
      return (ys[0]! + ys[ys.length - 1]!) / 2
    }
    expect(middle(0)).toBeCloseTo(32, 0)
    expect(middle(0.5)).toBeGreaterThan(middle(0))
    // a full lap at speed 1 takes 1 / 0.35 s
    expect(pulled(1 / 0.35)).toEqual(pulled(0))
  })
})

describe("one frame of the band", () => {
  const frame = (env: number, draw: number) => {
    const out = new Uint8ClampedArray(GRAIN_PX * GRAIN_PX * 4)
    const rows = new Float32Array(GRAIN_PX)
    rows.fill(1, 0, 10)
    paintBand(out, rows, env, 0.25, () => draw)
    return { inBand: out.slice(0, 4), away: out.slice(GRAIN_PX * 64 * 4, GRAIN_PX * 64 * 4 + 4) }
  }

  it("lights a pixel in the band whose draw is under its strength", () => {
    const { inBand } = frame(1, 0.01)
    expect(inBand[0]).toBeGreaterThanOrEqual(200)
    expect(inBand[3]).toBeGreaterThan(150)
  })

  it("quiets a pixel away from the band to the grain's opacity in black", () => {
    // 0.01 * 7919 % 1 = 0.19: under the pull of 0.29 away from the band
    const { away } = frame(1, 0.01)
    expect([...away]).toEqual([0, 0, 0, Math.floor(255 * 0.25)])
  })

  it("draws nothing visible outside an episode", () => {
    const { inBand, away } = frame(0, 0.01)
    expect(inBand[3]).toBe(0)
    expect(away[3]).toBe(0)
  })
})
