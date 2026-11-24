// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Where the collectables float once the bubble has popped: no grid, but no
 * physics either. A loose spot for every piece, worked out only when
 * something changes (the pop, a piece opened, a claim landing, a drag let go,
 * the frame resized). The engine eases each piece to its spot and lets it
 * breathe there, so a frame costs a few multiplications a piece.
 *
 * Opened pieces are light and gather at the top of the frame; unopened ones
 * are heavy and gather at the bottom. Each piece keeps its own side of the
 * frame where it can, so a change moves only what it has to.
 *
 * Plain numbers in the camera's plane, in world units (one collectable cell
 * is 1): u to the right, v up.
 */

/** A piece as the layout sees it. */
export interface FloatPiece {
  /** where it is now: its side of the frame is kept */
  u: number
  v: number
  r: number
  /** light: gathers at the top */
  opened: boolean
  /** 0–1, its own: how far short of the edge it rests, so no layer lines up */
  lift: number
}

/** The frame's edges, as plane coordinates. */
export interface Walls {
  left: number
  right: number
  bottom: number
  top: number
}

export const FLOAT = {
  /** pieces keep at least this many times their summed radii apart */
  halo: 1.45,
  /** air between a piece and an edge of the screen */
  wallPad: 0.2,
  /** how far short of its edge a piece may rest (× its lift): a loose layer, not a row */
  unevenness: 0.35,
  /** the settling: rounds of pulling toward the edge and pushing apart */
  rounds: 40,
  /** rounds of pushing apart only, at the end, so nothing is left overlapping */
  cleanup: 12,
  /** how far a round pulls a piece toward its edge */
  pull: 0.12,
  /** air left between the opened ones and the rest, when both are there */
  gap: 0.5,
  /** the most a pile is spread to fill its share of the frame (× the halo):
   *  a few pieces spread out, they do not scatter */
  maxSpread: 2.2,
  /** how much of its share a pile fills (the rest is air around it) */
  fill: 0.85,
} as const

/**
 * Every piece's resting spot, in the order given. It is the same for the
 * same input.
 *
 * Each kind gets a share of the frame by its count, the opened ones at the
 * top and the rest at the bottom (no opened piece yet, and the unopened ones
 * have it all), so the screen is never half empty. In its share, each kind
 * settles into a loose pile against its own edge: every piece starts at the
 * edge above or below where it is now, and rounds of pulling toward the edge
 * and pushing overlapping pairs apart settle them. The pile's spacing is
 * the widest that still fits its share, so it fills the share evenly in both
 * directions rather than leaving rows with gaps between them. A pile too
 * small to fill its share even at its widest sits in the middle of it.
 */
export function floatLayout(pieces: readonly FloatPiece[], walls: Walls): { u: number; v: number }[] {
  const n = pieces.length
  const pad = (p: FloatPiece) => p.r + FLOAT.wallPad
  const clampU = (p: FloatPiece, u: number) => Math.min(walls.right - pad(p), Math.max(walls.left + pad(p), u))
  const at = pieces.map((p, i) => ({
    // two pieces in the same place split by their order, the same way every time
    u: clampU(p, p.u + (i - (n - 1) / 2) * 1e-3),
    v: 0,
  }))

  /** push apart the pairs among `members` closer than `spread` × their halo, then keep them in [lo, hi] */
  const pushApart = (members: number[], spread: number, lo: number, hi: number) => {
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const i = members[x]!
        const j = members[y]!
        const a = at[i]!
        const b = at[j]!
        const reach = (pieces[i]!.r + pieces[j]!.r) * FLOAT.halo * spread
        const dist = Math.hypot(b.u - a.u, b.v - a.v)
        if (dist >= reach) continue
        // on top of each other: apart sideways
        const nu = dist < 1e-6 ? 1 : (b.u - a.u) / dist
        const nv = dist < 1e-6 ? 0 : (b.v - a.v) / dist
        const half = (reach - dist) / 2
        a.u -= nu * half
        a.v -= nv * half
        b.u += nu * half
        b.v += nv * half
      }
    }
    for (const i of members) {
      at[i]!.u = clampU(pieces[i]!, at[i]!.u)
      at[i]!.v = Math.min(hi, Math.max(lo, at[i]!.v))
    }
  }

  // the shares: the opened ones' at the top, the rest's at the bottom
  const r = Math.max(0, ...pieces.map((p) => p.r))
  const low = walls.bottom + r + FLOAT.wallPad
  const high = walls.top - r - FLOAT.wallPad
  const openCount = pieces.filter((p) => p.opened).length
  const both = openCount > 0 && openCount < n
  const room = high - low - (both ? FLOAT.gap : 0)
  const split = high - room * (openCount / Math.max(1, n))

  for (const kind of [true, false]) {
    const members = pieces.flatMap((p, i) => (p.opened === kind ? [i] : []))
    if (!members.length) continue
    const [lo, hi] = kind ? [both ? split : low, high] : [low, both ? split - FLOAT.gap : high]
    // its edge, each piece held short of it by its own lift
    const edge = (i: number) => (kind ? hi - pieces[i]!.lift * FLOAT.unevenness : lo + pieces[i]!.lift * FLOAT.unevenness)
    /** the pile at this spread: how tall it stands */
    const pile = (spread: number) => {
      for (const i of members) {
        at[i]!.u = clampU(pieces[i]!, pieces[i]!.u + (i - (n - 1) / 2) * 1e-3)
        at[i]!.v = edge(i)
      }
      for (let round = 0; round < FLOAT.rounds; round++) {
        for (const i of members) at[i]!.v = kind ? Math.min(edge(i), at[i]!.v + FLOAT.pull) : Math.max(edge(i), at[i]!.v - FLOAT.pull)
        pushApart(members, spread, lo, hi)
      }
      const vs = members.map((i) => at[i]!.v)
      return Math.max(...vs) - Math.min(...vs)
    }
    // the widest spread whose pile still fits the share
    const target = (hi - lo) * FLOAT.fill
    let fits = 1
    let over: number = FLOAT.maxSpread
    if (pile(over) <= target) fits = over
    else {
      for (let step = 0; step < 7; step++) {
        const mid = (fits + over) / 2
        if (pile(mid) <= target) fits = mid
        else over = mid
      }
    }
    const height = pile(fits)
    // what it leaves of its share: it moves to the middle of it
    const leftover = hi - lo - height
    if (leftover > 0) for (const i of members) at[i]!.v += (kind ? -leftover : leftover) / 2
  }

  // the seam between them, and anything a squeezed share left: nothing overlaps
  const everyone = pieces.map((_, i) => i)
  for (let round = 0; round < FLOAT.cleanup; round++) pushApart(everyone, 1, low, high)
  return at
}
