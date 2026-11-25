// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { BOOK, CLAIM_AT, OPEN_SCALE, bookAt, cellAt, cellOrder, cellsFor, claims, coverEdge, coverFor, grabs, onCover, openY, sweeps, type Book } from "./book"

const stage = { width: 390, height: 844 }
const open = (over: Partial<Parameters<typeof bookAt>[0]> = {}) => bookAt({ stage, bookIn: 1, peek: 0, cov: 0, shut: false, grown: 0, ...over })

describe("the Pocket book", () => {
  it("peeks over the foot at rest and stands fully on screen when lifted", () => {
    // Given
    const half = (BOOK.height * BOOK.open) / 2

    // Then
    expect(openY(0, stage.height) - half).toBeCloseTo(stage.height - 104)
    expect(openY(1, stage.height) + half).toBeCloseTo(stage.height - 24)
  })

  it("comes in from below the screen", () => {
    expect(open({ bookIn: 0 }).sy).toBeGreaterThan(stage.height)
    expect(open({ bookIn: 1 }).sy).toBeCloseTo(openY(0, stage.height))
  })

  it("lies open with its spine in the middle, and slides left to centre the shut book as the cover passes half closed", () => {
    // Given
    const atRest = open()
    const halfway = open({ cov: 0.5 })
    const closing = open({ cov: 1 })

    // Then
    expect(atRest.sx).toBe(195)
    expect(atRest.sc).toBe(OPEN_SCALE)
    expect(halfway.sx).toBe(195)
    expect(closing.sx + closing.pw / 2).toBeCloseTo(195)
  })

  it("grows into the middle of the screen once shut", () => {
    // When
    const grown = open({ shut: true, grown: 1 })

    // Then
    expect(grown.sc).toBe(BOOK.grown)
    expect(grown.sy).toBeCloseTo(422)
    expect(grown.sx + grown.pw / 2).toBeCloseTo(195)
  })
})

describe("the cells", () => {
  const book: Book = { sx: 195, sy: 700, sc: 1, pw: 180, ph: 240 }

  it("fill the right page first, then the inside of the cover", () => {
    expect(cellOrder(5)).toEqual([3, 4, 0, 1, 2])
    expect(cellOrder(6)).toEqual([3, 4, 5, 0, 1, 2])
  })

  it("puts the first half of an odd haul on the cover", () => {
    expect(onCover(5)).toBe(3)
    expect(onCover(6)).toBe(3)
  })

  it("sit two to a row on each page, a lone last one centred", () => {
    // When
    const cells = cellsFor(5, book)

    // Then
    expect(cells.map((cell) => cell.onCover)).toEqual([true, true, true, false, false])
    expect(cells[0]).toMatchObject({ x: 195 - 90 - 33, y: 700 - 33, side: 54 })
    expect(cells[1]).toMatchObject({ x: 195 - 90 + 33, y: 700 - 33 })
    expect(cells[2]).toMatchObject({ x: 195 - 90, y: 700 + 33 })
    expect(cells[3]).toMatchObject({ x: 195 + 90 - 33, y: 700 })
  })

  it("turn over with the cover: a cell on its inside lands mirrored on the right page as it shuts", () => {
    // When
    const lying = cellAt(3, 6, book, 0)
    const shut = cellAt(3, 6, book, 1)
    const onPage = cellAt(0, 6, book, 1)

    // Then
    expect(lying.x).toBeCloseTo(195 - 90 - 33)
    expect(shut.x).toBeCloseTo(195 + 90 + 33)
    expect(onPage.x).toBeCloseTo(195 + 90 - 33)
  })
})

describe("the cover", () => {
  const book: Book = { sx: 195, sy: 700, sc: 1, pw: 180, ph: 240 }

  it("follows the finger: lying open under the far left, standing over the spine, shut under the far right", () => {
    expect(coverFor(15, book)).toBeCloseTo(0)
    expect(coverFor(195, book)).toBeCloseTo(0.5)
    expect(coverFor(375, book)).toBeCloseTo(1)
    expect(coverFor(-100, book)).toBe(0)
    expect(coverFor(500, book)).toBe(1)
  })

  it("sweeps up the pieces its edge has passed", () => {
    // Then
    expect(coverEdge(book, 0.5)).toBeCloseTo(195)
    expect(sweeps(205, book, 0.5)).toBe(true)
    expect(sweeps(215, book, 0.5)).toBe(false)
  })

  it("is grabbed on the book or close round it", () => {
    expect(grabs({ x: 30, y: 700 }, book)).toBe(true)
    expect(grabs({ x: 195, y: 850 }, book)).toBe(true)
    expect(grabs({ x: 195, y: 500 }, book)).toBe(false)
    expect(grabs({ x: -10, y: 700 }, book)).toBe(false)
  })

  it("shuts by itself from the threshold on and swings back open below it", () => {
    expect(claims(CLAIM_AT)).toBe(true)
    expect(claims(CLAIM_AT - 0.01)).toBe(false)
  })
})
