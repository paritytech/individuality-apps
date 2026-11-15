// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE FIELD'S PATTERNS — what is cut into the field behind the letters,
   drawn into the engraving canvas's height (R) by engrave.js, so the
   normals, the cavity and the parallax all read it. Bake-time only: a pattern
   costs nothing per frame.

   Every one is a few strokes or dots, clipped to the field, with lines about
   2 texels wide at any map size (px is one texel at 1024):

     guilloche     the engine-turned rosette: phase-shifted sinusoids round a circle
     spirograph    hypotrochoids — the guilloché machine's own curve
     spiral        a many-armed Archimedean spiral, r = aθ
     circles       concentric ripples
     goldenSpiral  logarithmic spirals growing by φ each quarter turn, a Fibonacci
                   number of them each way — where they cross is a sunflower's lattice
     sunflower     phyllotaxis (Vogel): dot n at r ∝ √n, θ = n × the golden angle
     flowerOfLife  overlapping circles on a hex lattice, the 19 of the classic figure
     metatron      Metatron's cube: the fruit of life's 13 circles, every centre
                   joined to every other
     psyMandala    a kaleidoscope of wavy rings in alternating phase, so they moiré
     opArt         two families of spirals turning opposite ways: a hypnotic moiré
     clover        a four-leaf clover: heart leaves hatched in herringbone off a
                   midrib, an outline and a stem. Cut in, or `raised` — the leaves
                   stand up and the hatching is cut into them

   scale is the density (1 = the figure as described; the clover's lines per
   leaf); h the canvas height the lines are cut to, field the ground's. */

const PHI = (1 + Math.sqrt(5)) / 2
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)) // 137.508°
const TAU = Math.PI * 2

export const FIELD_PATTERNS = ['none', 'guilloche', 'spirograph', 'spiral', 'circles', 'goldenSpiral', 'sunflower', 'flowerOfLife', 'metatron', 'psyMandala', 'opArt', 'clover']

export const heightStyle = (h) => `rgb(${Math.round(Math.max(0, Math.min(1, h)) * 255)},0,0)`

/* a polyline from f(t) = [x, y] around centre c, t over [t0, t1] in `steps` */
function curve(g, c, f, t0, t1, steps) {
  g.beginPath()
  for (let i = 0; i <= steps; i++) {
    const [x, y] = f(t0 + ((t1 - t0) * i) / steps)
    if (i) g.lineTo(c + x, c + y)
    else g.moveTo(c + x, c + y)
  }
  g.stroke()
}
const ring = (g, x, y, r) => {
  g.beginPath()
  g.arc(x, y, r, 0, TAU)
  g.stroke()
}

/* overlapping phase-shifted sinusoids round a circle: the engine-turned look
   (the rim's guilloché uses it too) */
export function rosette(g, c, rMid, amp, lobes, strands, width, h) {
  g.strokeStyle = heightStyle(h)
  g.lineWidth = width
  for (let k = 0; k < strands; k++) {
    const ph = (k / strands) * TAU
    curve(g, c, (a) => {
      const r = rMid + amp * Math.sin(lobes * a + ph)
      return [r * Math.cos(a), r * Math.sin(a)]
    }, 0, TAU, 720)
  }
}

/* the classic heart (16sin³t, 13cos t − 5cos2t − 2cos3t − cos4t) as a leaf:
   its point at the clover's centre, its lobes out along angle th. k scales
   the curve, d0 is how far the point sits off the centre. Leaf-local u runs
   out along the midrib (0 at the point, the notch at 22k, the lobes to ~29k),
   v across it */
const HEART_NOTCH = 22
const HEART_LEN = 29
function leafAt(c, th, d0, k) {
  const ax = Math.cos(th)
  const ay = Math.sin(th)
  return (u, v) => [c + (d0 + u) * ax - v * ay, c + (d0 + u) * ay + v * ax]
}
function heartPath(g, at, k) {
  g.beginPath()
  for (let i = 0; i <= 240; i++) {
    const t = (i / 240) * TAU
    const x = 16 * Math.sin(t) ** 3
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    const [px, py] = at((y + 17) * k, x * k)
    if (i) g.lineTo(px, py)
    else g.moveTo(px, py)
  }
  g.closePath()
}

/* the four-leaf clover. mark: the height the pattern is cut (or raised) to;
   field: the ground's */
