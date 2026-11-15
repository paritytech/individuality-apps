// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE ZOOM THAT NEVER CUTS THE WEDGE.

   The flow's zoom is a fixed 2.4× on the wedge's middle: right for a needle
   (6 in 420 is 5°), wrong for a slice — 3 in 8 is 135°, and at 2.4× its two
   ends are off the phone. Here the zoom is fitted to the wedge instead:

     band   the part of the stage the wedge may use — inside the sides, under
            the WINNER label's room, over the timeline
     box    the wedge's bounding box: the hub (its tip), the ends of its arc,
            and every axis extreme the arc passes (a slice wider than 180°
            reaches below the hub)

   First the WHEEL is fitted, unzoomed (rimFor): the largest rim, up to its
   dial, whose wedge box fits the band — so the zoom starts from a wedge that
   is already whole. Then the zoom's end (zoomFit): as far in as the box still
   fits, never past zoomX, the box centred in the band.

   And in between? The view is p → s·p + t with s = 1 + (s1 − 1)·z and t = z·t1,
   both LINEAR in the zoom's progress z — so every point moves in a straight
   line, at constant rate in z, from where it is unzoomed to where it is
   zoomed. A box inside the band at both ends is inside it the whole way, and
   on the way back out (the lost ending's) too.

   Nominal stage px, y DOWN; the wedge's angles are the wheel's own (place.js:
   ccw from three o'clock, y UP). No imports — wheel-slit:zoom runs it in node. */

const HALF = Math.PI / 2

/* the unit directions that bound a wedge from a0 to a1 (radians, ccw, y up),
   in screen terms (y down): its two ends, and each axis it sweeps through */
function extremes(a0, a1) {
  const dirs = [a0, a1]
  for (let k = Math.ceil(a0 / HALF); k * HALF < a1; k++) dirs.push(k * HALF)
  return dirs.map((a) => ({ x: Math.cos(a), y: -Math.sin(a) }))
}

/* the wedge's box: the tip at the hub, out to `reach`, padded by `pad` */
export function wedgeBox({ hub, reach, a0, a1, pad = 0 }) {
  let x0 = hub.x
  let x1 = hub.x
  let y0 = hub.y
  let y1 = hub.y
  for (const d of extremes(a0, a1)) {
    const x = hub.x + reach * d.x
    const y = hub.y + reach * d.y
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
}

/* the longest reach whose box fits the band, unzoomed: each extreme direction
   may go only as far as the band's edge it heads for */
export function reachFit({ hub, band, a0, a1, pad = 0 }) {
  let best = Infinity
  for (const d of extremes(a0, a1)) {
    if (d.x > 1e-9) best = Math.min(best, (band.x1 - pad - hub.x) / d.x)
    if (d.x < -1e-9) best = Math.min(best, (band.x0 + pad - hub.x) / d.x)
    if (d.y > 1e-9) best = Math.min(best, (band.y1 - pad - hub.y) / d.y)
    if (d.y < -1e-9) best = Math.min(best, (band.y0 + pad - hub.y) / d.y)
  }
  return Math.max(0, best)
}

/* the rim, fitted: reach = rim·k + extra (the wedge runs k × the outermost
   ring, and a ball's radius more), and no bigger than rimMax */
export function rimFor({ hub, band, a0, a1, k, extra, pad, rimMax }) {
  const reach = reachFit({ hub, band, a0, a1, pad })
  return Math.max(1, Math.min(rimMax, (reach - extra) / Math.max(1e-6, k)))
}

/* the zoom's end: as far in as the box fits the band, at most maxX. Never
   below 1 — the rim fit has made 1 fit already. The box's centre moves
   toward the band's as far as the zoom goes in (all the way at maxX, not at
   all at 1, so a slice that only just fits is not panned for nothing), and
   then as little as it must to be wholly inside the band. */
export function zoomFit({ box, band, maxX }) {
  const bw = Math.max(1e-6, box.x1 - box.x0)
  const bh = Math.max(1e-6, box.y1 - box.y0)
  const s1 = Math.max(1, Math.min(maxX, (band.x1 - band.x0) / bw, (band.y1 - band.y0) / bh))
  const k = maxX > 1 ? Math.max(0, Math.min(1, (s1 - 1) / (maxX - 1))) : 0
  const along = (lo, hi, b0, b1) => {
    const c = (b0 + b1) / 2
    const to = c + ((lo + hi) / 2 - c) * k
    let t = to - s1 * c
    // inside the band, both ends: the box is no bigger than it at s1
    if (s1 * b0 + t < lo) t = lo - s1 * b0
    if (s1 * b1 + t > hi) t = hi - s1 * b1
    return t
  }
  return { s1, tx1: along(band.x0, band.x1, box.x0, box.x1), ty1: along(band.y0, band.y1, box.y0, box.y1) }
}

/* the view at progress z (0..1): p → s·p + t */
export function zoomAt(fit, z) {
  const u = Math.max(0, Math.min(1, z))
  return { s: 1 + (fit.s1 - 1) * u, tx: fit.tx1 * u, ty: fit.ty1 * u, z: u }
}
