// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { BOUNCY, SNUG, arcAt, coverSwing, standUp, departureOrder, flightAt, leaning, settled, sparksFor, stepSpring, type Spring } from "./motion"

const run = (from: Spring, target: number, tune = BOUNCY, frames = 240) => {
  let spring = from
  let peak = from.x
  for (let i = 0; i < frames; i++) {
    spring = stepSpring(spring, target, tune, 1 / 60)
    peak = Math.max(peak, spring.x)
  }
  return { spring, peak }
}

describe("a spring", () => {
  it("overshoots its target once and settles on it", () => {
    // When
    const { spring, peak } = run({ x: 0, v: 0 }, 1)

    // Then
    expect(peak).toBeGreaterThan(1.05)
    expect(settled(spring, 1)).toBe(true)
  })

  it("stays put through a long stall instead of flying off", () => {
    // When
    const after = stepSpring({ x: 0, v: 0 }, 1, SNUG, 5)

    // Then
    expect(after.x).toBeGreaterThan(0)
    expect(after.x).toBeLessThan(1.5)
  })
})

describe("a held piece", () => {
  it("rests where it floats before the finger moves", () => {
    expect(leaning({ from: { x: 100, y: 300 }, rayX: 195, progress: 0, wobble: 1 })).toEqual({ x: 0, y: 0, rotate: 0, scale: 1, opacity: 1 })
  })

  it("leans towards the ray and down as the swipe goes on", () => {
    // When
    const pose = leaning({ from: { x: 100, y: 300 }, rayX: 200, progress: 1, wobble: -1 })

    // Then
    expect(pose.x).toBeCloseTo(22)
    expect(pose.y).toBe(28)
    expect(pose.scale).toBeCloseTo(1.08)
  })
})

describe("a flight", () => {
  const trip = { from: { x: 80, y: 200 }, rayX: 195, to: { x: 150, y: 760 }, startScale: 1, endScale: 0.5, startRotate: 12 }

  it("starts where the piece let go and ends on its cell at the size of the cell", () => {
    // When
    const start = flightAt({ ...trip, t: 0 })
    const end = flightAt({ ...trip, t: 1 })

    // Then
    expect(start.at).toEqual(trip.from)
    expect(start.opacity).toBe(1)
    expect(end.at.x).toBeCloseTo(150)
    expect(end.at.y).toBeCloseTo(760)
    expect(end.scale).toBeCloseTo(0.5)
    expect(end.opacity).toBe(0)
  })

  it("bends through the ray on its way", () => {
    // When
    const middle = flightAt({ ...trip, t: 0.5 })

    // Then
    expect(middle.at.x).toBeGreaterThan(Math.min(trip.from.x, trip.to.x) + 30)
  })

  it("follows a curve through its control point", () => {
    expect(arcAt({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, 0.5)).toEqual({ x: 5, y: 2.5 })
  })
})

describe("the cover", () => {
  it("lifts off slowly and is still moving when it lands", () => {
    // When
    const start = coverSwing(0.1) - coverSwing(0)
    const end = coverSwing(1) - coverSwing(0.9)

    // Then
    expect(coverSwing(0)).toBe(0)
    expect(coverSwing(1)).toBeCloseTo(1)
    expect(end).toBeGreaterThan(start * 2)
  })
})

describe("the book standing up", () => {
  it("leaves the table quickly, leans a hair past upright and settles", () => {
    // When
    const early = standUp(0.2)
    const late = standUp(0.9) - standUp(0.8)
    const peak = Math.max(...[0.6, 0.7, 0.8, 0.9].map(standUp))

    // Then
    expect(standUp(0)).toBeCloseTo(0)
    expect(early).toBeGreaterThan(0.35)
    expect(Math.abs(late)).toBeLessThan(0.05)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThan(1.08)
    expect(standUp(1)).toBeCloseTo(1)
  })
})

describe("the order of the flights", () => {
  it("sends the pieces nearest the book first", () => {
    expect(departureOrder([{ x: 0, y: 100 }, { x: 0, y: 700 }, { x: 0, y: 400 }], { x: 0, y: 800 })).toEqual([1, 2, 0])
  })
})

describe("the confetti", () => {
  it("is thrown upwards and is the same for the same seed", () => {
    // When
    const sparks = sparksFor(12, 3)

    // Then
    expect(sparks).toHaveLength(12)
    expect(sparks.every((spark) => spark.rise <= 0)).toBe(true)
    expect(sparksFor(12, 3)).toEqual(sparks)
  })
})