function clover(g, { c, R, w, scale, mark, field, raised }) {
  const d0 = R * 0.04
  const k = (R * 0.88) / HEART_LEN
  const n = Math.max(4, Math.round(22 * scale)) // lines each side of each midrib
  const leaves = [1, 3, 5, 7].map((q) => leafAt(c, (q * Math.PI) / 4, d0, k))

  // the stem: a tapered curve down between the lower leaves (canvas y is down)
  const P0 = [0, R * 0.06]
  const P1 = [-R * 0.06, R * 0.5]
  const P2 = [R * 0.14, R * 0.88]
  const side = []
  const other = []
  for (let i = 0; i <= 40; i++) {
    const t = i / 40
    const bx = (1 - t) ** 2 * P0[0] + 2 * (1 - t) * t * P1[0] + t * t * P2[0]
    const by = (1 - t) ** 2 * P0[1] + 2 * (1 - t) * t * P1[1] + t * t * P2[1]
    const dx = 2 * (1 - t) * (P1[0] - P0[0]) + 2 * t * (P2[0] - P1[0])
    const dy = 2 * (1 - t) * (P1[1] - P0[1]) + 2 * t * (P2[1] - P1[1])
    const l = Math.hypot(dx, dy) || 1
    const half = R * (0.028 - 0.016 * t)
    side.push([c + bx - (dy / l) * half, c + by + (dx / l) * half])
    other.push([c + bx + (dy / l) * half, c + by - (dx / l) * half])
  }
  g.beginPath()
  ;[...side, ...other.reverse()].forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
  g.closePath()
  g.fillStyle = heightStyle(mark) // cut or raised, the stem is solid
  g.fill()

  for (const at of leaves) {
    if (raised) {
      heartPath(g, at, k)
      g.fillStyle = heightStyle(mark)
      g.fill()
    }
    const groove = heightStyle(raised ? field : mark)
    // the hatching, each half of the leaf on its own, clipped to it
    for (const s of [1, -1]) {
      g.save()
      heartPath(g, at, k)
      g.clip()
      g.beginPath()
      const q = [at(-HEART_LEN * k, 0), at(HEART_LEN * 2 * k, 0), at(HEART_LEN * 2 * k, s * 20 * k), at(-HEART_LEN * k, s * 20 * k)]
      q.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
      g.closePath()
      g.clip()
      g.strokeStyle = groove
      g.lineWidth = w
      const len = HEART_LEN * k
      // from behind the leaf's point: the first lines fill the corner by it
      for (let i = -Math.ceil(n * 0.4); i < n; i++) {
        const f = (i + 0.5) / n
        const u = f * HEART_LEN * k
        const slant = ((38 + 24 * Math.max(0, f)) * Math.PI) / 180 // steeper toward the lobes: the lines fan a little, as on a leaf
        const [x0, y0] = at(u, 0)
        const [x1, y1] = at(u + len * Math.cos(slant), s * len * Math.sin(slant))
        g.beginPath()
        g.moveTo(x0, y0)
        g.lineTo(x1, y1)
        g.stroke()
      }
      g.restore()
    }
    // the midrib, point to notch
    g.strokeStyle = groove
    g.lineWidth = w * 1.6
    g.beginPath()
    g.moveTo(...at(0, 0))
    g.lineTo(...at(HEART_NOTCH * 0.96 * k, 0))
    g.stroke()
    // the outline: cut round the leaf, or, raised, a smooth border and a groove
    // inside it — a stroke clipped to the leaf is an inset that follows its edge
    heartPath(g, at, k)
    if (raised) {
      const border = w * 2.5
      g.save()
      g.clip()
      g.lineWidth = 2 * (border + w * 1.4)
      g.stroke()
      g.strokeStyle = heightStyle(mark)
      g.lineWidth = 2 * border
      g.stroke()
      g.restore()
    } else {
      g.lineWidth = w * 2.5
      g.stroke()
    }
  }
}

/* one pattern over the field: c the centre, R how far it reaches (canvas px),
   clip(g) the field's outline as a path to keep it in */
