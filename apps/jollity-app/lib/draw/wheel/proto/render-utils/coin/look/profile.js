// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE COIN'S SOLID — a half-profile at unit radius, swept along the coin's
   outline (shape.js: round, or a rounded polygon) into three meshes' worth of
   geometry: the front face, the back face and the edge band.
   The coin's radius is the mesh's scale (coinR), so this only rebuilds when
   the PROPORTIONS change.

   The half-profile, centre outward (z toward the viewer):

      field     slightly dished, flat to the eye — where the letters go
      wall      an S-curve up to the rim (rimH over wall)
      rim top   flat — where the rim pattern goes
      arc       a quarter-round down to the edge (bevel b × edgeRound: 0 a sharp corner)
      edge      straight, the edge band's own mesh (reeded by the shader)

   The profile is written as a radius r from the middle; on a polygon, the rim
   part of it is read as an inset (1 − r) from the outline, so the rim keeps
   one width all the way round. Normals are analytic (the profile's slope
   turned onto the outline's normal), not averaged, so the seam and the centre
   are exact. UVs on the faces are PLANAR — u = x/2 + ½ at unit
   radius — so the engraving maps (engrave.js) land on the face as drawn; the
   back is mirrored in u so its art reads right way round from behind. The
   edge's UV is (length round the perimeter, height): u runs round the coin,
   v across its thickness. */

import * as THREE from 'three'
import { coinShape } from './shape.js'

const smooth = (u) => u * u * (3 - 2 * u)

/* the half-profile as [{ r, z, nr, nz }], and where the rim top starts and
   ends (the engraving's rim band) */
export function profile({ thick, rimW, edgeRound = 1 }) {
  const t = Math.max(0.01, thick)
  const w = Math.min(0.4, Math.max(0.02, rimW))
  const zRim = t / 2
  const rimH = t * 0.28 //                 the rim stands this far over the field
  const dish = t * 0.1 //                  …and the field's centre sits this much lower still
  const b = Math.max(0, Math.min(1, edgeRound)) * Math.min(t * 0.4, w * 0.4) // the outer quarter-round; 0: its rings meet at the corner
  const wall = w * 0.35 //                 the inner wall's run
  const zField = zRim - rimH
  const rIn = 1 - w
  const pts = []
  const push = (r, z, slope) => {
    const l = Math.hypot(slope, 1)
    pts.push({ r, z, nr: -slope / l, nz: 1 / l })
  }
  const NF = 28
  for (let i = 0; i <= NF; i++) {
    const r = rIn * (i / NF)
    push(r, zField - dish * (1 - (r / rIn) ** 2), (2 * dish * r) / (rIn * rIn))
  }
  const NW = 10
  for (let i = 1; i <= NW; i++) {
    const u = i / NW
    push(rIn + wall * u, zField + rimH * smooth(u), (rimH * 6 * u * (1 - u)) / wall)
  }
  const rTop0 = rIn + wall
  const rTop1 = 1 - b
  const NT = 6
  for (let i = 1; i <= NT; i++) push(rTop0 + ((rTop1 - rTop0) * i) / NT, zRim, 0)
  const NA = 10
  for (let i = 1; i <= NA; i++) {
    const phi = (i / NA) * (Math.PI / 2)
    pts.push({ r: rTop1 + b * Math.sin(phi), z: zRim - b + b * Math.cos(phi), nr: Math.sin(phi), nz: Math.cos(phi) })
  }
  return { pts, edgeZ: zRim - b, rimBand: [rTop0, rTop1], fieldR: rIn, fieldZ: zField - dish }
}

/* one face: the profile swept along the outline, z mirrored for the back.
   The rim's rings are the outline's insets (contour(1 − r)) with the
   profile's normal turned onto the outline's; the field's rings are the
   field's own outline, shrunk toward the middle */
function face(pts, back, S, rIn) {
  const count = S.count
  const rings = pts.length
  const cols = count + 1
  const pos = new Float32Array(rings * cols * 3)
  const nrm = new Float32Array(rings * cols * 3)
  const uv = new Float32Array(rings * cols * 2)
  const s = back ? -1 : 1
  const fieldC = S.contour(1 - rIn)
  for (let i = 0; i < rings; i++) {
    const p = pts[i]
    const rim = p.r >= rIn - 1e-9
    const C = rim ? S.contour(1 - p.r) : fieldC
    const k = rim ? 1 : p.r / rIn
    for (let j = 0; j < cols; j++) {
      const q = C[j % count]
      const x = q.x * k
      const y = q.y * k
      let dx = q.nx
      let dy = q.ny
      if (!rim) {
        // the dish leans toward the middle along the point's own direction
        const l = Math.hypot(x, y)
        dx = l > 1e-9 ? x / l : 0
        dy = l > 1e-9 ? y / l : 0
      }
      const v = i * cols + j
      pos.set([x, y, s * p.z], v * 3)
      nrm.set([p.nr * dx, p.nr * dy, s * p.nz], v * 3)
      uv.set([back ? 0.5 - x / 2 : 0.5 + x / 2, 0.5 + y / 2], v * 2)
    }
  }
  const idx = []
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < count; j++) {
      const a = i * cols + j
      const b = (i + 1) * cols + j
      const c = b + 1
      const d = a + 1
      if (back) idx.push(a, c, b, a, d, c)
      else idx.push(a, b, c, a, c, d)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

/* the edge band: the outline itself, straight up and down; u runs round the
   perimeter by length, so the reeding is even along flats and corners */
function edge(z, S) {
  const C = S.contour(0)
  const count = S.count
  const cols = count + 1
  const len = [0]
  for (let j = 1; j < cols; j++) {
    const a = C[j - 1]
    const b = C[j % count]
    len.push(len[j - 1] + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const perimeter = len[count] || 1
  const pos = new Float32Array(cols * 2 * 3)
  const nrm = new Float32Array(cols * 2 * 3)
  const uv = new Float32Array(cols * 2 * 2)
  for (let j = 0; j < cols; j++) {
    const q = C[j % count]
    for (let row = 0; row < 2; row++) {
      const k = row * cols + j
      pos.set([q.x, q.y, row ? -z : z], k * 3)
      nrm.set([q.nx, q.ny, 0], k * 3)
      uv.set([len[j] / perimeter, row ? 0 : 1], k * 2)
    }
  }
  const idx = []
  for (let j = 0; j < count; j++) {
    const top = j
    const bot = cols + j
    idx.push(top, bot, bot + 1, top, bot + 1, top + 1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setIndex(idx)
  return g
}

/* the solid, and what the engraving and the glints need to know of its shape:
     fieldIn / fieldOut   the field's inscribed and circumscribed radii — the
                          letters fit in the first, a pattern reaches the second
     outline              the field's contour and the rim band's two, for
                          clipping the engraving's canvas (unit-coin points)
     rimAt(angle)         a point on the rim's outer curve, for the glints */
export function coinGeometry({ thick, rimW, sides = 0, round = 1, edgeRound = 1 }) {
  const p = profile({ thick, rimW, edgeRound })
  const S = coinShape({ sides, round })
  const dField = 1 - p.fieldR
  const rimMid = S.contour(1 - (p.rimBand[1] + 1) / 2)
  const angles = rimMid.map((q) => Math.atan2(q.y, q.x))
  const rimAt = (a) => {
    let best = 0
    let bd = Infinity
    for (let j = 0; j < angles.length; j++) {
      const d = Math.abs(Math.atan2(Math.sin(angles[j] - a), Math.cos(angles[j] - a)))
      if (d < bd) {
        bd = d
        best = j
      }
    }
    return rimMid[best]
  }
  return {
    front: face(p.pts, false, S, p.fieldR),
    back: face(p.pts, true, S, p.fieldR),
    edge: edge(Math.max(0.001, p.edgeZ), S),
    fieldZ: p.fieldZ,
    edgeZ: p.edgeZ, // the straight edge's half-height: the whole half-thickness when edgeRound is 0
    fieldIn: S.inscribed(dField),
    fieldOut: S.circumscribed(dField),
    outline: {
      field: S.contour(dField),
      bandOuter: S.contour(1 - p.rimBand[1]),
      bandInner: S.contour(1 - p.rimBand[0]),
      bandIn: S.inscribed(1 - p.rimBand[0]),
      bandOut: S.circumscribed(1 - p.rimBand[1]),
    },
    rimAt,
    shape: S,
  }
}
