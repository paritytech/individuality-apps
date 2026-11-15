// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Collection-coin geometry — pure data and math. No DOM, no three.js, no React.
//
// ./useCoinTurn.ts owns the pointer events and the settle loop, ./coinMesh.ts
// turns the numbers below into a mesh, and this file owns the arithmetic.
// Nothing here knows how the coin is drawn.
//
// THE COIN IS ALWAYS A HEXAGON. The side count is a constant, not a parameter.
// The collection count is a separate number and it is free — see
// ./facetWheel.ts, which maps any number of collections onto these six
// faces. The rim outline below is still generated, so the corner radius and the
// segment counts stay dials.

/** How many faces the coin has. Fixed. The number of collections has nothing to
 *  do with it. */
export const COIN_SIDES = 6

/** How round the vertical edges are, as a fraction of the circumradius. One
 *  machining radius, the way a real cutter would leave it. */
const CORNER_RADIUS = 0.22

/** How long the coin takes to settle after the finger lets go. */
export const SPIN_MS = 1000

// ── The rim outline ────────────────────────────────────────────────────────

/** One point on the coin's rim, in the coin's own plane at circumradius 1.
 *
 *  `x` runs right, `z` runs toward the player. `nx`/`nz` is the outward unit
 *  normal at that point — flat along a face, turning through a corner, which is
 *  what makes the faces read flat and the corners read round. `u` is the
 *  texture coordinate around the rim: face k owns exactly [k/6, (k+1)/6], with
 *  its flat centered in that band. */
interface RimPoint {
  x: number
  z: number
  nx: number
  nz: number
  u: number
}

export interface CoinOutline {
  /** The closed ring, first point repeated at the end with `u` = 1 so the
   *  texture seam has two coordinates instead of one. */
  points: RimPoint[]
  /** How much of one face's texture band the FLAT part covers. The engraving
   *  has to stay inside this, or the name bends round the corner. */
  flatFraction: number
  /** Distance from the axis to a flat face, as a fraction of the
   *  circumradius. */
  apothem: number
  /** The corner radius the generator actually used, after the cap. */
  cornerRadius: number
  /** Rim length of one face plus one corner — the perimeter divided by six.
   *  The texture atlas sizes a face's tile from it, so the engraving keeps its
   *  shape when the coin's proportions change. */
  blockLength: number
}

/** Build the rim of the hexagonal coin with rounded vertical edges.
 *
 *  Physical face k faces straight at the player when the coin has turned k
 *  steps. Which COLLECTION that face carries is a separate question — see
 *  ./facetWheel.ts.
 *
 *  Each corner is a circular arc tangent to both neighboring faces. The ring
 *  starts at the MIDDLE of the corner before face 0, so every face sits in the
 *  center of its own texture band with half a corner on each side. */
