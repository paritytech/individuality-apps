// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The prize draw's coins, baked, so a phone does not build them.
 *
 * The coin the player drags into the slit (the slit page's Good Luck coin,
 * SOLID_LOOK) is the same every draw: scripts/bake-draw-coin.mjs ships it
 * (public/draw/lucky-coin/) and this loads it into the build's BAKED registry,
 * keyed by engravingKey. The prize's coin carries the chain's amount, so the
 * script ships it for the amounts the draws pay (public/draw/prize-coin/,
 * index.json by key), loaded for a winner only (loadPrizeCoin). Any other
 * amount is built on the phone once and kept in IndexedDB (BAKE_HOOK →
 * keepBakes(), called as the stage closes) for the next draw of that prize.
 *
 * Anything missing or failing leaves BAKED without it: the coin is built as
 * before. Client only.
 */
import * as THREE from "three"
import { asset } from "@/lib/asset"
import { once } from "@/lib/async-cache"
import { ScratchCanvas } from "@/lib/dom/canvas"
import { committed, openStore, request } from "@/lib/idb"
import { BAKED, BAKE_HOOK, engravingKey } from "./proto/render-utils/coin/look/build.js"
import { SOLID_LOOK, PRIZE_LOOK } from "./proto/scenes/wheel/slit/config.js"

interface Packed {
  type: string
  offset: number
  bytes: number
}
interface Manifest {
  key: string
  N: number
  letters: string
  sides: Record<
    "front" | "back",
    {
      normal: string
      orm: string
      letters: { attributes: Record<string, Packed & { itemSize: number; normalized: boolean }>; index: Packed | null } | null
    }
  >
}

const INTRO_DIR = "/draw/lucky-coin"
const PRIZE_DIR = "/draw/prize-coin"
const ARRAYS: Record<string, new (buffer: ArrayBuffer, offset: number, length: number) => ArrayBufferView & ArrayLike<number>> = {
  Float32Array,
  Uint32Array,
  Uint16Array,
  Int16Array,
  Uint8Array,
}

/** a map as the baker's render target held it: linear, mipmapped, rows bottom-up */
async function texture(dir: string, file: string): Promise<THREE.Texture> {
  return textureOf(await (await fetch(asset(`${dir}/${file}`))).blob())
}
async function textureOf(blob: Blob): Promise<THREE.Texture> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" })
  const t = new THREE.Texture(bitmap)
  t.flipY = false
  t.colorSpace = THREE.NoColorSpace
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.anisotropy = 8 // the baker's: 8, or what the GPU offers, which three clamps to
  t.needsUpdate = true
  return t
}

async function gunzip(dir: string, file: string): Promise<ArrayBuffer> {
  const res = await fetch(asset(`${dir}/${file}`))
  if (!res.body) throw new Error("no body")
  return new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
}
const gunzipBlob = (blob: Blob) => new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
const gzipBytes = (bytes: Uint8Array) => new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))).blob()

function geometry(buf: ArrayBuffer, g: NonNullable<Manifest["sides"]["front"]["letters"]>): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry()
  const view = (p: Packed) => {
    const Arr = ARRAYS[p.type]
    if (!Arr) throw new Error(`unknown array ${p.type}`)
    const size = (Arr as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
    return new Arr(buf, p.offset, p.bytes / size)
  }
  for (const [name, a] of Object.entries(g.attributes)) {
    out.setAttribute(name, new THREE.BufferAttribute(view(a) as unknown as THREE.TypedArray, a.itemSize, a.normalized))
  }
  if (g.index) out.setIndex(new THREE.BufferAttribute(view(g.index) as unknown as THREE.TypedArray, 1))
  return out
}

/** a coin the script shipped under `dir`, into BAKED under `key` */
async function loadShipped(dir: string, key: string): Promise<void> {
  const manifest = (await (await fetch(asset(`${dir}/manifest.json`))).json()) as Manifest
  // baked from another coin than this build's: build it live instead
  if (manifest.key !== key) return
  const [letters, ...maps] = await Promise.all([
    gunzip(dir, manifest.letters),
    texture(dir, manifest.sides.front.normal),
    texture(dir, manifest.sides.front.orm),
    texture(dir, manifest.sides.back.normal),
    texture(dir, manifest.sides.back.orm),
  ])
  const side = (s: "front" | "back", normal: THREE.Texture, orm: THREE.Texture) => {
    const l = manifest.sides[s].letters
    return { normal, orm, letters: l ? geometry(letters, l) : null }
  }
  BAKED.set(key, { N: manifest.N, front: side("front", maps[0]!, maps[1]!), back: side("back", maps[2]!, maps[3]!) })
}

