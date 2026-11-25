// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The Pocket book the collectables are put away in.
 *
 * It lies open at the foot of the screen: the cover is hinged at the spine and lies open to the left with the first
 * half of the cells on its inside, and the right page holds the rest. Closing it is a drag of the cover across the
 * spine. How far it has closed runs from 0 (lying open) to 1 (shut on the right page), and its free edge sweeps the
 * screen from the left as it goes: every piece it passes drops into the book.
 */

export const BOOK = { width: 180, height: 240, open: 1.18, grown: 1.7 }
/** the book's scale while it lies open at the foot */
export const OPEN_SCALE = 0.95
export const CELL = 54
const CELL_GAP = 12
/** let go past this much closed and the cover shuts by itself */
export const CLAIM_AT = 0.7
/** how much of the open book shows over the foot at rest, px */
const PEEK = 104
/** the gap under the book once it is fully up, px */
const FOOT_GAP = 24
/** where the book waits below the screen before it comes in, px past the foot */
const BELOW = 200
/** how far round the book a press still grabs the cover: past its sides, and past its top and bottom, px */
const GRAB_SIDE = 24
const GRAB_ENDS = 40
/** how far right of the cover's edge a piece already counts as swept, px */
const SWEEP = 16

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Where the book is drawn: its spine (`sx`, `sy`, the middle of the spine), its scale, and one page's size. */
export interface Book {
  sx: number
  sy: number
  sc: number
  pw: number
  ph: number
}

export interface Cell {
  x: number
  y: number
  side: number
  /** on the inside of the cover, which turns over with it */
  onCover: boolean
}

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** how far `t` is from `a` to `b`, held to 0..1 */
export const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a))
export const smooth = (t: number) => {
  const k = clamp01(t)
  return k * k * (3 - 2 * k)
}

/** The spine's height on the screen: peeking over the foot (`peek` 0) or fully up (`peek` 1). */
export function openY(peek: number, height: number): number {
  const half = (BOOK.height * BOOK.open) / 2
  return lerp(height - PEEK + half, height - FOOT_GAP - half, peek)
}

/**
 * Where the book is this frame. It comes up from below (`bookIn` 0 to 1) to peek over the foot, lifts the rest of
 * the way (`peek`) while the cover is held, and its spine slides left by half a page as the cover passes half
 * closed, so the shut book ends up centred. Once shut it grows into the middle of the screen (`grown` 0 to 1).
 */
export function bookAt({
  stage,
  bookIn,
  peek,
  cov,
  shut,
  grown,
  dip = 0,
}: {
  stage: Size
  bookIn: number
  peek: number
  cov: number
  shut: boolean
  grown: number
  dip?: number
}): Book {
  const sc = lerp(OPEN_SCALE, BOOK.grown, grown)
  const pw = BOOK.width * sc
  const centre = Math.max(grown, shut ? 1 : smooth(seg(cov, 0.5, 1)))
  const below = lerp(stage.height + BELOW, openY(peek, stage.height), bookIn)
  return {
    sx: lerp(stage.width / 2, stage.width / 2 - pw / 2, centre),
    sy: lerp(below, stage.height / 2, grown) + dip,
    sc,
    pw,
    ph: BOOK.height * sc,
  }
}

/**
 * The highest the book's top comes while it is open: lifted all the way, as it is while its cover is held. The
 * collectables float above this, so the book never covers one.
 */
export function bookTop(stage: Size): number {
  const book = bookAt({ stage, bookIn: 1, peek: 1, cov: 0, shut: false, grown: 0 })
  return book.sy - book.ph / 2
}

/** The order the cells fill in: the right page first, then the inside of the cover. */
export function cellOrder(count: number): number[] {
  const half = Math.ceil(count / 2)
  return [...Array.from({ length: count - half }, (_, k) => half + k), ...Array.from({ length: half }, (_, k) => k)]
}

/** The first half of the pieces goes on the inside of the cover, the rest on the page. */
export const onCover = (count: number) => Math.ceil(count / 2)

/** Every cell of the open book, the cover's first: two to a row, a lone last one centred, each half centred on its page. */
export function cellsFor(count: number, book: Book): Cell[] {
  const half = onCover(count)
  const side = CELL * book.sc
  const gap = CELL_GAP * book.sc
  return Array.from({ length: count }, (_, j) => {
    const left = j < half
    const k = left ? j : j - half
    const inPage = left ? half : count - half
    const rows = Math.ceil(inPage / 2)
    const col = k % 2
    const row = Math.floor(k / 2)
    const inRow = row === rows - 1 && inPage % 2 ? 1 : Math.min(2, inPage)
    const middle = left ? book.sx - book.pw / 2 : book.sx + book.pw / 2
    return {
      x: middle + (col - (inRow - 1) / 2) * (side + gap),
      y: book.sy + (row - (rows - 1) / 2) * (side + gap),
      side,
      onCover: left,
    }
  })
}

/** Where the `order`-th cell to fill is, with the cover `closed` of the way shut: a cell on the cover turns over with it. */
export function cellAt(order: number, count: number, book: Book, closed: number): Cell {
  const cell = cellsFor(count, book)[cellOrder(count)[order] ?? 0]!
  return cell.onCover ? { ...cell, x: book.sx - (book.sx - cell.x) * Math.cos(Math.PI * closed) } : cell
}

/** How far closed the cover is with its edge under the finger. */
export const coverFor = (fingerX: number, book: Book) => Math.acos(Math.min(1, Math.max(-1, (book.sx - fingerX) / book.pw))) / Math.PI

/** Where the cover's free edge is on the screen. */
export const coverEdge = (book: Book, cov: number) => book.sx - book.pw * Math.cos(Math.PI * cov)

/** The cover's edge has passed a piece at `x`. */
export const sweeps = (x: number, book: Book, cov: number) => x < coverEdge(book, cov) + SWEEP

/** A press here grabs the cover: on either page or close round them. */
export const grabs = (at: Point, book: Book) =>
  Math.abs(at.x - book.sx) < book.pw + GRAB_SIDE && Math.abs(at.y - book.sy) < book.ph / 2 + GRAB_ENDS

export const claims = (cov: number) => cov >= CLAIM_AT