export function coinOutline(
  cornerRadius: number = CORNER_RADIUS,
  cornerSegments: number = 10
): CoinOutline {
  // Half the angle one face spans. Every length below is a function of it.
  const half = Math.PI / COIN_SIDES
  const apothem = Math.cos(half)
  // A hexagon's apothem is 0.866, so the constant above never reaches this
  // clamp. It is here so an edited constant cannot make a negative flat.
  const cr = Math.max(0, Math.min(cornerRadius, apothem))
  // Distance from the axis to a corner arc's center. The center sits `cr`
  // inside both faces it touches, so it is the inset apothem divided by the
  // cosine of the half angle.
  const centerDist = (apothem - cr) / Math.cos(half)

  const flatLen = 2 * (apothem - cr) * Math.tan(half)
  const arcLen = cr * 2 * half
  const blockLen = flatLen + arcLen
  const halfArcSegs = Math.max(1, Math.ceil(cornerSegments / 2))

  const points: RimPoint[] = []

  /** Append one point of a corner arc. `dir` is the angle of the outward
   *  normal there, measured from +z toward +x, which is also the angle the arc
   *  is swept through. */
  function pushArc(centerAngle: number, dir: number, u: number): void {
    const cx = Math.sin(centerAngle) * centerDist
    const cz = Math.cos(centerAngle) * centerDist
    const nx = Math.sin(dir)
    const nz = Math.cos(dir)
    points.push({ x: cx + nx * cr, z: cz + nz * cr, nx, nz, u })
  }

  for (let k = 0; k < COIN_SIDES; k++) {
    // Face k's outward direction. The whole block is built around it.
    const phi = k * 2 * half
    const uBase = k / COIN_SIDES
    /** Arc length `s` into this block, as a texture coordinate. */
    const uAt = (s: number): number => uBase + s / blockLen / COIN_SIDES

    // 1. The second half of the corner BEFORE face k, from its midpoint up to
    //    where face k's flat begins.
    for (let i = 0; i <= halfArcSegs; i++) {
      // k > 0 shares its first point with the previous block's last one. The
      // ring is welded, so emitting it twice would give two normals at one
      // place and put a visible crease in the corner.
      if (i === 0 && k > 0) continue
      const q = i / halfArcSegs
      pushArc(phi - half, phi - half + half * q, uAt((arcLen / 2) * q))
    }

    // 2. The flat. Its far end is the tangent point of the NEXT corner, so
    //    only that one point is new — the near end came out of step 1.
    const cNext = phi + half
    const cnx = Math.sin(cNext) * centerDist
    const cnz = Math.cos(cNext) * centerDist
    points.push({
      x: cnx + Math.sin(phi) * cr,
      z: cnz + Math.cos(phi) * cr,
      nx: Math.sin(phi),
      nz: Math.cos(phi),
      u: uAt(arcLen / 2 + flatLen)
    })

    // 3. The first half of the corner AFTER face k, up to its midpoint. Its
    //    first point is the flat's far end, already pushed.
    for (let i = 1; i <= halfArcSegs; i++) {
      const q = i / halfArcSegs
      pushArc(cNext, phi + half * q, uAt(arcLen / 2 + flatLen + (arcLen / 2) * q))
    }
  }

  // Close the ring. Same place as points[0], but at u = 1 — one vertex cannot
  // hold both ends of the texture, and without the copy the last block would
  // be squeezed back across the whole atlas.
  const first = points[0]!
  points.push({ x: first.x, z: first.z, nx: first.nx, nz: first.nz, u: 1 })

  return {
    points,
    flatFraction: flatLen / blockLen,
    apothem,
    cornerRadius: cr,
    blockLength: blockLen
  }
}

// ── The turn ───────────────────────────────────────────────────────────────

/** Degrees between two neighboring faces. Six of them make one whole turn. */
export function stepAngle(): number {
  return 360 / COIN_SIDES
}

/** The COLLECTION now square to the camera, given the float `turns`.
 *
 *  `turns` counts faces, not degrees, and it is unbounded, so the front face is
 *  the rounded value. `count` is how many collections exist, which is NOT the
 *  side count. Wrapped twice so a negative `turns` still lands in [0, count). */
export function facetIndex(turns: number, count: number): number {
  const n = Math.max(1, count)
  return ((Math.round(turns) % n) + n) % n
}

/** Where a released drag settles.
 *
 *  A finger still moving at release carries the coin one face further, in the
 *  direction it was going. Below the threshold the coin just squares up to the
 *  nearest face. `velocityPx` is the last pointermove delta in px, so it is
 *  positive when the finger moved right. */
export function settleTurns(turns: number, velocityPx: number): number {
  let t = turns
  if (Math.abs(velocityPx) > 10) t += velocityPx < 0 ? 0.5 : -0.5
  return Math.round(t)
}

/** The settle curve, cubic-bezier(0.3, 0.12, 0.1, 1.004).
 *
 *  A mesh has no CSS transitions, so the curve lives here and the turn hook
 *  drives it from a rAF loop. The tail passes 1 and comes back, which is the small
 *  overshoot that makes the metal feel heavy. */
export function spinEase(x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  // Bisection rather than Newton: 20 halvings put the error under 1e-6 and the
  // loop cannot diverge on the near-flat start of this curve.
  let lo = 0
  let hi = 1
  let t = x
  for (let i = 0; i < 20; i++) {
    t = (lo + hi) / 2
    if (bezier1D(t, 0.3, 0.1) < x) lo = t
    else hi = t
  }
  return bezier1D(t, 0.12, 1.004)
}

/** One axis of a cubic bezier with fixed endpoints 0 and 1. */
function bezier1D(t: number, a: number, b: number): number {
  const mt = 1 - t
  return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t
}
