// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { drainParams, drainPoint } from "./warp"

const W = 390, H = 844
const at = (pull: number, cx = 250, cy = 544, t = 0) => drainParams({ cx, cy, R: 30, pull, t }, W, H)
const corners = [[0, 0], [W, 0], [0, H], [W, H]]

describe("drainParams", () => {
  it("leaves the picture as it was at pull 0", () => {
    expect(at(0)).toMatchObject({ pull: 0, h: 0, gate: 0 })
  })

  it("has swallowed past the farthest corner by pull 1, wherever the bubble is", () => {
    for (const [cx, cy] of [[250, 544], [0, 0], [195, 422], [W, H], [70, 120]]) {
      const far = Math.max(...corners.map(([x, y]) => Math.hypot(x - cx, y - cy)))
      expect(at(1, cx, cy).h).toBeGreaterThan(far)
    }
  })

  it("swallows nearest first: what it has swallowed only grows with the pull", () => {
    let last = -1
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const { h } = at(p)
      expect(h).toBeGreaterThan(last)
      last = h
    }
  })

  it("is slow at first: the near content goes before the far edges move", () => {
    expect(at(0.15).h).toBeLessThan(at(1).h * 0.1)
    expect(at(0.5).h).toBeLessThan(at(1).h * 0.5)
  })

  it("takes a pull out of range as the nearest end", () => {
    expect(at(-0.5)).toMatchObject({ pull: 0, h: 0, gate: 0 })
    expect(at(1.5).h).toBe(at(1).h)
  })

  it("brings the hole, lens and ripple in quickly", () => {
    expect(at(0.01).gate).toBeLessThan(0.1)
    expect(at(0.1).gate).toBe(1)
  })

  it("keeps the ripple's phase in [0, 2π) at any time", () => {
    for (const t of [0, 1.7, 123456.789, -3.2, 1e7]) {
      const { phase } = at(0.5, 250, 544, t)
      expect(phase).toBeGreaterThanOrEqual(0)
      expect(phase).toBeLessThan(Math.PI * 2)
    }
  })
})

describe("drainPoint: the drain run forwards, for what is not in the picture", () => {
  const frame = { cx: 250, cy: 544, R: 40, pull: 0.3, t: 0 }
  it("leaves everything where it is before the pull", () => {
    expect(drainPoint(120, 80, { ...frame, pull: 0 }, 390, 844)).toEqual({ x: 120, y: 80, turn: 0, k: 1, alpha: 1 })
  })
  it("brings a point in to where the shader looks for it, turned round the bubble", () => {
    const { h } = drainParams(frame, 390, 844)
    const d = Math.hypot(120 - frame.cx, 80 - frame.cy)
    const p = drainPoint(120, 80, frame, 390, 844)!
    expect(Math.hypot(p.x - frame.cx, p.y - frame.cy)).toBeCloseTo(Math.sqrt(d * d - h * h), 6)
    expect(p.turn).toBeGreaterThan(0)
    expect(p.k).toBeLessThan(1)
  })
  it("swallows what the sink has reached", () => {
    const near = drainPoint(frame.cx + 20, frame.cy, frame, 390, 844)
    expect(near).toBeNull()
  })
})
