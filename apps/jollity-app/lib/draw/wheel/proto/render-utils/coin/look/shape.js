// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE COIN'S OUTLINE — a rounded regular polygon, and the same outline drawn
   in by any inset: the rim, the field and the edge are all insets of one
   shape, so a hexagon's rim is as wide along a flat as round a corner.

     sides   n: 3… for a polygon, anything under 3 for a round coin
     round   ρ, the corners' radius as a share of the coin's (0 sharp, 1 round —
             a polygon rounded all the way IS a circle)

   The outline always fits the unit circle (its corners touch radius 1), so
   the coin's size, its planar UVs and the shadow's box need not know the
   shape. Its apothem is A = ρ + (1−ρ)·cos(π/n).

   contour(d) is the outline d in from the edge: apothem A − d, corner radius
   max(ρ − d, 0) — an inner corner sharpens once the inset passes its radius,
   as a real polygon coin's inner rim does. Counter-clockwise, a flat side at
   the bottom; each side is a run of edge samples and then its corner's arc,
   and the COUNT is the same at every inset, so rings line up vertex for vertex
   (profile.js sweeps them into the faces). A round coin is n = 16 with ρ = 1:
   the same code, with edge runs of nothing. */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const PER = 192 // samples round the whole outline, shared between the edges and the corners

export function coinShape({ sides = 0, round = 1 } = {}) {
  const polygon = sides >= 3
  const n = polygon ? Math.round(sides) : 16
  const rho = polygon ? clamp(round, 0, 1) : 1
  const half = Math.PI / n
  const A = rho + (1 - rho) * Math.cos(half)
  // a corner keeps a few samples even when sharp (its normals fan round it); a flat gets the rest
  const Kc = Math.max(3, Math.round((PER / n) * (polygon ? Math.max(0.2, rho) : 1)))
  const Ke = polygon ? Math.max(2, Math.round((PER / n) * (1 - rho)) + 2) : 0
  const count = n * (Ke + Kc)

  function contour(d) {
    const a = A - d
    const r = Math.max(rho - d, 0)
    const cd = (a - r) / Math.cos(half) // the corners' centres, from the middle
    const pts = []
    for (let k = 0; k < n; k++) {
      const te = -Math.PI / 2 + k * 2 * half // side k's outward normal: side 0 at the bottom
      const ex = Math.cos(te)
      const ey = Math.sin(te)
      const c0x = cd * Math.cos(te - half)
      const c0y = cd * Math.sin(te - half)
      const c1x = cd * Math.cos(te + half)
      const c1y = cd * Math.sin(te + half)
      // the flat, from the corner before it to the corner after it
      for (let i = 0; i < Ke; i++) {
        const t = i / Ke
        pts.push({ x: c0x + r * ex + (c1x - c0x) * t, y: c0y + r * ey + (c1y - c0y) * t, nx: ex, ny: ey })
      }
      // the corner after it: round its centre, from this side's normal to the next's
      for (let i = 0; i < Kc; i++) {
        const phi = te + 2 * half * (i / Kc)
        const cx = Math.cos(phi)
        const cy = Math.sin(phi)
        pts.push({ x: c1x + r * cx, y: c1y + r * cy, nx: cx, ny: cy })
      }
    }
    return pts
  }

  return {
    polygon,
    n,
    rho,
    count,
    contour,
    /* the largest circle inside the outline at inset d, and the smallest round it */
    inscribed: (d) => A - d,
    circumscribed: (d) => {
      const r = Math.max(rho - d, 0)
      return (A - d - r) / Math.cos(half) + r
    },
  }
}
