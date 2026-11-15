// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE TRAIL LAB'S PAINTER — the trails the slit's painter hands it, drawn
   by one fragment shader (glsl.js) on an offscreen WebGL2 canvas, then
   copied into the 2D canvas at the very point the flat ribbon would have
   been drawn: over the dots, under the balls, and under any clip the
   painter has set (the flip's coin cut out of its own trail).

   Cheap on purpose: one program, one buffer allocated once, one draw call
   for all of a frame's trails, no textures, no render targets — and only
   the box the trails cover is copied back. Within one trail its quads
   overlap at every joint: each trail (each circle) is drawn at its own
   depth with the test LESS, so a trail never blends over itself, and a
   later one lies over an earlier one as on the 2D canvas.

   No WebGL2: createTrailLook() is null, and the painter keeps the flat
   trail. */

import { VERT, FRAG } from './glsl.js'

const TAU = Math.PI * 2
const COLOUR_MODE = { gamma: 0, spectral: 1, heatmap: 2, '70s rainbow': 3 }
const EDGE_MODE = { none: 0, spectral: 1, dots: 2, dust: 3, 'hot liquid glass': 4 }
/* the 70s palettes, first lane to last (the reference: a decal's rainbow, green inside to violet out) */
const PALETTES = {
  'the reference': ['#3fbf5a', '#c9e04a', '#f6d94a', '#f6a845', '#ef7f4a', '#ec6f7a', '#d9489f', '#6b3fa8'],
  sunset: ['#ffd23f', '#ff9f1c', '#ff6b3d', '#f2385a', '#c2185b', '#7b1fa2', '#4527a0', '#1a237e'],
}

/* the suite reads these (lab-scene.js's debug): is there a GL, how many
   trails (circles) the last call drew, and any GL error, read on demand */
export const TRAIL_LOOK_STATS = { gl: null, drawn: 0, calls: 0, error: () => 'no GL' }

const FLOATS = 13 // pos 2, local 2, info 4, head 4, depth 1
const smooth = (u) => {
  const x = Math.max(0, Math.min(1, u))
  return x * x * (3 - 2 * x)
}
const linOf = new Map()
function lin(hex) {
  let v = linOf.get(hex)
  if (!v) {
    const h = hex.replace('#', '')
    v = [0, 2, 4].map((i) => Math.pow(parseInt(h.slice(i, i + 2), 16) / 255, 2.2))
    linOf.set(hex, v)
  }
  return v
}

function program(gl) {
  const sh = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
    return s
  }
  const p = gl.createProgram()
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT))
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
  return p
}

