// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE STARS: the room's dust, behind the hold and the collectables alike.
 * Fine motes over the dark, each drifting a few px on its own slow rhythm,
 * cleared where the bubble is. One field, laid out over the whole screen
 * (fractions of it) and moved on one clock (performance.now, in seconds), so
 * the draw's hold (lib/draw/hold/scene) and the collectables' backdrop
 * (components/chest/starfield) draw the same stars in the same places, and
 * nothing jumps between the screens.
 *
 * Logic only, no React (architecture rule 6).
 */

/** how many motes */
export const STAR_COUNT = 160
/** how far a mote drifts each way, px */
const DRIFT_X = 8
const DRIFT_Y = 6
const COLOUR = "#aab6e0"

interface Star {
  /** where it lies, 0–1 of the screen */
  x: number
  y: number
  /** how bright, and how big (px) */
  a: number
  s: number
}

/** the field, the same every time (a fixed seed) */
export const STARS: readonly Star[] = (() => {
  let seed = 5 >>> 0
  const next = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296
  return Array.from({ length: STAR_COUNT }, () => ({ x: next(), y: next(), a: 0.1 + next() * 0.25, s: 0.6 + next() }))
})()

/** where the bubble clears the stars, px on the screen: none inside 0.75 r, all from 1.05 r */
export interface StarHole {
  x: number
  y: number
  r: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smooth = (v: number) => {
  const x = clamp01(v)
  return x * x * (3 - 2 * x)
}

/**
 * The stars on a 2D context whose units are screen px: the screen `w` × `h`,
 * at time `t` (s, performance.now's), as bright as `alpha`, cleared in `hole`.
 */
export function drawStars(g: CanvasRenderingContext2D, w: number, h: number, t: number, alpha = 1, hole: StarHole | null = null): void {
  if (alpha <= 0.01) return
  g.save()
  g.strokeStyle = COLOUR
  g.lineCap = "round"
  for (const p of STARS) {
    const px = p.x * w + Math.sin(t * 0.25 + p.a * 40) * DRIFT_X
    const py = p.y * h + Math.cos(t * 0.2 + p.s * 30) * DRIFT_Y
    const out = hole ? smooth((Math.hypot(px - hole.x, py - hole.y) - hole.r * 0.75) / (hole.r * 0.3)) : 1
    if (out <= 0) continue
    g.globalAlpha = p.a * out * alpha
    g.lineWidth = p.s
    g.beginPath()
    g.moveTo(px - 0.01, py)
    g.lineTo(px, py)
    g.stroke()
  }
  g.restore()
}
