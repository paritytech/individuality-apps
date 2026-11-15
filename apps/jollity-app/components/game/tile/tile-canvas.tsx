// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { useCallback, useEffect, useRef, type CSSProperties } from "react"
import { POOL_BAKE_PAD_PX, poolImage, type PoolLook } from "./tile-bake"
import { ScratchCanvas } from "@/lib/dom/canvas"
import { TILE_PX } from "./tile-geometry"

/**
 * The tile's moving soft light, drawn into small canvases. As big CSS layers
 * a few tiles of it overran the WebView's GPU tile budget (96 MB on Android)
 * and layers flashed out; a canvas costs only its own few pixels.
 */

// ── the images they draw from, each painted once per key for the page ──
const SPRITES = new Map<string, HTMLCanvasElement>()
function sprite(key: string, size: number, paint: (g: CanvasRenderingContext2D, size: number) => void): HTMLCanvasElement {
  let img = SPRITES.get(key)
  if (!img) {
    const s = new ScratchCanvas(size)
    paint(s.ctx, size)
    SPRITES.set(key, (img = s.canvas))
  }
  return img
}

// ── one clock for every canvas ─────────────────────────────────────────
type Draw = (now: number) => void
const subscribers = new Map<Draw, { every: number; last: number }>()
let raf = 0
function tick(now: number) {
  for (const [draw, s] of subscribers) {
    if (now - s.last < s.every) continue
    s.last = now
    draw(now)
  }
  raf = subscribers.size ? requestAnimationFrame(tick) : 0
}
/** `draw` runs at most `fps` times a second while `on`, on one shared frame loop */
function useTicker(draw: Draw, fps: number, on: boolean) {
  useEffect(() => {
    if (!on) return
    subscribers.set(draw, { every: 1000 / fps - 2, last: 0 })
    if (!raf) raf = requestAnimationFrame(tick)
    return () => {
      subscribers.delete(draw)
    }
  }, [draw, fps, on])
}

// ── the pool under the tile ─────────────────────────────────────────────
const POOL_SCALE = 1.5
const POOL_BOX = TILE_PX + 2 * POOL_BAKE_PAD_PX
/** one lap on the page clock, so every pool agrees; at 10 fps a step is 3° */
const WHEEL_LAP_MS = 12000
const WHEEL_FPS = 10
type Stop = [number, string]
const WHEELS: Record<"" | "host" | "me", Stop[]> = {
  "": [[0, "#46d1c1"], [0.22, "#4d8dff"], [0.45, "#7a5cff"], [0.66, "#ff4fd8"], [0.84, "#7a5cff"], [1, "#46d1c1"]],
  host: [[0, "#ffe38f"], [0.22, "#f5b31d"], [0.45, "#ffcf5a"], [0.66, "#e9961a"], [0.84, "#ffd76e"], [1, "#ffe38f"]],
  me: [[0, "#e9ecf2"], [0.22, "#aab2c0"], [0.45, "#d6dbe4"], [0.66, "#93a0b3"], [0.84, "#cfd5df"], [1, "#e9ecf2"]],
}
const FULL_SWEEP = 460

/**
 * A colour wheel, wide enough (the square's diagonal) that turning it never
 * shows a corner, starting at 12 o'clock as CSS drew it.
 */
const wheelImage = (wheel: "" | "host" | "me", w: number) =>
  sprite(`wheel|${wheel}|${w}`, Math.ceil(w * Math.SQRT2), (g, size) => {
    const c = size / 2
    if (g.createConicGradient) {
      const grad = g.createConicGradient(-Math.PI / 2, c, c)
      for (const [at, color] of WHEELS[wheel]) grad.addColorStop(at, color)
      g.fillStyle = grad
    } else g.fillStyle = WHEELS[wheel][2]![1]
    g.fillRect(0, 0, size, size)
  })

