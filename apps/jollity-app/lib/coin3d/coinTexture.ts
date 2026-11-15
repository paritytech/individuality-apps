// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The engraving — one canvas texture for the coin's six faces.
//
// One ATLAS holds the six PHYSICAL faces: six tiles side by side, tile k
// covering the texture band face k owns. Each tile carries TWO LINES of type,
// white on transparent: the COLLECTION name on top, small and wide, and the
// ITEM name below, large and bold. There is no icon and there is no text on
// the top face — the metal carries these two lines and nothing else.
//
// The wall shader reads the ALPHA as an ink mask and paints its own colour, so
// the collection line is made dimmer with a lower alpha and never with a
// different fill. See coinMaterial.ts.
//
// THE TILES ARE REPAINTED AS THE COIN TURNS. There are more collections than
// faces, so a face carries a different collection after a whole turn — see
// ./facetWheel.ts. setFaceTexts() repaints only the tiles whose pair really
// changed, which is at most one per face crossed. The wheel puts that change on
// a face that points away from the camera. TWO TILES ARE EQUAL ONLY WHEN BOTH
// STRINGS MATCH.
//
// Every repaint is SYNCHRONOUS. The atlas loads nothing and waits for nothing.
//
// The canvas is sized from the coin's real proportions (see bandAspect in
// coinMesh.ts), so the letters keep their shape at every coin thickness.

import * as THREE from 'three'
import { COIN_SIDES } from './coinGeometry'
import type { FaceText } from './facetWheel'

/** Tile height in texels. It stands for the STRAIGHT part of the wall only,
 *  which is about 42 CSS px tall on a phone, so this is roughly 2x. */
const TILE_H = 96

/** No atlas may be wider than this. The oldest WebGL devices guarantee 2048,
 *  and six tiles at the default dials land near 2000, so the margin is thin.
 *  A thinner coin makes a wider band and would pass it. */
const MAX_ATLAS_W = 2048

/** How much of the flat the engraving is allowed to use. The rest is the
 *  margin that keeps a letter from bending round a corner. */
const FLAT_USE = 0.9

const FONT_STACK = "'Inter', system-ui, sans-serif"

/** How one line of the tile is drawn. `alpha` is INK COVERAGE and not colour:
 *  the wall shader mixes its own engraving colour by this amount, so a lower
 *  number reads as a dimmer cut. */
interface LineStyle {
  /** The font size in texels (the canvas `font` px), before any shrink to fit. */
  fontPx: number
  weight: number
  /** Widest tracking the spread may add, as a fraction of the font size. */
  trackCap: number
  alpha: number
}

/* Inter ships as a variable font (100–900, app/layout.tsx), so these weights
   draw true; where it is missing, a fallback face may synthesize bold. */
/** The collection. Small, wide-tracked and dim. */
const LABEL_LINE: LineStyle = { fontPx: TILE_H * 0.2, weight: 500, trackCap: 0.34, alpha: 0.5 }
/** The item. The headline of the tile. */
const NAME_LINE: LineStyle = { fontPx: TILE_H * 0.38, weight: 600, trackCap: 0.12, alpha: 1 }
/** Space between the two lines, in texels. */
const LINE_GAP = TILE_H * 0.07

export interface CoinAtlas {
  texture: THREE.CanvasTexture
  /** Repaint the faces whose pair changed. Takes one pair per PHYSICAL face, so
   *  the array is always COIN_SIDES long. A pair equal to what the tile already
   *  holds costs nothing. */
  setFaceTexts: (faces: readonly FaceText[]) => void
  dispose: () => void
}

export interface CoinAtlasParams {
  /** One collection + item pair per PHYSICAL face, in face order. Six of them. */
  faces: readonly FaceText[]
  /** Width over height of one face's texture band, from buildCoinGeometry. */
  bandAspect: number
  /** How much of that band is flat, from buildCoinGeometry. */
  flatFraction: number
}

