// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE ENGRAVING, AS DRAWN — a Canvas2D picture of each face, sharp edged, in
   two layers: R the height of the field and its patterns, G where the letters
   are. maps.js softens the two apart (a hairline pattern cannot take the
   letters' bevel), sets the letters at their height, and turns it all into
   normals and cavity; nothing here is lit.

   The canvas is the face's UV square, so its disc is the whole coin at unit
   radius (profile.js: u = x/2 + ½): canvas px per unit radius is N/2. The
   coin's outline (shape.js: round or a polygon) arrives as contours, which
   clip the rim's pattern and the field's; the letters fit the field's
   inscribed circle. The
   heights (0..1):

      FIELD 0.6    the field and the rim top alike — the lathe already made the rim
      patterns     stipple 0.45..0.75 dots · guilloché 0.75 lines · knurl 0.4 grooves
                   · the rosette 0.45, cut lightly into the field
      letters      not a height here: a mask. RAISED / CUT (below) are the
                   heights maps.js lays them at

   The front carries the amount and the label; the back its own words
   (backLabel, one line a word — LUCKY YOU), or the Polkadot symbol (render-utils/coin/logo.js)
   on a plain disc cleared out of the field's pattern (logoDisc: its radius, a
   share of the field's; logoSize: the symbol, a share of the disc). The field behind the letters takes
   a pattern from patterns.js on both faces (the back falls back to the
   guilloché when there is none, so it is never bare). */

import { fieldPattern, rosette } from './patterns.js'
import { drawLogo } from '../logo.js'

const FIELD = 0.6
export const RAISED = 1
export const CUT = 0.2
const FONT = 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif'
const rgb = (h, frost = 0) => `rgb(${Math.round(h * 255)},${frost ? 255 : 0},0)`

/* a seeded LCG, so the stipple is the same dots every redraw */
function lcg(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

export function formatAmount(n) {
  const v = Math.max(0, Math.round(Number(n) || 0))
  return v.toLocaleString('en-US')
}

function pattern(g, kind, c, r0, r1, px, clip) {
  g.save()
  clip(g)
  g.clip('evenodd')
  if (kind === 'stipple') {
    const rnd = lcg(11)
    const area = Math.PI * (r1 * r1 - r0 * r0)
    const n = Math.round((area * 0.16) / (px * px)) // the same dots at any map size, in more texels
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2
      const r = Math.sqrt(r0 * r0 + rnd() * (r1 * r1 - r0 * r0))
      g.fillStyle = rgb(0.45 + rnd() * 0.3)
      g.beginPath()
      g.arc(c + r * Math.cos(a), c + r * Math.sin(a), (0.6 + rnd() * 0.8) * px, 0, Math.PI * 2)
      g.fill()
    }
  } else if (kind === 'guilloche') {
    rosette(g, c, (r0 + r1) / 2, (r1 - r0) * 0.42, 36, 10, 1.6 * px, 0.75)
  } else if (kind === 'knurl') {
    // two sets of slanted grooves, crossing into diamonds
    g.strokeStyle = rgb(0.4)
    g.lineWidth = 1.6 * px
    const n = 140
    for (const slant of [1, -1]) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const b = a + (slant * 6 * Math.PI) / n
        g.beginPath()
        g.moveTo(c + r0 * Math.cos(a), c + r0 * Math.sin(a))
        g.lineTo(c + r1 * Math.cos(b), c + r1 * Math.sin(b))
        g.stroke()
      }
    }
  }
  g.restore()
}

/* the letters: `lines` top to bottom, each at its share of the field (sizes,
   the last one repeating), shrunk to fit its width */
function letters(g, c, fieldPx, lines, sizes, fill, halo = 0) {
  if (!lines.length) return
  g.fillStyle = fill
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  const maxW = fieldPx * 2 * 0.74
  const sized = lines.map((text, i) => {
    let size = fieldPx * sizes[Math.min(i, sizes.length - 1)]
    g.font = `800 ${size}px ${FONT}`
    const w = g.measureText(text).width
    if (w > maxW) size *= maxW / w
    g.font = `800 ${size}px ${FONT}`
    const m = g.measureText(text)
    return { text, size, asc: m.actualBoundingBoxAscent || size * 0.72 }
  })
  const gap = fieldPx * 0.1
  const total = sized.reduce((s, l) => s + l.asc, 0) + gap * (sized.length - 1)
  let y = c - total / 2
  for (const l of sized) {
    y += l.asc
    g.font = `800 ${l.size}px ${FONT}`
    if (halo > 0) {
      // clear the field's pattern round the letter first: a coin keeps its type in open metal
      g.save()
      g.strokeStyle = rgb(FIELD)
      g.lineWidth = halo * 2
      g.lineJoin = 'round'
      g.strokeText(l.text, c, y)
      g.restore()
    }
    g.fillText(l.text, c, y)
    y += gap
  }
}

