// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE DRAIN — the draw's picture going down into the bubble, in one GPU pass.
 * LOGIC ONLY, no React (architecture rule 6), no dependencies: WebGL1, one
 * quad, one texture.
 *
 * The hold's still picture of the screen flows into the bubble like water
 * down a plughole: what is nearest goes first and the far edges last, it
 * turns round the centre on its way in, faster the closer it gets (a
 * whirlpool), it shrinks and thins, and it is gone by 0.4·R from the centre.
 * Just outside the rim the picture bends a little towards the bubble, as if
 * seen through its edge. By pull 1 the canvas is empty (transparent: the live
 * page under it shows).
 *
 * How: an inverse map in the fragment shader. For each pixel at distance r
 * from the bubble, the picture it shows comes from s = √(r² + h²), turned
 * back by TWIST·ln(s/r): an ideal sink (it keeps area, so what goes in
 * thins along the circle and streams out along the radius) that has
 * swallowed everything within h of the centre, h growing with pull until it
 * passes the far corner, plus a vortex. What is squeezed along the circle is
 * averaged over the texels it covers (four taps) and fades as it thins, so
 * the streams neither shimmer nor alias. At pull 0 the shader takes the
 * picture texel for texel (exact, given a picture the size of the canvas:
 * round(cssW·dpr) × round(cssH·dpr)).
 *
 * API: createWarp(canvas) -> { ok, setPicture(pic), resize(cssW, cssH, dpr),
 * draw({ cx, cy, R, pull, t }), clear(), destroy() }. `ok` is live: it goes
 * false while the context is lost and true again once it is restored (the
 * picture is uploaded again by itself). The caller falls back while it is
 * false. It is also false without highp floats in the fragment shader; the
 * canvas may then already hold a WebGL context, so the fallback does not
 * draw 2D on this canvas. destroy() frees the texture and program but
 * leaves the context to the canvas.
 */

export interface WarpFrame {
  cx: number; cy: number   // bubble centre, CSS px from the canvas's top-left
  R: number                // bubble radius, CSS px
  pull: number             // 0 → 1: how far the hold has gone (0: the picture as it was, exactly; 1: all of it gone into the bubble)
  t: number                // seconds (performance.now()/1000), for a subtle living motion
  /** the picture as shown is the picture scaled by `s` (about the canvas's top-left) and moved by (x, y), CSS px: a zoom easing out as the hold begins. None: as it is */
  view?: { s: number; x: number; y: number }
}

export interface Warp {
  /** false where WebGL is not available or failed: the caller falls back */
  readonly ok: boolean
  /** the still picture, a canvas of the whole screen at device px (width = cssW·dpr). Uploaded once. */
  setPicture(picture: HTMLCanvasElement): void
  /** size the canvas: CSS px and device-pixel ratio (call on create and on resize) */
  resize(cssW: number, cssH: number, dpr: number): void
  /** draw one frame (clears first). Cheap: one quad. */
  draw(frame: WarpFrame): void
  /** blank the canvas (nothing shown) */
  clear(): void
  destroy(): void
}

/* the look's knobs */
const PACE = 1.4        // h = far · pull^PACE: slow at first, the near content goes, then faster
const TWIST = 1.4       // the whirlpool: turned by TWIST·ln(s/r) rad on the way in from s to r
const HOLE_IN = 0.4     // swallowed by this · R from the centre…
const HOLE_OUT = 1.0    // …fading from this · R
const THIN_IN = 0.06    // squeezed along the circle to this share of its width it is gone…
const THIN_OUT = 0.22   // …fading from this share
const LENS = 0.15       // just outside the rim (1.0–1.4·R) the picture bends in by up to ~0.4 of this · R
const LENS_OUT = 1.4
const SOFT = 24         // the picture's own edges, coming in, go this soft (CSS px)
const GATE = 0.08       // the hole, the lens and the ripple come in over the first this much of the pull
const WOBBLE = 0.035    // the living motion: a ripple in the swirl, rad…
const WOBBLE_HZ = 0.35  // …this often…
const WOBBLE_WAVE = 22  // …running out this far apart, CSS px

