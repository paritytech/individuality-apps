// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The CPU half of the wrapping effect: one item image in, three data blocks out.
// Its names are Wrapping*, except the shader exports (SHELL_*).
//
// This module is PURE apart from one offscreen canvas. It touches no React, no
// WebGL and no DOM node that the page can see, which is what lets
// wrapping/fields.worker.ts run the build off the main thread.
//
// ROW ORDER IS A TRAP. `buildFields` writes its output rows BOTTOM-UP, because
// the renderer uploads the item texture with `UNPACK_FLIP_Y_WEBGL = true`. The
// two must agree. Change one and the wrapping lights from the wrong side.
//
// Channel B is **unused**. The build bakes a static ripple into it and the
// fragment shader never reads it — the shader samples live noise instead,
// because the baked pattern read as a fixed grid. The write is left in.
//
// CORS. `buildFields` calls `getImageData`, which throws a `SecurityError` on a
// canvas tainted by a cross-origin image. Every caller must load the art with
// `crossOrigin = 'anonymous'`. wrapping/fieldCache.ts does that.

import { ScratchCanvas } from '@/lib/dom/canvas'

/** The side of the SDF texture, in texels. */
export const FIELD_N = 256

/** The distance the SDF encodes, in texels of the 256 grid. The shader maps
 *  the byte back with the same number, so both sides carry it. */
const FIELD_RANGE = 46

/** The side of the blurred colour texture, in texels. */
export const COLOUR_N = 64

/** What one item image becomes. */
export interface WrappingFields {
  /** The RGBA 256x256 field texture. R sharp SDF, G soft SDF, B dead payload,
   *  A the blurred luminance, which is both the relief and the zone mask. */
  sdf: Uint8Array
  /** The RGBA 64x64 alpha-weighted colour blur. */
  colour: Uint8Array
  /** The mask bounds in uv space, `[u0, v0, u1, v1]`, with v inverted to match
   *  the flipped upload. The renderer fits every item to one size with it. */
  bbox: readonly [number, number, number, number]
}

