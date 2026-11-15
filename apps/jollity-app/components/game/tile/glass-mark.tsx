// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react"
import { AsyncCache } from "@/lib/async-cache"
import { ScratchCanvas } from "@/lib/dom/canvas"
import { loadImage } from "@/lib/dom/image"
import { TILE_PX } from "./tile-geometry"
import { CardLight, type CardBlob, type CardPath } from "./tile-canvas"
import { getLowPower } from "@/lib/low-power"
import { ensureShapeImage, type MarkShape, type ShapeImage } from "./mark-map"
import { REJECT_WASH } from "./tile-faces"
import tickBold from "./tick-bold.png"
// "generated portrait" by Thomas Meerseman, from the Noun Project
// a PNG, not an SVG with a nested <image>: iOS 17 Safari draws that SVG into a canvas empty
import portraitBold from "./portrait-bold.png"
import portrait from "./portrait.png"

// ── the light inside a turned card ───────────────────────────────────────
/** the card's colours: one blue-violet family on a near-black ground */
const GLOW_PALETTE = { deep: "#22227a", body: "#3b3fd8", mid: "#7a6cff", pale: "#c9c4ff" }
type Palette = typeof GLOW_PALETTE

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}
function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const a = s * Math.min(l, 1 - l)
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, "0")
  }
  return `#${f(0)}${f(8)}${f(4)}`
}
function turnHex(hex: string, deg: number): string {
  if (!deg) return hex
  const [h, s, l] = hexToHsl(hex)
  return hslToHex((h + deg + 360) % 360, s, l)
}
function blendHex(a: string, b: string, t: number): string {
  const n = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [ar, ag, ab] = n(a) as [number, number, number]
  const [br, bg, bb] = n(b) as [number, number, number]
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0")
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`
}

// One clock for every drifting glow on the page: two cards with the same seed
// show the same instant.
const GLOW_EPOCH = typeof performance !== "undefined" ? performance.now() : 0

/** the drift circuits, as [at, translate x %, translate y %, scale] of a blob laid out at half size */
const DRIFT: Record<"a" | "b" | "c", CardPath> = {
  a: [[0, -68, -48, 1.88], [0.17, -16, -68, 2.2], [0.33, 48, -28, 2.44], [0.5, 60, 36, 2.52], [0.67, 16, 72, 2.12], [0.83, -52, 40, 1.76], [1, -68, -48, 1.88]],
  b: [[0, 64, -60, 2.28], [0.17, 16, -36, 2.04], [0.33, -36, -8, 1.8], [0.5, -56, 48, 1.72], [0.67, -4, 72, 2.04], [0.83, 48, 32, 2.36], [1, 64, -60, 2.28]],
  c: [[0, 0, 68, 2.44], [0.17, -44, 28, 2.12], [0.33, -60, -44, 1.88], [0.5, 12, -64, 2.12], [0.67, 60, -24, 2.32], [0.83, 44, 40, 2.32], [1, 0, 68, 2.44]],
}

/**
 * The living gradient inside a turned card: six soft blobs on closed drift
 * circuits over the body colour, drawn into one small canvas (tile-canvas).
 */
export function CardGlow({ seed, hue }: { seed: number[]; hue: number }) {
  const P = useMemo<Palette>(
    () => Object.fromEntries(Object.entries(GLOW_PALETTE).map(([k, v]) => [k, turnHex(v, hue)])) as Palette,
    [hue],
  )
  const ground = useMemo<[number, string][]>(
    () => [[0, P.body], [0.42, blendHex(P.body, P.deep, 0.5)], [1, P.deep]],
    [P],
  )
  const blobs = useMemo<CardBlob[]>(() => {
    const s = (k: number) => seed[k % seed.length]!
    return [
      { color: P.body, size: 210, x: -18, y: 14, dur: 82, offset: s(4), path: DRIFT.b, opacity: 0.85 },
      { color: P.deep, size: 205, x: 18, y: 16, dur: 70, offset: s(3), path: DRIFT.c, opacity: 0.95 },
      { color: P.deep, size: 128, x: -10, y: 12, dur: 50, offset: s(2), path: DRIFT.b, opacity: 0.7 },
      { color: P.mid, size: 138, x: -12, y: -10, dur: 42, offset: s(1), path: DRIFT.a, opacity: 0.85 },
      { color: P.mid, size: 104, x: 6, y: 2, dur: 34, offset: s(0), path: DRIFT.a, opacity: 0.75 },
      // one pale highlight only: more than one and the card goes milky
      { color: P.pale, size: 86, x: 12, y: -12, dur: 62, offset: s(3), path: DRIFT.c, opacity: 0.34 },
    ]
  }, [P, seed])
  return (
    <div className="a-glow" aria-hidden>
      <CardLight ground={ground} blobs={blobs} mirrored={seed[0]! > 0.5} epoch={GLOW_EPOCH} />
    </div>
  )
}

// ── the marks ────────────────────────────────────────────────────────────
type MarkSide = "negative" | "positive"
type ArtShape = MarkSide | "eye"
/** a circle a little inside its box: its blurred rim must not reach the box's edge */
const EYE_DISC = 0.88
const EYE_R = 50 * EYE_DISC
const EYE_DISC_D = `M50 ${50 - EYE_R}A${EYE_R} ${EYE_R} 0 1 1 50 ${50 + EYE_R}A${EYE_R} ${EYE_R} 0 1 1 50 ${50 - EYE_R}Z`
// each mark is its own artwork, whose alpha is the shape; the eye chip's disc is a path
const MARK_SHAPES: Record<ArtShape, MarkShape> = {
  negative: { src: portraitBold.src, viewBox: 100 },
  positive: { src: tickBold.src, viewBox: 100 },
  eye: { path: EYE_DISC_D, viewBox: 100 },
}

/** the mark's images are baked at the tile's size */
const MARK_MAP_PX = TILE_PX
/** the glass's thickness: the blur its bevel is derived from */
const MARK_THICKNESS_PX = 9
/** the drawn outline: wide and solid enough to read as the mark's own stroke */
const MARK_LINE_BLUR = 2.6
const MARK_LINE_POWER = 0.45
const MARK_EDGE_POWER = 0.85
/** the arrival: after the card lands, a fade over this long */
const MARK_AFTER_MS = 200
const MARK_FADE_MS = 420
/** the frost inside the glass: over a photo a little more, so the window reads */
const FROST_OVER_PHOTO = 0.12
const FROST_OVER_LIGHT = 0.08


const EDGE_IMAGE: ShapeImage = { kind: "edge", blur: MARK_THICKNESS_PX, power: MARK_EDGE_POWER }
const OUTLINE_IMAGE: ShapeImage = { kind: "edge", blur: MARK_LINE_BLUR, power: MARK_LINE_POWER }
const CUT_IMAGE: ShapeImage = { kind: "mask" }

/** canvas px across a composed mark, and the room kept round it for the stroke */
const ART_PX = 320
const ART_PAD = 0.04

type Stop = [number, number]
/** a white light at each stop's alpha, along a CSS 135° line (corner to corner) */
const LIT_EDGE: Stop[] = [[0, 0.95], [0.22, 0.62], [0.48, 0.3], [0.68, 0.18], [1, 0.42]]
const LIT_SPEC: Stop[] = [[0, 1], [0.14, 0.45], [0.34, 0], [1, 0]]
const LIT_SHEEN: Stop[] = [[0, 0.5], [0.45, 0.05], [1, 0.28]]
const LIT_OUTLINE: Stop[] = [[0, 0.95], [0.24, 0.6], [0.52, 0.28], [0.72, 0.18], [1, 0.45]]

/** one look of a glass shape: the tint is a resolved colour */
interface Look {
  shape: ArtShape
  frost: number
  tint: string | null
  wash: number
}

/** every composed mark this page, by its look */
const ARTS = new AsyncCache<string>()

/**
 * The whole mark as ONE image (frost, tint, sheen, stroke, rim), drawn once
 * per look: as five masked layers it cost a GPU pass each per frame.
 */
function composeMark(look: Look): Promise<string> {
  return ARTS.ensure(JSON.stringify(look), async () => {
    const shape = MARK_SHAPES[look.shape]
    const bake = (image: ShapeImage) => ensureShapeImage(shape, image, MARK_MAP_PX).then((url) => loadImage(url))
    const [cut, edge, outline] = await Promise.all([bake(CUT_IMAGE), bake(EDGE_IMAGE), bake(OUTLINE_IMAGE)])
    const n = ART_PX
    const pad = Math.round(n * ART_PAD)
    const out = new ScratchCanvas(n + 2 * pad)
    const ctx = out.ctx
    // one scratch layer for every masked part, cleared between them
    const layer = new ScratchCanvas(n)
    const g = layer.ctx
    const box = (draw: (g: CanvasRenderingContext2D) => void, masks: HTMLImageElement[]) => {
      g.globalCompositeOperation = "source-over"
      g.globalAlpha = 1
      g.clearRect(0, 0, n, n)
      draw(g)
      g.globalCompositeOperation = "destination-in"
      g.globalAlpha = 1
      for (const mask of masks) g.drawImage(mask, 0, 0, n, n)
      ctx.drawImage(layer.canvas, pad, pad)
    }
    const lit = (stops: Stop[]) => (g: CanvasRenderingContext2D) => {
      const grad = g.createLinearGradient(0, 0, n, n)
      for (const [at, a] of stops) grad.addColorStop(at, `rgba(255,255,255,${a})`)
      g.fillStyle = grad
      g.fillRect(0, 0, n, n)
    }
    // the glass: frost, and the verdict's tint, inside the silhouette
    box((g) => {
      g.fillStyle = `rgba(255,255,255,${look.frost})`
      g.fillRect(0, 0, n, n)
      if (look.tint) {
        g.globalAlpha = look.wash
        g.fillStyle = look.tint
        g.fillRect(0, 0, n, n)
      }
    }, [cut])
    box(lit(LIT_SHEEN), [cut])
    box(lit(LIT_OUTLINE), [outline, cut])
    // the rim, faint and even, and again on the side the light comes from
    box(lit(LIT_EDGE), [edge, cut])
    box(lit(LIT_SPEC), [edge, cut])
    const url = out.canvas.toDataURL()
    // the composed image lives on as the URL: free both canvases now
    layer.release()
    out.release()
    return url
  })
}

/** a `var(--x)` colour as the element sees it */
function resolveColor(el: HTMLElement, color: string): string {
  const name = /^var\((--[^),]+)/.exec(color)?.[1]
  return name ? getComputedStyle(el).getPropertyValue(name).trim() || color : color
}

/**
 * The mark as glass: a frosted window in the mark's silhouette with a lit rim,
 * one image (composeMark) over whatever lies behind. It fades in on opacity only.
 */
function GlassMark({
  side,
  frost,
  tint,
  wash,
  snapshot,
}: {
  side: MarkSide
  frost: number
  tint?: string
  wash?: number
  snapshot?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [art, setArt] = useState<string | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let live = true
    void composeMark({ shape: side, frost, tint: tint ? resolveColor(el, tint) : null, wash: wash ?? 0 })
      .then((url) => {
        if (live) setArt(url)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [side, frost, tint, wash])
  const shapeMask = `url(${MARK_SHAPES[side].src})`
  return (
    <div
      ref={ref}
      className="a-glass-mark"
      aria-hidden
      style={
        {
          width: "100%",
          height: "100%",
          "--a-after": `${MARK_AFTER_MS}ms`,
          "--a-fade": `${MARK_FADE_MS}ms`,
        } as CSSProperties
      }
    >
      {snapshot ? (
        <div className={`a-glass-mark-window is-${side}`} style={{ WebkitMaskImage: shapeMask, maskImage: shapeMask }}>
          {/* the whole face's photo, centred on the mark: the shape is a window onto the face */}
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL frame; next/image can't optimize it */}
          <img src={snapshot} alt="" draggable={false} style={{ width: TILE_PX, height: TILE_PX }} />
        </div>
      ) : null}
      {art ? (
        <div className="a-glass-mark-art" style={{ inset: `${-ART_PAD * 100}%`, backgroundImage: `url(${art})` }} />
      ) : null}
    </div>
  )
}

/**
 * What the tile mounts: the glass mark. Over an approved photo it carries the
 * face's green wash, so the mark is a window and not a patch. A rejected photo
 * and the covered card's light get clear frost.
 */
export function AutoGlassMark({
  side,
  photo,
  tint,
  wash,
  snapshot,
}: {
  side: MarkSide
  /** the mark sits over the photo, not over the card's light */
  photo: boolean
  tint?: string
  wash?: number
  /** the vote screen: the face's photo, frosted inside the shape */
  snapshot?: string
}) {
  return (
    <GlassMark
      side={side}
      frost={photo ? FROST_OVER_PHOTO : FROST_OVER_LIGHT}
      tint={photo ? tint : undefined}
      wash={wash}
      snapshot={snapshot}
    />
  )
}

/** the mark as one solid shape with a hard outline: no bake, a short fade */
export function LowPowerMark({ side }: { side: MarkSide }) {
  const mask = `url(${(side === "positive" ? tickBold : portrait).src})`
  return (
    <div aria-hidden className={`tile-lp-mark is-${side}`}>
      {/* prefixed too: Chrome before 120 knows only -webkit-mask */}
      <div className="tile-lp-mark-shape" style={{ WebkitMaskImage: mask, maskImage: mask }} />
    </div>
  )
}

/** the rejected face's wash in low power mode: dark blue to light blue */
const LP_WASH_DARK = "#1e3a8a"
const LP_WASH_LIGHT = "#93c5fd"
/** how far each tile and turn moves the wash's hue (deg), brightness and reach (%), either way */
const LP_WASH_HUE = 15
const LP_WASH_BRIGHT = 0.12
const LP_WASH_STOP = 72
const LP_WASH_STOP_SPREAD = 10

function brightHex(hex: string, k: number): string {
  const c = (i: number) => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k))
  return `#${[1, 3, 5].map((i) => c(i).toString(16).padStart(2, "0")).join("")}`
}