const c01 = (x: number) => Math.min(1, Math.max(0, x))
const smooth = (x: number) => { const k = c01(x); return k * k * (3 - 2 * k); }

/** the per-frame numbers the shader takes, from a frame and the canvas's CSS size (pure) */
export function drainParams(f: WarpFrame, cssW: number, cssH: number) {
  const pull = c01(f.pull)
  // past the farthest corner by pull 1: the screen is then empty
  const far = Math.max(Math.hypot(f.cx, f.cy), Math.hypot(cssW - f.cx, f.cy), Math.hypot(f.cx, cssH - f.cy), Math.hypot(cssW - f.cx, cssH - f.cy)) + 4
  const h = far * Math.pow(pull, PACE)
  const gate = smooth(pull / GATE)
  // the ripple's phase, kept small so the float holds it
  const phase = ((((f.t * WOBBLE_HZ) % 1) + 1) % 1) * Math.PI * 2
  return { pull, h, gate, phase }
}

/**
 * Where a point of the picture is drawn this frame, the drain's own map run
 * forwards (the shader runs it backwards, from each pixel to the picture):
 * so whatever is not in the picture (words on the page) can go in with it.
 * `turn` is how far it has turned round the bubble (rad), `k` how much it has
 * shrunk, `alpha` what is left of it; null once it is swallowed. The lens and
 * the ripple, small, are left out. CSS px, as the frame (pure)
 */
export function drainPoint(x: number, y: number, f: WarpFrame, cssW: number, cssH: number) {
  const { pull, h, gate } = drainParams(f, cssW, cssH)
  const dx = x - f.cx, dy = y - f.cy, d = Math.hypot(dx, dy)
  if (pull <= 0) return { x, y, turn: 0, k: 1, alpha: 1 }
  if (d <= h + 1e-3) return null
  const r = Math.sqrt(d * d - h * h)
  const turn = TWIST * Math.log(d / Math.max(r, 1e-3))
  const ct = Math.cos(turn), st = Math.sin(turn)
  const ux = (dx * ct - dy * st) / d, uy = (dy * ct + dx * st) / d
  const thin = smoothstepJs(THIN_IN, THIN_OUT, r / d)
  const R = Math.max(1, f.R)
  const hole = 1 - gate + gate * smoothstepJs(HOLE_IN * R, HOLE_OUT * R, r)
  const alpha = thin * hole
  if (alpha <= 0.002) return null
  return { x: f.cx + ux * r, y: f.cy + uy * r, turn, k: Math.sqrt(r / d), alpha }
}
const smoothstepJs = (a: number, b: number, x: number) => smooth((x - a) / (b - a))

const f4 = (x: number) => x.toFixed(4)

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