/** one side's pool: the baked light (tile-bake) in the verdict's green or the turning wheel; the cue writer sets `--level` and `--sweep` */
export function PoolGlow({
  wheel,
  look,
  poolGrow,
  tone,
  on,
  className,
  style,
  cue = true,
}: {
  wheel: "" | "host" | "me" | null
  look: PoolLook
  poolGrow: number
  /** "r,g,b" */
  tone: string
  /** the wheel turns only while lit */
  on: boolean
  className: string
  style?: CSSProperties
  cue?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const draw = useCallback((now: number) => {
    const canvas = ref.current
    const light = poolImage(look, poolGrow)
    const ctx = canvas?.getContext("2d")
    if (!canvas || !light || !ctx) return
    const w = canvas.width
    ctx.globalCompositeOperation = "source-over"
    ctx.clearRect(0, 0, w, w)
    if (wheel === null) {
      ctx.fillStyle = `rgb(${tone})`
      ctx.fillRect(0, 0, w, w)
    } else {
      const turn = ((now % WHEEL_LAP_MS) / WHEEL_LAP_MS) * Math.PI * 2
      const img = wheelImage(wheel, w)
      ctx.setTransform(1, 0, 0, 1, w / 2, w / 2)
      ctx.rotate(turn)
      ctx.drawImage(img, -img.width / 2, -img.height / 2)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
    }
    ctx.globalCompositeOperation = "destination-in"
    ctx.drawImage(light, 0, 0, w, w)
    const sweep = parseFloat(canvas.style.getPropertyValue("--sweep")) || FULL_SWEEP
    if (wheel !== null && sweep < 360 && ctx.createConicGradient) {
      const level = parseFloat(canvas.style.getPropertyValue("--level")) || 0
      const m = ctx.createConicGradient(-Math.PI / 2, w / 2, w / 2)
      const at = (deg: number) => Math.min(1, Math.max(0, deg / 360))
      const lead = at(60 * (1 - level))
      const full = Math.max(lead, at(sweep - 100))
      m.addColorStop(0, "rgba(0,0,0,0)")
      m.addColorStop(lead, "#000")
      m.addColorStop(full, "#000")
      m.addColorStop(Math.max(full, at(sweep)), "rgba(0,0,0,0)")
      if (at(sweep) < 1) m.addColorStop(1, "rgba(0,0,0,0)")
      ctx.fillStyle = m
      ctx.fillRect(0, 0, w, w)
    }
  }, [wheel, look, poolGrow, tone])
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const px = Math.round(POOL_BOX * POOL_SCALE)
    if (canvas.width !== px) canvas.width = canvas.height = px
    draw(performance.now())
  }, [draw, on])
  useTicker(draw, WHEEL_FPS, on && wheel !== null)
  return <canvas ref={ref} aria-hidden data-cue={cue ? "glow" : undefined} className={className} style={style} />
}

// ── the light inside a turned card ─────────────────────────────────────
/** soft light: few pixels, few steps */
const CARD_PX = 64
const CARD_FPS = 20

export interface CardBlob {
  color: string
  /** % of the card, and offset from its middle */
  size: number
  x: number
  y: number
  /** seconds per circuit, and the start along it (0..1) */
  dur: number
  offset: number
  path: CardPath
  opacity: number
}
/** a drift path's stops: [at, translate x %, translate y %, scale] of the blob's own box */
export type CardPath = [number, number, number, number][]

