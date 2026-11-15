// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE CAN'T-REACH STATIC (#1349): a player whose endpoint is out there but
 * whose link will not form gets the static that now and then does something.
 * For an episode the grain collects into a horizontal band that crawls down
 * the tile, smeared sideways like bad VHS tracking, and away from the band
 * the static goes quiet. A no-show's tile (no endpoint) keeps the plain static.
 *
 * Pure: components/game/tv-static.tsx draws what this computes, on the grain's
 * own 128 × 128.
 */

/** the effect's tuned values: how often, the band's height against the
 *  tile's, how hard it pulls the grain in, and how fast it rolls */
export const TRACKING = { amount: 1, size: 0.29, strength: 0.29, speed: 1 } as const

/** the grain's side, px (public/grain.gif) */
export const GRAIN_PX = 128

const smooth = (a: number, b: number, t: number) => {
  const x = t <= a ? 0 : t >= b ? 1 : (t - a) / (b - a)
  return x * x * (3 - 2 * x)
}

/** a fixed 0..1 per (row, seed): the band's rows jitter, not every pixel */
const hash = (y: number, seed: number) => {
  const h = Math.sin(y * 12.9898 + seed * 78.233) * 43758.5453
  return h - Math.floor(h)
}

/** Seconds to the next episode: a Poisson wait at `amount * 0.8` a second.
 *  `random` in [0, 1). */
export function nextEpisodeIn(random: number, amount: number = TRACKING.amount): number {
  return -Math.log(1 - random) / (amount * 0.8)
}

/** An episode's length, s: 1.5 to 3.5. */
export function episodeLife(random: number): number {
  return 1.5 + random * 2
}

/** How much of the episode shows at `a` (0..1 through it): fading in over its
 *  first fifth and out over its last quarter. */
export function episodeEnvelope(a: number): number {
  return smooth(0, 0.2, a) * (1 - smooth(0.75, 1, a))
}

/**
 * The band's pull on each row, `t` s into an episode: about 1 at its middle,
 * 0 away from it, wrapping round the tile. `seed` places it and sets its
 * jitter, which steps a dozen times a second.
 */
export function bandRows(t: number, seed: number, rows = GRAIN_PX, size: number = TRACKING.size, speed: number = TRACKING.speed): Float32Array {
  const out = new Float32Array(rows)
  const hh = Math.max(2, (size * rows) / 2)
  const cy = ((((seed / 1000 + t * speed * 0.35) % 1) + 1) % 1) * rows
  const jit = Math.floor(t * 12) + seed
  for (let y = 0; y < rows; y++) {
    let d = Math.abs(y - cy)
    if (d > rows / 2) d = rows - d
    out[y] = (1 - smooth(0.25, 1, d / hh)) * (0.7 + 0.3 * hash(y, jit))
  }
  return out
}

/**
 * One frame of the band into RGBA `out` (GRAIN_PX² × 4), from `rows` and the
 * envelope `env`. Each pixel takes one draw from `random`: under the band's
 * local strength it lights up, and a lit pixel tends to keep its right-hand
 * neighbour lit, which smears it sideways; away from the band a draw under
 * the pull turns the pixel black (`quiet`'s alpha), so the grain goes quiet.
 */
export function paintBand(out: Uint8ClampedArray, rows: Float32Array, env: number, quiet: number, random: () => number, strength: number = TRACKING.strength): void {
  const k = env * strength
  const width = out.length / 4 / rows.length
  for (let y = 0, i = 0; y < rows.length; y++) {
    const field = rows[y] ?? 0
    const f = field * k
    let lit = false
    for (let x = 0; x < width; x++, i += 4) {
      const r = random()
      const th = f * (lit ? 0.9 : 0.55)
      if (r < th) {
        lit = true
        out[i] = out[i + 1] = out[i + 2] = (200 + 55 * (1 - r / th)) | 0
        out[i + 3] = (255 * Math.min(1, 0.35 + f)) | 0
      } else if ((r * 7919) % 1 < k * (1 - field)) {
        lit = false
        out[i] = out[i + 1] = out[i + 2] = 0
        out[i + 3] = (255 * quiet) | 0
      } else {
        lit = false
        // a faint lift of the grain round the lit runs
        out[i] = out[i + 1] = out[i + 2] = 255
        out[i + 3] = (f * 60 * r) | 0
      }
    }
  }
}