/** the low power wash as a CSS gradient, from three rolls in 0..1 (a turn's own, so each tile and turn differs) */
export function lowPowerWash([hue, bright, stop]: number[]): string {
  const deg = (hue! - 0.5) * 2 * LP_WASH_HUE
  const k = 1 + (bright! - 0.5) * 2 * LP_WASH_BRIGHT
  const at = LP_WASH_STOP + (stop! - 0.5) * 2 * LP_WASH_STOP_SPREAD
  const tone = (hex: string) => brightHex(turnHex(hex, deg), k)
  return `linear-gradient(135deg, ${tone(LP_WASH_DARK)} 0%, ${tone(LP_WASH_LIGHT)} ${at.toFixed(1)}%)`
}

/** the low power auto-reject cue, CSS only (tile.css). `atMs` is the part of the
 *  window already gone, so a tile that joins late starts in step. */
export function LowPowerWarn({ leadMs, atMs, wash }: { leadMs: number; atMs: number; wash: string }) {
  return (
    <div
      aria-hidden
      className="tile-lp-warn"
      style={{ "--warn-ms": `${leadMs}ms`, "--warn-at": `${-atMs}ms` } as CSSProperties}
    >
      <div className="tile-lp-warn-wash" style={{ background: wash }} />
      <div className="tile-lp-warn-mark">
        <div className="tile-lp-warn-core">
          <LowPowerMark side="negative" />
        </div>
        <div className="tile-lp-warn-echo">
          <LowPowerMark side="negative" />
        </div>
        <div className="tile-lp-warn-echo is-late">
          <LowPowerMark side="negative" />
        </div>
      </div>
    </div>
  )
}

