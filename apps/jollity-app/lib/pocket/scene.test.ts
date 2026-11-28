// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { CLAIM_AT, bookAt, coverFor, type Book } from "./book"
import { COVER_WAIT, FLIGHT } from "./motion"
import {
  coverLook,
  coverStep,
  createPocketScene,
  emptyCell,
  fillCell,
  flightsClip,
  poseAt,
  progress,
  type CoverMotion,
  type PocketElements,
  type PoseState,
  type RingSpot,
} from "./scene"

const stage = { width: 390, height: 844 }
const frame = 1 / 60

const cover = (over: Partial<CoverMotion> = {}): CoverMotion => ({
  cov: 0,
  covV: 0,
  covTarget: 0,
  lift: 0,
  grab: null,
  finishing: false,
  still: false,
  ...over,
})

/** `seconds` of frames of the cover, from `from` */
function run(from: CoverMotion, seconds: number, lastIn = 0, t0 = 0): CoverMotion {
  let c = from
  for (let t = t0; t < t0 + seconds; t += frame) c = { ...c, ...coverStep(c, frame, t, lastIn) }
  return c
}

const pose = (over: Partial<PoseState> = {}): PoseState => ({
  cov: 0,
  lift: 0,
  grab: null,
  finishing: false,
  still: false,
  openedAt: -1,
  thudAt: -1,
  shutAt: -1,
  ...over,
})

describe("the cover", () => {
  it("held, trails the finger, and the book lifts", () => {
    // When
    const held = run(cover({ grab: 1, covTarget: 0.6 }), 1)

    // Then
    expect(held.cov).toBeCloseTo(0.6, 3)
    expect(held.covV).toBe(0)
    expect(held.lift).toBeGreaterThan(0.99)
  })

  it("let go short, swings back open and the book settles down", () => {
    // When
    const open = run(cover({ cov: 0.5, lift: 1 }), 2)

    // Then
    expect(open.cov).toBeLessThan(0.001)
    expect(open.lift).toBeLessThan(0.01)
  })

  it("past the point, falls shut by itself and waits short of shut until the last piece is in", () => {
    // Given
    const falling = cover({ cov: CLAIM_AT, finishing: true })

    // When
    const waiting = run(falling, 0.5, 10)
    const landed = run(waiting, 0.5, 0)

    // Then
    expect(waiting.cov).toBe(COVER_WAIT)
    expect(waiting.lift).toBeGreaterThan(0.9)
    expect(landed.cov).toBe(1)
  })

  it("with reduced motion, is shut at once", () => {
    expect(coverStep(cover({ finishing: true, still: true }), frame, 0, 10).cov).toBe(1)
  })
})

describe("the book's pose", () => {
  it("comes up from below, then peeks, and lifts as the cover is taken", () => {
    expect(poseAt(pose(), 1).bookIn).toBe(0)
    expect(poseAt(pose(), 2).bookIn).toBe(1)
    expect(poseAt(pose(), 2).peek).toBeCloseTo(0.45)
    expect(poseAt(pose({ lift: 1 }), 2).peek).toBe(1)
  })

  it("invites a drag only while nobody holds the cover: not before INVITE_LATE, or INVITE_AFTER_OPEN after a piece was opened", () => {
    // Given: 3.5 s, 7.2 s and 13.8 s in are inside an invitation (every 3.4 s, for 1.5 s); INVITE_LATE is 11 s,
    // INVITE_AFTER_OPEN 6 s
    const early = 3.5
    const mid = 7.2
    const at = 13.8
    const openedAt = 1

    // Then: nothing opened, it waits for INVITE_LATE
    expect(poseAt(pose(), mid).ghost).toBeNull()
    expect(poseAt(pose(), at).ghost).not.toBeNull()
    expect(poseAt(pose(), at).closed).toBeGreaterThan(0)
    // a piece opened at 1 s: not 2.5 s after, but 6.2 s after
    expect(poseAt(pose({ openedAt }), early).ghost).toBeNull()
    expect(poseAt(pose({ openedAt }), mid).ghost).not.toBeNull()
    expect(poseAt(pose({ grab: 1 }), at).ghost).toBeNull()
    expect(poseAt(pose({ cov: 0.1 }), at).ghost).toBeNull()
    expect(poseAt(pose({ finishing: true }), at).ghost).toBeNull()
    expect(poseAt(pose({ still: true }), at).ghost).toBeNull()
  })

  it("bounces and dips after the thud, then grows into the middle once shut", () => {
    // When
    const thudding = poseAt(pose({ cov: 1, finishing: true, thudAt: 3 }), 3.1)
    const shut = poseAt(pose({ cov: 1, thudAt: 3, shutAt: 3.5 }), 3.5)
    const grown = poseAt(pose({ cov: 1, thudAt: 3, shutAt: 3.5 }), 5)

    // Then
    expect(thudding.closed).toBeLessThan(1)
    expect(thudding.dip).toBeGreaterThan(0)
    expect(shut.grown).toBe(0)
    expect(shut.bookIn).toBe(1)
    expect(grown.grown).toBe(1)
    expect(poseAt(pose({ still: true, shutAt: 3.5 }), 3.5).grown).toBe(1)
  })
})