/** Build the face atlas. The texture comes back drawn. */
export function buildEngraveAtlas({ faces, bandAspect, flatFraction }: CoinAtlasParams): CoinAtlas {
  const shown: FaceText[] = []
  for (let k = 0; k < COIN_SIDES; k++) {
    const face = faces[k]
    shown.push({ label: face?.label ?? '', name: face?.name ?? '' })
  }

  let tileH = TILE_H
  let tileW = Math.round(tileH * bandAspect)
  if (tileW * COIN_SIDES > MAX_ATLAS_W) {
    const shrink = MAX_ATLAS_W / (tileW * COIN_SIDES)
    tileW = Math.floor(tileW * shrink)
    tileH = Math.floor(tileH * shrink)
  }
  // The dials above are written against TILE_H. A narrow device shrinks the
  // atlas, so the type has to shrink with it.
  const scale = tileH / TILE_H

  const canvas = document.createElement('canvas')
  canvas.width = tileW * COIN_SIDES
  canvas.height = tileH
  const ctx = canvas.getContext('2d')

  const texture = new THREE.CanvasTexture(canvas)
  // The wall's v runs past 0 and 1 over the two lips. Clamping there samples
  // the transparent first and last row, which is exactly what the lips want.
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  // The wall shader reads the ALPHA only and paints its own colour, so the
  // atlas carries no colour space of its own.
  texture.colorSpace = THREE.NoColorSpace
  texture.anisotropy = 4

  let disposed = false

  // The two-line block, centered in the straight wall.
  const labelStyle: LineStyle = { ...LABEL_LINE, fontPx: LABEL_LINE.fontPx * scale }
  const nameStyle: LineStyle = { ...NAME_LINE, fontPx: NAME_LINE.fontPx * scale }
  const gap = LINE_GAP * scale
  const blockH = labelStyle.fontPx + gap + nameStyle.fontPx
  const blockTop = (tileH - blockH) / 2
  const labelMid = blockTop + labelStyle.fontPx / 2
  const nameMid = blockTop + labelStyle.fontPx + gap + nameStyle.fontPx / 2
  const flatW = tileW * flatFraction * FLAT_USE

  /** Redraw one tile from scratch: clear, collection, item. */
  function paintTile(k: number): void {
    if (!ctx) return
    const face = shown[k]
    const x0 = k * tileW
    ctx.clearRect(x0, 0, tileW, tileH)
    if (!face) return
    ctx.textBaseline = 'middle'
    drawLine(ctx, face.label, x0 + tileW / 2, labelMid, flatW, labelStyle)
    drawLine(ctx, face.name, x0 + tileW / 2, nameMid, flatW, nameStyle)
  }

  function paintAll(): void {
    for (let k = 0; k < COIN_SIDES; k++) paintTile(k)
    texture.needsUpdate = true
  }

  paintAll()

  // Inter may still be downloading when the picker opens. Without the reprint
  // the names would stay in the fallback face for the life of the coin.
  document.fonts?.ready.then(() => {
    if (disposed) return
    paintAll()
  }).catch(() => { /* the fallback face is readable enough */ })

  function setFaceTexts(next: readonly FaceText[]): void {
    let touched = false
    for (let k = 0; k < COIN_SIDES; k++) {
      const face = shown[k]
      const label = next[k]?.label ?? ''
      const name = next[k]?.name ?? ''
      // BOTH strings decide. Two collections can offer items with the same
      // name, and one collection changes its item as the wheel wraps.
      if (!face || (face.label === label && face.name === name)) continue
      face.label = label
      face.name = name
      paintTile(k)
      touched = true
    }
    if (touched) texture.needsUpdate = true
  }

  return {
    texture,
    setFaceTexts,
    dispose: () => {
      disposed = true
      texture.dispose()
    }
  }
}

// ── Drawing helpers ────────────────────────────────────────────────────────

/** Draw one line of the tile, letter by letter, centered on `cx`.
 *
 *  The prism spread its names with flex space-between. Canvas has no such
 *  thing, and letterSpacing is not everywhere yet, so the gaps are shared out
 *  by hand. A name too long to fit SHRINKS until it does — item names come from
 *  a filename parse and some of them are long, and a letter that bends round a
 *  corner or falls off the flat is worse than a small one. */
function drawLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  width: number,
  style: LineStyle
): void {
  const upper = text.toUpperCase()
  if (!upper) return
  const chars = [...upper]
  let size = style.fontPx
  ctx.font = `${style.weight} ${size}px ${FONT_STACK}`
  let natural = ctx.measureText(upper).width
  if (natural > width) {
    size = Math.max(9, size * (width / natural))
    ctx.font = `${style.weight} ${size}px ${FONT_STACK}`
    natural = ctx.measureText(upper).width
  }
  // A short name spread edge to edge would leave absurd gaps, so the tracking
  // is capped.
  const spare = Math.max(0, width - natural)
  const track = chars.length > 1 ? Math.min(spare / (chars.length - 1), size * style.trackCap) : 0
  const used = natural + track * Math.max(0, chars.length - 1)
  ctx.fillStyle = `rgba(255, 255, 255, ${style.alpha})`
  let x = cx - used / 2
  for (const ch of chars) {
    ctx.fillText(ch, x, cy)
    x += ctx.measureText(ch).width + track
  }
}
