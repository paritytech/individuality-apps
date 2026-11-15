// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The coin generator — turns the coin's proportions into a three.js
// BufferGeometry.
//
// The shape is a lofted rim: ./coinGeometry.ts gives the outline of the
// hexagon with rounded vertical edges, and this file sweeps a vertical PROFILE
// along it. The profile is a straight wall with a quarter-round lip at
// the top and at the bottom, so the coin has no sharp edge anywhere and reads
// as a turned metal part rather than as folded paper.
//
// Normals are computed from the sweep, not from averaged triangles. Every point
// on the rim knows its own outward direction and every point on the profile
// knows its own tilt, so a flat face gets one exact normal and a rounded corner
// gets a smooth run of them. computeVertexNormals() would smear the two
// together at the join.
//
// The geometry carries TWO groups: 0 is the engraved wall, 1 is the top and
// bottom faces. They take different materials — see coinMaterial.ts.

import * as THREE from 'three'
import { coinOutline } from './coinGeometry'

/** How far the coin leans back, in radians. The top face has to show, and the
 *  shader reads this to decide how square to the camera a face must be before
 *  it counts as the one turned to the player. */
export const COIN_TILT = 16 * (Math.PI / 180)

export interface CoinMeshParams {
  /** Coin height, as a fraction of the circumradius. Measured off the layout
   *  box so the CSS dials still own the proportions. */
  height: number
  /** Top and bottom lip radius, as a fraction of the coin height. */
  rimRadius?: number
  /** Samples across one full vertical edge. */
  cornerSegments?: number
  /** Samples across one lip. */
  rimSegments?: number
}

export interface CoinMeshResult {
  geometry: THREE.BufferGeometry
  /** How much of one face's texture band the flat part covers. */
  flatFraction: number
  /** Width over height of one face's texture band, in world units. The atlas
   *  sizes its tiles from this, so the engraving keeps its shape at every coin
   *  thickness. */
  bandAspect: number
}

/** Build the coin. The caller owns the geometry and must dispose of it. */
export function buildCoinGeometry({
  height,
  rimRadius = 0.16,
  cornerSegments = 10,
  rimSegments = 4
}: CoinMeshParams): CoinMeshResult {
  const outline = coinOutline(undefined, cornerSegments)
  const ring = outline.points
  const halfH = height / 2
  // Cap the lip so a short coin keeps a straight wall to engrave.
  const lip = Math.max(0.001, Math.min(rimRadius * height, 0.34 * height))
  const straightTop = halfH - lip
  const straightH = 2 * straightTop

  // The vertical profile, bottom lip first. `a` is the angle the surface has
  // turned through: -90° looks straight down, 0° looks straight out, +90°
  // looks straight up. `yc` is the center of the arc that angle belongs to.
  const profile: { a: number; yc: number }[] = []
  for (let i = 0; i <= rimSegments; i++) {
    profile.push({ a: -Math.PI / 2 + (Math.PI / 2) * (i / rimSegments), yc: -straightTop })
  }
  for (let i = 0; i <= rimSegments; i++) {
    profile.push({ a: (Math.PI / 2) * (i / rimSegments), yc: straightTop })
  }

  const pos: number[] = []
  const nrm: number[] = []
  const uvs: number[] = []
  const wall: number[] = []
  const caps: number[] = []

  // ── The wall ─────────────────────────────────────────────────────────────
  const M = ring.length
  const P = profile.length
  for (let i = 0; i < M; i++) {
    const p = ring[i]!
    for (let j = 0; j < P; j++) {
      const { a, yc } = profile[j]!
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      // The lip pulls the surface inward as it turns away from horizontal.
      const inset = lip * (ca - 1)
      const y = yc + lip * sa
      pos.push(p.x + p.nx * inset, y, p.z + p.nz * inset)
      // Already unit: (nx, nz) is unit in the plane and (ca, sa) is unit in
      // the vertical section.
      nrm.push(p.nx * ca, sa, p.nz * ca)
      // v runs 0..1 over the STRAIGHT wall only. The lips fall outside that
      // range and clamp to the atlas edge, which is transparent, so nothing of
      // the engraving smears round the rim.
      uvs.push(p.u, (y + straightTop) / straightH)
    }
  }
  for (let i = 0; i < M - 1; i++) {
    for (let j = 0; j < P - 1; j++) {
      const a = i * P + j
      const b = (i + 1) * P + j
      wall.push(a, b, b + 1, a, b + 1, a + 1)
    }
  }

  // ── The two flat faces ───────────────────────────────────────────────────
  // Their edge sits exactly where the lip ends, so the join is seamless. They
  // need their own vertices because their normals and their texture
  // coordinates have nothing to do with the wall's.
  for (const sign of [1, -1] as const) {
    const y = sign * halfH
    const center = pos.length / 3
    pos.push(0, y, 0)
    nrm.push(0, sign, 0)
    uvs.push(0, 0)
    for (let i = 0; i < M; i++) {
      const p = ring[i]!
      const x = p.x - p.nx * lip
      const z = p.z - p.nz * lip
      pos.push(x, y, z)
      nrm.push(0, sign, 0)
      // u carries the distance from the axis, so the face material can shade a
      // radial gradient without a texture.
      uvs.push(Math.hypot(x, z), 0)
    }
    for (let i = 0; i < M - 1; i++) {
      const a = center + 1 + i
      const b = center + 2 + i
      if (sign > 0) caps.push(center, a, b)
      else caps.push(center, b, a)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex([...wall, ...caps])
  geometry.addGroup(0, wall.length, 0)
  geometry.addGroup(wall.length, caps.length, 1)

  return {
    geometry,
    flatFraction: outline.flatFraction,
    bandAspect: outline.blockLength / straightH
  }
}
