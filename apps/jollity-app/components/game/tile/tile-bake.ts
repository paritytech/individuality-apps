// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { TILE_RADIUS_PX } from "../animations"
import { TILE_PX } from "./tile-geometry"
import { ScratchCanvas, releaseCanvas } from "@/lib/dom/canvas"

/**
 * The tile's soft light, baked once into images: a CSS `filter: blur()` is
 * redone every frame its layer draws (every frame of a turn or a live feed).
 */

/** device px per tile px in a baked image: the light is soft, so this is plenty */
const BAKE_SCALE = 2

interface Blur {
  /** the blur's standard deviation in tile px: CSS `blur(Npx)` is N */
  sigma: number
  alpha: number
}

interface Baked {
  /** kept for a canvas that draws it (the pools); null once only its URL is wanted */
  canvas: HTMLCanvasElement | null
  /** the same image as a CSS `url()` */
  url: string
}
const cache = new Map<string, Baked>()

/** the tile's rounded square, grown by `grow` px all round, with its corner at `at` px */
function roundedSquare(at: number, grow = 0): Path2D {
  const path = new Path2D()
  path.roundRect(at - grow, at - grow, TILE_PX + 2 * grow, TILE_PX + 2 * grow, TILE_RADIUS_PX + grow)
  return path
}

/**
 * `shape` (in tile px) blurred once per entry of `blurs`, the layers stacked as
 * CSS stacks them, minus `hole` when given. A square image `size` tile px wide.
 */
function bake(key: string, shape: Path2D, size: number, blurs: Blur[], keepCanvas = true, hole?: Path2D): Baked | null {
  const hit = cache.get(key)
  if (hit) return hit
  if (typeof document === "undefined") return null
  const px = Math.ceil(size * BAKE_SCALE)
  const { canvas, ctx } = new ScratchCanvas(px)
  // the blur is a shadow of a shape filled off-canvas: shadows blur in every
  // WebView, `ctx.filter` does not (shadow sizes are in device px)
  const away = px * 2
  for (const { sigma, alpha } of blurs) {
    ctx.save()
    ctx.shadowColor = `rgba(255,255,255,${alpha})`
    ctx.shadowBlur = sigma * 2 * BAKE_SCALE
    ctx.shadowOffsetX = away
    ctx.setTransform(BAKE_SCALE, 0, 0, BAKE_SCALE, -away, 0)
    ctx.fill(shape)
    ctx.restore()
  }
  if (hole) {
    // the light only round the tile, none under it
    ctx.save()
    ctx.globalCompositeOperation = "destination-out"
    ctx.setTransform(BAKE_SCALE, 0, 0, BAKE_SCALE, 0, 0)
    ctx.fill(hole)
    ctx.restore()
  }
  const baked: Baked = { canvas, url: `url(${canvas.toDataURL()})` }
  if (!keepCanvas) {
    // only the URL is wanted: free the canvas's pixels now
    releaseCanvas(canvas)
    baked.canvas = null
  }
  cache.set(key, baked)
  return baked
}


// ── the pool under the tile ─────────────────────────────────────────────
/** how far past the tile the pool's image reaches: the widest blur's 3σ past its pad */
export const POOL_BAKE_PAD_PX = 26

/** the pool's two layers, a tight band and a haze, as tile.css drew them with `filter` */
export type PoolLook = "verdict" | "rim-band" | "rim-band-role" | "rim-hair" | "rim-hair-role"
const POOL_BLURS: Record<PoolLook, Blur[]> = {
  // the approve verdict's plain light
  verdict: [{ sigma: 6, alpha: 0.4 }, { sigma: 2.5, alpha: 0.9 }],
  // the colour wheel round a turned card
  "rim-band": [{ sigma: 4, alpha: 0.4 }, { sigma: 2.6, alpha: 1 }],
  "rim-band-role": [{ sigma: 4, alpha: 0.2 }, { sigma: 2.6, alpha: 0.95 }],
  // the wheel as a hairline, round a pending tile in its cue and round a role tile
  "rim-hair": [{ sigma: 2.5, alpha: 0.4 }, { sigma: 0.8, alpha: 1 }],
  "rim-hair-role": [{ sigma: 2.5, alpha: 0.2 }, { sigma: 0.8, alpha: 0.95 }],
}

/** the pool's light as an alpha image, for a box POOL_BAKE_PAD_PX past the tile */
export function poolImage(look: PoolLook, poolGrow: number): HTMLCanvasElement | null {
  const key = `pool|${look}|${poolGrow}`
  const hit = cache.get(key)
  if (hit?.canvas) return hit.canvas
  const size = TILE_PX + 2 * POOL_BAKE_PAD_PX
  // a ring, so nothing shows under a turning tile; the hole sits a px inside its edge
  const hole = roundedSquare(POOL_BAKE_PAD_PX, -1)
  return bake(key, roundedSquare(POOL_BAKE_PAD_PX, poolGrow), size, POOL_BLURS[look], true, hole)?.canvas ?? null
}

// ── the landing ─────────────────────────────────────────────────────────
/** the aura and the waves reach this far past the tile */
export const LANDING_BAKE_PAD_PX = 28

/** the landing's white silhouettes: the aura, the wave and its fainter twin */
export function landingImage(kind: "aura" | "wave" | "wave-faint"): string {
  const hit = cache.get(`landing|${kind}`)
  if (hit) return hit.url
  const blur: Blur =
    kind === "aura" ? { sigma: 9, alpha: 0.75 } : { sigma: 3, alpha: kind === "wave" ? 0.75 : 0.45 }
  const size = TILE_PX + 2 * LANDING_BAKE_PAD_PX
  return bake(`landing|${kind}`, roundedSquare(LANDING_BAKE_PAD_PX), size, [blur], false)?.url ?? ""
}