// ── the coins this device baked itself ─────────────────────────────────────
type Letters = NonNullable<Manifest["sides"]["front"]["letters"]>
interface Kept {
  key: string
  N: number
  maps: Record<"front" | "back", { normal: Blob; orm: Blob }>
  letters: Blob
  layout: Record<"front" | "back", Letters | null>
  at: number
}
/** a bake as the build hands it over (build.js's BAKE_HOOK) */
interface FreshBake {
  key: string
  renderer: THREE.WebGLRenderer
  sets: Record<"front" | "back", { N: number; normal: THREE.WebGLRenderTarget; orm: THREE.WebGLRenderTarget }>
  made: Record<"front" | "back", THREE.BufferGeometry | null>
}

const DB = "jollity-draw-coins"
const STORE = "coins"
/** the looks kept: the prize's coin, and room for a prize that changes */
const KEEP = 4

const openDb = () => openStore(DB, STORE, "key")
const all = (db: IDBDatabase) => request(db.transaction(STORE).objectStore(STORE).getAll() as IDBRequest<Kept[]>)
function write(db: IDBDatabase, put: Kept[], drop: string[]): Promise<void> {
  const tx = db.transaction(STORE, "readwrite")
  const store = tx.objectStore(STORE)
  for (const k of put) store.put(k)
  for (const key of drop) store.delete(key)
  return committed(tx)
}

async function loadKept(): Promise<void> {
  const db = await openDb()
  for (const k of await all(db)) {
    if (BAKED.has(k.key)) continue
    const [letters, fn, fo, bn, bo] = await Promise.all([
      gunzipBlob(k.letters),
      textureOf(k.maps.front.normal),
      textureOf(k.maps.front.orm),
      textureOf(k.maps.back.normal),
      textureOf(k.maps.back.orm),
    ])
    const side = (s: "front" | "back", normal: THREE.Texture, orm: THREE.Texture) => ({
      normal,
      orm,
      letters: k.layout[s] ? geometry(letters, k.layout[s]) : null,
    })
    BAKED.set(k.key, { N: k.N, front: side("front", fn, fo), back: side("back", bn, bo) })
  }
}

/** bakes this page made that are not kept yet, by key */
const fresh = new Map<string, FreshBake>()
// the hook is a plain object in proto/'s build.js: typed here, where it is filled
;(BAKE_HOOK as { onBake: ((bake: FreshBake) => void) | null }).onBake = (bake) => {
  if (!BAKED.has(bake.key)) fresh.set(bake.key, bake)
}

/** a render target as a lossless image at half its side (2×2 averaged: the mip a phone samples) */
function encode(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, N: number): Promise<Blob> {
  const full = new Uint8Array(N * N * 4)
  renderer.readRenderTargetPixels(rt, 0, 0, N, N, full)
  const M = N / 2
  const px = new Uint8ClampedArray(M * M * 4)
  for (let y = 0; y < M; y++)
    for (let x = 0; x < M; x++)
      for (let ch = 0; ch < 4; ch++) {
        const i = (2 * y * N + 2 * x) * 4 + ch
        px[(y * M + x) * 4 + ch] = (full[i]! + full[i + 4]! + full[i + N * 4]! + full[i + N * 4 + 4]! + 2) >> 2
      }
  const c = new ScratchCanvas(M)
  c.ctx.putImageData(new ImageData(px, M, M), 0, 0)
  return new Promise((resolve, reject) =>
    c.canvas.toBlob(
      (b) => {
        c.release() // encoded: free the canvas now
        if (b) resolve(b)
        else reject(new Error("no image"))
      },
      "image/webp",
      1,
    ),
  )
}

