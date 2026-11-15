// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE LETTERS' OUTLINES — the letter mask (engrave.js's letterMask, white on
   black) traced into THREE.Shapes for letters.js to extrude. No font file:
   the outlines are whatever system-ui drew, so the 3D letters are exactly the
   relief's.

     1  marching squares over ONE getImageData, each crossing placed along its
        cell edge by linear interpolation (so the outline is sub-pixel, not a
        staircase), inside the letters' bounding box only
     2  the segments linked into closed loops through the cell edges they share
     3  Douglas–Peucker, which keeps corners sharp and drops the points a
        straight run does not need
     4  nesting by containment: a loop inside an even number of others is a
        letter's outline, inside an odd number a hole in it (the 0s, the A,
        the P)

   Coordinates come out in unit-coin space (profile.js): x right, y up, the
   face's radius 1. Each outline comes with its stroke width (≈ 2 × area /
   perimeter, holes counted), so letters.js can keep a bevel from eating
   through a thin letter while a fat one gets all of it. */

import * as THREE from 'three'

const T = 128 // the mask's threshold
const SIMPLIFY_PX = 0.35 // Douglas–Peucker tolerance, mask pixels

/* segments per marching-squares case, as pairs of cell edges: 0 top, 1 right,
   2 bottom, 3 left. Corner bits: 8 top-left, 4 top-right, 2 bottom-right, 1
   bottom-left. The two saddles (5, 10) are resolved by the cell's centre */
const CASES = {
  1: [[3, 2]],
  2: [[2, 1]],
  3: [[3, 1]],
  4: [[0, 1]],
  6: [[0, 2]],
  7: [[0, 3]],
  8: [[0, 3]],
  9: [[0, 2]],
  11: [[0, 1]],
  12: [[3, 1]],
  13: [[2, 1]],
  14: [[3, 2]],
}

