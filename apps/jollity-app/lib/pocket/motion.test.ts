// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { Book } from "./book"
import {
  COVER_WAIT,
  CONFETTI_FOR,
  arcAt,
  confettiAt,
  confettiFor,
  coverFall,
  flightAt,
  follow,
  ghostAt,
  invitation,
  puffAt,
  squash,
  thud,
  trailAlpha,
} from "./motion"

const book: Book = { sx: 195, sy: 700, sc: 0.95, pw: 171, ph: 228 }

describe("the cover held", () => {
  it("trails its target, the same at any frame rate", () => {
    // When
    let slow = 0
    for (let i = 0; i < 6; i++) slow = follow(slow, 1, 11, 1 / 30)
    let fast = 0
    for (let i = 0; i < 12; i++) fast = follow(fast, 1, 11, 1 / 60)

    // Then
    expect(slow).toBeGreaterThan(0.8)
    expect(slow).toBeLessThan(1)
    expect(fast).toBeCloseTo(slow)
  })
})

describe("the cover falling shut", () => {
  const fall = (from: number, seconds: number, waiting: (t: number) => boolean) => {
    let cover = { cov: from, v: 0 }
    let t = 0
    while (t < seconds) {
      cover = coverFall(cover, 1 / 60, waiting(t))
      t += 1 / 60
    }
    return cover
  }

  it("gathers speed as it goes", () => {
    // When
    const early = coverFall({ cov: 0.7, v: 0 }, 1 / 60, false)
    const later = coverFall(early, 1 / 60, false)

    // Then
    expect(later.v).toBeGreaterThan(early.v)
    expect(later.cov - early.cov).toBeGreaterThan(early.cov - 0.7)
  })

  it("waits short of shut while a piece is on its way in, then lands", () => {
    // When
    const held = fall(0.7, 1, () => true)
    const landed = fall(0.7, 1, (t) => t < 0.5)

    // Then
    expect(held.cov).toBe(COVER_WAIT)
    expect(landed.cov).toBe(1)
  })
})

describe("a flight", () => {
  const from = { x: 80, y: 300 }
  const to = { x: 250, y: 760 }

  it("starts where the piece was and ends on its cell", () => {
    // When
    const start = flightAt(from, to, 195, 0)
    const end = flightAt(from, to, 195, 1)

    // Then
    expect(start.at).toEqual(from)
    expect(end.at).toEqual(to)
    expect(end.k).toBe(1)
  })

  it("curves in through the middle of the screen, halfway down", () => {
    // When
    const middle = flightAt(from, to, 195, 0.5)

    // Then
    expect(middle.at.x).toBeGreaterThan((from.x + to.x) / 2)
    expect(middle.at.y).toBeCloseTo((from.y + to.y) / 2)
  })

  it("follows a curve through its control point", () => {
    expect(arcAt({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, 0.5)).toEqual({ x: 5, y: 2.5 })
  })

  it("leaves a trail only early on", () => {
    expect(trailAlpha(0)).toBe(0)
    expect(trailAlpha(0.25)).toBeCloseTo(0.35)
    expect(trailAlpha(0.6)).toBe(0)
  })
})

describe("a landing", () => {
  it("lands wide and flat and rings back to still", () => {
    expect(squash(0)).toBeCloseTo(0.28)
    expect(squash(0.13)).toBeLessThan(0)
    expect(Math.abs(squash(0.7))).toBeLessThan(0.002)
  })

  it("bounces the cover a little open and dips the book, then settles shut", () => {
    // When
    const now = thud(0)
    const bounce = thud(0.1)
    const after = thud(2)

    // Then
    expect(now.closed).toBe(1)
    expect(bounce.closed).toBeLessThan(1)
    expect(bounce.dip).toBeGreaterThan(2)
    expect(after.closed).toBeCloseTo(1)
    expect(after.dip).toBeCloseTo(0)
  })

  it("puffs specks out from the book's edges", () => {
    // When
    const specks = Array.from({ length: 28 }, (_, j) => [puffAt(j, 0, book), puffAt(j, 0.5, book)] as const)

    // Then
    for (const [start, later] of specks) {
      const onEdge = Math.abs(start.y - (book.sy - book.ph / 2)) < 0.01 || Math.abs(start.y - (book.sy + book.ph / 2)) < 0.01 || start.x === book.sx + book.pw
      expect(onEdge).toBe(true)
      expect(Math.hypot(later.x - start.x, later.y - start.y)).toBeGreaterThan(10)
    }
    expect(puffAt(0, 1, book).alpha).toBe(0)
  })
})

describe("the invitation", () => {
  it("lifts the cover a little and shows the finger, every 3.4 s", () => {
    // When
    const lifted = invitation(0.75)
    const between = invitation(2)
    const again = invitation(3.4 + 0.75)

    // Then
    expect(lifted.lift).toBeGreaterThan(0.2)
    expect(lifted.lift).toBeLessThanOrEqual(0.3)
    expect(lifted.ghost).not.toBeNull()
    expect(between).toEqual({ lift: 0, ghost: null })
    expect(again.lift).toBeCloseTo(lifted.lift)
  })

  it("moves the finger from the cover's left part to just right of the spine", () => {
    expect(ghostAt(0, book).x).toBeCloseTo(195 - 171 + 26)
    expect(ghostAt(1, book).x).toBeCloseTo(195 + 34)
    expect(ghostAt(1, book).y).toBeCloseTo(710)
  })
})

describe("the confetti", () => {
  it("is thrown up, falls, and is the same for the same seed", () => {
    // When
    const bits = confettiFor(46, 3)
    const from = { x: 195, y: 422 }

    // Then
    expect(bits).toHaveLength(46)
    expect(confettiFor(46, 3)).toEqual(bits)
    expect(bits.every((bit) => Math.sin(bit.angle) < 0.3)).toBe(true)
    expect(confettiAt(bits[0]!, 0, from)).toBeNull()
    expect(confettiAt(bits[0]!, CONFETTI_FOR + 0.1, from)).toBeNull()
    expect(confettiAt(bits[0]!, CONFETTI_FOR, from)!.y).toBeGreaterThan(from.y)
  })
})
