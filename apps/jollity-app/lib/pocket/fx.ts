// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE POCKET'S EFFECTS LAYER: the puff of film as the cover lands, the ghost
 * finger that shows where to take the cover, and the confetti once the book is
 * shut, drawn on one canvas over the book (components/pocket/pocket-claim.tsx
 * hosts it) and only while there is something to draw. Framework-free
 * (architecture rule 6): where each speck is comes from ./motion, what the
 * book is from ./book; this paints them.
 */
import type { Book, Size } from "./book"
import { CONFETTI_FOR, PUFF, PUFF_FOR, confettiAt, ghostAt, puffAt, type Bit } from "./motion"

/** The bubble's own film colours, for the puff and the confetti. */
const FILM = ["#ff9ad5", "#c7a4ff", "#86d4ff", "#9cf0cf", "#ffe3a0", "#ffad8c"]
/** after the book is shut: the confetti, s */
export const CONFETTI_AT = 0.55

/** what the effects read of the Pocket's state; `painted` is theirs: whether the canvas holds a frame to clear */
export interface FxState {
  /** when the cover landed, on the Pocket's clock (s), and the book it landed on; -1 / null before */
  thudAt: number
  thudBook: Book | null
  /** reduced motion: no puff */
  still: boolean
  /** when the book shut (s); -1 before */
  shutAt: number
  confetti: Bit[]
  painted: boolean
}

/** One frame of the effects at `t` (s), on `fx`, the size of `stage`. `ghost`:
 *  the invitation's finger, `u` along its way and `a` its alpha, or null. */
export function paintPocketFx(
  fx: HTMLCanvasElement | null,
  stage: Size,
  t: number,
  book: Book,
  ghost: { a: number; u: number } | null,
  s: FxState,
): void {
  const puffing = s.thudBook !== null && !s.still && t < s.thudAt + PUFF_FOR
  const confetti = s.shutAt >= 0 && s.confetti.length > 0 && t < s.shutAt + CONFETTI_AT + CONFETTI_FOR
  const anything = puffing || confetti || ghost !== null
  if (!fx || (!anything && !s.painted)) return
  s.painted = anything
  const dpr = Math.min(devicePixelRatio || 1, 2)
  const width = Math.round(stage.width * dpr)
  const height = Math.round(stage.height * dpr)
  if (fx.width !== width || fx.height !== height) {
    fx.width = width
    fx.height = height
  }
  const g = fx.getContext("2d")
  if (!g) return
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, stage.width, stage.height)
  if (!anything) return
  // the puff: a breath of the film escaping the edges as the cover lands
  if (puffing) {
    for (let j = 0; j < PUFF; j++) {
      const speck = puffAt(j, t - s.thudAt, s.thudBook!)
      if (speck.alpha <= 0 || speck.r <= 0) continue
      g.globalAlpha = speck.alpha
      g.fillStyle = FILM[j % FILM.length]!
      g.beginPath()
      g.arc(speck.x, speck.y, speck.r, 0, Math.PI * 2)
      g.fill()
    }
  }
  // the ghost finger: where to take the cover
  if (ghost) {
    const at = ghostAt(ghost.u, book)
    g.fillStyle = "#fff"
    g.globalAlpha = 0.28 * ghost.a
    g.beginPath()
    g.arc(at.x, at.y, 22, 0, Math.PI * 2)
    g.fill()
    g.globalAlpha = 0.55 * ghost.a
    g.beginPath()
    g.arc(at.x, at.y, 8, 0, Math.PI * 2)
    g.fill()
  }
  if (confetti) {
    const from = { x: stage.width / 2, y: stage.height / 2 }
    for (const bit of s.confetti) {
      const at = confettiAt(bit, t - s.shutAt - CONFETTI_AT, from)
      if (!at || at.alpha <= 0) continue
      const colour = FILM[bit.hue % FILM.length]!
      g.save()
      g.globalAlpha = at.alpha
      g.translate(at.x, at.y)
      g.rotate(at.turn)
      g.fillStyle = colour
      g.shadowColor = colour
      g.shadowBlur = 6
      g.fillRect(-bit.size / 2, -bit.size * 0.3, bit.size, bit.round ? bit.size : bit.size * 0.6)
      g.restore()
    }
  }
  g.globalAlpha = 1
}
