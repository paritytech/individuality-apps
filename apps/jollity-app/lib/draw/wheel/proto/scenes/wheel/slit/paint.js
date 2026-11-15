// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE SLIT PAGE'S PAINTER — flat, as the Figma draws it. The scene says what
   is where this frame (the frame description `f`, below); this draws it, and
   keeps nothing but caches (the speckle tiles, the glow's canvas).

   Two canvases:
     under   UNDER the GL, while the solid coin is up: the backdrop and the
             slit's light. The GL is screen-blended over it (style.css), so
             the coin reads as lit by the slit.
     main    OVER the GL: the slit's dark block over the coin, the hairline,
             the chevrons and INSERT COIN — then, once the coin is through,
             everything: the backdrop (it is the ending's backdrop too), the
             bowl, the circle and the hub, the wedge, the tickets, your coin
             and its trail, WINNERS.

   Everything is drawn in NOMINAL stage px (390×844, y down) under one
   transform: dpr × the stage's scale, and the zoom where it applies. */

import { bowlPoint } from './bowl.js'

const TAU = Math.PI * 2
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (u) => {
  const x = clamp01(u)
  return x * x * (3 - 2 * x)
}
const lerp = (a, b, t) => a + (b - a) * t
const hexRgb = (hex) => {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
const rgba = ([r, g, b], a) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${clamp01(a).toFixed(4)})`
/* a panel colour and its alpha, as the wedge's edge takes them */
export const colourOf = (hex, a) => ({ rgb: hexRgb(hex), a: clamp01(a) })
export const mixHex = (a, b, t) => {
  const A = hexRgb(a)
  const B = hexRgb(b)
  return `#${A.map((v, i) => Math.round(lerp(v, B[i], clamp01(t))).toString(16).padStart(2, '0')).join('')}`
}

const WHITE = [255, 255, 255]
const HINT_FONT = '400 11.8px Inter, system-ui, -apple-system, sans-serif' // INSERT COIN, and the flip page's FLIP THE COIN

/* THE CIRCLE'S LIGHT: one band of light travelling in from the rim to the
   centre (t: 0 → 2), widening as it goes, and landing on Section 7's glow
   (Ellipse 10, 469:6007) — from the middle out: a red (#FF0004) to .2308 of
   the radius, the bright core (#DBEFF2) at .3702, the blue (#1F7098) at
   .5096, the navy (#182336) at .6731, then nothing at 1. The black disc
   covers out to .349, so of the red only a breath shows, warming the
   core's inner edge round the disc.
     t 0  the closed slit: a bright rim, falling off both sides through the
          blue and the navy — the slit's own light (it takes on the core as
          it bends), so the hand-over has no jump
     t 1  a ring half way in, soft both sides
     t 2  the glow: its peak at .3702 of the radius, and from there out the
          Figma's ramp exactly; inside the peak, the core running to the red
          (glow.heart; off: the core, flat, under the disc)
   One band moving (its peak from the rim in to .3702, its outer side
   widening from .16 to the Figma's .6298, its inner side becoming the
   Figma's as it lands), not stops crossfading each on its own — so the
   light reads as going to the centre. Its cross-section is always the
   Figma's ramp.

   BLURRED by `blur` (the circle's radius = 1): the profile — colour
   premultiplied by alpha — smoothed by a gaussian of that sigma, out to
   2·blur past it so the rim softens outward as well as in. Done on the
   stops rather than with a canvas filter, so it costs nothing. Returns the
   stops over [0, reach] and reach, the gradient's radius. */
const CIRCLE_STOPS = 40
const TAPS = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((d) => [d, Math.exp(-(d * d) / 2)])
const TAP_SUM = TAPS.reduce((s, [, w]) => s + w, 0)
// the Figma's stops, of the glow's radius
const GLOW_PEAK = 0.3702 // the core
const GLOW_HEART = 0.2308 //       the red, and all of it inside
// the Figma's ramp, by the distance out from the peak (0) to nothing (1): .3702 → .5096 → .6731 → 1 of its radius
const RAMP_W = 1 - GLOW_PEAK
const RAMP_MID = (0.5096 - GLOW_PEAK) / RAMP_W
const RAMP_OUTER = (0.6731 - GLOW_PEAK) / RAMP_W
function rampAt(d, g) {
  const x = clamp01(d)
  if (x < RAMP_MID) return [g.core.map((v, j) => lerp(v, g.mid[j], x / RAMP_MID)), 1]
  if (x < RAMP_OUTER) return [g.mid.map((v, j) => lerp(v, g.outer[j], (x - RAMP_MID) / (RAMP_OUTER - RAMP_MID))), 1]
  const u = (x - RAMP_OUTER) / (1 - RAMP_OUTER)
  return [g.outer.map((v) => lerp(v, 0, u)), 1 - u] // to black at nothing, as the Figma's last stop is
}
export function circleStops(t, glow, blur = 0) {
  const u = clamp01(t / 2)
  const c = lerp(1, GLOW_PEAK, u)
  const wo = lerp(0.16, RAMP_W, u)
  const wi = lerp(0.24, GLOW_PEAK, u)
  const land = smooth((t - 1.2) / 0.8) // the inner side becoming the Figma's as it lands
  const heartW = (c * (GLOW_PEAK - GLOW_HEART)) / GLOW_PEAK // the core to the red, in step with the peak
  const inner = (p) => {
    if (!glow.heart) return [glow.core, 1] // the core, flat, under the disc
    const v = clamp01((c - p) / heartW)
    return [glow.core.map((x, j) => lerp(x, glow.heart[j], v)), 1]
  }
  const at = (p) => {
    if (p >= c) return rampAt((p - c) / wo, glow)
    const [a, aa] = rampAt((c - p) / wi, glow)
    if (land <= 0) return [a, aa]
    const [b, ba] = inner(p)
    return [a.map((x, j) => lerp(x, b[j], land)), lerp(aa, ba, land)]
  }
  const b = Math.max(0, blur)
  const reach = c + wo + 2 * b
  const sample =
    b > 1e-4
      ? (p) => {
          // at the centre the profile is mirrored (|p|): a radial glow has no edge there
          let r = 0
          let gg = 0
          let bb = 0
          let a = 0
          for (const [d, k] of TAPS) {
            const [col, al] = at(Math.abs(p + d * b))
            r += col[0] * al * k
            gg += col[1] * al * k
            bb += col[2] * al * k
            a += al * k
          }
          return a > 1e-6 ? [[r / a, gg / a, bb / a], a / TAP_SUM] : [[0, 0, 0], 0]
        }
      : at
  const out = []
  for (let i = 0; i <= CIRCLE_STOPS; i++) {
    const p = (i / CIRCLE_STOPS) * reach
    const [col, a] = sample(p)
    out.push([p / reach, col, a])
  }
  return { stops: out, reach }
}

/* the trail's colours, as the Figma's conic gradient has them, by how far
   along the trail (0 at the ticket, 1 at the tail's end): the ticket's own
   colour, a pale yellow, a lavender, then nothing */
const TRAIL = [
  [0, null, 1], // the head: the ticket's colour
  [45 / 138.5, [255, 251, 192], 0.711],
  [77.9 / 138.5, [221, 190, 255], 0.5],
  [1, [221, 190, 255], 0], // out to nothing in the lavender — fading to the Figma's white@0 washed the whole tail white
]
/* the other flat tail (TAILS' 'blue to red'): the Figma's ring (Ellipse 13,
   469:6032), its angular stroke read off the file — your ticket's colour at
   the head, a red at .87 a 22% of the way back, then straight on out to
   white at nothing. Straight, not premultiplied: the colour runs from the
   red towards the white as it goes, so the tail pales to a rose and a grey
   as it fades (the ribbon samples it finely, TAIL_STEPS, so it does) */
const BLUE_TO_RED = [
  [0, null, 1], // the head: the ticket's colour (#00BCF5, yours)
  [0.2212, [255, 47, 0], 0.8702], // the red
  [1, [255, 255, 255], 0], // …and out, through the white
]
const TAIL_STEPS = 16 // the ribbon's gradient: the table's own stops and this many more between, for the straight blend
/* the flat tails, by the tail select's name (the rest are the shader's) */
export const FLAT_TAILS = { gradient: TRAIL, 'blue to red': BLUE_TO_RED }
export function trailColour(head, f, table = TRAIL) {
  let i = 0
  while (i < table.length - 2 && f > table[i + 1][0]) i++
  const [f0, c0, a0] = table[i]
  const [f1, c1, a1] = table[i + 1]
  const u = clamp01((f - f0) / Math.max(1e-6, f1 - f0))
  const A = c0 ?? head
  const B = c1 ?? head
  return [A.map((v, j) => lerp(v, B[j], u)), lerp(a0, a1, u)]
}

/* the wedge's grain (the Figma's noise on Ellipse 3, 469:6008: MONOTONE,
   size 0.5, density 1, black at .25) — one seeded tile, one tone as the
   Figma's is: black at .25 on 54% of the px, each speck one device px (half
   a nominal px, as the Figma's size, on a 2× screen). Measured off Figma's
   own render, over the fill alone: .32 → .35 on average, never past .374 —
   the specks clipped by the fill's alpha (.25 × .32 at most), on 54% of it.
   So drawn at the grain dial, 0.32 is the Figma's. */
const NOISE_TILE = 96
const NOISE_DENSITY = 0.54
let noise = null
function noiseTile() {
  if (noise) return noise
  const c = document.createElement('canvas')
  c.width = c.height = NOISE_TILE
  const x = c.getContext('2d')
  const img = x.createImageData(NOISE_TILE, NOISE_TILE)
  let seed = 0x2f6b1d
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 0
    img.data[i + 3] = rnd() < NOISE_DENSITY ? Math.round(255 * 0.25) : 0
  }
  x.putImageData(img, 0, 0)
  noise = c
  return c
}