export function fieldPattern(g, kind, { c, R, px, scale = 1, h, field = 0.6, raised = false, clip = null }) {
  if (!kind || kind === 'none') return
  const s = Math.max(0.25, scale)
  const w = 2 * px
  g.save()
  g.beginPath()
  if (clip) clip(g) // the field's own outline (a polygon coin's)
  else g.arc(c, c, R * 0.97, 0, TAU)
  g.clip()
  g.strokeStyle = g.fillStyle = heightStyle(h)
  g.lineWidth = w
  g.lineCap = g.lineJoin = 'round'

  if (kind === 'guilloche') {
    rosette(g, c, R * 0.62, R * 0.26, 18, Math.round(16 * s), w, h)
  } else if (kind === 'spirograph') {
    // r = 7/19 of the ring closes after 7 turns; several pen distances d
    const r0 = 7 / 19
    const k = (1 - r0) / r0
    const n = Math.round(5 * s)
    for (let i = 0; i < n; i++) {
      const d = 0.25 + (0.45 * i) / Math.max(1, n - 1)
      const norm = (R * 0.94) / (1 - r0 + d)
      curve(g, c, (t) => [norm * ((1 - r0) * Math.cos(t) + d * Math.cos(k * t)), norm * ((1 - r0) * Math.sin(t) - d * Math.sin(k * t))], 0, 7 * TAU, 2400)
    }
  } else if (kind === 'spiral') {
    const arms = Math.max(1, Math.round(6 * s))
    const turns = 3
    for (let a = 0; a < arms; a++) {
      const off = (a / arms) * TAU
      curve(g, c, (t) => {
        const r = (R * t) / (turns * TAU)
        return [r * Math.cos(t + off), r * Math.sin(t + off)]
      }, 0, turns * TAU, 900)
    }
  } else if (kind === 'circles') {
    const n = Math.max(2, Math.round(14 * s))
    for (let i = 1; i <= n; i++) {
      g.lineWidth = i % 2 ? w : w * 1.8
      ring(g, c, c, (R * i) / n)
    }
  } else if (kind === 'goldenSpiral') {
    // r = r0·φ^(2θ/π): out from near the centre to the rim; 13 one way, 21 the other
    const r0 = R * 0.03
    const tMax = (Math.log(R / r0) / Math.log(PHI)) * (Math.PI / 2)
    for (const [count, dir] of [
      [Math.max(1, Math.round(13 * s)), 1],
      [Math.max(1, Math.round(21 * s)), -1],
    ]) {
      for (let i = 0; i < count; i++) {
        const off = (i / count) * TAU
        curve(g, c, (t) => {
          const r = r0 * PHI ** ((2 * t) / Math.PI)
          return [r * Math.cos(dir * t + off), r * Math.sin(dir * t + off)]
        }, 0, tMax, 400)
      }
    }
  } else if (kind === 'sunflower') {
    const N = Math.round(500 * s * s)
    const dot = Math.max(px, (R / Math.sqrt(N)) * 0.32)
    for (let i = 1; i <= N; i++) {
      const r = R * 0.96 * Math.sqrt(i / N)
      const a = i * GOLDEN_ANGLE
      g.beginPath()
      g.arc(c + r * Math.cos(a), c + r * Math.sin(a), dot, 0, TAU)
      g.fill()
    }
  } else if (kind === 'flowerOfLife') {
    // hex lattice to `rings` steps (2 → the classic 19), circles of the lattice's spacing
    const rings = Math.max(1, Math.round(2 * s))
    const a = (R * 0.95) / (rings + 1)
    for (let q = -rings; q <= rings; q++) {
      for (let r = -rings; r <= rings; r++) {
        if (Math.abs(q + r) > rings) continue
        ring(g, c + a * (q + r / 2), c + a * r * (Math.sqrt(3) / 2), a)
      }
    }
    ring(g, c, c, a * (rings + 1))
  } else if (kind === 'metatron') {
    // the fruit of life: the centre, six at 2a, six at 4a; a circle at each, every pair joined
    const a = R * 0.19
    const pts = [[0, 0]]
    for (const d of [2, 4]) for (let i = 0; i < 6; i++) pts.push([d * a * Math.cos((i * Math.PI) / 3 + Math.PI / 6), d * a * Math.sin((i * Math.PI) / 3 + Math.PI / 6)])
    for (const [x, y] of pts) ring(g, c + x, c + y, a)
    g.lineWidth = w * 0.8
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        g.beginPath()
        g.moveTo(c + pts[i][0], c + pts[i][1])
        g.lineTo(c + pts[j][0], c + pts[j][1])
        g.stroke()
      }
    }
  } else if (kind === 'psyMandala') {
    // two kaleidoscopes of wavy rings, 8-fold and 12-fold, in alternating phase
    const n = Math.max(3, Math.round(12 * s))
    for (const [fold, amp] of [
      [8, 0.9],
      [12, 0.6],
    ]) {
      for (let i = 0; i < n; i++) {
        const base = (R * (i + 0.5)) / n
        const ph = i % 2 ? Math.PI / fold : 0
        curve(g, c, (t) => {
          const r = base + amp * (R / n) * 0.5 * Math.sin(fold * t + ph)
          return [r * Math.cos(t), r * Math.sin(t)]
        }, 0, TAU, 900)
      }
    }
  } else if (kind === 'clover') {
    clover(g, { c, R, w, scale: s, mark: h, field, raised })
  } else if (kind === 'opArt') {
    const arms = Math.max(4, Math.round(24 * s))
    for (const dir of [1, -1]) {
      for (let i = 0; i < arms; i++) {
        const off = (i / arms) * TAU
        curve(g, c, (t) => {
          const r = R * t
          const a = dir * t * 1.6 * Math.PI + off
          return [r * Math.cos(a), r * Math.sin(a)]
        }, 0, 1, 240)
      }
    }
  }
  g.restore()
}
