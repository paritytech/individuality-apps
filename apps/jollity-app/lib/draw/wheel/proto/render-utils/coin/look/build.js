// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE COIN, BUILT FROM A LOOK — the solid (coin.js), its two engraving sets
   (maps.js) and its 3D letters (trace.js → letters.js), drawn from a look
   (look.js's keys). Two pages build it: the lab (coin-look), which redraws
   whenever a dial rests, and the intro (lucky.js), which draws the Lucky coin
   once.

   redraw(L) is the costly part, so the host decides when; key(L) says what it
   depends on, so a host can tell when it is due. It is two halves, and a host
   that cares when each lands calls them apart:

     prepare(L)  the CPU's: the engraving canvases and the 3D letters, traced
                 from a 2048² mask — the slow part on a phone, and almost no
                 memory (the mask is let go as soon as the letters have it)
     bake()      the GPU's, one face a call: the engraving baked into its maps
                 (maps.js) — a few ms of GPU, and the coin's memory. Each
                 engraving canvas goes once its face is baked. True when there
                 is nothing left to bake

   A look baked before (BAKED, by engravingKey) skips both: its maps and
   letters are taken as they are. A host that keeps bakes hears of every fresh
   one through BAKE_HOOK.onBake, while the sets still hold it. */

import { createCoin } from './coin.js'
import { createBaker, PATTERN, H_REF } from './maps.js'
import { engrave, letterMask, hasType } from './engrave.js'
import { traceLetters } from './trace.js'
import { letterGeometry } from './letters.js'
import { geometryLetters } from './look.js'

const TRACE_N = 2048 // the mask the 3D letters are traced from, px a side

/* what the engraving depends on: a change here is a redraw */
export const engravingKey = (L) =>
  [L.amount, L.label, L.backLabel, L.raised, L.pattern, L.fieldPattern, L.patternScale, L.patternDepth, L.cloverRaised, L.backDesign, L.logoDisc, L.logoSize, L.mapSize, L.rimW, L.thick, L.sides, L.round, L.parallax, L.bevel, L.height, L.profile, L.build, L.topCurve, L.topCurveWidth].join('|')

/* looks baked ahead of time, by engravingKey: { N, front, back }, each face
   { normal, orm, letters } — textures and a letters geometry (or null). A
   host fills it (jollity ships its draw's coins baked); nothing here does */
export const BAKED = new Map()
/* onBake({ key, renderer, sets, made }) after each fresh bake: the sets hold
   it only until the coin is let go, so whoever keeps it reads it then */
export const BAKE_HOOK = { onBake: null }

export function createCoinBuild(renderer) {
  const coin = createCoin()
  const baker = createBaker(renderer)
  const sets = { front: baker.createSet(), back: baker.createSet() }
  coin.maps('front', sets.front)
  coin.maps('back', sets.back)
  const canvases = { front: document.createElement('canvas'), back: document.createElement('canvas') }
  const mask = document.createElement('canvas')
  const made = { front: null, back: null } // the last fresh bake's letters, for BAKE_HOOK
  const shown = { front: null, back: null } // the textures each face reads now, baked ahead or ours
  let due = null // what bake() has left: { faces, opts, key }

  /* the engraving and the letters for look L, on the coin's current shape
     (coin.shape first). Returns what it cost, ms */
  function prepare(L) {
    const t0 = performance.now()
    const key = engravingKey(L)
    const ready = BAKED.get(key)
    if (ready) {
      for (const side of ['front', 'back']) coin.letters(side, ready[side].letters ? ready[side].letters.clone() : null)
      due = { faces: ['front', 'back'], ready }
      return { ms: performance.now() - t0, lettersMs: 0, baked: true }
    }
    const geo = coin.geometry
    const common = {
      N: Number(L.mapSize) || 1024,
      amount: L.amount,
      label: L.label,
      pattern: L.pattern,
      backLabel: L.backLabel,
      fieldPattern: L.fieldPattern,
      patternScale: L.patternScale,
      patternCut: L.patternDepth / (PATTERN * H_REF * 100), // % of the diameter → the canvas's units
      cloverRaised: L.cloverRaised,
      backDesign: L.backDesign,
      logoDisc: L.logoDisc / 100,
      logoSize: L.logoSize / 100,
      outline: geo.outline,
      fieldIn: geo.fieldIn,
      fieldOut: geo.fieldOut,
    }
    const solid = geometryLetters(L)
    for (const side of ['front', 'back']) engrave(canvases[side], { ...common, side })
    const opts = {
      keepHeight: L.parallax,
      bevel: L.bevel / 100,
      height: L.height / 100,
      raised: L.raised,
      letters: !solid,
      profile: L.profile,
      curve: L.topCurve,
      curveW: L.topCurveWidth / 100,
    }
    due = { faces: ['front', 'back'], opts, key }
    const t1 = performance.now()
    for (const side of ['front', 'back']) {
      // no 3D letters, or none on this face: nothing to draw, read back (16 MB) and trace
      if (!solid || !hasType(side, L)) {
        coin.letters(side, (made[side] = null))
        continue
      }
      letterMask(mask, { N: TRACE_N, side, amount: L.amount, label: L.label, backLabel: L.backLabel, backDesign: L.backDesign, logoDisc: L.logoDisc / 100, logoSize: L.logoSize / 100, fieldIn: geo.fieldIn })
      // unit-coin sizes: the diameter is 2
      coin.letters(side, (made[side] = letterGeometry(traceLetters(mask), { height: (L.height / 100) * 2, bevel: (L.bevel / 100) * 2, profile: L.profile })))
    }
    mask.width = mask.height = 0 // 16 MB: the letters have it now (letterMask sizes it again)
    const t2 = performance.now()
    return { ms: t2 - t0, lettersMs: solid ? t2 - t1 : 0 }
  }

  /* the next face's maps; true once there is nothing left to bake */
  function bake() {
    if (!due) return true
    const side = due.faces.shift()
    const { ready } = due
    if (ready) {
      // baked ahead: its textures, sent to the GPU now rather than on the first frame that draws them
      show(side, { N: ready.N, normal: { texture: ready[side].normal }, orm: { texture: ready[side].orm }, height: null, version: 1 })
      renderer.initTexture(ready[side].normal)
      renderer.initTexture(ready[side].orm)
    } else {
      baker.bake(sets[side], canvases[side], due.opts)
      show(side, sets[side])
      canvases[side].width = canvases[side].height = 0 // its pixels are in the maps now (engrave sizes it again)
    }
    if (due.faces.length) return false
    const key = due.key
    due = null
    if (key) BAKE_HOOK.onBake?.({ key, renderer, sets, made })
    return true
  }

  function show(side, set) {
    // a face moving off a look baked ahead lets that look's textures go from
    // the GPU (the look keeps them, and uploads them again if it is shown again)
    const was = shown[side]
    if (was && was !== sets[side] && was.normal.texture !== set.normal.texture) {
      was.normal.texture.dispose()
      was.orm.texture.dispose()
    }
    shown[side] = set
    coin.maps(side, set)
  }

  function redraw(L) {
    const t0 = performance.now()
    const r = prepare(L)
    while (!bake());
    return { ...r, ms: performance.now() - t0 }
  }

  /* everything the build holds: its maps, the baker's materials, the scratch
     canvases and the coin itself */
  function dispose() {
    for (const side of ['front', 'back']) {
      const s = shown[side]
      if (s && s !== sets[side]) {
        s.normal.texture.dispose()
        s.orm.texture.dispose()
      }
    }
    baker.dispose(Object.values(sets))
    for (const c of [canvases.front, canvases.back, mask]) c.width = c.height = 0
    due = null
    coin.dispose()
  }

  return { coin, baker, sets, made, prepare, bake, redraw, dispose }
}
