// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE 3D LETTERS — the traced outlines (trace.js) extruded into real
   geometry standing on the face, for when the relief map is not enough: real
   letters move against the field as the coin tilts, their edges cover it,
   and their bevels are actual surfaces reflecting the room.

   ExtrudeGeometry does the work: a straight wall, a bevel round its top edge,
   a flat cap. The PROFILE picks the bevel, in the same words as the relief's:

     struck   a vertical wall with a small round shoulder (a third of the height)
     rounded  all bevel — a quarter round from the foot to the cap
     chamfer  all bevel — one flat 45°-ish facet

   bevelOffset = −bevelSize keeps the wall ON the traced outline and pulls the
   cap in, so the letters' footprint is exactly the relief's. The bevel is
   capped at a share of each letter's own stroke, so a thin CASH keeps its cap
   while a fat 200 gets the whole bevel. Normals: the caps are flat (they are
   triangulated from their outline alone, so any smoothing there would tilt
   every vertex and facet the cap); the walls and bevel are smoothed along the
   outline and across the bevel's steps but creased at the letters' corners
   (toCreasedNormals) — ExtrudeGeometry's own are flat per triangle, which
   shows every segment of a curve as a facet in the reflection.

   THE CAP'S OUTLINE: three triangulates the cap from the outline already
   pulled in by the bevel. The trace leaves sub-pixel chamfers on every corner
   (marching squares cuts a square corner at 45°); pulled in by more than their
   own length they cross over, the triangulation gives up, and the cap comes
   out a few wrong triangles — a wedge across an L. So an edge shorter than the
   pull-in is folded into the corner its neighbours meet at (sharp, as the
   letter was drawn), and a cap that still comes out short of triangles is
   extruded again with half the bevel.

   UVs: the cap gets the face's planar UV (u = x/2 + ½), so the brush and the
   grain line up with the field; walls get a wall-local UV, which only has to
   be non-degenerate — the shader's tangent frame is built from it. */

import * as THREE from 'three'
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const V2 = (x, y) => new THREE.Vector2(x, y)

/* the face's planar UV on the caps, three's own wall UV on the sides */
const UV = {
  generateTopUV(geometry, v, a, b, c) {
    return [a, b, c].map((i) => V2(v[i * 3] / 2 + 0.5, v[i * 3 + 1] / 2 + 0.5))
  },
  generateSideWallUV(geometry, v, a, b, c, d) {
    const along = Math.abs(v[a * 3 + 1] - v[b * 3 + 1]) < Math.abs(v[a * 3] - v[b * 3]) ? 0 : 1
    return [a, b, c, d].map((i) => V2(v[i * 3 + along], 1 - v[i * 3 + 2]))
  },
}

/* the bevel in each profile: its height as a share of the letter's, how far
   in it runs as a share of the dialled bevel, its steps, and the crease */
const PROFILE = {
  struck: { up: 0.33, run: 0.45, steps: 3, crease: 0.95 },
  rounded: { up: 0.9, run: 1, steps: 6, crease: 0.95 },
  chamfer: { up: 0.9, run: 1, steps: 1, crease: 0.6 },
}

/* one of ExtrudeGeometry's groups (0: the caps, 1: the walls and bevel) as
   a geometry of its own */
function slice(g, group) {
  const out = new THREE.BufferGeometry()
  for (const name of ['position', 'uv']) {
    const a = g.attributes[name]
    out.setAttribute(name, new THREE.BufferAttribute(a.array.slice(group.start * a.itemSize, (group.start + group.count) * a.itemSize), a.itemSize))
  }
  return out
}

/* the lines through a→b and c→d, where they cross (null when parallel) */
function cross(a, b, c, d) {
  const r = b.clone().sub(a)
  const s = d.clone().sub(c)
  const den = r.x * s.y - r.y * s.x
  if (Math.abs(den) < 1e-12) return null
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den
  return a.clone().addScaledVector(r, t)
}

/* a closed outline with every edge shorter than minLen folded into the corner
   its neighbours meet at — or its midpoint, when they meet far off (a curve) */
