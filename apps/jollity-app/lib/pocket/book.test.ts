// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { BOOK, CLAIM_AT, SWIPE_REACH, claims, closedBookAt, onCover, openBookAt, trackSwipe } from "./book"

const stage = { width: 390, height: 844 }

describe("the Pocket book", () => {
  it("peeks over the foot at rest and stands fully on screen when the swipe completes", () => {
    // Given
    const atRest = openBookAt(0, stage)
    const up = openBookAt(1, stage)

    // Then
    const half = (BOOK.height * BOOK.open) / 2
    expect(atRest.y - half).toBeCloseTo(stage.height - 104)
    expect(up.y + half).toBeCloseTo(stage.height - 24)
    expect(atRest.x).toBeCloseTo(stage.width / 2 + (BOOK.width / 2) * BOOK.open)
  })

  it("closes in the middle of the screen", () => {
    expect(closedBookAt(stage)).toEqual({ x: 195, y: 422 })
  })

  it("puts the first half of an odd haul on the cover", () => {
    expect(onCover(5)).toBe(3)
    expect(onCover(6)).toBe(3)
  })
})

describe("the swipe", () => {
  it("counts only the distance down from where the finger landed", () => {
    // Given
    const landed = trackSwipe(null, { x: 100, y: 300 })

    // When
    const halfway = trackSwipe(landed, { x: 160, y: 300 + SWIPE_REACH / 2 })
    const upwards = trackSwipe(landed, { x: 100, y: 200 })
    const past = trackSwipe(landed, { x: 100, y: 300 + SWIPE_REACH * 2 })

    // Then
    expect(landed.progress).toBe(0)
    expect(halfway.progress).toBe(0.5)
    expect(halfway.start).toEqual({ x: 100, y: 300 })
    expect(upwards.progress).toBe(0)
    expect(past.progress).toBe(1)
  })

  it("claims from the threshold on and springs back below it", () => {
    expect(claims(CLAIM_AT)).toBe(true)
    expect(claims(CLAIM_AT - 0.01)).toBe(false)
  })
})
