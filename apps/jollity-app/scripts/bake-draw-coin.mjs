#!/usr/bin/env node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// BAKE THE PRIZE DRAW'S COINS, so a phone never builds them (seconds of GPU
// and main-thread work):
//   - the coin the player flips (the flip page's Good Luck coin, SOLID_LOOK)
//     → public/draw/lucky-coin/
//   - the prize's coin for each amount the draws pay (the slit page's
//     PRIZE_LOOK with the amount and the unit on it, as wheel/ending.js builds
//     it for a winner)
//     → public/draw/prize-coin/<amount>/, with index.json by key
//
//   node scripts/bake-draw-coin.mjs            # the prize amounts below
//   node scripts/bake-draw-coin.mjs 1 10 25    # these prize amounts instead
//
// Builds each coin once with the draw's own code (lib/draw/wheel/proto/
// render-utils/coin/look/build.js) in
// headless Chrome and writes, per coin: manifest.json, each face's normal +
// orm maps (half size, lossless, rows bottom-up as the GPU holds them) and
// letters.bin.gz (the 3D letters, 16-bit fixed point).
// lib/draw/wheel/baked-coin.ts loads them by engravingKey; if a coin's look
// changes the key misses and the phone builds it as before, until this reruns.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runInChrome } from "./lib/headless.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "..")
// the page is served from the workspace root: npm hoists three and
// postprocessing to its node_modules, not the app's
const root = path.resolve(repo, "..", "..")
const draw = path.join(repo, "public", "draw")

// the amounts the draws pay, as lib/draw/prize-unit.ts coinAmount writes them
// (by default 1 and 10; read your network's Airdrop.Events and pass yours)
const PRIZE_AMOUNTS = process.argv.length > 2 ? process.argv.slice(2) : ["1", "10"]
// the unit under the amount, as lib/draw/prize-unit.ts PRIZE_UNIT
const PRIZE_UNIT = process.env.NEXT_PUBLIC_PRIZE_UNIT?.trim() || "CASH"
const COINS = [
  { dir: "lucky-coin", kind: "intro" },
  ...PRIZE_AMOUNTS.map((amount) => ({ dir: `prize-coin/${amount}`, kind: "prize", amount, unit: PRIZE_UNIT })),
]

const PAGE = `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{
  "three": "/node_modules/three/build/three.module.js",
  "three/examples/jsm/": "/node_modules/three/examples/jsm/",
  "postprocessing": "/node_modules/postprocessing/build/index.js"
}}</script>
<script type="module">
import * as THREE from "three"
import { createCoinBuild, engravingKey } from "/apps/jollity-app/lib/draw/wheel/proto/render-utils/coin/look/build.js"
import { SOLID_LOOK, PRIZE_LOOK } from "/apps/jollity-app/lib/draw/wheel/proto/scenes/wheel/slit/config.js"
const COINS = __COINS__
try {
  const renderer = new THREE.WebGLRenderer({ canvas: document.createElement("canvas"), antialias: false })
  const baked = []
  for (const c of COINS) {
    // the flip's coin, or the prize's with the stage's words (wheel/ending.js)
    const L = c.kind === "intro" ? { ...SOLID_LOOK } : { ...PRIZE_LOOK, amount: c.amount, label: c.unit }
    const build = createCoinBuild(renderer)
    // as coin/lucky.js builds it: the shape first, then the one redraw
    build.coin.shape(L.thick, L.rimW, L.sides, L.round, L.edgeRound)
    build.redraw(L)
    const N = build.sets.front.N
    // a map as an image file at HALF the bake's side: each texel the average of
    // the 2×2 it covers, which is the mip level the GPU samples a coin of this
    // size from anyway (the full-size maps rendered no different on a phone)
    // and a quarter of the bytes. Then LOSSLESS: WebP when it decodes back to
    // the very same bytes, PNG otherwise.
    const M = N / 2
    const encode = async (rt) => {
      const full = new Uint8Array(N * N * 4)
      renderer.readRenderTargetPixels(rt, 0, 0, N, N, full)
      for (let i = 3; i < full.length; i += 4) if (full[i] !== 255) throw new Error("a map has alpha: an image file would not hold it exactly")
      const px = new Uint8Array(M * M * 4)
      for (let y = 0; y < M; y++)
        for (let x = 0; x < M; x++)
          for (let ch = 0; ch < 4; ch++) {
            const at = (yy, xx) => full[(yy * N + xx) * 4 + ch]
            px[(y * M + x) * 4 + ch] = (at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1) + 2) >> 2
          }
      const c = document.createElement("canvas")
      c.width = c.height = M
      c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(px.buffer), M, M), 0, 0)
      const webp = c.toDataURL("image/webp", 1)
      const back = await createImageBitmap(await (await fetch(webp)).blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" })
      const d = document.createElement("canvas")
      d.width = d.height = M
      const g = d.getContext("2d", { willReadFrequently: true })
      g.drawImage(back, 0, 0)
      const got = g.getImageData(0, 0, M, M).data
      let same = webp.startsWith("data:image/webp")
      for (let i = 0; same && i < got.length; i++) if (got[i] !== px[i]) same = false
      return same ? { ext: "webp", data: webp } : { ext: "png", data: c.toDataURL("image/png") }
    }
    const b64 = (view) => {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      let s = ""
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(s)
    }
    // the letters in 16-bit fixed point: positions and normals in [-1, 1] (a
    // unit coin: the diameter is 2), uvs in [0, 1], each to 1/32767, far under a
    // pixel of a coin on any screen; half the bytes of 32-bit floats
    const fixed = (a) => {
      const v = a.array
      if (!(v instanceof Float32Array) || a.normalized) return { array: v, normalized: a.normalized }
      let lo = Infinity, hi = -Infinity
      for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x }
      if (lo >= 0 && hi <= 1) return { array: Uint16Array.from(v, (x) => Math.round(x * 65535)), normalized: true }
      if (lo >= -1 && hi <= 1) return { array: Int16Array.from(v, (x) => Math.round(x * 32767)), normalized: true }
      return { array: v, normalized: false }
    }
    const geometry = (g) =>
      g && {
        attributes: Object.fromEntries(
          Object.entries(g.attributes).map(([name, a]) => {
            const f = fixed(a)
            return [name, { itemSize: a.itemSize, normalized: f.normalized, type: f.array.constructor.name, data: b64(f.array) }]
          }),
        ),
        index: g.index ? { type: g.index.array.constructor.name, data: b64(g.index.array) } : null,
      }
    baked.push({
      dir: c.dir,
      key: engravingKey(L),
      N: M,
      sides: Object.fromEntries(
        await Promise.all(
          ["front", "back"].map(async (side) => [side, { normal: await encode(build.sets[side].normal), orm: await encode(build.sets[side].orm), letters: geometry(build.made[side]) }]),
        ),
      ),
    })
  }
  window.__bake = baked
} catch (e) {
  window.__bake = { error: String(e && e.stack || e) }
}
</script>`