function tidy(pts, minLen) {
  const p = pts.map((q) => q.clone())
  if (p.length > 1 && p[0].distanceTo(p[p.length - 1]) < 1e-9) p.pop()
  let changed = true
  while (changed && p.length > 3) {
    changed = false
    let at = -1
    let best = minLen
    for (let i = 0; i < p.length; i++) {
      const d = p[i].distanceTo(p[(i + 1) % p.length])
      if (d < best) {
        best = d
        at = i
      }
    }
    if (at < 0) break
    const n = p.length
    const a = p[(at - 1 + n) % n]
    const b = p[at]
    const c = p[(at + 1) % n]
    const d = p[(at + 2) % n]
    const mid = b.clone().add(c).multiplyScalar(0.5)
    const x = cross(a, b, c, d)
    const q = x && x.distanceTo(mid) < minLen * 2 ? x : mid
    // b and c become q (the edge from the last point wraps to the first)
    if (at === n - 1) {
      p[n - 1] = q
      p.shift()
    } else p.splice(at, 2, q)
    changed = true
  }
  return p
}

/* the shape again, its outline and holes tidied for a pull-in of minLen */
function tidyShape(shape, minLen) {
  const out = new THREE.Shape(tidy(shape.getPoints(), minLen))
  for (const h of shape.holes) out.holes.push(new THREE.Path(tidy(h.getPoints(), minLen)))
  return out
}

/* how many triangles a cap of this shape should have: earcut makes n − 2, and
   each hole adds its points and two more */
const capTriangles = (shape) => shape.getPoints().length - 2 + shape.holes.reduce((s, h) => s + h.getPoints().length + 2, 0)

/* letters → one geometry, in unit-coin space, its caps at z = height and its
   foot at z = 0. ExtrudeGeometry bevels BOTH ends; the back bevel is flattened
   onto the foot, or a tall bevel would reach through a thin coin and show on
   the other face.
     height  the letters' height (unit-coin: the diameter is 2)
     bevel   the bevel's run (unit-coin) */
export function letterGeometry(letters, { height, bevel, profile }) {
  const P = PROFILE[profile] ?? PROFILE.struck
  const bt = height * P.up
  const depth = Math.max(height * 0.02, height - bt)
  const parts = []
  let retried = 0 //  letters extruded again with a smaller bevel
  let broken = 0 //   …and still short of triangles after that
  for (const { shape: traced, stroke } of letters) {
    let bs = Math.max(1e-5, Math.min(bevel * P.run, stroke * 0.22)) // the cap keeps at least ~half the stroke
    const shape = tidyShape(traced, bs * 1.5)
    const want = capTriangles(shape)
    let g
    for (let tries = 0; ; tries++) {
      g = new THREE.ExtrudeGeometry(shape, {
        depth,
        steps: 1,
        bevelEnabled: true,
        bevelThickness: bt,
        bevelSize: bs,
        bevelOffset: -bs,
        bevelSegments: P.steps,
        curveSegments: 1,
        UVGenerator: UV,
      })
      // both caps, three vertices a triangle: a short count is a failed triangulation
      if (g.groups[0].count >= want * 6) break
      if (tries === 4) {
        broken++
        break
      }
      if (!tries) retried++
      g.dispose()
      bs /= 2
    }
    g.translate(0, 0, height - depth - bt)
    const pos = g.attributes.position.array
    for (let i = 2; i < pos.length; i += 3) if (pos[i] < 0) pos[i] = 0
    const [capsG, sidesG] = g.groups
    const caps = slice(g, capsG)
    caps.computeVertexNormals() // non-indexed: flat, (0, 0, ±1)
    parts.push(caps, toCreasedNormals(slice(g, sidesG), P.crease)) // non-indexed in, so it creases in place
    g.dispose()
  }
  if (!parts.length) return null
  const merged = mergeGeometries(parts, false)
  for (const g of parts) g.dispose()
  merged.userData.caps = { letters: letters.length, retried, broken }
  return merged
}