/** the eye chip's disc: the photo mark's frost and rim, untinted */
const EYE_LOOK: Look = { shape: "eye", frost: FROST_OVER_PHOTO, tint: null, wash: 0 }
const EYE_KEY = JSON.stringify(EYE_LOOK)
/** the composed disc reaches past the chip by this much of its size on each side */
export const EYE_ART_OVERHANG = ((1 + 2 * ART_PAD) / EYE_DISC - 1) / 2

/** the eye chip's glass disc as one image URL, or null until it is baked */
export function useEyeDiscArt(): string | null {
  const url = useSyncExternalStore(
    ARTS.subscribe,
    () => ARTS.peek(EYE_KEY) ?? null,
    () => null,
  )
  useEffect(() => {
    void composeMark(EYE_LOOK).catch(() => {})
  }, [])
  return url
}

const whenIdle = (then: () => void) =>
  typeof requestIdleCallback === "function" ? requestIdleCallback(then, { timeout: 2000 }) : setTimeout(then, 200)
let warmed = false

/**
 * Bake every glass image a game can show, one look per idle moment, so no turn
 * waits on it. Low power mode bakes the eye disc only. `el` carries the tints' variables.
 */
export function warmMarks(el: HTMLElement) {
  if (warmed) return
  warmed = true
  // the eye disc first, then the marks as AutoGlassMark is asked for them (final-tile)
  const looks: Look[] = [
    EYE_LOOK,
    // the approved photo's tick
    { shape: "positive", frost: FROST_OVER_PHOTO, tint: "var(--game-approve)", wash: REJECT_WASH },
    // the covered card's portrait, over its light
    { shape: "negative", frost: FROST_OVER_LIGHT, tint: null, wash: 0 },
    // the reviewed reject's portrait, over its photo, untinted
    { shape: "negative", frost: FROST_OVER_PHOTO, tint: null, wash: 0 },
  ]
  const next = (i: number) => {
    const look = looks[i]
    if (!look || (i > 0 && getLowPower())) return
    whenIdle(() => {
      void composeMark({ ...look, tint: look.tint ? resolveColor(el, look.tint) : null })
        .catch(() => {})
        .finally(() => next(i + 1))
    })
  }
  next(0)
}