describe("the cover's look", () => {
  it("lies open with its inside up and no shade on the page", () => {
    // When
    const look = coverLook(0, false)

    // Then
    expect(look.inside).toBe(true)
    expect(look.shadow).toBe("0")
    expect(look.transform).toContain("rotateY(-180.00deg)")
    expect(look.light).toBe("0.000")
  })

  it("stands upright lifted off the table and catching the light, higher while held", () => {
    // When
    const upright = coverLook(0.5, false)
    const held = coverLook(0.5, true)

    // Then
    expect(upright.lift).toBeCloseTo(16)
    expect(held.lift).toBeCloseTo(26)
    expect(upright.light).toBe("0.220")
    expect(upright.transform).toContain("rotateY(-90.00deg)")
  })

  it("shut, shows its outside and shades the page under it", () => {
    // When
    const look = coverLook(1, false)

    // Then
    expect(look.inside).toBe(false)
    expect(look.shadow).toBe("0.500")
    expect(look.shadowWidth).toBe("180.0px")
  })

  it("cuts the cover's place out of the flights' layer", () => {
    // Given
    const book: Book = { sx: 195, sy: 700, sc: 1, pw: 180, ph: 240 }

    // When
    const clip = flightsClip(book, stage, coverLook(1, false))

    // Then: the whole stage, less the right page under the shut cover
    expect(clip).toBe('path(evenodd, "M0 0H390V844H0Z M195.0 576.0H377.0V824.0H195.0Z")')
  })
})

describe("a piece's way", () => {
  it("runs into its cell over FLIGHT from when it left, and back out from when it starts home", () => {
    expect(progress({ at: 1, back: -1 }, 1, false)).toBe(0)
    expect(progress({ at: 1, back: -1 }, 1 + FLIGHT / 2, false)).toBeCloseTo(0.5)
    expect(progress({ at: 1, back: -1 }, 9, false)).toBe(1)
    expect(progress({ at: 1, back: 4 }, 4, false)).toBe(1)
    expect(progress({ at: 1, back: 4 }, 4 + FLIGHT, false)).toBe(0)
  })

  it("is there at once with reduced motion", () => {
    expect(progress({ at: 1, back: -1 }, 1, true)).toBe(1)
    expect(progress({ at: 1, back: 4 }, 4, true)).toBe(0)
  })

  it("fills its cell, and empties only its own", () => {
    // Given
    const filled = fillCell(fillCell([], 0, 3), 1, 5)

    // Then
    expect(filled).toEqual([3, 5])
    expect(emptyCell(filled, 0, 3)).toEqual([undefined, 5])
    expect(emptyCell(filled, 0, 5)).toEqual([3, 5])
    expect(filled).toEqual([3, 5])
  })
})

/* The scene itself, on bare elements: no React, as rule 6 asks of it. */

function scene(spots: RingSpot[]) {
  const div = () => document.createElement("div")
  const root = div()
  Object.defineProperty(root, "clientWidth", { value: stage.width })
  Object.defineProperty(root, "clientHeight", { value: stage.height })
  const els: PocketElements = {
    root,
    book: div(),
    cover: div(),
    inner: div(),
    outer: div(),
    edge: div(),
    flights: div(),
    fx: null,
    shells: null,
    sprites: spots.map(() => document.createElement("img")),
    cells: [],
  }
  const heard = {
    cells: [] as { filled: readonly number[]; landed: number }[],
    taken: [] as number[],
    returned: [] as [number, boolean][],
    covers: [] as number[],
    claims: 0,
    shut: 0,
    /** how many had landed when the book shut */
    landedAtShut: -1,
    /** the frames the cover landed (the book shimmers) and the book shut on */
    thudFrame: -1,
    shutFrame: -1,
  }
  let frames = 0
  const pocket = createPocketScene(els, {
    pieces: spots.map(() => ({ image: "", rare: false })),
    ring: () => spots,
    surface: () => null,
    onCells: (filled, landed) => heard.cells.push({ filled, landed }),
    onShut: () => {
      heard.shut++
      heard.landedAtShut = heard.cells.at(-1)?.landed ?? 0
      heard.shutFrame = frames
    },
    onTake: (index) => heard.taken.push(index),
    onReturn: (index, opened) => heard.returned.push([index, opened]),
    onCover: (closed) => heard.covers.push(closed),
    onClaim: () => heard.claims++,
  })
  let now = 1000
  const play = (seconds: number) => {
    for (let k = 0; k < seconds * 60; k++) {
      frames++
      pocket.step((now += 1000 / 60))
      if (heard.thudFrame < 0 && els.book.classList.contains("is-shimmering")) heard.thudFrame = frames
    }
  }
  // the book as it is lying open, its cover not yet taken
  const open = () => bookAt({ stage, bookIn: 1, peek: 0.45, cov: 0, shut: false, grown: 0 })
  return { pocket, els, heard, play, open }
}