/* highp only (createWarp says not ok without it): a 2000 px texture and h² past 65 504 are beyond mediump */
const FRAG = `
precision highp float;
uniform sampler2D uPic;
uniform vec2 uBuf;   // the drawing buffer, device px
uniform vec2 uCss;   // the canvas, CSS px
uniform vec3 uBub;   // cx, cy, R (CSS px)
uniform vec4 uK;     // pull, h², gate, phase
uniform vec3 uView;  // the picture as shown: scaled by x, moved by (y, z), CSS px
void main() {
  vec2 dev = vec2(gl_FragCoord.x, uBuf.y - gl_FragCoord.y);
  vec2 px = uCss / uBuf;
  // where a point as shown is in the picture
  #define PIC(q) (((q) - uView.yz) / uView.x)
  if (uK.x <= 0.0) {
    vec2 p0 = PIC(dev * px);
    float in0 = step(0.0, min(min(p0.x, p0.y), min(uCss.x - p0.x, uCss.y - p0.y)));
    gl_FragColor = texture2D(uPic, p0 / uCss) * in0;
    return;
  }
  float R = uBub.z, h2 = uK.y, g = uK.z;
  vec2 v = dev * px - uBub.xy;
  float r = max(length(v), 1e-3);
  // the lens: a hump of inward bend between the rim and LENS_OUT·R
  float x = clamp((r / R - 1.0) / ${f4(LENS_OUT - 1)}, 0.0, 1.0);
  float b = sin(3.14159265 * x);
  float r1 = r + ${f4(LENS)} * R * g * b * b * (1.0 - x);
  // the sink and the vortex
  float s = sqrt(r1 * r1 + h2);
  float turn = ${f4(TWIST)} * log(s / r1) + ${f4(WOBBLE)} * g * sin(uK.w - r * ${(1 / WOBBLE_WAVE).toFixed(6)}) * R / (r + R);
  // turned back by rotating v itself (no atan round trip: exact as the turn goes to 0)
  float ct = cos(turn), st = sin(turn);
  vec2 dir = vec2(v.x * ct + v.y * st, v.y * ct - v.x * st) / r;
  vec2 src = uBub.xy + s * dir;
  // squeezed along the circle by s/r (and sheared there by the twist): four taps over what one pixel covers
  float foot = (s / r1) * (1.0 + ${f4(TWIST)} * h2 / (s * s));
  vec2 pic = PIC(src);
  vec2 uv = pic / uCss, du = vec2(-dir.y, dir.x) * (max(foot - 1.0, 0.0) * 0.25) * px / (uCss * uView.x);
  vec4 c = 0.25 * (texture2D(uPic, uv - 1.5 * du) + texture2D(uPic, uv - 0.5 * du) + texture2D(uPic, uv + 0.5 * du) + texture2D(uPic, uv + 1.5 * du));
  // outside the picture is nothing, and its edges come in soft
  float edge = min(min(pic.x, pic.y), min(uCss.x - pic.x, uCss.y - pic.y)) * uView.x;
  float alpha = clamp((edge + 0.5) / (0.5 + min(${f4(SOFT)}, 0.5 * (s - r))), 0.0, 1.0);
  // thinned away, and swallowed by the bubble
  alpha *= smoothstep(${f4(THIN_IN)}, ${f4(THIN_OUT)}, r1 / s);
  alpha *= mix(1.0, smoothstep(${f4(HOLE_IN)} * R, ${f4(HOLE_OUT)} * R, r), g);
  gl_FragColor = c * alpha;
}
`

const NONE: Warp = { ok: false, setPicture() {}, resize() {}, draw() {}, clear() {}, destroy() {} }