function simplify(pts, tol) {
  if (pts.length < 4) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [ax, ay] = pts[a]
    const [bx, by] = pts[b]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy) || 1
    let far = -1
    let fd = tol
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len
      if (d > fd) {
        fd = d
        far = i
      }
    }
    if (far >= 0) {
      keep[far] = 1
      stack.push([a, far], [far, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/* a closed loop through Douglas–Peucker: split at the point farthest from the
   first, so the loop's own start is not a forced corner */
function simplifyLoop(loop, tol) {
  let far = 0
  let fd = 0
  for (let i = 1; i < loop.length; i++) {
    const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2
    if (d > fd) {
      fd = d
      far = i
    }
  }
  const a = simplify(loop.slice(0, far + 1), tol)
  const b = simplify([...loop.slice(far), loop[0]], tol)
  return [...a.slice(0, -1), ...b.slice(0, -1)]
}

const area = (p) => {
  let s = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] - p[i][0]) * (p[j][1] + p[i][1])
  return s / 2
}
const perimeter = (p) => {
  let s = 0
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1])
  return s
}
function contains(poly, [x, y]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/* canvas (the mask) → [{ shape, stroke }] in unit-coin space */
export function traceLetters(canvas) {
  const N = canvas.width
  const g = canvas.getContext('2d', { willReadFrequently: true })
  const px = g.getImageData(0, 0, N, N).data
  const v = (x, y) => px[(y * N + x) * 4]

  // the letters' box, so the scan skips the empty field
  let x0 = N
  let y0 = N
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (v(x, y) >= T) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return []
  x0 = Math.max(0, x0 - 1)
  y0 = Math.max(0, y0 - 1)
  x1 = Math.min(N - 2, x1 + 1)
  y1 = Math.min(N - 2, y1 + 1)

  /* the crossing on each cell edge, keyed by the edge (shared by two cells) */
  const W = N + 1
  const hKey = (x, y) => (y * W + x) * 2 //     the horizontal edge from sample (x, y) to (x+1, y)
  const vKey = (x, y) => (y * W + x) * 2 + 1 // the vertical edge from sample (x, y) to (x, y+1)
  const point = new Map()
  const lerp = (a, b) => (T - a) / (b - a || 1)
  const edgeKey = (x, y, e) => {
    const k = e === 0 ? hKey(x, y) : e === 1 ? vKey(x + 1, y) : e === 2 ? hKey(x, y + 1) : vKey(x, y)
    if (!point.has(k)) {
      let p
      if (e === 0) p = [x + lerp(v(x, y), v(x + 1, y)), y]
      else if (e === 2) p = [x + lerp(v(x, y + 1), v(x + 1, y + 1)), y + 1]
      else if (e === 1) p = [x + 1, y + lerp(v(x + 1, y), v(x + 1, y + 1))]
      else p = [x, y + lerp(v(x, y), v(x, y + 1))]
      point.set(k, p)
    }
    return k
  }

  const next = new Map() // edge key → the two edge keys it links to
  const link = (a, b) => {
    ;(next.get(a) ?? next.set(a, []).get(a)).push(b)
    ;(next.get(b) ?? next.set(b, []).get(b)).push(a)
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const tl = v(x, y) >= T
      const tr = v(x + 1, y) >= T
      const br = v(x + 1, y + 1) >= T
      const bl = v(x, y + 1) >= T
      const c = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)
      if (c === 0 || c === 15) continue
      let segs = CASES[c]
      if (c === 5 || c === 10) {
        const centre = (v(x, y) + v(x + 1, y) + v(x + 1, y + 1) + v(x, y + 1)) / 4 >= T
        // the inside joins across the centre (cut off the two outside corners) or does not
        const cutTL_BR = [[0, 3], [2, 1]]
        const cutTR_BL = [[0, 1], [3, 2]]
        segs = c === 5 ? (centre ? cutTL_BR : cutTR_BL) : centre ? cutTR_BL : cutTL_BR
      }
      for (const [ea, eb] of segs) link(edgeKey(x, y, ea), edgeKey(x, y, eb))
    }
  }

  /* walk the links into loops */
  const seen = new Set()
  const loops = []
  for (const start of next.keys()) {
    if (seen.has(start)) continue
    const loop = []
    let prev = -1
    let cur = start
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur)
      loop.push(point.get(cur))
      const [a, b] = next.get(cur)
      const n = a !== prev ? a : b
      prev = cur
      cur = n
    }
    if (loop.length >= 3) loops.push(loop)
  }

  /* simplify, then into unit-coin space: x right, y up, radius 1 */
  const c = N / 2
  const unit = N / 2
  const polys = loops
    .map((l) => simplifyLoop(l, SIMPLIFY_PX))
    .filter((l) => l.length >= 3)
    .map((l) => l.map(([x, y]) => [(x + 0.5 - c) / unit, -(y + 0.5 - c) / unit]))
    .filter((l) => Math.abs(area(l)) > 1e-7)

  /* nesting: how many loops each sits inside; even → an outline, odd → a hole
     in the smallest loop around it */
  const info = polys.map((p) => ({ p, a: Math.abs(area(p)), per: perimeter(p), parent: -1, depth: 0 }))
  info.forEach((me, i) => {
    let best = -1
    info.forEach((other, j) => {
      if (i === j || other.a <= me.a) return
      if (contains(other.p, me.p[0])) {
        me.depth++
        if (best < 0 || other.a < info[best].a) best = j
      }
    })
    me.parent = best
  })
  const byOuter = new Map()
  info.forEach((o, i) => {
    if (o.depth % 2) return
    byOuter.set(i, { shape: new THREE.Shape(o.p.map(([x, y]) => new THREE.Vector2(x, y))), a: o.a, per: o.per })
  })
  info.forEach((o) => {
    if (!(o.depth % 2) || o.parent < 0) return
    const host = byOuter.get(o.parent)
    if (!host) return
    host.shape.holes.push(new THREE.Path(o.p.map(([x, y]) => new THREE.Vector2(x, y))))
    host.a -= o.a
    host.per += o.per
  })
  return [...byOuter.values()].map((h) => ({ shape: h.shape, stroke: (2 * h.a) / h.per }))
}