export function createTrailLook() {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: true, stencil: false })
  if (!gl) {
    TRAIL_LOOK_STATS.gl = false
    return null
  }
  let prog
  try {
    prog = program(gl)
  } catch (e) {
    console.error('trail look:', e)
    TRAIL_LOOK_STATS.gl = false
    TRAIL_LOOK_STATS.error = () => String(e.message ?? e)
    return null
  }
  TRAIL_LOOK_STATS.gl = true
  TRAIL_LOOK_STATS.error = () => {
    const e = gl.getError()
    return e === gl.NO_ERROR ? null : `GL error 0x${e.toString(16)}`
  }

  const U = {}
  const nU = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)
  for (let i = 0; i < nU; i++) {
    const name = gl.getActiveUniform(prog, i).name.replace(/\[0\]$/, '')
    U[name] = gl.getUniformLocation(prog, name)
  }

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  let data = new Float32Array(FLOATS * 4096)
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW)
  let off = 0
  for (const [name, size] of [['aPos', 2], ['aLocal', 2], ['aInfo', 4], ['aHead', 4], ['aDepth', 1]]) {
    const loc = gl.getAttribLocation(prog, name)
    if (loc >= 0) {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, FLOATS * 4, off * 4)
    }
    off += size
  }

  /* asleep between trails: a second with nothing to draw and the canvas goes
     to 0×0 — its colour and depth, the whole stage's size, let go — while the
     program and the buffer stay; the next trail sizes it again */
  const SLEEP_MS = 1000
  let idleSince = -1
  let nv = 0 // vertices written this call
  let x0, y0, x1, y1 // the box they cover, nominal px
  function vertex(x, y, lx, ly, age, hw, a, kind, head, tint, z) {
    if ((nv + 1) * FLOATS > data.length) {
      const grown = new Float32Array(data.length * 2)
      grown.set(data)
      data = grown
      gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW)
    }
    const o = nv * FLOATS
    data[o] = x
    data[o + 1] = y
    data[o + 2] = lx
    data[o + 3] = ly
    data[o + 4] = age
    data[o + 5] = hw
    data[o + 6] = a
    data[o + 7] = kind
    data[o + 8] = head[0] / 255
    data[o + 9] = head[1] / 255
    data[o + 10] = head[2] / 255
    data[o + 11] = tint
    data[o + 12] = z
    nv++
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }

  /* how far past the ticket's edge the geometry reaches, in half-widths: the
     edge's own reach, and a device pixel or two for the anti-aliasing */
  function reachOf(look, hw, k) {
    const px = 2 / Math.max(1e-3, hw * k)
    switch (look.edge) {
      case 'spectral':
        return 1 + look.fringe * (0.35 + 0.65 * look.soft) + px
      case 'dots':
        return 1 + (0.5 * look.dotPx) / hw + px
      case 'dust':
        return 1 + look.spread + (2 * look.speckPx) / hw + px
      case 'hot liquid glass':
        return 1.3 + 0.2 * look.wobble + px
      default:
        return 1 + px
    }
  }

  const L = new Float32Array(2 * 64)
  const R = new Float32Array(2 * 64)
  const S = new Float32Array(64)
  function build(t, look, circles, k, z) {
    /* the flat trail's own cut: never a lap or more, nothing for a still ticket */
    let N = Math.min(63, t.n - 1)
    while (N > 0 && t.ang[0] - t.ang[N] > TAU * 0.98) N--
    if (N < 1 || t.ang[0] - t.ang[N] <= 1e-4) return 0
    let len = 0
    for (let j = 1; j <= N; j++) len += Math.hypot(t.pts[2 * j] - t.pts[2 * j - 2], t.pts[2 * j + 1] - t.pts[2 * j - 1])
    /* how much of the palette: a short trail is the ticket's own colour, the
       rest coming in as it grows (the flat trail's tint); a plain one (the
       flipped coin's, on its way up) is its own colour all the way */
    const tint = t.plain ? -1 : smooth((len / Math.max(1e-3, t.wid[0]) - 1.5) / 3)
    if (circles > 0) {
      /* the circles: tail first, each at its own depth so the newer lie over the older */
      let drawn = 0
      for (let c = circles; c >= 1; c--) {
        const fr = c / (circles + 1)
        const x = fr * N
        const j = Math.min(N - 1, Math.floor(x))
        const u = x - j
        const px = t.pts[2 * j] + (t.pts[2 * j + 2] - t.pts[2 * j]) * u
        const py = t.pts[2 * j + 1] + (t.pts[2 * j + 3] - t.pts[2 * j + 1]) * u
        const r = (t.wid[j] + (t.wid[j + 1] - t.wid[j]) * u) / 2
        if (r <= 0.05) continue
        const q = reachOf(look, r, k)
        const zc = z - drawn * 0.0004
        const v = (sx, sy) => vertex(px + sx * r * q, py + sy * r * q, sx * q, sy * q, fr, r, t.a, 1, t.head, tint, zc)
        v(-1, -1)
        v(1, -1)
        v(-1, 1)
        v(-1, 1)
        v(1, -1)
        v(1, 1)
        drawn++
      }
      return drawn
    }
    /* the line: both sides of it at each sample, its reach out past the ticket */
    for (let j = 0; j <= N; j++) {
      const x = t.pts[2 * j]
      const y = t.pts[2 * j + 1]
      const j0 = Math.max(0, j - 1)
      const j1 = Math.min(N, j + 1)
      const tx = t.pts[2 * j1] - t.pts[2 * j0]
      const ty = t.pts[2 * j1 + 1] - t.pts[2 * j0 + 1]
      const l = Math.hypot(tx, ty) || 1
      const hw = t.wid[j] / 2
      const q = reachOf(look, hw, k) * hw
      L[2 * j] = x - (ty / l) * q
      L[2 * j + 1] = y + (tx / l) * q
      R[2 * j] = x + (ty / l) * q
      R[2 * j + 1] = y - (tx / l) * q
      S[j] = j === 0 ? 0 : S[j - 1] + Math.hypot(x - t.pts[2 * j - 2], y - t.pts[2 * j - 1])
    }
    for (let j = 0; j < N; j++) {
      const a = j / N
      const b = (j + 1) / N
      const ha = t.wid[j] / 2
      const hb = t.wid[j + 1] / 2
      const qa = reachOf(look, ha, k)
      const qb = reachOf(look, hb, k)
      const A = () => vertex(L[2 * j], L[2 * j + 1], S[j], qa, a, ha, t.a, 0, t.head, tint, z)
      const B = () => vertex(R[2 * j], R[2 * j + 1], S[j], -qa, a, ha, t.a, 0, t.head, tint, z)
      const C = () => vertex(L[2 * j + 2], L[2 * j + 3], S[j + 1], qb, b, hb, t.a, 0, t.head, tint, z)
      const D = () => vertex(R[2 * j + 2], R[2 * j + 3], S[j + 1], -qb, b, hb, t.a, 0, t.head, tint, z)
      A()
      B()
      C()
      C()
      B()
      D()
    }
    return 1
  }

  const stops = new Float32Array(12)
  const pals = new Float32Array(24)
  function uniforms(look) {
    gl.uniform1f(U.uTime, (performance.now() / 1000) % 1000)
    gl.uniform1i(U.uColour, COLOUR_MODE[look.colour] ?? 0)
    gl.uniform1i(U.uEdge, EDGE_MODE[look.edge] ?? 0)
    gl.uniform1i(U.uStops, look.stops)
    gl.uniform1f(U.uTicketFirst, look.ticketFirst ? 1 : 0)
    for (let i = 0; i < 4; i++) stops.set(lin(look[`c${i + 1}`]), 3 * i)
    gl.uniform3fv(U.uC, stops)
    gl.uniform1f(U.uCurve, look.curve)
    gl.uniform2f(U.uNm, look.fromNm, look.toNm)
    gl.uniform1f(U.uSat, look.saturation)
    gl.uniform4f(U.uHeat, look.warp, look.grain, look.flow, look.reverse ? 1 : 0)
    const pal = PALETTES[look.palette] ?? [look.first, look.last]
    pal.forEach((h, i) => pals.set(lin(h), 3 * i))
    gl.uniform1i(U.uPalN, pal.length)
    gl.uniform3fv(U.uPal, pals)
    gl.uniform1f(U.uLanes, look.stripes)
    const gap = lin(look.gap)
    gl.uniform4f(U.uGap, gap[0], gap[1], gap[2], look.gapPx)
    gl.uniform4f(U.uFringe, look.fringe, look.soft, look.redOutside ? 1 : 0, look.fringeStrength)
    gl.uniform3f(U.uDots, look.dotPx, look.dotSize, look.dotDepth)
    gl.uniform4f(U.uDust, look.spread, look.density, look.speckPx, look.twinkle)
    gl.uniform4f(U.uGlass, look.thickness, look.rim, look.rainbow, look.wobble)
    gl.uniform1f(U.uGlassHeat, look.heat)
  }

  return {
    /* f: { trails, trailCircles, look } — what the slit's painter has; g
       under the transform it draws trails with (dpr × scale × the zoom) */
    draw(g, f) {
      const look = f.look
      const W = g.canvas.width
      const H = g.canvas.height
      const m = g.getTransform()
      const k = m.a // nominal px → device px (the transform is a uniform scale and a shift)
      nv = 0
      x0 = y0 = Infinity
      x1 = y1 = -Infinity
      let drawn = 0
      let z = 0.95
      for (const t of f.trails) {
        if (t.a <= 0.002 || t.n < 2) continue
        const n = build(t, look, f.trailCircles, k, z)
        drawn += n
        z -= 0.0004 * Math.max(1, n) + 0.0004
      }
      TRAIL_LOOK_STATS.drawn = drawn
      TRAIL_LOOK_STATS.calls++
      if (!nv) {
        const now = performance.now()
        if (idleSince < 0) idleSince = now
        else if (canvas.width && now - idleSince > SLEEP_MS) canvas.width = canvas.height = 0
        return
      }
      idleSince = -1
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
      }
      gl.viewport(0, 0, W, H)
      gl.clearColor(0, 0, 0, 0)
      gl.clearDepth(1)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(gl.LESS)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.useProgram(prog)
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, nv * FLOATS)
      gl.uniform3f(U.uXform, k, m.e, m.f)
      gl.uniform2f(U.uRes, W, H)
      uniforms(look)
      gl.drawArrays(gl.TRIANGLES, 0, nv)
      /* only the box the trails cover, back into the 2D canvas, device px */
      const bx = Math.max(0, Math.floor(x0 * k + m.e) - 2)
      const by = Math.max(0, Math.floor(y0 * k + m.f) - 2)
      const bw = Math.min(W, Math.ceil(x1 * k + m.e) + 2) - bx
      const bh = Math.min(H, Math.ceil(y1 * k + m.f) + 2) - by
      if (bw <= 0 || bh <= 0) return
      g.save()
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalAlpha = 1
      g.drawImage(canvas, bx, by, bw, bh, bx, by, bw, bh)
      g.restore()
    },
  }
}