export function createWarp(canvas: HTMLCanvasElement): Warp {
  let gl: WebGLRenderingContext | null = null
  try {
    gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false })
  } catch { gl = null; }
  if (!gl) return NONE
  const ctx = gl
  const high = ctx.getShaderPrecisionFormat(ctx.FRAGMENT_SHADER, ctx.HIGH_FLOAT)
  if (!high || high.precision < 16) return NONE

  let prog: WebGLProgram | null = null, buf: WebGLBuffer | null = null, tex: WebGLTexture | null = null
  let U: Record<"pic" | "buf" | "css" | "bub" | "k" | "view", WebGLUniformLocation | null> | null = null
  let picture: HTMLCanvasElement | null = null, uploaded = false
  let cssW = canvas.clientWidth || 1, cssH = canvas.clientHeight || 1
  let lost = false, broken = false, gone = false

  function shader(type: number, src: string) {
    const sh = ctx.createShader(type)
    if (!sh) return null
    ctx.shaderSource(sh, src); ctx.compileShader(sh)
    if (!ctx.getShaderParameter(sh, ctx.COMPILE_STATUS)) { ctx.deleteShader(sh); return null; }
    return sh
  }

  /* everything the context holds: built on create, and again after a restore */
  function build() {
    const vs = shader(ctx.VERTEX_SHADER, VERT), fs = shader(ctx.FRAGMENT_SHADER, FRAG)
    const p = ctx.createProgram()
    if (!vs || !fs || !p) return false
    ctx.attachShader(p, vs); ctx.attachShader(p, fs)
    ctx.bindAttribLocation(p, 0, "aPos")
    ctx.linkProgram(p)
    ctx.deleteShader(vs); ctx.deleteShader(fs)
    if (!ctx.getProgramParameter(p, ctx.LINK_STATUS)) { ctx.deleteProgram(p); return false; }
    prog = p
    U = {
      pic: ctx.getUniformLocation(p, "uPic"), buf: ctx.getUniformLocation(p, "uBuf"), css: ctx.getUniformLocation(p, "uCss"),
      bub: ctx.getUniformLocation(p, "uBub"), k: ctx.getUniformLocation(p, "uK"), view: ctx.getUniformLocation(p, "uView"),
    }
    buf = ctx.createBuffer()
    ctx.bindBuffer(ctx.ARRAY_BUFFER, buf)
    ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), ctx.STATIC_DRAW)
    ctx.enableVertexAttribArray(0)
    ctx.vertexAttribPointer(0, 2, ctx.FLOAT, false, 0, 0)
    tex = ctx.createTexture()
    ctx.activeTexture(ctx.TEXTURE0)
    ctx.bindTexture(ctx.TEXTURE_2D, tex)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE)
    ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE)
    ctx.useProgram(p)
    ctx.uniform1i(U.pic, 0)
    ctx.disable(ctx.BLEND); ctx.disable(ctx.DEPTH_TEST)
    ctx.clearColor(0, 0, 0, 0)
    uploaded = false
    return true
  }

  function upload() {
    if (!picture || !tex || lost) return
    ctx.bindTexture(ctx.TEXTURE_2D, tex)
    // premultiplied, top row first, no colour conversion: at pull 0 the texels are the picture's own
    ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, false)
    ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    ctx.pixelStorei(ctx.UNPACK_COLORSPACE_CONVERSION_WEBGL, ctx.NONE)
    ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, picture)
    uploaded = ctx.getError() === ctx.NO_ERROR
  }

  function onLost(e: Event) { e.preventDefault(); lost = true; prog = buf = tex = null; U = null; uploaded = false; }
  function onRestored() {
    lost = false
    broken = !build()
    if (!broken) upload()
  }
  canvas.addEventListener("webglcontextlost", onLost)
  canvas.addEventListener("webglcontextrestored", onRestored)
  broken = !build()

  const live = () => !gone && !lost && !broken && !ctx.isContextLost()

  return {
    get ok() { return live(); },
    setPicture(pic) {
      picture = pic
      if (live()) upload()
    },
    resize(w, h, dpr) {
      cssW = Math.max(1, w); cssH = Math.max(1, h)
      const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr))
      if (canvas.width !== bw) canvas.width = bw
      if (canvas.height !== bh) canvas.height = bh
      canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`
    },
    draw(f) {
      if (!live() || !U) return
      const bw = ctx.drawingBufferWidth, bh = ctx.drawingBufferHeight
      ctx.viewport(0, 0, bw, bh)
      ctx.clear(ctx.COLOR_BUFFER_BIT)
      if (!uploaded || !Number.isFinite(f.pull) || f.pull >= 1) return
      const k = drainParams(f, cssW, cssH)
      ctx.useProgram(prog)
      ctx.uniform2f(U.buf, bw, bh)
      ctx.uniform2f(U.css, cssW, cssH)
      ctx.uniform3f(U.bub, f.cx, f.cy, Math.max(1, f.R))
      ctx.uniform4f(U.k, k.pull, k.h * k.h, k.gate, k.phase)
      const view = f.view ?? { s: 1, x: 0, y: 0 }
      ctx.uniform3f(U.view, Math.max(1e-3, view.s), view.x, view.y)
      ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4)
    },
    clear() {
      if (!live()) return
      ctx.viewport(0, 0, ctx.drawingBufferWidth, ctx.drawingBufferHeight)
      ctx.clear(ctx.COLOR_BUFFER_BIT)
    },
    destroy() {
      if (gone) return
      gone = true
      canvas.removeEventListener("webglcontextlost", onLost)
      canvas.removeEventListener("webglcontextrestored", onRestored)
      if (!lost && !ctx.isContextLost()) {
        ctx.clear(ctx.COLOR_BUFFER_BIT)
        if (tex) ctx.deleteTexture(tex)
        if (buf) ctx.deleteBuffer(buf)
        if (prog) ctx.deleteProgram(prog)
      }
      prog = buf = tex = null; U = null; picture = null
    },
  }
}