const spot = (index: number, cx: number): RingSpot => ({ index, cx, cy: 300, size: 80, rotation: 0, opened: false })

describe("the Pocket scene", () => {
  it("a drag past the point takes every piece, claims, and shuts the book", () => {
    // Given
    const { pocket, els, heard, play, open } = scene([spot(0, 60), spot(1, 150), spot(2, 330)])
    play(2.5)
    const book = open()

    // When
    expect(pocket.press({ x: book.sx - book.pw / 2, y: book.sy }, 7)).toBe(true)
    pocket.move(7, book.sx + book.pw)
    play(1)
    pocket.release(7)
    play(3)

    // Then
    expect(heard.claims).toBe(1)
    expect([...heard.taken].sort()).toEqual([0, 1, 2])
    expect(heard.shut).toBe(1)
    expect(heard.landedAtShut).toBe(3)
    // the cover lies still half a second after the thud before the book shuts
    expect((heard.shutFrame - heard.thudFrame) / 60).toBeGreaterThanOrEqual(0.5)
    expect((heard.shutFrame - heard.thudFrame) / 60).toBeLessThan(0.55)
    expect(heard.cells.at(-1)).toEqual({ filled: [0, 1, 2], landed: 3 })
    expect(heard.covers.at(-1)).toBe(1)
    expect(els.book.classList.contains("is-shimmering")).toBe(true)
    expect(els.outer.style.visibility).toBe("visible")
  })

  it("let go short, gives back what the cover took and claims nothing", () => {
    // Given
    const { pocket, heard, play, open } = scene([spot(0, 60), spot(1, 120), spot(2, 330)])
    play(2.5)
    const book = open()

    // When: the cover held upright, its edge over the spine, long enough for what it swept to land
    pocket.press({ x: book.sx - book.pw / 2, y: book.sy }, 7)
    pocket.move(7, book.sx)
    play(1.2)
    pocket.release(7)
    play(2)

    // Then
    expect(heard.taken.sort()).toEqual([0, 1])
    expect(heard.returned.sort()).toEqual([
      [0, true],
      [1, true],
    ])
    expect(heard.claims).toBe(0)
    expect(heard.shut).toBe(0)
    expect(heard.cells.at(-1)).toEqual({ filled: [], landed: 0 })
    expect(pocket.holding()).toBe(false)
  })

  it("leaves a press on a piece to the collectables screen", () => {
    // Given: a piece floating over the book's open cover
    const { pocket, play, open } = scene([spot(0, 60)])
    play(2.5)
    const book = open()
    const onIt = { index: 0, cx: book.sx - book.pw / 2, cy: book.sy, size: 80, rotation: 0, opened: false }
    const over = scene([onIt])
    over.play(2.5)

    // Then
    expect(over.pocket.press({ x: onIt.cx, y: onIt.cy }, 1)).toBe(false)
    expect(pocket.press({ x: onIt.cx, y: onIt.cy }, 1)).toBe(true)
  })

  it("puts everything in on the screen's word without a claim of its own, and on Claim all with one", () => {
    // Given
    const word = scene([spot(0, 60), spot(1, 330)])
    const claimAll = scene([spot(0, 60), spot(1, 330)])
    word.play(2.5)
    claimAll.play(2.5)

    // When
    word.pocket.finish(false)
    claimAll.pocket.finish(true)
    word.play(3)
    claimAll.play(3)

    // Then
    expect(word.heard.claims).toBe(0)
    expect(claimAll.heard.claims).toBe(1)
    expect(word.heard.shut).toBe(1)
    expect(claimAll.heard.shut).toBe(1)
    expect(word.pocket.press({ x: 100, y: 700 }, 1)).toBe(false)
  })

  it("follows a held cover's finger and tells the collectables screen how far it has closed", () => {
    // Given
    const { pocket, heard, play, open } = scene([spot(0, 330)])
    play(2.5)
    const book = open()

    // When
    pocket.press({ x: book.sx - book.pw / 2, y: book.sy }, 3)
    pocket.move(3, book.sx)
    play(1)

    // Then
    expect(heard.covers.at(-1)).toBeCloseTo(coverFor(book.sx, book), 2)
    expect(pocket.holding()).toBe(true)
  })

  it("stops its frames on destroy", () => {
    // Given
    const request = vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(42)
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {})
    const { pocket } = scene([spot(0, 60)])

    // When
    pocket.run()
    pocket.destroy()

    // Then
    expect(request).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledWith(42)
    request.mockRestore()
    cancel.mockRestore()
  })
})
