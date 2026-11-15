// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"

/**
 * The tile's geometry. The tile draws at TILE_PX and every `path()` clip below
 * assumes that size; the tile's wrapper scales the whole box to its cell.
 */
export const TILE_PX = 183

// ── the slab and the perspective ──────────────────────────────────────────
/** the tile is a slab: this much edge shows while it turns */
export const SLAB_DEPTH_PX = 4
/** the root's perspective */
export const PERSPECTIVE_PX = 900
/**
 * The scale that makes a plane `planeBehind` px behind the viewer's reference
 * project onto a face `faceBehind` px behind it (negative = in front).
 */
export const fitDepth = (planeBehind: number, faceBehind: number) =>
  ((PERSPECTIVE_PX + planeBehind) / (PERSPECTIVE_PX + faceBehind)).toFixed(5)
/** the showing face's depth: the root plane, or the back face in front of it */
export const showingFaceDepth = (flipped: boolean) => (flipped ? -(SLAB_DEPTH_PX + 1) : 0)
/** the pool sits right behind the slab, so it turns with the tile */
export const BLOOM_NEAR_PX = SLAB_DEPTH_PX + 2

// ── the pool of light under the tile ─────────────────────────────────────
/** the host and the own tile: the outline grown barely at all */
export const POOL_GROW_ROLE_PX = 1
/** a verdict's pool: twice that, so it reads under a moving tile */
export const POOL_GROW_VERDICT_PX = 2

const TAU = Math.PI * 2
const frac = (n: number) => n - Math.floor(n)

// ── per-tile clocks, hues and seeds ──────────────────────────────────────
/** a tile's seed from its player's id: the same player keeps the same clock and hue in every seat */
export function tileSeed(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return (h >>> 0) % 1000
}

/** each tile wiggles on its own clock, spread on the golden ratio by seed */
export function wiggleClock(seed: number) {
  return { offset: frac(seed * 0.618034) * TAU, speed: 0.85 + 0.3 * frac(seed * 0.381966) }
}

/** how far each tile's cover may turn the palette, either way, in degrees */
const HUE_SPREAD_DEG = 28
export const slotHue = (seed: number) => (frac(seed * 0.618034) - 0.5) * 2 * HUE_SPREAD_DEG
/** five numbers per tile: where each blob of its light starts */
export const slotSeeds = (seed: number) => [
  frac(0.37 + seed * 0.618034),
  frac(0.11 + seed * 0.381966),
  frac(0.73 + seed * 0.271828),
  frac(0.29 + seed * 0.732051),
  frac(0.53 + seed * 0.514229),
]

// The card a tile turns into takes its hue from a point on the pool's colour
// wheel, kept only in part (PULL), capped (SPAN), plus a little of its own
// (JITTER), so neighbours land close but never alike.
const WHEEL_HUE_STOPS = [
  { at: 0, hue: 172 },
  { at: 0.22, hue: 218 },
  { at: 0.45, hue: 252 },
  { at: 0.66, hue: 313 },
  { at: 0.84, hue: 252 },
  { at: 1, hue: 172 },
]
const PALETTE_HUE_DEG = 238
const NEG_HUE_PULL = 0.34
const NEG_HUE_SPAN = 26
const NEG_HUE_JITTER = 7

function wheelHueAt(t: number): number {
  for (let i = 1; i < WHEEL_HUE_STOPS.length; i++) {
    const a = WHEEL_HUE_STOPS[i - 1]!
    const b = WHEEL_HUE_STOPS[i]!
    if (t <= b.at) return a.hue + (b.hue - a.hue) * ((t - a.at) / Math.max(1e-6, b.at - a.at))
  }
  return WHEEL_HUE_STOPS[0]!.hue
}

/** a stable pseudo-random number in 0..1 for this tile, this turn and this draw */
const hash = (seed: number, turn: number, k: number) =>
  frac(Math.sin((seed + 1) * 12.9898 + turn * 78.233 + k * 37.719) * 43758.5453)

/**
 * A rejected card's own hue and blob seeds, rolled once per turn: the same tile
 * rejected twice is not the same blue twice. Pure, so a render can call it.
 */