/** an attribute in 16-bit fixed point where its values allow (as the shipped coin's letters) */
function fixed(a: THREE.BufferAttribute): { array: ArrayBufferView; normalized: boolean } {
  const v = a.array
  if (!(v instanceof Float32Array) || a.normalized) return { array: v, normalized: a.normalized }
  let lo = Infinity
  let hi = -Infinity
  for (const x of v) {
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  if (lo >= 0 && hi <= 1) return { array: Uint16Array.from(v, (x) => Math.round(x * 65535)), normalized: true }
  if (lo >= -1 && hi <= 1) return { array: Int16Array.from(v, (x) => Math.round(x * 32767)), normalized: true }
  return { array: v, normalized: false }
}

/** the letters' attributes and index, packed 4-byte aligned, and where each one is */
function pack(made: FreshBake["made"]): { bytes: Uint8Array; layout: Kept["layout"] } {
  const parts: Uint8Array[] = []
  let offset = 0
  const put = (a: ArrayBufferView) => {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const at = offset
    parts.push(bytes)
    offset += bytes.length
    const pad = (4 - (offset % 4)) % 4
    if (pad) {
      parts.push(new Uint8Array(pad))
      offset += pad
    }
    return { offset: at, bytes: bytes.length }
  }
  const layoutOf = (g: THREE.BufferGeometry | null): Letters | null =>
    g && {
      attributes: Object.fromEntries(
        Object.entries(g.attributes).map(([name, a]) => {
          const f = fixed(a as THREE.BufferAttribute)
          return [name, { itemSize: a.itemSize, normalized: f.normalized, type: f.array.constructor.name, ...put(f.array) }]
        }),
      ),
      index: g.index ? { type: g.index.array.constructor.name, ...put(g.index.array) } : null,
    }
  const layout = { front: layoutOf(made.front), back: layoutOf(made.back) }
  const bytes = new Uint8Array(offset)
  let at = 0
  for (const p of parts) {
    bytes.set(p, at)
    at += p.length
  }
  return { bytes, layout }
}

/** keep the coins this page baked for the next draw; call while the stage's GL context is alive */
export function keepBakes(): void {
  if (!fresh.size) return
  const read: { bake: FreshBake; maps: Promise<Kept["maps"]>; letters: ReturnType<typeof pack> }[] = []
  for (const bake of fresh.values()) {
    try {
      const N = bake.sets.front.N
      const map = (side: "front" | "back") =>
        Promise.all([encode(bake.renderer, bake.sets[side].normal, N), encode(bake.renderer, bake.sets[side].orm, N)])
      read.push({
        bake,
        maps: Promise.all([map("front"), map("back")]).then(([f, b]) => ({ front: { normal: f[0], orm: f[1] }, back: { normal: b[0], orm: b[1] } })),
        letters: pack(bake.made),
      })
    } catch {
      // a target already gone: built again next time
    }
  }
  fresh.clear()
  void (async () => {
    const kept: Kept[] = []
    for (const r of read) {
      kept.push({ key: r.bake.key, N: r.bake.sets.front.N / 2, maps: await r.maps, letters: await gzipBytes(r.letters.bytes), layout: r.letters.layout, at: Date.now() })
    }
    const db = await openDb()
    const had = await all(db)
    const drop = [...had, ...kept]
      .sort((a, b) => b.at - a.at)
      .slice(KEEP)
      .map((k) => k.key)
    await write(db, kept, drop)
  })().catch(() => {})
}

/** let the baked coins' GPU copies go as the stage closes. three hangs a
 *  dispose listener on every texture and geometry it uploads, and that
 *  listener holds the renderer, so a kept coin would keep the whole closed
 *  draw alive. The textures and letters keep their pixels and vertices: the
 *  next draw uploads them again. */
export function releaseBakes(): void {
  for (const coin of BAKED.values() as Iterable<{ front: BakedSide; back: BakedSide }>)
    for (const side of [coin.front, coin.back]) {
      side.normal.dispose()
      side.orm.dispose()
      side.letters?.dispose()
    }
}
type BakedSide = { normal: THREE.Texture; orm: THREE.Texture; letters: THREE.BufferGeometry | null }

/** load the baked coins, once a page: resolves when they are in BAKED, or when they cannot be (never rejects) */
export const loadBakedCoins = once(() =>
  Promise.all([loadShipped(INTRO_DIR, engravingKey(SOLID_LOOK)).catch(() => {}), loadKept().catch(() => {})]).then(() => {}),
)

// ── the prize's coin, for the amounts the draws pay ──────────────────────────
/** the prize's coin as wheel/ending.js builds it: the base look with the stage's words */
const prizeKey = (amount: string, unit: string) => engravingKey({ ...PRIZE_LOOK, amount, label: unit })
/** the shipped prize coins, by key → their folder under PRIZE_DIR; none when it cannot be read */
const prizeIndex = once(async (): Promise<Record<string, string>> => {
  const res = await fetch(asset(`${PRIZE_DIR}/index.json`))
  return res.ok ? ((await res.json()) as Record<string, string>) : {}
})
const prizeLoads = new Map<string, Promise<void>>()
/** a winner's prize coin, when the script shipped one for this amount and unit
 *  (`amount` as coinAmount writes it). Resolves when it is in BAKED or cannot
 *  be, never rejects; a coin not shipped is not fetched at all. */
export function loadPrizeCoin(amount: string, unit: string): Promise<void> {
  const key = prizeKey(amount, unit)
  let load = prizeLoads.get(key)
  if (!load) {
    load = (async () => {
      if (BAKED.has(key)) return
      const dir = (await prizeIndex())[key]
      if (dir) await loadShipped(`${PRIZE_DIR}/${dir}`, key)
    })().catch(() => {})
    prizeLoads.set(key, load)
  }
  return load
}
