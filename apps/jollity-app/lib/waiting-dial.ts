// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE WAITING-ROOM DIAL — the math of one dial turn, with no React and no clock.
 *
 * Sixty bars light from twelve, one each second of the window, and the digits
 * count the seconds left to 00.
 *
 * Every function takes `left`, the seconds to the dial's 00 (negative after
 * it). The component reads its clock and feeds it in each frame. All geometry
 * is in the dial's own 274 frame.
 */

export const DIAL_SIZE = 274
const C = DIAL_SIZE / 2
const TAU = Math.PI * 2

// the art's own colors, not theme tokens
export const DIAL_WHITE = "#ffffff"

export const DIGIT_FONT = "600 85.754px/1 var(--font-sans)"
export const DIGIT_TRACKING = 1.7151

const BARS_N = 60
/** aligned at their outer end; the majors reach further in */
const BAR_MINOR = [104, 110] as const
const BAR_MAJOR = [98, 110] as const
export const BAR_LIT = 0.95
export const BAR_DIM = 0.22

export interface DialBar {
  x1: number
  y1: number
  x2: number
  y2: number
  width: number
}
/** 60 bars from twelve, clockwise, a major one every 5 */
export const DIAL_BARS: readonly DialBar[] = Array.from({ length: BARS_N }, (_, i) => {
  const major = i % 5 === 0
  const [r0, r1] = major ? BAR_MAJOR : BAR_MINOR
  const a = (i / BARS_N) * TAU
  return {
    x1: C + r0 * Math.sin(a),
    y1: C - r0 * Math.cos(a),
    x2: C + r1 * Math.sin(a),
    y2: C - r1 * Math.cos(a),
    width: major ? 2.4 : 1.8,
  }
})

/** how many bars are lit: one per second of the window, 0 at its start, all at 00 */
export function litBars(left: number, windowSec: number): number {
  const elapsed = windowSec - Math.min(windowSec, Math.max(0, left))
  return Math.floor((elapsed * BARS_N) / windowSec)
}

/** the seconds left as two digits, "60" … "00" */
export function dialDigits(left: number, windowSec: number): string {
  return String(Math.ceil(Math.min(windowSec, Math.max(0, left)))).padStart(2, "0")
}