export function turnRoll(seed: number, turn: number): { hue: number; seeds: number[] } {
  const d = ((wheelHueAt(hash(seed, turn, 0)) - PALETTE_HUE_DEG + 540) % 360) - 180
  const pulled = Math.max(-NEG_HUE_SPAN, Math.min(NEG_HUE_SPAN, d * NEG_HUE_PULL))
  return {
    hue: pulled + (hash(seed, turn, 1) - 0.5) * 2 * NEG_HUE_JITTER,
    seeds: [2, 3, 4, 5, 6].map((k) => hash(seed, turn, k)),
  }
}

// ── the room a growing tile has ──────────────────────────────────────────
/** a growing tile is raised over its neighbours */
export const ACTIVE_Z = 20
/** a turning tile keeps this much clear of the screen's edge */
const TILE_SAFE_PX = 16

export interface TileRoom {
  w: number
  h: number
  /** screen px per tile px, for a tile under a scaled ancestor */
  scale: number
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * How much room the tile has on each side before the nearest clipping
 * ancestor. It measures the element ABOVE the tile, which carries none of the
 * tile's own turn, so the reading is valid mid-turn.
 */
export function useTileRoom(ref: RefObject<HTMLElement | null>, active: boolean): TileRoom | null {
  const [room, setRoom] = useState<TileRoom | null>(null)
  // the clipping ancestor is found once: a turn starts with a measure, and
  // a style read per ancestor per turn was work for an answer that never changes
  const clipRef = useRef<HTMLElement | null | undefined>(undefined)
  const measure = useCallback(() => {
    const el = ref.current
    const host = el?.parentElement
    if (!el || !host) return
    if (clipRef.current === undefined) {
      clipRef.current = null
      for (let p: HTMLElement | null = host; p; p = p.parentElement) {
        const cs = getComputedStyle(p)
        if (cs.overflow !== "visible" || cs.overflowX !== "visible" || cs.overflowY !== "visible") {
          clipRef.current = p
          break
        }
      }
    }
    const bounds = clipRef.current?.getBoundingClientRect() ?? null
    const b = bounds ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    const r = host.getBoundingClientRect()
    if (!r.width || !r.height) return
    const layoutW = el.offsetWidth || r.width
    const scale = layoutW > 0 ? r.width / layoutW : 1
    const next: TileRoom = {
      w: r.width,
      h: r.height,
      scale: scale > 0.05 ? scale : 1,
      left: r.left - b.left,
      right: b.right - r.right,
      top: r.top - b.top,
      bottom: b.bottom - r.bottom,
    }
    setRoom((old) =>
      old &&
      Math.abs(old.left - next.left) < 0.5 &&
      Math.abs(old.right - next.right) < 0.5 &&
      Math.abs(old.top - next.top) < 0.5 &&
      Math.abs(old.bottom - next.bottom) < 0.5 &&
      Math.abs(old.scale - next.scale) < 0.005
        ? old
        : next,
    )
  }, [ref])
  // the moment the tile becomes active is the reading that has to be right
  useLayoutEffect(measure, [measure, active])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.parentElement) ro.observe(el.parentElement)
    window.addEventListener("resize", measure)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [ref, measure])
  return room
}

/**
 * The shift that keeps a tile grown to scale `s` inside its room with its
 * margin. The margin grows with the scale, measured against `maxScale`, so the
 * pull-back arrives with the growth rather than snapping on.
 */
export function keepInside(room: TileRoom | null, s: number, maxScale: number): { x: number; y: number } | null {
  if (!room || s <= 1) return null
  const grown = Math.max(0, Math.min(1, (s - 1) / Math.max(0.0001, maxScale - 1)))
  const safe = TILE_SAFE_PX * grown
  const gx = (room.w * (s - 1)) / 2
  const gy = (room.h * (s - 1)) / 2
  const x = Math.max(0, gx - (room.left - safe)) - Math.max(0, gx - (room.right - safe))
  const y = Math.max(0, gy - (room.top - safe)) - Math.max(0, gy - (room.bottom - safe))
  const k = room.scale || 1
  return Math.abs(x) < 0.05 && Math.abs(y) < 0.05 ? null : { x: x / k, y: y / k }
}