/** The 1D squared euclidean distance transform of one row or column. */
function edt1d(f: ArrayLike<number>, n: number): Float64Array {
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  let k = 0
  v[0] = 0
  z[0] = -1e20
  z[1] = 1e20
  for (let q = 1; q < n; q++) {
    let s = 0
    for (;;) {
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      if (s <= z[k]) k--
      else break
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = 1e20
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
  return d
}

/** The squared distance to the nearest set pixel. A set pixel holds 1. */
function edt2d(mask: ArrayLike<number>, w: number, h: number): Float64Array {
  const INF = 1e20
  const out = new Float64Array(w * h)
  const col = new Float64Array(h)
  const row = new Float64Array(w)
  for (let i = 0; i < w * h; i++) out[i] = mask[i] ? 0 : INF
  for (let y = 0; y < h; y++) {                    // rows
    for (let x = 0; x < w; x++) row[x] = out[y * w + x]
    const r = edt1d(row, w)
    for (let x = 0; x < w; x++) out[y * w + x] = r[x]
  }
  for (let x = 0; x < w; x++) {                    // columns
    for (let y = 0; y < h; y++) col[y] = out[y * w + x]
    const r = edt1d(col, h)
    for (let y = 0; y < h; y++) out[y * w + x] = r[y]
  }
  return out
}

/** A separable box blur, `passes` times over. */
function boxBlur(
  src: ArrayLike<number>,
  w: number,
  h: number,
  radius: number,
  passes: number
): Float32Array {
  // `Float32Array.from` would widen the buffer type to `ArrayBufferLike`, which
  // then refuses to flow back into a plain `Float32Array`. Allocate and copy.
  const a = new Float32Array(w * h)
  a.set(src)
  const b = new Float32Array(w * h)
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {      // horizontal
      let acc = 0, n = 0
      for (let i = -radius; i <= radius; i++) {
        const xx = x + i
        if (xx < 0 || xx >= w) continue
        acc += a[y * w + xx]
        n++
      }
      b[y * w + x] = acc / n
    }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {      // vertical
      let acc = 0, n = 0
      for (let i = -radius; i <= radius; i++) {
        const yy = y + i
        if (yy < 0 || yy >= h) continue
        acc += b[yy * w + x]
        n++
      }
      a[y * w + x] = acc / n
    }
  }
  return a
}

/** Turn one item image into the field set the wrapping renderer needs.
 *
 *  @param img        the art. It must be decoded and CORS-clean.
 *  @param reliefBlur the blur radius of the relief map. Every caller uses the
 *                    default 3; a bigger number reads coarser when the
 *                    wrapping is drawn small. */
export function buildFields(img: CanvasImageSource, reliefBlur = 3): WrappingFields {
  const read = (n: number): Uint8ClampedArray => {
    const c = new ScratchCanvas(n, n, { readback: true })
    c.ctx.drawImage(img, 0, 0, n, n)
    // Throws a SecurityError when the image is not CORS-clean. The caller owns
    // the `crossOrigin` attribute — see the header.
    try {
      return c.pixels()
    } finally {
      c.release()
    }
  }
  return fieldsFromPixels(read(FIELD_N), read(COLOUR_N), reliefBlur)
}

/** The build itself, from the art's pixels: RGBA at FIELD_N² (`px`) and at
 *  COLOUR_N² (`q`), each the art drawn to that square. Pure arithmetic, so
 *  wrapping/fields.worker.ts runs it off the main thread. */
export function fieldsFromPixels(px: Uint8ClampedArray, q: Uint8ClampedArray, reliefBlur = 3): WrappingFields {
  const N = FIELD_N

  const mask = new Uint8Array(N * N)
  const inv = new Uint8Array(N * N)
  for (let i = 0; i < N * N; i++) {
    mask[i] = px[i * 4 + 3] > 128 ? 1 : 0
    inv[i] = mask[i] ? 0 : 1
  }

  // The item's own luminance, blurred. Until a real bump map exists this is
  // what drives the relief and the zone mask.
  const lum = new Float32Array(N * N)
  for (let i = 0; i < N * N; i++) {
    const aw = px[i * 4 + 3] / 255
    lum[i] = aw * (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2])
      + (1 - aw) * 128
  }
  const lumS = boxBlur(lum, N, N, reliefBlur, 2)
  const lumBlur = new Uint8Array(N * N)
  for (let i = 0; i < N * N; i++) {
    lumBlur[i] = Math.max(0, Math.min(255, Math.round(lumS[i])))
  }

  const dOut = edt2d(mask, N, N)
  const dIn = edt2d(inv, N, N)
  const sd = new Float32Array(N * N)
  for (let i = 0; i < N * N; i++) sd[i] = Math.sqrt(dOut[i]) - Math.sqrt(dIn[i])  // > 0 outside
  const sdSoft = boxBlur(sd, N, N, 7, 2)

  // Rows go out bottom-up. See the header.
  const data = new Uint8Array(N * N * 4)
  for (let yy = 0; yy < N; yy++) for (let xx = 0; xx < N; xx++) {
    const src = yy * N + xx
    const dst = (N - 1 - yy) * N + xx
    data[dst * 4] = Math.max(0, Math.min(255, Math.round(128 + sd[src] / FIELD_RANGE * 127)))
    data[dst * 4 + 1] = Math.max(0, Math.min(255, Math.round(128 + sdSoft[src] / FIELD_RANGE * 127)))
    // Channel B: a static ripple. The shader never reads it.
    const rx = xx / N * 6.0, ry = yy / N * 6.0
    const rip = 0.5 + 0.28 * Math.sin(rx * 2.1 + ry * 1.3) + 0.22 * Math.sin(rx * 3.7 - ry * 2.9)
    data[dst * 4 + 2] = Math.max(0, Math.min(255, Math.round(rip * 255)))
    data[dst * 4 + 3] = lumBlur[src]
  }

  // The colour field. The blur is alpha-weighted, then divided by the blurred
  // alpha, so no black bleeds out of the cut-out.
  const CF = COLOUR_N
  const rw = new Float32Array(CF * CF)
  const gw = new Float32Array(CF * CF)
  const bw = new Float32Array(CF * CF)
  const aw2 = new Float32Array(CF * CF)
  for (let i = 0; i < CF * CF; i++) {
    const w = q[i * 4 + 3] / 255
    rw[i] = q[i * 4] * w
    gw[i] = q[i * 4 + 1] * w
    bw[i] = q[i * 4 + 2] * w
    aw2[i] = w
  }
  const rr = boxBlur(rw, CF, CF, 5, 2)
  const gg = boxBlur(gw, CF, CF, 5, 2)
  const bb = boxBlur(bw, CF, CF, 5, 2)
  const aa = boxBlur(aw2, CF, CF, 5, 2)
  const cdata = new Uint8Array(CF * CF * 4)
  for (let yy = 0; yy < CF; yy++) for (let xx = 0; xx < CF; xx++) {
    const s = yy * CF + xx
    const d = (CF - 1 - yy) * CF + xx
    const wa = Math.max(aa[s], 1e-3)
    // The typed array truncates the fraction. The build relies on that.
    cdata[d * 4] = Math.min(255, rr[s] / wa)
    cdata[d * 4 + 1] = Math.min(255, gg[s] / wa)
    cdata[d * 4 + 2] = Math.min(255, bb[s] / wa)
    cdata[d * 4 + 3] = 255
  }

  // The mask bounds in uv space. The rows flip on upload, so v inverts here.
  let mnx = N, mxx = 0, mny = N, mxy = 0
  for (let by = 0; by < N; by++) for (let bx = 0; bx < N; bx++) {
    if (!mask[by * N + bx]) continue
    if (bx < mnx) mnx = bx
    if (bx > mxx) mxx = bx
    if (by < mny) mny = by
    if (by > mxy) mxy = by
  }
  const bbox: readonly [number, number, number, number] = mxx >= mnx
    ? [mnx / N, 1 - (mxy + 1) / N, (mxx + 1) / N, 1 - mny / N]
    : [0, 0, 1, 1]

  return { sdf: data, colour: cdata, bbox }
}

/** Tileable value noise, four independent channels in one RGBA block.
 *
 *  The renderer uploads it with `gl.REPEAT`. Clamp makes the wobble and the
 *  ripple streak at the quad edge. */
export function noiseTex(size: number, cells: number): Uint8Array {
  const g: Float32Array[] = []
  for (let ch = 0; ch < 4; ch++) {
    const grid = new Float32Array(cells * cells)
    for (let i = 0; i < cells * cells; i++) grid[i] = Math.random()
    g.push(grid)
  }
  const out = new Uint8Array(size * size * 4)
  const smooth = (t: number): number => t * t * (3 - 2 * t)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    for (let ch = 0; ch < 4; ch++) {
      const fx = x / size * cells, fy = y / size * cells
      const x0 = Math.floor(fx), y0 = Math.floor(fy)
      const tx = smooth(fx - x0), ty = smooth(fy - y0)
      const gc = g[ch]
      const a = gc[(y0 % cells) * cells + (x0 % cells)]
      const b = gc[(y0 % cells) * cells + ((x0 + 1) % cells)]
      const c = gc[((y0 + 1) % cells) * cells + (x0 % cells)]
      const d = gc[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)]
      const v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
      out[(y * size + x) * 4 + ch] = Math.round(v * 255)
    }
  }
  return out
}