/** the card's light: a ground gradient and blobs on closed drift paths, in one small canvas */
export function CardLight({
  ground,
  blobs,
  mirrored,
  epoch,
}: {
  ground: Stop[]
  blobs: CardBlob[]
  mirrored: boolean
  /** the page clock's zero, ms: two cards with one seed agree */
  epoch: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const draw = useCallback((now: number) => {
    const ctx = ref.current?.getContext("2d")
    if (!ctx) return
    const w = CARD_PX
    ctx.globalAlpha = 1
    ctx.drawImage(groundImage(ground), 0, 0)
    const t = (now - epoch) / 1000
    for (const b of blobs) {
      const u = (((t / b.dur + b.offset) % 1) + 1) % 1
      const at = pathTable(b.path)
      const k = Math.min(PATH_STEPS - 1, Math.floor(u * PATH_STEPS)) * 3
      const box = (b.size / 2 / 100) * w
      const cx = w / 2 + (b.x / 100) * w + (mirrored ? -1 : 1) * (at[k]! / 100) * box
      const cy = w / 2 + (b.y / 100) * w + (at[k + 1]! / 100) * box
      const r = (box / 2) * at[k + 2]!
      ctx.globalAlpha = b.opacity
      ctx.drawImage(blobImage(b.color), cx - r, cy - r, r * 2, r * 2)
    }
  }, [ground, blobs, mirrored, epoch])
  useEffect(() => draw(performance.now()), [draw])
  useTicker(draw, CARD_FPS, true)
  return (
    <canvas
      ref={ref}
      width={CARD_PX}
      height={CARD_PX}
      aria-hidden
      className="absolute inset-0 h-full w-full"
    />
  )
}

/** a drift path, sampled once: a frame reads its place */
const PATH_STEPS = 1024
const PATH_TABLES = new WeakMap<CardPath, Float32Array>()
/** [x %, y %, scale] per step, linear between stops as CSS keyframes ran */
function pathTable(path: CardPath): Float32Array {
  let table = PATH_TABLES.get(path)
  if (table) return table
  table = new Float32Array(PATH_STEPS * 3)
  for (let i = 0; i < PATH_STEPS; i++) {
    const u = i / PATH_STEPS
    let j = 1
    while (j < path.length - 1 && u > path[j]![0]) j++
    const a = path[j - 1]!
    const b = path[j]!
    const k = (u - a[0]) / Math.max(1e-6, b[0] - a[0])
    table[i * 3] = a[1] + (b[1] - a[1]) * k
    table[i * 3 + 1] = a[2] + (b[2] - a[2]) * k
    table[i * 3 + 2] = a[3] + (b[3] - a[3]) * k
  }
  PATH_TABLES.set(path, table)
  return table
}

/** the card's ground: 130% wide, lit from 32% 26% */
const groundImage = (ground: Stop[]) =>
  sprite(`ground|${JSON.stringify(ground)}`, CARD_PX, (g, w) => {
    const grad = g.createRadialGradient(0.32 * w, 0.26 * w, 0, 0.32 * w, 0.26 * w, 1.3 * w)
    for (const [at, c] of ground) grad.addColorStop(at, c)
    g.fillStyle = grad
    g.fillRect(0, 0, w, w)
  })

/** a blob's soft disc, as CSS drew it (closest-side, gone by 78%) */
const blobImage = (color: string) =>
  sprite(`blob|${color}`, 64, (g, w) => {
    const c = w / 2
    const grad = g.createRadialGradient(c, c, 0, c, c, c)
    grad.addColorStop(0, color)
    grad.addColorStop(0.32, `${color}e6`)
    grad.addColorStop(0.58, `${color}80`)
    grad.addColorStop(0.78, `${color}00`)
    g.fillStyle = grad
    g.fillRect(0, 0, w, w)
  })

// ── the landing's sparks ───────────────────────────────────────────────
const SPARKS = 12
/** how far past the tile a spark flies, its life after its delay, its density cap */
const SPARK_PAD = 40
const SPARK_MS = 340
const SPARK_DPR_MAX = 2
const sparkEase = cubicBezier(0.2, 0.8, 0.3, 1)

/** round the perimeter, jittered, each flying a short way out */
const SPARK_PLAN = Array.from({ length: SPARKS }, (_, i) => {
  const seed = (i * 0.618034 + 0.137) % 1
  const angle = ((i + seed * 0.6) / SPARKS) * Math.PI * 2
  const fly = 14 + seed * 16
  const size = 5 + Math.round(seed * 6)
  return {
    x: TILE_PX * (0.5 + Math.cos(angle) * 0.5) - 3 + size / 2,
    y: TILE_PX * (0.5 + Math.sin(angle) * 0.5) - 3 + size / 2,
    size,
    delay: Math.round(seed * 180),
    dx: Math.cos(angle) * fly,
    dy: Math.sin(angle) * fly - 6,
  }
})

/** each spark's [move, scale, spin, light] per ms of its life: 30% lit, 0.4 out, 1.15×, 20°; 100% gone, 1, 0.2×, 50° */
const SPARK_SAMPLES = SPARK_MS
const SPARK_LIFE = (() => {
  const life = new Float32Array(SPARK_SAMPLES * 4)
  for (let i = 0; i < SPARK_SAMPLES; i++) {
    const u = i / SPARK_SAMPLES
    let row: [number, number, number, number]
    if (u < 0.3) {
      const e = sparkEase(u / 0.3)
      row = [0.4 * e, 1.15 * e, (20 * e * Math.PI) / 180, e]
    } else {
      const e = sparkEase((u - 0.3) / 0.7)
      row = [0.4 + 0.6 * e, 1.15 - 0.95 * e, ((20 + 30 * e) * Math.PI) / 180, 1 - e]
    }
    life.set(row, i * 4)
  }
  return life
})()

/** the white diamond, at the size the biggest spark reaches */
const diamondImage = () =>
  sprite("diamond", 32, (g, w) => {
    g.fillStyle = "#fff"
    g.beginPath()
    g.moveTo(w / 2, 0)
    g.lineTo(w, w / 2)
    g.lineTo(w / 2, w)
    g.lineTo(0, w / 2)
    g.fill()
  })

/** a landing's twelve sparks in one canvas over the tile */
export function SparkBurst() {
  const ref = useRef<HTMLCanvasElement>(null)
  const start = useRef(0)
  const draw = useCallback((now: number) => {
    const canvas = ref.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    start.current ||= now
    const k = canvas.width / (TILE_PX + 2 * SPARK_PAD)
    const img = diamondImage()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const sp of SPARK_PLAN) {
      const i = Math.floor(now - start.current - sp.delay)
      if (i < 0 || i >= SPARK_SAMPLES) continue
      const move = SPARK_LIFE[i * 4]!
      const half = (sp.size / 2) * SPARK_LIFE[i * 4 + 1]!
      ctx.setTransform(k, 0, 0, k, (SPARK_PAD + sp.x + sp.dx * move) * k, (SPARK_PAD + sp.y + sp.dy * move) * k)
      ctx.rotate(SPARK_LIFE[i * 4 + 2]!)
      ctx.globalAlpha = SPARK_LIFE[i * 4 + 3]!
      ctx.drawImage(img, -half, -half, half * 2, half * 2)
    }
  }, [])
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(SPARK_DPR_MAX, window.devicePixelRatio || 1)
    canvas.width = canvas.height = Math.round((TILE_PX + 2 * SPARK_PAD) * dpr)
  }, [])
  useTicker(draw, 60, true)
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute"
      style={{ left: -SPARK_PAD, top: -SPARK_PAD, width: TILE_PX + 2 * SPARK_PAD, height: TILE_PX + 2 * SPARK_PAD }}
    />
  )
}

/** a CSS cubic-bezier as a function of time 0..1 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const X = (t: number) => ((ax * t + bx) * t + cx) * t
  const Y = (t: number) => ((ay * t + by) * t + cy) * t
  return (x) => {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2
      if (X(m) < x) lo = m
      else hi = m
    }
    return Y((lo + hi) / 2)
  }
}
