// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { floatLayout, type FloatPiece, type Walls } from "./float"

// a 2 × 4 chest's frame on a phone: the frame the engine fits to eight pieces
const WALLS: Walls = { left: -1.45, right: 1.45, bottom: -2.6, top: 2.6 }
const R = 0.38

/** a seeded scatter of pieces, the first `open` of them opened */
function pieces(count: number, open: number, seed = 1): FloatPiece[] {
  let s = seed
  const rnd = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
  return Array.from({ length: count }, (_, i) => ({ u: (rnd() - 0.5) * 2, v: (rnd() - 0.5) * 4, r: R, opened: i < open, lift: rnd() }))
}

const CASES = [[8, 0], [8, 3], [8, 1], [8, 7], [8, 8], [6, 3], [10, 5], [3, 1], [1, 0]] as const

describe("floatLayout", () => {
  it("gathers the opened pieces at the top and the rest at the bottom, whatever the count and the start", () => {
    for (const [count, open] of CASES) {
      for (const seed of [1, 7, 42]) {
        const fs = pieces(count, open, seed)
        const at = floatLayout(fs, WALLS)
        const up = at.filter((_, i) => fs[i]!.opened).map((p) => p.v)
        const down = at.filter((_, i) => !fs[i]!.opened).map((p) => p.v)
        if (up.length && down.length) expect(Math.min(...up)).toBeGreaterThan(Math.max(...down) - 0.3)
        const mean = (vs: number[]) => vs.reduce((a, b) => a + b, 0) / vs.length
        if (up.length && down.length) expect(mean(up)).toBeGreaterThan(mean(down) + 0.8)
      }
    }
  })

  it("keeps every piece inside the frame and clear of the others", () => {
    for (const [count, open] of CASES) {
      const fs = pieces(count, open, 3)
      const at = floatLayout(fs, WALLS)
      for (const p of at) {
        expect(p.u - R).toBeGreaterThanOrEqual(WALLS.left - 1e-9)
        expect(p.u + R).toBeLessThanOrEqual(WALLS.right + 1e-9)
        expect(p.v - R).toBeGreaterThanOrEqual(WALLS.bottom - 1e-9)
        expect(p.v + R).toBeLessThanOrEqual(WALLS.top + 1e-9)
      }
      for (let i = 0; i < at.length; i++)
        for (let j = i + 1; j < at.length; j++) expect(Math.hypot(at[i]!.u - at[j]!.u, at[i]!.v - at[j]!.v)).toBeGreaterThan(2 * R)
    }
  })

  it("is loose, not rows: the pieces resting on an edge do not line up", () => {
    const fs = pieces(8, 0, 5)
    const at = floatLayout(fs, WALLS)
    const low = [...at].sort((a, b) => a.v - b.v).slice(0, 3).map((p) => p.v)
    expect(Math.max(...low) - Math.min(...low)).toBeGreaterThan(0.05)
  })

  it("keeps a piece on its own side of the frame when there is room", () => {
    const at = floatLayout([{ u: -0.8, v: 0, r: R, opened: true, lift: 0 }, { u: 0.8, v: 0, r: R, opened: false, lift: 0 }], WALLS)
    expect(at[0]!.u).toBeCloseTo(-0.8, 2)
    expect(at[1]!.u).toBeCloseTo(0.8, 2)
  })

  it("fills the frame: no half of it is left empty, whatever has been opened", () => {
    const high = WALLS.top - R - 0.2
    const low = WALLS.bottom + R + 0.2
    for (const [count, open] of [[8, 0], [8, 3], [8, 8], [10, 5], [6, 1]] as const) {
      const at = floatLayout(pieces(count, open, 21), WALLS).map((p) => p.v)
      expect(Math.max(...at)).toBeGreaterThan(high - 0.6)
      expect(Math.min(...at)).toBeLessThan(low + 0.6)
    }
  })

  it("gives each kind a share of the frame by its count", () => {
    const fs = pieces(8, 2, 4)
    const at = floatLayout(fs, WALLS)
    const span = WALLS.top - WALLS.bottom
    // two of eight opened: they keep to about the top quarter
    for (let i = 0; i < 2; i++) expect(at[i]!.v).toBeGreaterThan(WALLS.top - span * 0.25 - 0.5)
  })

  it("sits a lone piece in the middle of the frame, not on an edge", () => {
    const [only] = floatLayout([{ u: 0.3, v: 2, r: R, opened: false, lift: 0.4 }], WALLS)
    expect(Math.abs(only!.v)).toBeLessThan(0.3)
    expect(only!.u).toBeCloseTo(0.3, 5)
  })

  it("keeps every piece on its side of the frame when one opens", () => {
    const fs = pieces(8, 0, 9)
    const before = floatLayout(fs, WALLS)
    const settled = fs.map((p, i) => ({ ...p, u: before[i]!.u, v: before[i]!.v }))
    const top = before.reduce((best, p, i) => (p.v > before[best]!.v ? i : best), 0)
    settled[top] = { ...settled[top]!, opened: true }
    const after = floatLayout(settled, WALLS)
    expect(after[top]!.v).toBeGreaterThan(WALLS.top - 1.2)
    // the share changes, so the rest move up or down, but not across
    for (let i = 0; i < fs.length; i++) if (i !== top) expect(Math.abs(after[i]!.u - before[i]!.u)).toBeLessThan(0.6)
  })

  it("gives the same spots for the same pieces", () => {
    const fs = pieces(10, 4, 13)
    expect(floatLayout(fs, WALLS)).toEqual(floatLayout(fs, WALLS))
  })
})