/* the glow's grain (Section 7's Ellipse 10): the same kind of tile, its own
   tones — under a third of its specks black at .58, as many white at .15 —
   laid over the glow alone (source-atop), so it shows as much as the glow
   does, and most on the mid of it: none on the bright core, all of it on the
   blue, easing off over the navy (GRAIN_AT) */
let glowNoise = null
function glowNoiseTile() {
  if (glowNoise) return glowNoise
  const c = document.createElement('canvas')
  c.width = c.height = NOISE_TILE
  const x = c.getContext('2d')
  const img = x.createImageData(NOISE_TILE, NOISE_TILE)
  let seed = 0x6036
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rnd()
    const tone = v < 0.29 ? 0 : v >= 0.71 ? 255 : -1
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, tone)
    img.data[i + 3] = tone < 0 ? 0 : Math.round(255 * (tone ? 0.15 : 0.58))
  }
  x.putImageData(img, 0, 0)
  glowNoise = c
  return c
}

export function createPainter() {
  const base = (g, view, zs = 1, tx = 0, ty = 0) => {
    const k = view.dpr * view.scale
    g.setTransform(k * zs, 0, 0, k * zs, k * tx, k * ty)
  }

  /* the backdrop: flat, the whole way through — the coin, the slit and the
     wheel all on the same ground, the host's dark (f.bg, the panel's) */
  function backdrop(g, f) {
    g.globalAlpha = 1
    g.fillStyle = f.bg ?? '#000'
    g.fillRect(0, 0, f.Wn, f.Hn)
  }

  /* THE SLIT'S LIGHT (frames 41 → 45): a box standing on the slit, filled
     with an elliptical radial centred under the line — and as the coin comes
     in it shines further OUT: wider, lower, brighter (heat 0 → 1) */
  function cone(g, f) {
    const c = f.cone
    if (!c || c.a <= 0.002) return
    const h = clamp01(c.heat)
    const w = lerp(223, 283, h)
    const hb = lerp(139, 105, h)
    const off = lerp(63, 48, h)
    const rx = lerp(180, 228, h)
    const ry = lerp(320, 243, h)
    const A = lerp(0.3, 0.6, h)
    g.save()
    g.beginPath()
    g.rect(f.cx - w / 2, f.slitY - hb, w, hb)
    g.clip()
    g.translate(f.cx, f.slitY + off)
    g.scale(rx, ry)
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1)
    grad.addColorStop(0, rgba(WHITE, A))
    grad.addColorStop(0.608, rgba(WHITE, 0))
    g.globalAlpha = c.a
    g.fillStyle = grad
    g.fillRect(-2, -2, 4, 4)
    g.restore()
    g.globalAlpha = 1
  }

  /* THE BOWL: the lit segment between the bent slit and its chord — a rim
     light, dark inside, bright at the arc (frame 51: white; here the slit's
     colour, f.slitRgb — white going over to the centre's as it bends), its
     inner edge creeping out as it closes (0.69 → 0.76 of the radius, frame 43) */
  /* JOLLITY: the bowl's rim light fades out toward the arc's two ends, as
     the hairline does, instead of stopping at the chord: the chord cut the
     ring's glow with a hard straight line, nothing drawn above it, all the
     way until the circle closed. Drawn into a scratch canvas the size of the
     bowl, multiplied there by a conic fade about the arc's centre, then onto
     the page. Without conic gradients, the bowl as it was. Jollity's
     change. */
  const BOWL_END_FADE = 0.55 // rad of arc over which each end fades out
  const BOWL_CHORD_FADE = 36 // px (at most) over which the bowl fades in below its chord
  let bowlScratch = null
  function bowlFill(g, f) {
    const b = f.bowl
    if (!b || b.straight || f.bowlA <= 0) return
    const p = lerp(0.69, 0.76, b.m)
    const col = f.slitRgb ?? WHITE
    const segment = (x) => {
      const grad = x.createRadialGradient(b.c.x, b.c.y, 0, b.c.x, b.c.y, b.R)
      grad.addColorStop(0, rgba(col, 0))
      grad.addColorStop(p, rgba(col, 0))
      grad.addColorStop(1, rgba(col, 0.7))
      x.fillStyle = grad
      x.beginPath()
      x.arc(b.c.x, b.c.y, b.R, Math.PI / 2 - b.alpha, Math.PI / 2 + b.alpha)
      x.closePath()
      x.fill()
    }
    if (typeof g.createConicGradient !== 'function') {
      g.globalAlpha = f.bowlA
      segment(g)
      g.globalAlpha = 1
      return
    }
    // the bowl's box on the page, in device px
    const m = g.getTransform()
    const halfW = b.R * (b.alpha >= Math.PI / 2 ? 1 : Math.sin(b.alpha))
    const x0 = Math.max(0, Math.floor(m.a * (b.c.x - halfW) + m.e) - 2)
    const x1 = Math.min(g.canvas.width, Math.ceil(m.a * (b.c.x + halfW) + m.e) + 2)
    const y0 = Math.max(0, Math.floor(m.d * b.chordY + m.f) - 2)
    const y1 = Math.min(g.canvas.height, Math.ceil(m.d * (b.c.y + b.R) + m.f) + 2)
    if (x1 <= x0 || y1 <= y0) return
    bowlScratch ??= document.createElement('canvas')
    const sc = bowlScratch
    if (sc.width < x1 - x0 || sc.height < y1 - y0) {
      sc.width = Math.max(sc.width, x1 - x0)
      sc.height = Math.max(sc.height, y1 - y0)
    }
    const s = sc.getContext('2d')
    s.setTransform(1, 0, 0, 1, 0, 0)
    s.clearRect(0, 0, x1 - x0, y1 - y0)
    s.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0)
    segment(s)
    // the fade: 0 at each end of the arc, 1 once BOWL_END_FADE in
    const span = (2 * b.alpha) / TAU
    const w = Math.min(span / 2, BOWL_END_FADE / TAU)
    const fade = s.createConicGradient(Math.PI / 2 - b.alpha, b.c.x, b.c.y)
    fade.addColorStop(0, 'rgba(0,0,0,0)')
    fade.addColorStop(w, 'rgba(0,0,0,1)')
    fade.addColorStop(Math.max(w, span - w), 'rgba(0,0,0,1)')
    fade.addColorStop(Math.min(1, span), 'rgba(0,0,0,0)')
    s.globalCompositeOperation = 'destination-in'
    s.fillStyle = fade // in the bowl's own space: a gradient is placed by the transform it is filled under
    s.fillRect(b.c.x - b.R - 4, b.chordY - 4, 2 * b.R + 8, b.c.y + b.R - b.chordY + 8)
    // …and toward the chord itself: a shallow bowl's rim reaches it all along, not only at the ends
    const depth = b.c.y + b.R - b.chordY
    const top = s.createLinearGradient(0, b.chordY, 0, b.chordY + Math.max(1, Math.min(BOWL_CHORD_FADE, 0.45 * depth)))
    top.addColorStop(0, 'rgba(0,0,0,0)')
    top.addColorStop(1, 'rgba(0,0,0,1)')
    s.fillStyle = top
    s.fillRect(b.c.x - b.R - 4, b.chordY - 4, 2 * b.R + 8, depth + 8)
    s.globalCompositeOperation = 'source-over'
    g.save()
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalAlpha = f.bowlA
    g.drawImage(sc, 0, 0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0)
    g.restore()
  }

  /* THE HAIRLINE, along the arc: brightest at the bottom, out to nothing at
     both ends — the straight slit's own fade, carried round the bend (a conic
     gradient about the arc's centre, so it follows the curve exactly) */
  function hairline(g, f) {
    const b = f.bowl
    const a = f.hairA
    if (!b || a <= 0.002) return
    const col = f.slitRgb ?? WHITE
    g.globalAlpha = a
    g.lineWidth = b.straight ? 1.6 : Math.min(1.6, Math.max(0.5, b.R * 0.12)) // thinning as the black hole's collapse takes it in
    g.lineCap = 'butt'
    if (b.straight) {
      const l = bowlPoint(b, -1)
      const r = bowlPoint(b, 1)
      const grad = g.createLinearGradient(l.x, 0, r.x, 0)
      grad.addColorStop(0, rgba(col, 0))
      grad.addColorStop(0.5, rgba(col, 1))
      grad.addColorStop(1, rgba(col, 0))
      g.strokeStyle = grad
      g.beginPath()
      g.moveTo(l.x, l.y)
      g.lineTo(r.x, r.y)
      g.stroke()
    } else {
      const plain = clamp01(f.hairPlain ?? 0)
      if (plain > 0.002) {
        // 'fades to a line': a plain white line, all the way round
        g.globalAlpha = a * plain
        g.strokeStyle = rgba(WHITE, 1)
        g.beginPath()
        g.arc(b.c.x, b.c.y, b.R, 0, TAU)
        g.stroke()
        g.globalAlpha = a * (1 - plain)
        if (plain >= 0.998) {
          g.globalAlpha = 1
          return
        }
      }
      const start = Math.PI / 2 - b.alpha
      const span = b.alpha / Math.PI // the arc's share of the turn
      if (typeof g.createConicGradient === 'function') {
        const grad = g.createConicGradient(start, b.c.x, b.c.y)
        grad.addColorStop(0, rgba(col, 0))
        grad.addColorStop(span / 2, rgba(col, 1))
        grad.addColorStop(Math.max(span, 1e-4), rgba(col, 0))
        if (span < 1) grad.addColorStop(1, rgba(col, 0))
        g.strokeStyle = grad
        g.beginPath()
        g.arc(b.c.x, b.c.y, b.R, start, start + 2 * b.alpha)
        g.stroke()
      } else {
        // no conic gradients (Safari < 16.1): the arc in short pieces, each at its own alpha
        const N = 32
        for (let i = 0; i < N; i++) {
          const u = (i + 0.5) / N
          g.strokeStyle = rgba(col, 1 - Math.abs(2 * u - 1))
          g.beginPath()
          g.arc(b.c.x, b.c.y, b.R, start + (2 * b.alpha * i) / N, start + (2 * b.alpha * (i + 1)) / N)
          g.stroke()
        }
      }
    }
    g.globalAlpha = 1
  }

  /* the slit's dark block: the coin goes INTO it (the Figma's black at 0.89) */
  function shade(g, f) {
    if (f.shade <= 0.002) return
    g.globalAlpha = 1
    g.fillStyle = `rgba(0,0,0,${clamp01(f.shade).toFixed(3)})`
    g.fillRect(0, f.slitY + 1, f.Wn, f.Hn - f.slitY - 1) // from just under the hairline, which is drawn beneath
  }

  /* the chevrons over the slit and INSERT COIN under it (frame 41) */
  function slitWords(g, f) {
    const w = f.words
    if (!w) return
    if (w.chevron > 0.002) {
      const size = 29.5
      const k = size / 24
      const x0 = f.cx - size / 2
      const y0 = f.slitY - 25.6 - size
      g.save()
      g.translate(x0, y0)
      g.scale(k, k)
      g.globalAlpha = 0.9 * w.chevron
      g.strokeStyle = '#fff'
      g.lineWidth = 2
      g.lineCap = 'round'
      g.lineJoin = 'round'
      g.beginPath()
      g.moveTo(7, 6)
      g.lineTo(12, 11)
      g.lineTo(17, 6)
      g.moveTo(7, 13)
      g.lineTo(12, 18)
      g.lineTo(17, 13)
      g.stroke()
      g.restore()
    }
    if (w.hint > 0.002) {
      g.globalAlpha = 0.9 * w.hint
      g.fillStyle = '#fff'
      g.font = HINT_FONT
      g.textAlign = 'center'
      g.textBaseline = 'top'
      g.fillText('INSERT COIN', f.cx, f.slitY + 25.6)
    }
    g.globalAlpha = 1
  }

  /* the closed circle, and from there the hub's glow — drawn into a canvas
     the size of the screen, through the zoom, the grain laid over it there
     in screen px (so it stays as fine as the Figma's however far in), then
     onto the page. At rest it does not change: the canvas is kept until
     something does */
  const glowCanvas = document.createElement('canvas')
  const glowG = glowCanvas.getContext('2d')
  let glowKey = ''
  const grainCanvas = document.createElement('canvas')
  const grainG = grainCanvas.getContext('2d')
  // how much grain, by where on the glow's ramp: [radius from the peak out, 0 → 1 (nothing), weight]
  const GRAIN_AT = [
    [0, 0],
    [0.12, 0.15],
    [0.28, 1],
    [0.52, 0.8],
    [1, 0.35],
  ]
  function circle(g, view, f, zm) {
    const c = f.circle
    if (!c || c.a <= 0.002 || c.R <= 0) return
    const gl = f.glow
    const { stops, reach } = circleStops(c.t, gl, (c.blur ?? 0) / c.R)
    const R = c.R * reach
    const W = g.canvas.width
    const H = g.canvas.height
    const key = `${c.t.toFixed(4)}|${c.R.toFixed(2)}|${(c.blur ?? 0).toFixed(2)}|${gl.heart}|${gl.core}|${gl.mid}|${gl.outer}|${gl.grain}|${W}x${H}|${zm.s.toFixed(4)},${zm.tx.toFixed(2)},${zm.ty.toFixed(2)}|${f.hub.x},${f.hub.y}`
    if (key !== glowKey) {
      glowKey = key
      if (glowCanvas.width !== W || glowCanvas.height !== H) {
        glowCanvas.width = W
        glowCanvas.height = H
      }
      glowG.setTransform(1, 0, 0, 1, 0, 0)
      glowG.globalCompositeOperation = 'source-over'
      glowG.globalAlpha = 1
      glowG.clearRect(0, 0, W, H)
      base(glowG, view, zm.s, zm.tx, zm.ty)
      const grad = glowG.createRadialGradient(f.hub.x, f.hub.y, 0, f.hub.x, f.hub.y, R)
      for (const [p, col, a] of stops) grad.addColorStop(clamp01(p), rgba(col, a))
      glowG.fillStyle = grad
      glowG.beginPath()
      glowG.arc(f.hub.x, f.hub.y, R, 0, TAU)
      glowG.fill()
      if (gl.grain > 0.002) {
        /* the grain on its own canvas, in screen px, weighted by where on the
           ramp it lies (out from the band's peak), then laid over the glow */
        if (grainCanvas.width !== W || grainCanvas.height !== H) {
          grainCanvas.width = W
          grainCanvas.height = H
        }
        grainG.setTransform(1, 0, 0, 1, 0, 0)
        grainG.globalCompositeOperation = 'source-over'
        grainG.clearRect(0, 0, W, H)
        grainG.fillStyle = grainG.createPattern(glowNoiseTile(), 'repeat')
        grainG.fillRect(0, 0, W, H)
        base(grainG, view, zm.s, zm.tx, zm.ty)
        grainG.globalCompositeOperation = 'destination-in'
        const peak = c.R * lerp(1, GLOW_PEAK, clamp01(c.t / 2)) // the band's peak, as circleStops has it
        const mask = grainG.createRadialGradient(f.hub.x, f.hub.y, 0, f.hub.x, f.hub.y, R)
        const inner = peak / R
        mask.addColorStop(0, 'rgba(0,0,0,0)')
        for (const [d, wgt] of GRAIN_AT) mask.addColorStop(clamp01(inner + d * (1 - inner)), `rgba(0,0,0,${wgt})`)
        grainG.fillStyle = mask
        grainG.fillRect(f.hub.x - R, f.hub.y - R, 2 * R, 2 * R)
        glowG.setTransform(1, 0, 0, 1, 0, 0)
        glowG.globalCompositeOperation = 'source-atop'
        glowG.globalAlpha = gl.grain
        glowG.drawImage(grainCanvas, 0, 0)
        glowG.globalCompositeOperation = 'source-over'
        glowG.globalAlpha = 1
      }
    }
    g.save()
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalAlpha = c.a
    g.drawImage(glowCanvas, 0, 0)
    g.restore()
  }
  /* the burst's shockwave: a thin bright ring in the core's colour, shooting
     out past the glow and fading, its width in screen px */
  function shock(g, f, zm) {
    const k = f.shock
    if (!k || k.a <= 0.002 || k.R <= 0) return
    const w = k.w / zm.s
    const grad = g.createRadialGradient(f.hub.x, f.hub.y, Math.max(0, k.R - 2 * w), f.hub.x, f.hub.y, k.R + 2 * w)
    const c = f.glow.core
    grad.addColorStop(0, rgba(c, 0))
    grad.addColorStop(0.5, rgba(c, 1))
    grad.addColorStop(1, rgba(c, 0))
    g.globalAlpha = k.a
    g.strokeStyle = grad
    g.lineWidth = 4 * w
    g.beginPath()
    g.arc(f.hub.x, f.hub.y, k.R, 0, TAU)
    g.stroke()
    g.globalAlpha = 1
  }
  /* the dark disc in the middle, under WINNERS (Section 7's Ellipse 11):
     what the light leaves as it closes in on the hub — in the page's own
     ground (f.bg, the panel's backdrop), so it reads as a hole through to it */
  // ≈ the gaussian's edge: 1 inside, ½ on it, 0 out — stretched to run exactly 1 → 0 (tanh's own ends are .992 and .008,
  // and .992 left the glow showing through the disc by a level)
  const ERF_RAW = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((d) => [d, 0.5 * (1 - Math.tanh(d * 1.2))])
  const ERF = ERF_RAW.map(([d, a]) => [d, (a - ERF_RAW.at(-1)[1]) / (ERF_RAW[0][1] - ERF_RAW.at(-1)[1])])
  function disc(g, f) {
    const d = f.disc
    if (!d || d.a <= 0.002 || d.R <= 0) return
    const sigma = d.blur ?? 0 // wheel px
    const ground = hexRgb(f.bg ?? '#000000')
    g.globalAlpha = d.a
    if (sigma > 0.01) {
      const out = d.R + 2.2 * sigma
      const grad = g.createRadialGradient(f.hub.x, f.hub.y, 0, f.hub.x, f.hub.y, out)
      grad.addColorStop(0, rgba(ground, 1))
      for (const [k, a] of ERF) grad.addColorStop(clamp01((d.R + k * sigma) / out), rgba(ground, a))
      grad.addColorStop(1, rgba(ground, 0))
      g.fillStyle = grad
      g.beginPath()
      g.arc(f.hub.x, f.hub.y, out, 0, TAU)
    } else {
      g.fillStyle = rgba(ground, 1)
      g.beginPath()
      g.arc(f.hub.x, f.hub.y, d.R, 0, TAU)
    }
    g.fill()
    g.globalAlpha = 1
  }

  /* THE WEDGE: a pie slice from the hub, never turning and never changing
     size — sized to the winners. Section 7's Ellipse 3 (469:6008): fill,
     edge, grain, with the Figma's LUMINOSITY blend (w.luminosity) — only
     the light is laid on, the colour under it kept, so the edge over the
     blue glow reads a pale blue, not a white. Straight onto the page, no
     layer of its own (a stage-sized canvas, 6 MB on a phone): the fill and
     the grain are black, and black laid on as light is black laid on as
     ever, so only the edge needs the blend.
       fill   black at .32 over the hub's glow (w.fill, the panel's)
       edge   the Figma's 4 px stroke masked to the inside: w.edgePx wide,
              all of it inside the slice. Its gradient is STRAIGHT, up the
              wedge's middle from the tip to the arc (a point's light goes by
              how far up the middle it lies, not how far from the hub), four
              stops: white at .5 at the tip, black at .1 at w.innerAt (.37),
              white at .05 at w.outerAt (.66), white at .5 on the arc's
              middle — so the arc is brightest there and fades towards its
              corners, which lie lower down, and the sides go faintly dark
              where the light has left them. That is what moves: it lights up from the hub
              outward as the wedge comes on (w.reveal 0 → 1, a soft front
              travelling up it), sits at w.vis of itself while the wheel
              turns, and comes up to all of it as the wheel lands.
       grain  the Figma's noise: black specks at .25 on half the px, over
              fill and edge, clipped by the fill as Figma clips it — so at
              the grain dial, .32 is the Figma's. In screen px, as fine as
              the Figma's however far the zoom goes in. */
  /* the edge's four stops — tip, inner, outer, arc — blended straight (colour
     and alpha each on its own, as Figma does), p 0 at the tip to 1 at the arc */
  function wedgeEdgeAt(w, p) {
    const pIn = Math.max(1e-4, w.innerAt ?? 0.37)
    const pOut = Math.min(1 - 1e-4, Math.max(pIn + 1e-4, w.outerAt ?? 0.66))
    const [lo, hi, u] =
      p <= pIn ? [w.tip, w.inner, p / pIn] : p <= pOut ? [w.inner, w.outer, (p - pIn) / (pOut - pIn)] : [w.outer, w.edge, (p - pOut) / (1 - pOut)]
    return [lo.rgb.map((v, j) => lerp(v, hi.rgb[j], u)), lerp(lo.a, hi.a, u)]
  }
  function wedge(g, view, f, zm) {
    const w = f.wedge
    if (!w || w.reach <= 0.5) return
    const { x, y } = f.hub
    const slice = new Path2D()
    slice.moveTo(x, y)
    slice.arc(x, y, w.reach, -w.a1, -w.a0)
    slice.closePath()
    g.save()
    g.clip(slice)
    if (w.fillA > 0.002) {
      g.globalAlpha = w.fillA
      g.fillStyle = w.fill ?? '#000'
      g.fill(slice)
    }
    if (w.vis > 0.002) {
      /* the edge: straight up the middle, tip → between → arc, times a front travelling up from the hub */
      const mid = (w.a0 + w.a1) / 2
      const edge = g.createLinearGradient(x, y, x + w.reach * Math.cos(mid), y - w.reach * Math.sin(mid))
      const STOPS = 24
      const at = new Set([w.innerAt, w.outerAt].filter((p) => p > 0 && p < 1))
      for (let i = 0; i <= STOPS; i++) at.add(i / STOPS)
      for (const p of [...at].sort((a, b) => a - b)) {
        const [rgb, a] = wedgeEdgeAt(w, p)
        const front = smooth((w.reveal * 1.35 - p) / 0.35)
        edge.addColorStop(p, rgba(rgb, a * front * w.vis))
      }
      g.globalAlpha = 1
      g.globalCompositeOperation = w.luminosity ? 'luminosity' : 'source-over'
      g.strokeStyle = edge
      g.lineWidth = (2 * (w.edgePx ?? 1)) / zm.s // twice over the path, clipped: all of it inside
      g.lineJoin = 'miter'
      g.stroke(slice)
      g.globalCompositeOperation = 'source-over'
    }
    if (w.grainA > 0.002) {
      // over fill and edge, as the Figma's noise is; one speck to a device px whatever the zoom (the clip stays as set)
      const m = g.getTransform()
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalAlpha = w.grainA
      g.fillStyle = g.createPattern(noiseTile(), 'repeat')
      const x0 = Math.floor(m.a * (x - w.reach) + m.e)
      const y0 = Math.floor(m.d * (y - w.reach) + m.f)
      g.fillRect(x0, y0, Math.ceil(2 * w.reach * m.a) + 1, Math.ceil(2 * w.reach * m.d) + 1)
    }
    g.restore()
  }

  /* THE TICKETS: flat circles in their colour, no border, no shadow — in
     batched paths by alpha (16 levels: every alpha the rule gives lands on
     one) */
  const LEVELS = 16
  function tickets(g, view, f, zm) {
    const T = f.tickets
    if (!T || !T.count) return
    const paths = Array.from({ length: LEVELS }, () => new Path2D())
    for (let i = 0; i < T.count; i++) {
      const a = T.alpha[i]
      if (a <= 0.004) continue
      const lvl = Math.min(LEVELS - 1, Math.round(a * (LEVELS - 1)))
      if (lvl <= 0) continue
      const x = T.x[i]
      const y = T.y[i]
      const r = T.r[i]
      const sq = T.sq[i]
      const p = paths[lvl]
      if (sq >= 0.999) {
        p.moveTo(x + r, y)
        p.arc(x, y, r, 0, TAU)
      } else {
        const rot = T.rot[i]
        p.moveTo(x + r * Math.cos(rot), y + r * Math.sin(rot))
        p.ellipse(x, y, r, Math.max(0.08, sq) * r, rot, 0, TAU)
      }
    }
    g.fillStyle = f.ticketColour ?? '#fff'
    for (let l = 1; l < LEVELS; l++) {
      g.globalAlpha = l / (LEVELS - 1)
      g.fill(paths[l])
    }
    g.globalAlpha = 1
  }

  /* THE TICKETS' BLOOM: a soft halo of light over each one, added (lighter),
     in its own colour — white for the rest, yours in
     theirs — at its own alpha, f.bloom.size × its radius out. One sprite per
     colour: a radial from the colour to the same colour at nothing, so the
     halo never goes dark at its edge. Off at strength 0 (the default). */
  const glows = new Map()
  function glowSprite(colour) {
    let c = glows.get(colour)
    if (c) return c
    c = document.createElement('canvas')
    c.width = c.height = 64
    const x = c.getContext('2d')
    const rgb = hexRgb(colour)
    const grad = x.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0, rgba(rgb, 1))
    grad.addColorStop(0.25, rgba(rgb, 0.45))
    grad.addColorStop(0.6, rgba(rgb, 0.1))
    grad.addColorStop(1, rgba(rgb, 0))
    x.fillStyle = grad
    x.fillRect(0, 0, 64, 64)
    glows.set(colour, c)
    return c
  }
  function bloom(g, f) {
    const b = f.bloom
    if (!b || b.a <= 0.002) return
    g.save()
    g.globalCompositeOperation = 'lighter'
    const T = f.tickets
    if (T?.count) {
      const sp = glowSprite('#ffffff')
      for (let i = 0; i < T.count; i++) {
        const a = T.alpha[i] * b.a
        if (a <= 0.004) continue
        const h = T.r[i] * b.size
        g.globalAlpha = Math.min(1, a)
        g.drawImage(sp, T.x[i] - h, T.y[i] - h, 2 * h, 2 * h)
      }
    }
    for (const m of f.markers) {
      const a = m.a * b.a
      if (!m.onWheel || a <= 0.004 || m.r <= 0) continue // not the coin on its way in: only what is on the wheel
      const h = m.r * b.size
      g.globalAlpha = Math.min(1, a)
      g.drawImage(glowSprite(m.colour), m.x - h, m.y - h, 2 * h, 2 * h)
    }
    g.restore()
  }

  /* a marked ticket — yours, or the coin on its way: a flat disc in its
     colour, and a ring round it in the Figma's fading stroke (bright top and
     bottom, gone at the sides) */
  function marker(g, view, zm, m) {
    if (m.a <= 0.002) return
    if (m.r > 0) {
      g.globalAlpha = m.a
      g.fillStyle = m.colour
      g.beginPath()
      g.arc(m.x, m.y, m.r, 0, TAU)
      g.fill()
    }
    if (m.ringA > 0.002) {
      const R = m.ringR
      const grad = g.createLinearGradient(0, m.y - R, 0, m.y + R)
      const rgb = hexRgb(m.ringColour)
      grad.addColorStop(0, rgba(rgb, 1))
      grad.addColorStop(0.5, rgba(rgb, 0))
      grad.addColorStop(1, rgba(rgb, 1))
      g.globalAlpha = m.a * m.ringA
      g.strokeStyle = grad
      g.lineWidth = Math.max(1 / zm.s, R * 0.066)
      g.beginPath()
      g.arc(m.x, m.y, R, 0, TAU)
      g.stroke()
    }
    g.globalAlpha = 1
  }

  /* THE LIT ONE (Section 7): a black disc, a white ring round it, the
     ticket again on top in its own colour — on the wheel, the ring's gap and
     width in screen px whatever the zoom; and its line, in screen space, from
     its name's underline straight down to the ring */
  function select(g, view, zm, f) {
    const s = f.select
    if (!s) return
    g.globalAlpha = s.discA ?? s.a
    g.fillStyle = '#000'
    g.beginPath()
    g.arc(s.x, s.y, s.ringR, 0, TAU)
    g.fill()
    g.globalAlpha = s.a
    const lw = s.w / zm.s
    g.strokeStyle = '#fff'
    g.lineWidth = lw
    g.beginPath()
    g.arc(s.x, s.y, s.ringR - lw / 2, 0, TAU)
    g.stroke()
    g.globalAlpha = 1
    marker(g, view, zm, { x: s.x, y: s.y, r: s.r, colour: s.colour, a: s.ticketA, ringA: 0 })
  }
  function selectLine(g, view, f) {
    const s = f.select
    const zm = f.zoom ?? { s: 1, tx: 0, ty: 0 }
    if (!s || s.lineTop == null) return
    const k = view.dpr * view.scale
    const dev = Math.max(1, Math.round(s.w * k)) // the line, whole device px
    const snap = (v) => (Math.round(v * k - dev / 2) + dev / 2) / k // a line of dev px centred on whole px
    const x = snap(zm.s * s.x + zm.tx)
    const top = snap(s.lineTop)
    const bottom = zm.s * (s.y - s.ringR) + zm.ty
    if (bottom <= top + 1) return
    const drawn = clamp01(s.drawn ?? 1)
    const y0 = s.up ? bottom - (bottom - top) * drawn : top // up from the ring to the underline…
    const y = s.up ? bottom : top + (bottom - top) * drawn // …or down from the underline
    g.globalAlpha = 1 // whole: it draws, it does not fade
    g.strokeStyle = '#fff'
    g.lineWidth = dev / k
    g.lineCap = 'butt'
    g.lineJoin = 'miter'
    g.beginPath()
    const u = s.up && drawn < 1 ? null : s.under // drawn up, the underline once the line is there
    if (!u) {
      g.moveTo(x, y0)
      g.lineTo(x, y)
      g.stroke()
      g.globalAlpha = 1
      return
    }
    // the underline, from its far end to the line's corner (or across, the line from its middle)
    const x0 = snap(u.x0)
    const x1 = snap(u.x1)
    const half = dev / 2 / k
    if (Math.abs(x - x0) < 1) {
      g.moveTo(x1 + half, top)
      g.lineTo(x, top)
    } else if (Math.abs(x - x1) < 1) {
      g.moveTo(x0 - half, top)
      g.lineTo(x, top)
    } else {
      g.moveTo(x0 - half, top)
      g.lineTo(x1 + half, top)
      g.moveTo(x, top)
    }
    g.lineTo(x, y)
    g.stroke()
    g.globalAlpha = 1
  }

  /* THE TRAILS — the flow's wake, in the Figma's colours: behind a ticket
     that is moving, the way it actually came (t.pts, head first, as the
     scene traced it back), tapering from the ticket's width to a third of it,
     its colour running from the ticket's own through a pale yellow and a
     lavender out to nothing. t.a is how much of it shows: the scene fades it
     with the speed, so a ticket standing still has none. Drawn as short
     pieces, each its own colour and width — a trail along a spiral is not an
     arc a gradient could follow. */
  /* the trail lab's (f.look): the same trails, through the shader painter —
     its code fetched, and its WebGL context made, the first time a look asks
     for it (the draw's own tails are flat, so on the draw it never is); the
     flat trail below until then, and where there is no WebGL2 */
  let looker // undefined: never asked for; null: on its way, or no WebGL2
  const L = new Float32Array(2 * 64) // the ribbon's two edges, made once
  const R = new Float32Array(2 * 64)
  function trails(g, f) {
    if (f.look) {
      if (looker === undefined) {
        looker = null
        import('./trail-look/gl.js').then((m) => (looker = m.createTrailLook()))
      }
      if (looker) return looker.draw(g, f)
    }
    const table = FLAT_TAILS[f.tail] ?? TRAIL // the Figma's colours, or the other flat tail's
    for (const t of f.trails) {
      if (t.a <= 0.002 || t.n < 2) continue
      /* how far round the hub it swept: nothing (a still ticket), nothing to draw */
      let N = Math.min(63, t.n - 1)
      while (N > 0 && t.ang[0] - t.ang[N] > TAU * 0.98) N-- // never a lap or more: one turn of it at most
      const span = t.ang[0] - t.ang[N]
      if (N < 1 || span <= 1e-4) continue
      /* its colour is its age: the table's stops (the Figma's four), each where the ticket
         was at that age (the samples are evenly spaced in time, so however
         unevenly it swept — speeding up, slowing down — the colours sit
         where they belong). A plain one (the flipped coin's) stays its colour, fading. */
      const ageAt = (fr) => {
        const x = fr * N
        const j = Math.min(N - 1, Math.floor(x))
        const u = x - j
        return {
          x: t.pts[2 * j] + (t.pts[2 * j + 2] - t.pts[2 * j]) * u,
          y: t.pts[2 * j + 1] + (t.pts[2 * j + 3] - t.pts[2 * j + 1]) * u,
          ang: t.ang[j] + (t.ang[j + 1] - t.ang[j]) * u,
        }
      }
      /* a short trail — a slow ticket, most of its trail still under it — is
         the ticket's own colour fading out: the yellow and the lavender come
         in only as it grows past a few of its own widths, so a slowing coin's
         tail is never those squeezed into the sliver that shows (it read white) */
      let len = 0
      for (let j = 1; j <= N; j++) len += Math.hypot(t.pts[2 * j] - t.pts[2 * j - 2], t.pts[2 * j + 1] - t.pts[2 * j - 1])
      const tint = t.plain ? 0 : smooth((len / Math.max(1e-3, t.wid[0]) - 1.5) / 3)
      /* THE OTHER KIND: not a line but circles — f.trailCircles of them
         along the way it came, evenly in time, each the ticket's size where
         it was then and the trail's colour and alpha at that age; tail first,
         so the ones nearer the ticket lie over the older */
      if (f.trailCircles > 0) {
        const K = f.trailCircles
        for (let k = K; k >= 1; k--) {
          const fr = k / (K + 1)
          const p = ageAt(fr)
          const x = fr * N
          const j = Math.min(N - 1, Math.floor(x))
          const r = (t.wid[j] + (t.wid[j + 1] - t.wid[j]) * (x - j)) / 2
          const [rgb, a] = trailColour(t.head, fr, table)
          if (a <= 0.004 || r <= 0.05) continue
          g.globalAlpha = t.a * 0.95 * a
          g.fillStyle = rgba(t.plain ? t.head : t.head.map((v, i) => lerp(v, rgb[i], tint)), 1)
          g.beginPath()
          g.arc(p.x, p.y, r, 0, TAU)
          g.fill()
        }
        continue
      }
      /* one ribbon, as wide as the ticket was at each point of it — filled
         once, so no seams; its head end sits under the ticket */
      for (let j = 0; j <= N; j++) {
        const x = t.pts[2 * j]
        const y = t.pts[2 * j + 1]
        const j0 = Math.max(0, j - 1)
        const j1 = Math.min(N, j + 1)
        const tx = t.pts[2 * j1] - t.pts[2 * j0]
        const ty = t.pts[2 * j1 + 1] - t.pts[2 * j0 + 1]
        const len = Math.hypot(tx, ty) || 1
        const hw = t.wid[j] / 2
        L[2 * j] = x - (ty / len) * hw
        L[2 * j + 1] = y + (tx / len) * hw
        R[2 * j] = x + (ty / len) * hw
        R[2 * j + 1] = y - (tx / len) * hw
      }
      g.beginPath()
      g.moveTo(L[0], L[1])
      for (let j = 1; j <= N; j++) g.lineTo(L[2 * j], L[2 * j + 1])
      for (let j = N; j >= 0; j--) g.lineTo(R[2 * j], R[2 * j + 1])
      g.closePath()
      g.globalAlpha = t.a * 0.95
      const at = new Set(table.map(([fr]) => fr))
      for (let k = 1; k < TAIL_STEPS; k++) at.add(k / TAIL_STEPS)
      const stops = [...at].sort((a, b) => a - b).map((fr) => {
        const [rgb, a] = trailColour(t.head, fr, table)
        return { fr, at: ageAt(fr), colour: rgba(t.head.map((v, j) => lerp(v, rgb[j], tint)), a) }
      })
      let fill
      if (span < Math.PI / 3 || typeof g.createConicGradient !== 'function') {
        /* a short trail (a slow ticket — the slow-mo, the zoom) is near
           enough straight: a linear gradient along it, head to tail. A conic
           one spreads its colours round the whole turn, and a few degrees of
           trail got a texel or two of it — every colour averaged to white */
        const hx = t.pts[0]
        const hy = t.pts[1]
        const dx = t.pts[2 * N] - hx
        const dy = t.pts[2 * N + 1] - hy
        const d2 = Math.max(1e-6, dx * dx + dy * dy)
        fill = g.createLinearGradient(hx, hy, hx + dx, hy + dy)
        let last = 0
        for (const st of stops) {
          last = Math.max(last, clamp01(((st.at.x - hx) * dx + (st.at.y - hy) * dy) / d2))
          fill.addColorStop(last, st.colour)
        }
      } else {
        /* a long one — an arc, or a spiral — a conic gradient about the hub,
           which a ticket only ever goes clockwise round, so it follows the
           trail exactly; a handful of stops over a good share of the turn */
        fill = g.createConicGradient(t.ang[N], f.hub.x, f.hub.y)
        for (let i = stops.length - 1; i >= 0; i--) fill.addColorStop(clamp01((stops[i].at.ang - t.ang[N]) / TAU), stops[i].colour)
        fill.addColorStop(Math.min(1, span / TAU + 0.002), rgba(t.head, 0))
        fill.addColorStop(1, rgba(t.head, 0))
      }
      g.fillStyle = fill
      g.fill()
    }
    g.globalAlpha = 1
  }

  /* THE ARROW TO YOUR TICKET (the flow's, wheel/paint.js's edgeArrow), in
     the stage's px over the zoom: a right isosceles triangle, its long side
     along the edge and its tip on the edge itself, pointing square out at
     your ticket. Friends' first, so where two meet yours is on top */
  function arrows(g, f) {
    const half = f.arrowPx / 2
    for (const ar of f.arrows) {
      if (ar.a <= 0.002) continue
      const out = { left: [-1, 0], right: [1, 0], bottom: [0, 1], top: [0, -1] }[ar.side]
      const bx = ar.x - out[0] * half
      const by = ar.y - out[1] * half
      g.globalAlpha = Math.min(1, ar.a)
      g.beginPath()
      g.moveTo(ar.x, ar.y)
      g.lineTo(bx + out[1] * half, by + out[0] * half)
      g.lineTo(bx - out[1] * half, by - out[0] * half)
      g.closePath()
      g.fillStyle = ar.colour
      g.fill()
    }
    g.globalAlpha = 1
  }

  /* zoomed in, the wheel reaches down past the timeline and the names: it
     fades into the backdrop over the last few px above the line instead of
     running under them (f.floor is how far, 0..1 — the zoom's progress). The
     backdrop is there, f.bg */
  function floor(g, f) {
    const fl = f.floor
    if (!fl || fl.a <= 0.002) return
    const bg = hexRgb(f.bg ?? '#000000')
    const grad = g.createLinearGradient(0, fl.y - 44, 0, fl.y - 10)
    grad.addColorStop(0, rgba(bg, 0))
    grad.addColorStop(1, rgba(bg, 1))
    g.globalAlpha = fl.a
    g.fillStyle = grad
    g.fillRect(0, fl.y - 44, f.Wn, 34)
    g.fillStyle = f.bg ?? '#000'
    g.fillRect(0, fl.y - 10, f.Wn, f.Hn - fl.y + 10)
    g.globalAlpha = 1
  }

  /* WINNERS (WINNER for one), over the wedge's tip — in screen space, so
     the zoom never scales the type; the names' own type, 12 px (frame 46
     had it at 18) */
  function winner(g, f) {
    const w = f.winner
    if (!w || w.a <= 0.002) return
    g.globalAlpha = w.a
    g.fillStyle = '#fff'
    g.font = '400 12px Inter, system-ui, -apple-system, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(w.text ?? 'WINNERS', w.x, w.y) // at the hub's middle
    g.globalAlpha = 1
  }

  /* THE FLIP PAGE'S OPENING (flip.js): its words under the coin, as INSERT
     COIN is, and the coin's trail as it flies off — drawn over the GL, so
     the coin's own disc is cut out of it and it reads as behind the coin */
  function flipWords(g, f) {
    const w = f.flipWords
    if (!w || w.a <= 0.002) return
    g.globalAlpha = 0.9 * w.a
    g.fillStyle = '#fff'
    g.font = HINT_FONT
    g.textAlign = 'center'
    g.textBaseline = 'top'
    g.fillText(w.text, w.x, w.y)
    g.globalAlpha = 1
  }
  function outTrail(g, f) {
    const t = f.outTrail
    if (!t) return
    g.save()
    if (t.clip) {
      g.beginPath()
      g.rect(0, 0, f.Wn, f.Hn)
      g.arc(t.clip.x, t.clip.y, Math.max(0, t.clip.r - 0.5), 0, TAU)
      g.clip('evenodd')
    }
    trails(g, { trails: [t], trailCircles: f.trailCircles, hub: f.hub, look: f.look })
    g.restore()
  }

  return {
    /* the canvas under the GL, while the coin is up */
    under(g, view, f) {
      base(g, view)
      backdrop(g, f)
      cone(g, f)
    },
    clearUnder(g) {
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.clearRect(0, 0, g.canvas.width, g.canvas.height)
    },
    /* the canvas over it: everything else */
    main(g, view, f) {
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.clearRect(0, 0, g.canvas.width, g.canvas.height)
      base(g, view)
      if (f.backdrop) {
        backdrop(g, f)
        cone(g, f)
      }
      bowlFill(g, f)
      hairline(g, f) // under the coin that circles across it
      const zm = f.zoom ?? { s: 1, tx: 0, ty: 0 }
      base(g, view, zm.s, zm.tx, zm.ty)
      circle(g, view, f, zm)
      shock(g, f, zm)
      wedge(g, view, f, zm)
      disc(g, f)
      // the trails run over small tickets (frames 48, 49) but under big ones (frame 50)
      const under = !!f.tickets?.trailsUnder
      if (under) trails(g, f)
      tickets(g, view, f, zm)
      if (!under) trails(g, f)
      for (const m of f.markers) marker(g, view, zm, m)
      select(g, view, zm, f)
      bloom(g, f)
      base(g, view)
      floor(g, f)
      shade(g, f)
      slitWords(g, f)
      selectLine(g, view, f)
      winner(g, f)
      outTrail(g, f)
      flipWords(g, f)
    },
    /* the arrows' own canvas, over the names: yours is never under the
       legend. It is the arrow's size, its top-left at `at` (device px of
       the stage), so the stage is drawn shifted by that much */
    arrows(g, view, f, at = { x: 0, y: 0 }) {
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.clearRect(0, 0, g.canvas.width, g.canvas.height)
      const k = view.dpr * view.scale
      g.setTransform(k, 0, 0, k, -at.x, -at.y)
      arrows(g, f)
    },
  }
}