// the page reads three.js, postprocessing and the draw code in proto/ straight from the repo
const bakes = await runInChrome({ html: PAGE.replace("__COINS__", JSON.stringify(COINS)), root, result: "__bake", timeout: 300_000 })
if (!Array.isArray(bakes)) throw new Error(`the bake failed: ${bakes?.error ?? JSON.stringify(bakes)}`)

// the prize coins are the ones asked for: an amount no longer paid is dropped
rmSync(path.join(draw, "prize-coin"), { recursive: true, force: true })
for (const bake of bakes) writeCoin(path.join(draw, bake.dir), bake)
// the loader fetches only what is listed, by key (lib/draw/wheel/baked-coin.ts)
const index = Object.fromEntries(bakes.filter((b) => b.dir.startsWith("prize-coin/")).map((b) => [b.key, b.dir.slice("prize-coin/".length)]))
writeFileSync(path.join(draw, "prize-coin", "index.json"), JSON.stringify(index, null, 2) + "\n")

function writeCoin(out, bake) {
  mkdirSync(out, { recursive: true })
  // the letters: every face's attributes and index, packed 4-byte aligned
  const chunks = []
  let offset = 0
  const put = (b64) => {
    const bytes = Buffer.from(b64, "base64")
    const at = offset
    chunks.push(bytes)
    offset += bytes.length
    const pad = (4 - (offset % 4)) % 4
    if (pad) {
      chunks.push(Buffer.alloc(pad))
      offset += pad
    }
    return { offset: at, bytes: bytes.length }
}
const sides = {}
for (const [side, s] of Object.entries(bake.sides)) {
  for (const map of ["normal", "orm"]) writeFileSync(path.join(out, `${side}-${map}.${s[map].ext}`), Buffer.from(s[map].data.split(",")[1], "base64"))
  sides[side] = {
    normal: `${side}-normal.${s.normal.ext}`,
    orm: `${side}-orm.${s.orm.ext}`,
    letters: s.letters && {
      attributes: Object.fromEntries(
        Object.entries(s.letters.attributes).map(([name, a]) => [name, { itemSize: a.itemSize, normalized: a.normalized, type: a.type, ...put(a.data) }]),
      ),
      index: s.letters.index && { type: s.letters.index.type, ...put(s.letters.index.data) },
    },
  }
}
// gzipped: the letters are unindexed triangles, a sixth of the size zipped,
// and DecompressionStream opens it in every browser the app runs in
writeFileSync(path.join(out, "letters.bin.gz"), gzipSync(Buffer.concat(chunks), { level: 9 }))
writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ key: bake.key, N: bake.N, letters: "letters.bin.gz", sides }, null, 2) + "\n")
for (const f of readdirSync(out)) if (![...Object.values(sides).flatMap((x) => [x.normal, x.orm]), "letters.bin.gz", "manifest.json"].includes(f)) rmSync(path.join(out, f))
const size = (f) => (statSync(path.join(out, f)).size / 1024).toFixed(0)
console.log(`baked a coin (maps ${bake.N}²) into ${path.relative(repo, out)}:`)
for (const f of readdirSync(out).sort()) console.log(`  ${f.padEnd(20)} ${size(f)} KB`)
}