/* one face's height canvas. `canvas` is reused when it is already N wide */
export function engrave(canvas, { N, side, amount, label, backLabel, pattern: kind, fieldPattern: fieldKind, patternScale = 1, patternCut = 0.25, cloverRaised = false, backDesign = 'words', logoDisc = 0.3, logoSize = 0.7, outline, fieldIn, fieldOut }) {
  if (canvas.width !== N) canvas.width = canvas.height = N
  const g = canvas.getContext('2d', { willReadFrequently: false })
  const c = N / 2
  const unit = N / 2 //          canvas px per unit radius
  const px = N / 1024 //         one "pixel" of detail at the reference size
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = rgb(FIELD)
  g.fillRect(0, 0, N, N)
  // the outline's points into canvas space (y down, as the canvas is; the face's v is up)
  const path = (pts, open = true) => {
    if (open) g.beginPath()
    pts.forEach((q, i) => (i ? g.lineTo(c + q.x * unit, c - q.y * unit) : g.moveTo(c + q.x * unit, c - q.y * unit)))
    g.closePath()
  }
  const band = (gg) => {
    gg.beginPath()
    path(outline.bandOuter, false)
    path(outline.bandInner, false)
  }
  pattern(g, kind, c, outline.bandIn * unit + 2 * px, outline.bandOut * unit - 1 * px, px, band)
  const fieldPx = fieldIn * unit
  const onField = fieldKind && fieldKind !== 'none' ? fieldKind : side === 'back' ? 'guilloche' : 'none'
  // the clover alone may stand up from the field instead of being cut into it
  const up = cloverRaised && onField === 'clover'
  const h = up ? Math.min(1, FIELD + patternCut) : FIELD - patternCut
  fieldPattern(g, onField, { c, R: fieldOut * unit, px, scale: patternScale, h, field: FIELD, raised: up, clip: () => path(outline.field, false) })
  const logo = side === 'back' && backDesign === 'logo'
  if (logo) {
    // the plain disc the symbol stands on: the pattern cleared back to the field
    g.fillStyle = rgb(FIELD)
    g.beginPath()
    g.arc(c, c, fieldPx * logoDisc, 0, Math.PI * 2)
    g.fill()
  }
  // the concave corner at the foot of the rim wall: soft strokes along the
  // field's edge into B, added so R and G stay — maps.js darkens it, whatever the shape
  g.save()
  g.globalCompositeOperation = 'lighter'
  for (const [w, a] of [
    [0.05, 0.12],
    [0.032, 0.2],
    [0.018, 0.3],
    [0.008, 0.38],
  ]) {
    g.strokeStyle = `rgba(0,0,255,${a})`
    g.lineWidth = w * unit
    path(outline.field)
    g.stroke()
  }
  g.restore()
  // R carries on as field under the letters: their own height is maps.js's
  // (the logo has its disc for open metal; the letters clear a halo round themselves)
  typeOf(side, { amount, label, backLabel, backDesign, logoDisc, logoSize }, g, c, fieldPx, rgb(FIELD, 1), onField !== 'none' && !logo ? fieldPx * 0.035 : 0)
  return canvas
}

/* what each face says, and how big: the front its text over the label — digits
   read as an amount (1250 → 1,250), anything else as typed, in capitals, and
   either may be empty — the back its words one line each (up to three) */
export const backLines = (text) => String(text ?? '').trim().toUpperCase().split(/\s+/).filter(Boolean).slice(0, 3)
function typeOf(side, { amount, label, backLabel, backDesign, logoDisc = 0.3, logoSize = 0.7 }, g, c, fieldPx, fill, halo = 0) {
  if (side === 'front') {
    const text = String(amount ?? '').trim()
    const lines = []
    if (text) lines.push(/^\d+$/.test(text) ? formatAmount(text) : text.toUpperCase())
    if (String(label ?? '').trim()) lines.push(String(label).trim().toUpperCase())
    letters(g, c, fieldPx, lines, [0.66, 0.24], fill, halo)
  } else if (backDesign === 'logo') {
    drawLogo(g, c, c, fieldPx * logoDisc * 2 * logoSize, fill)
  } else {
    const lines = backLines(backLabel)
    if (lines.length) letters(g, c, fieldPx * 0.78, lines, [0.34], fill, halo)
  }
}

/* whether a face has any type on it at all — typeOf() below would draw
   nothing (the draw's Good luck coin has no words on its front), so there is
   nothing to trace into letters */
export function hasType(side, { amount, label, backLabel, backDesign }) {
  if (side === 'front') return !!(String(amount ?? '').trim() || String(label ?? '').trim())
  return backDesign === 'logo' || backLines(backLabel).length > 0
}

/* the letters alone, white on black, for trace.js to outline — the same
   layout as engrave(), at whatever size the outline wants */
export function letterMask(canvas, { N, side, amount, label, backLabel, backDesign, logoDisc, logoSize, fieldIn }) {
  if (canvas.width !== N) canvas.width = canvas.height = N
  const g = canvas.getContext('2d', { willReadFrequently: true })
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.fillStyle = '#000'
  g.fillRect(0, 0, N, N)
  typeOf(side, { amount, label, backLabel, backDesign, logoDisc, logoSize }, g, N / 2, fieldIn * (N / 2), '#fff')
  return canvas
}
