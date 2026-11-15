// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { AsyncCache } from "@/lib/async-cache"
import { ScratchCanvas } from "@/lib/dom/canvas"
import { loadImage } from "@/lib/dom/image"

/**
 * The images a glass mark is built from, baked once per shape and cached for
 * the page. The shape is rasterised and its alpha blurred:
 *
 *  - `map`  the GRADIENT of that alpha as a displacement map (R = x, G = y),
 *           which is the bevel of a piece of glass cut to the shape;
 *  - `edge` the same gradient's magnitude as a white image: the lit rim;
 *  - `mask` the shape's own coverage, feathered over its last pixel or two.
 *
 * A shape is a path (in a `viewBox`-sized box) or artwork whose ALPHA is the shape.
 */
export interface MarkShape {
  path?: string
  src?: string
  viewBox: number
}

export type ShapeImage =
  | { kind: "map"; blur: number }
  | { kind: "edge"; blur: number; power: number }
  | { kind: "mask" }

/** every shape image baked this page, by keyOf */
const BAKED = new AsyncCache<string>()

/** the shape as white on black */
function rasterShape(shape: MarkShape, bitmap: HTMLImageElement | null, size: number): ScratchCanvas {
  const raster = new ScratchCanvas(size, size, { readback: true })
  const ctx = raster.ctx
  ctx.fillStyle = "#000"
  ctx.fillRect(0, 0, size, size)
  if (bitmap) {
    // the artwork's colour is irrelevant: paint its alpha white first
    const tmp = new ScratchCanvas(size)
    const r = Math.min(size / bitmap.width, size / bitmap.height)
    const w = bitmap.width * r
    const h = bitmap.height * r
    tmp.ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
    tmp.ctx.globalCompositeOperation = "source-in"
    tmp.ctx.fillStyle = "#fff"
    tmp.ctx.fillRect(0, 0, size, size)
    ctx.drawImage(tmp.canvas, 0, 0)
    tmp.release()
  } else if (shape.path) {
    ctx.save()
    const k = size / shape.viewBox
    ctx.scale(k, k)
    ctx.fillStyle = "#fff"
    ctx.fill(new Path2D(shape.path))
    ctx.restore()
  }
  return raster
}

function blurAlpha(shape: ScratchCanvas, size: number, blur: number): Uint8ClampedArray {
  const soft = new ScratchCanvas(size, size, { readback: true })
  soft.ctx.filter = `blur(${blur}px)`
  soft.ctx.drawImage(shape.canvas, 0, 0)
  const data = soft.pixels()
  soft.release()
  return data
}

function paint(size: number, fill: (d: Uint8ClampedArray, at: (x: number, y: number) => number) => void, soft: Uint8ClampedArray): string {
  const out = new ScratchCanvas(size)
  const ctx = out.ctx
  const img = ctx.createImageData(size, size)
  const at = (x: number, y: number) => {
    const cx = x < 0 ? 0 : x >= size ? size - 1 : x
    const cy = y < 0 ? 0 : y >= size ? size - 1 : y
    return soft[(cy * size + cx) * 4]! / 255
  }
  fill(img.data, at)
  ctx.putImageData(img, 0, 0)
  const url = out.canvas.toDataURL()
  out.release()
  return url
}

function bakeMap(shape: ScratchCanvas, size: number, blur: number): string {
  // the steepest slope a blur of this radius can produce, for normalising
  const norm = Math.max(0.02, 1 / (blur * 1.6))
  return paint(
    size,
    (d, at) => {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4
          const gx = Math.max(-1, Math.min(1, (at(x + 1, y) - at(x - 1, y)) / 2 / norm))
          const gy = Math.max(-1, Math.min(1, (at(x, y + 1) - at(x, y - 1)) / 2 / norm))
          // the light bends toward the middle of the shape: along the inward normal
          d[i] = Math.round(128 - gx * 127)
          d[i + 1] = Math.round(128 - gy * 127)
          d[i + 2] = 128
          d[i + 3] = 255
        }
      }
    },
    blurAlpha(shape, size, blur),
  )
}

function bakeEdge(shape: ScratchCanvas, size: number, blur: number, power: number): string {
  const norm = Math.max(0.02, 1 / (blur * 1.6))
  return paint(
    size,
    (d, at) => {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4
          const gx = (at(x + 1, y) - at(x - 1, y)) / 2
          const gy = (at(x, y + 1) - at(x, y - 1)) / 2
          const mag = Math.min(1, Math.hypot(gx, gy) / norm)
          d[i] = d[i + 1] = d[i + 2] = 255
          d[i + 3] = Math.round(Math.pow(mag, power) * 255)
        }
      }
    },
    blurAlpha(shape, size, blur),
  )
}

// the silhouette's last pixel or two: a smoothstep ramp over the blurred coverage
const MASK_SOFTEN_PX = 1.6
const MASK_FEATHER = 0.7
function bakeMask(shape: ScratchCanvas, size: number): string {
  const lo = 0.5 - MASK_FEATHER / 2
  const hi = 0.5 + MASK_FEATHER / 2
  return paint(
    size,
    (d, at) => {
      for (let i = 0; i < d.length; i += 4) {
        const p = i / 4
        let t = (at(p % size, Math.floor(p / size)) - lo) / (hi - lo)
        t = t < 0 ? 0 : t > 1 ? 1 : t
        d[i] = d[i + 1] = d[i + 2] = 255
        d[i + 3] = Math.round(t * t * (3 - 2 * t) * 255)
      }
    },
    blurAlpha(shape, size, MASK_SOFTEN_PX),
  )
}

async function bake(shape: MarkShape, image: ShapeImage, size: number): Promise<string> {
  const bitmap = shape.src ? await loadImage(shape.src, { crossOrigin: "anonymous" }) : null
  const raster = rasterShape(shape, bitmap, size)
  let url: string
  try {
    if (image.kind === "edge") return bakeEdge(raster, size, image.blur, image.power)
    if (image.kind === "mask") return bakeMask(raster, size)
    url = bakeMap(raster, size, image.blur)
  } finally {
    raster.release()
  }
  // an feImage that has not decoded makes the filter draw nothing, and the
  // cached result never corrects itself: publish the map only once it decodes
  await loadImage(url).catch(() => undefined)
  return url
}

const keyOf = (shape: MarkShape, image: ShapeImage, size: number) =>
  `${image.kind}|${shape.src ?? shape.path}|${shape.viewBox}|${size}|${image.kind === "mask" ? "" : image.blur}|${
    image.kind === "edge" ? image.power : ""
  }`
/** bake this shape's image if it is not yet baked; the url once it is */
export function ensureShapeImage(shape: MarkShape, image: ShapeImage, size: number): Promise<string> {
  return BAKED.ensure(keyOf(shape, image, size), () => bake(shape, image, size))
}
