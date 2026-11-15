// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Part of the wrapping effect: its names are Wrapping*, except the shader exports (SHELL_*).
// The GL half of the wrapping effect. One context, two programs, N wrappings.
//
// This is the ONLY module in the wrapping tree that touches WebGL. Load it
// lazily (the chest scene and the Pocket claim import it dynamically), so the
// GL code never joins the first-load chunk.
//
// SHADING AND POSITION TRACKING ARE DECOUPLED. A wrapping is shaded into its own
// square framebuffer only when something about it changed; every frame that
// framebuffer is blitted to wherever the wrapping currently is. The wrappings are
// fill-rate bound, and a wrapping at rest that only ripples does not need 60 shades
// a second. See the shade gate in `draw`.
//
// THE BLIT PLACES ITS QUAD IN THE VERTEX SHADER, not with the GL viewport. A
// viewport is axis-aligned and therefore cannot rotate, and a placement
// carries a rotation. The pixel-to-clip conversion is spelled out in
// `shader.ts`, above `BLIT_VS`.
//
// PREMULTIPLIED, THREE WAYS. The context is created with
// `premultipliedAlpha: true`, the blend is `ONE, ONE_MINUS_SRC_ALPHA`, and the
// fragment shader writes `vec4(outC * outA, outA)`. All three must agree or the
// wrapping either doubles its own edges or paints a dark halo.
//
// Only the framebuffer path exists here: there is no straight-to-screen draw.

import { BASE, type WrappingMaterial, idleTilt } from './materials'
import { markWrappingUnavailable } from './availability'
import { COLOUR_N, FIELD_N, noiseTex, type WrappingFields } from './fields'
import { BLIT_FS, BLIT_VS, SHELL_FS, SHELL_UNIFORMS, SHELL_VS } from './shader'

/** Where one wrapping is drawn, in CSS pixels of the frame. */
interface WrappingPlacement {
  /** The centre of the ITEM's mask, in viewport coordinates. */
  cx: number
  cy: number
  /** The box side. The art is fitted inside it at `BASE.fit`. */
  size: number
  /** Degrees, clockwise, about `(cx, cy)`. */
  rotation: number
  /** 0 hides the wrapping entirely. */
  opacity: number
}

/** One wrapping, fully resolved, ready to draw. The canvas host (the chest scene
 *  or the Pocket claim) computes the placement each frame and hands the
 *  renderer plain numbers; the renderer only reads them. */
export interface WrappingDrawEntry {
  /** Stable for the life of the wrapping. Keys the framebuffer. */
  id: string
  /** The art. Keys the texture triple, and `materialFor` hashes it. */
  url: string
  material: WrappingMaterial
  /** The sway phase. `wrappingPhase(index)` gives the usual spacing. */
  phase: number
  place: WrappingPlacement
  /** The break, 0..1. */
  brk: number
  /** Where the press landed, in the wrapping's own uv space. */
  hit: readonly [number, number]
  /** Freeze the sway; the wrapping still draws. For reduced motion (no caller
   *  sets it yet). */
  still?: boolean
  /** The arrival, 0..1. It scales the DRAWN quad and nothing else: the render
   *  target keeps the full size throughout, so a wrapping that is still growing
   *  neither rebuilds its framebuffer per frame nor needs a re-shade. Values
   *  over 1 are the overshoot of the entrance curve. Default 1. */
  grow?: number
  /** The wrapping is under an animation. Re-shade every frame, or the highlight
   *  lags the outline — that is what the shimmer during placement was. */
  moving?: boolean
  /** Overrides the idle sway. For a still-frame comparison, and for any caller
   *  that wants to drive the tilt itself. */
  tilt?: readonly [number, number]
}

/** What one item's textures cost the GPU, kept per art URL. */
interface WrappingTextures {
  sdf: WebGLTexture
  item: WebGLTexture
  col: WebGLTexture
  bbox: readonly [number, number, number, number]
}

/** Per-wrapping state: the render target and everything the shade gate compares. */
interface WrappingState {
  fb: WebGLFramebuffer | null
  tex: WebGLTexture | null
  /** The framebuffer side, in device pixels. 0 means none yet. */
  size: number
  shadedAt: number
  shadedBrk: number
  shadedTilt: [number, number]
  /** The low-passed sway. */
  tilt: [number, number]
  tiltInit: boolean
  /** The wall clock of the last frame this wrapping was seen in. */
  seenAt: number
  /** THE LAST BLIT'S GEOMETRY, in viewport CSS pixels. `hitUv` inverts it, so
   *  a press lands where the player pressed and not where the DOM box is.
   *  `quad` is 0 until the wrapping has been drawn once. */
  qcx: number
  qcy: number
  quad: number
  /** Radians, the angle the blit turned the quad by. */
  rot: number
  /** The `uZoom` the shade used. It maps the quad's uv onto the item's. */
  zoom: number
}

/** What the last `draw` did, for a host that logs or budgets frames. */
export interface WrappingDrawStats {
  /** False when the frame gate swallowed the call. */
  drew: boolean
  shades: number
  blits: number
  /** Entries skipped because their art has not been uploaded yet. */
  missing: number
}

const DEG = Math.PI / 180

export class WrappingRenderer {
  readonly canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext
  private prog: WebGLProgram
  private bprog: WebGLProgram
  private quad: WebGLBuffer
  private aPos: number
  private bPos: number
  private U: Record<string, WebGLUniformLocation | null> = {}
  private BU: Record<string, WebGLUniformLocation | null> = {}
  private noise: WebGLTexture
  private art = new Map<string, WrappingTextures>()
  private wrappings = new Map<string, WrappingState>()
  private lastDraw = 0
  private disposed = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    // `alpha` and `premultipliedAlpha` together with the blend below and the
    // shader's own `outC * outA`. See the header.
    // NO MSAA. The only geometry drawn here is the blit quads, and a shaded
    // wrapping is transparent at its quad's border (measured on the chest: alpha
    // 0 on every border texel at rest, in focus and through the shatter, bar one
    // shard frame), so the multisample buffer smoothed nothing. It was four more
    // copies of a full-screen canvas: ~18 MB at DPR 2.
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    }) as WebGLRenderingContext | null
    if (!gl) {
      markWrappingUnavailable('no webgl context')
      throw new Error('wrapping/WrappingRenderer: no webgl context')
    }
    this.gl = gl

    const prog = link(gl, SHELL_VS, SHELL_FS)
    const bprog = link(gl, BLIT_VS, BLIT_FS)
    if (!prog || !bprog) {
      markWrappingUnavailable('shader compile failed')
      throw new Error('wrapping/WrappingRenderer: shader compile failed')
    }
    this.prog = prog
    this.bprog = bprog

    const quad = gl.createBuffer()
    if (!quad) {
      markWrappingUnavailable('no vertex buffer')
      throw new Error('wrapping/WrappingRenderer: no vertex buffer')
    }
    this.quad = quad
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    this.aPos = gl.getAttribLocation(prog, 'aPos')
    this.bPos = gl.getAttribLocation(bprog, 'aPos')
    for (const n of SHELL_UNIFORMS) this.U[n] = gl.getUniformLocation(prog, n)
    for (const n of ['uTex', 'uAlpha', 'uCentre', 'uPxToClip', 'uHalfPx', 'uRot']) {
      this.BU[n] = gl.getUniformLocation(bprog, n)
    }

    gl.useProgram(prog)
    gl.uniform1i(this.U.uSDF, 0)
    gl.uniform1i(this.U.uItem, 1)
    gl.uniform1i(this.U.uCol, 2)
    gl.uniform1i(this.U.uNoise, 3)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)

    // One noise texture for every wrapping. Unit 3 MUST repeat, or the wobble and
    // the ripple streak at the quad edge.
    const noise = this.mkTex(3, gl.REPEAT)
    if (!noise) {
      markWrappingUnavailable('no noise texture')
      throw new Error('wrapping/WrappingRenderer: no noise texture')
    }
    this.noise = noise
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 128, 128, 0, gl.RGBA, gl.UNSIGNED_BYTE, noiseTex(128, 10))
  }

  /** Upload one item's textures. Idempotent per URL, so every consumer of the
   *  same art shares one triple. `fields` and `image` both come from
   *  `fieldCache.ensureFields`. */
  upload(url: string, fields: WrappingFields, image: TexImageSource): void {
    if (this.disposed || this.art.has(url)) return
    const gl = this.gl
    const sdf = this.mkTex(0)
    const col = this.mkTex(2)
    const item = this.mkTex(1)
    if (!sdf || !col || !item) return

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, sdf)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, FIELD_N, FIELD_N, 0, gl.RGBA, gl.UNSIGNED_BYTE, fields.sdf)

    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, col)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, COLOUR_N, COLOUR_N, 0, gl.RGBA, gl.UNSIGNED_BYTE, fields.colour)

    // FLIP_Y, because `buildFields` writes its rows bottom-up to match. Change
    // one and you must change the other.
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, item)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)

    this.art.set(url, { sdf, item, col, bbox: fields.bbox })
  }

  /** True when this art is ready to draw. */
  has(url: string): boolean {
    return this.art.has(url)
  }

  /** Draw every entry.
   *
   *  `nowMs` is the CONTENT clock, in `performance.now()` milliseconds: it
   *  drives `uTime` and the sway. Freeze it and the picture freezes. The shade
   *  gate reads the wall clock separately, so a frozen content clock still
   *  re-shades when the material changes. */
  draw(entries: readonly WrappingDrawEntry[], nowMs: number): WrappingDrawStats {
    const stats: WrappingDrawStats = { drew: false, shades: 0, blits: 0, missing: 0 }
    if (this.disposed) return stats
    const gl = this.gl
    const wall = performance.now()
    // The wrappings are fill-rate bound. 60 Hz is the cap, not the target.
    if (wall - this.lastDraw < BASE.frameMs) return stats
    const dtMs = this.lastDraw ? Math.min(120, wall - this.lastDraw) : 16
    this.lastDraw = wall
    stats.drew = true

    // ONE layout read for the whole frame. Everything after this writes.
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.min(BASE.maxDpr, window.devicePixelRatio || 1)
    const W = Math.max(1, Math.round(rect.width * dpr))
    const H = Math.max(1, Math.round(rect.height * dpr))
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W
      this.canvas.height = H
    }
    gl.viewport(0, 0, W, H)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const time = nowMs / 1000

    for (const e of entries) {
      // Touch the state of EVERY listed wrapping, drawn or not. A wrapping held at
      // zero opacity through a swirl must not have its target evicted and
      // rebuilt on the next frame it shows.
      const known = this.wrappings.get(e.id)
      if (known) known.seenAt = wall
      const art = this.art.get(e.url)
      if (!art) {
        stats.missing++
        continue
      }
      const p = e.place
      if (!(p.size > 0) || !(p.opacity > 0.001)) continue

      // ---- the quad -------------------------------------------------------
      // The quad opens while the shards fly, so they have room, then closes
      // again. `uZoom` maps the wrapping back into the middle of the larger quad;
      // a constant `uZoom` with a growing quad drifts the wrapping off centre.
      const brk = Math.min(1, Math.max(0, e.brk))
      const span = Math.max(art.bbox[2] - art.bbox[0], art.bbox[3] - art.bbox[1])
      if (!(span > 0)) continue
      const bump = Math.sin(Math.PI * brk)
      const zoom = BASE.pad * (1 + BASE.expand * e.material.shardSpread * bump)
      // The FULL quad sizes the render target. The arrival scales only what is
      // drawn, so the target is allocated once at the size the wrapping settles
      // at and the growing frames cost no reallocation.
      const full = (p.size * BASE.fit * zoom) / span
      const grow = e.grow === undefined ? 1 : e.grow
      const quad = full * grow
      if (!(quad > 1) || !isFinite(quad)) continue

      // The mask centre inside the quad, after `uZoom`. uv v grows upwards, so
      // the screen offset negates it.
      const mcx = 0.5 + ((art.bbox[0] + art.bbox[2]) / 2 - 0.5) / zoom
      const mcy = 0.5 + ((art.bbox[1] + art.bbox[3]) / 2 - 0.5) / zoom
      const rot = p.rotation * DEG
      // The placement rotates about the ITEM centre, not the quad centre. So
      // rotate the quad-centre offset by the same angle and the two agree.
      const ox = (0.5 - mcx) * quad
      const oy = -(0.5 - mcy) * quad
      const cr = Math.cos(rot)
      const sr = Math.sin(rot)
      const qcx = p.cx + (ox * cr - oy * sr)
      const qcy = p.cy + (ox * sr + oy * cr)

      // OFF THE CANVAS, NOTHING TO SHADE. A focus zoom throws the other pieces
      // far out of frame at the zoomed size, and shading each would cost a
      // 1024-px target (4 MB) nobody sees. A known wrapping keeps its
      // target (touched above), so it comes back without a rebuild.
      const reach = (quad / 2) * Math.SQRT2
      if (
        qcx + reach < rect.left ||
        qcx - reach > rect.right ||
        qcy + reach < rect.top ||
        qcy - reach > rect.bottom
      ) {
        continue
      }

      const st = this.stateFor(e.id)
      st.seenAt = wall

      // ---- the tilt -------------------------------------------------------
      const target = e.tilt ?? idleTilt(e.still ? 0 : time, e.phase)
      if (e.tilt || !st.tiltInit) {
        st.tilt[0] = target[0]
        st.tilt[1] = target[1]
        st.tiltInit = true
      } else {
        const k = 1 - Math.exp(-dtMs / BASE.tiltTau)
        st.tilt[0] += (target[0] - st.tilt[0]) * k
        st.tilt[1] += (target[1] - st.tilt[1]) * k
      }

      // ---- shade ----------------------------------------------------------
      // Supersample: shade larger than the quad and let the blit average it
      // down. The sparkle is born in the analytic terms, so more samples per
      // output pixel is the direct cure. Mipmaps did nothing here.
      this.ensureTarget(st, full * dpr * BASE.ssaa)
      if (!st.tex || !st.fb) continue
      const moved =
        Math.abs(st.tilt[0] - st.shadedTilt[0]) + Math.abs(st.tilt[1] - st.shadedTilt[1]) > 0.02
      if (e.moving || brk !== st.shadedBrk || moved || wall - st.shadedAt > BASE.shadeMs) {
        st.shadedAt = wall
        st.shadedBrk = brk
        st.shadedTilt[0] = st.tilt[0]
        st.shadedTilt[1] = st.tilt[1]
        this.shade(st, art, e, time, zoom)
        stats.shades++
        gl.viewport(0, 0, W, H)
      }

      // ---- blit -----------------------------------------------------------
      // Keep the geometry this frame drew. `hitUv` inverts it to turn a press
      // into uv, and the quad is the only thing that knows the fit, the zoom
      // and the mask offset.
      st.qcx = qcx
      st.qcy = qcy
      st.quad = quad
      st.rot = rot
      st.zoom = zoom
      gl.useProgram(this.bprog)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
      gl.enableVertexAttribArray(this.bPos)
      gl.vertexAttribPointer(this.bPos, 2, gl.FLOAT, false, 0, 0)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, st.tex)
      gl.uniform1i(this.BU.uTex, 0)
      gl.uniform1f(this.BU.uAlpha, Math.min(1, p.opacity))
      // The quad centre in clip space, and the pixel-to-clip scale that keeps
      // the rotation square on a canvas that is not.
      const cxPx = (qcx - rect.left) * dpr
      const cyPx = (qcy - rect.top) * dpr
      gl.uniform2f(this.BU.uCentre, (2 * cxPx) / W - 1, 1 - (2 * cyPx) / H)
      gl.uniform2f(this.BU.uPxToClip, 2 / W, -2 / H)
      gl.uniform1f(this.BU.uHalfPx, (quad * dpr) / 2)
      gl.uniform1f(this.BU.uRot, rot)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      stats.blits++
    }

    this.evict(wall)
    return stats
  }

  /** Turn a viewport point into one wrapping's own uv space — what `uHit` wants,
   *  so the shards fly from the point the player pressed.
   *
   *  IT INVERTS THE LAST BLIT, not the anchor's DOM box. The two are different
   *  rectangles: the quad is `BASE.fit`, `uZoom` and the item's own bounding
   *  box wide, the blit turns it by the placement's rotation, and the item sits
   *  off the quad centre by the mask offset. A rect answers none of that.
   *
   *  The answer is in the ITEM's uv, the shader's `vUvz`, so it does not drift
   *  as the quad opens under the break.
   *
   *  Returns null for a wrapping that has not been drawn yet. */
  hitUv(id: string, clientX: number, clientY: number): readonly [number, number] | null {
    const st = this.wrappings.get(id)
    if (!st || !(st.quad > 0)) return null
    const dx = clientX - st.qcx
    const dy = clientY - st.qcy
    // `BLIT_VS` turns a y-down local offset by [[c,-s],[s,c]]. This is that
    // matrix inverted.
    const c = Math.cos(st.rot)
    const s = Math.sin(st.rot)
    const lx = dx * c + dy * s
    const ly = -dx * s + dy * c
    // The blit negates `aPos.y`, so uv v grows upwards on the screen.
    const u = 0.5 + lx / st.quad
    const v = 0.5 - ly / st.quad
    return [(u - 0.5) * st.zoom + 0.5, (v - 0.5) * st.zoom + 0.5]
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    for (const st of this.wrappings.values()) {
      if (st.tex) gl.deleteTexture(st.tex)
      if (st.fb) gl.deleteFramebuffer(st.fb)
    }
    this.wrappings.clear()
    for (const a of this.art.values()) {
      gl.deleteTexture(a.sdf)
      gl.deleteTexture(a.item)
      gl.deleteTexture(a.col)
    }
    this.art.clear()
    gl.deleteTexture(this.noise)
    gl.deleteBuffer(this.quad)
    gl.deleteProgram(this.prog)
    gl.deleteProgram(this.bprog)
    // A context that only drops its reference can sit alive for a while, and
    // browsers cap live contexts. Hand it back at once.
    const lose = gl.getExtension('WEBGL_lose_context')
    if (lose) lose.loseContext()
  }

  // -------------------------------------------------------------------------

  private stateFor(id: string): WrappingState {
    let st = this.wrappings.get(id)
    if (!st) {
      st = {
        fb: null,
        tex: null,
        size: 0,
        shadedAt: -1e9,
        shadedBrk: -1,
        shadedTilt: [9, 9],
        tilt: [0, 0],
        tiltInit: false,
        seenAt: 0,
        qcx: 0,
        qcy: 0,
        quad: 0,
        rot: 0,
        zoom: 1,
      }
      this.wrappings.set(id, st)
    }
    return st
  }

  /** Drop the target of any wrapping that has not been drawn for a second. A
   *  framebuffer per wrapping is the memory here, and the shelf swaps wrappings. */
  private evict(wall: number): void {
    for (const [id, st] of this.wrappings) {
      if (wall - st.seenAt < 1000) continue
      if (st.tex) this.gl.deleteTexture(st.tex)
      if (st.fb) this.gl.deleteFramebuffer(st.fb)
      this.wrappings.delete(id)
    }
  }

  private mkTex(unit: number, wrap?: number): WebGLTexture | null {
    const gl = this.gl
    const t = gl.createTexture()
    if (!t) return null
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap ?? gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap ?? gl.CLAMP_TO_EDGE)
    return t
  }

  /** The per-wrapping render target. EXACT pixel size, no power-of-two rounding:
   *  a framebuffer with clamp, linear filtering and no mips does not need it,
   *  and rounding down made the cached wrapping blurrier than the quad it fills. */
  private ensureTarget(st: WrappingState, px: number): void {
    const gl = this.gl
    const size = Math.round(Math.max(32, Math.min(BASE.cacheMax, px)))
    if (st.tex && st.size === size) return
    if (st.tex) gl.deleteTexture(st.tex)
    if (st.fb) gl.deleteFramebuffer(st.fb)
    st.tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, st.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    st.fb = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, st.tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    st.size = size
    st.shadedBrk = -1
  }

  private shade(
    st: WrappingState,
    art: WrappingTextures,
    e: WrappingDrawEntry,
    time: number,
    zoom: number,
  ): void {
    const gl = this.gl
    const M = e.material
    const S = BASE.effectScale
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.fb)
    gl.viewport(0, 0, st.size, st.size)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.enableVertexAttribArray(this.aPos)
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, art.sdf)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, art.item)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, art.col)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.noise)

    const U = this.U
    gl.uniform1f(U.uTime, time)
    gl.uniform1f(U.uInflate, M.inflate)
    gl.uniform1f(U.uSmooth, M.smooth)
    gl.uniform1f(U.uEdge, M.edge)
    gl.uniform1f(U.uDome, M.dome)
    gl.uniform1f(U.uRelief, M.relief)
    gl.uniform1f(U.uBump, M.bump)
    gl.uniform1f(U.uRefract, M.refract * S)
    gl.uniform1f(U.uChroma, M.chroma * S)
    gl.uniform1f(U.uOpacity, M.opacity)
    gl.uniform1f(U.uBlurMix, M.blurMix)
    gl.uniform1f(U.uSatCut, M.satCut)
    gl.uniform1f(U.uBlue, M.blue)
    gl.uniform1f(U.uFres, M.fres)
    gl.uniform1f(U.uSpec, M.spec)
    gl.uniform1f(U.uSweep, M.sweep)
    gl.uniform1f(U.uMode, M.mode)
    gl.uniform1f(U.uCells, M.cells)
    gl.uniform1f(U.uAmp, M.amp)
    gl.uniform1f(U.uScale, M.scale / S)
    gl.uniform1f(U.uSpeed, M.speed)
    gl.uniform1f(U.uShatterSpin, M.shatterSpin)
    gl.uniform1f(U.uGlowMix, M.glowMix)
    gl.uniform1f(U.uGlowGain, M.glowGain)
    gl.uniform1f(U.uGlowFall, M.glowFall)
    gl.uniform1f(U.uRipple, M.ripple)
    gl.uniform1f(U.uZoneLo, M.zoneLo)
    // The zone bands widen with the scale, so speckle turns into regions.
    gl.uniform1f(U.uZoneHi, Math.min(1, M.zoneLo + (M.zoneHi - M.zoneLo) * S))
    gl.uniform1f(U.uZoneSpec, M.zoneSpec)
    gl.uniform1f(U.uZoneChroma, M.zoneChroma)
    gl.uniform1f(U.uZoneSharp, M.zoneSharp)
    gl.uniform1f(U.uShardSpread, M.shardSpread)
    gl.uniform1f(U.uCrackLight, M.crackLight)
    gl.uniform1f(U.uCrackDark, M.crackDark)
    gl.uniform1f(U.uTri, M.tri)
    gl.uniform1f(U.uBreak, Math.min(1, Math.max(0, e.brk)))
    gl.uniform1f(U.uZoom, zoom)
    gl.uniform2f(U.uTilt, st.tilt[0], st.tilt[1])
    gl.uniform2f(U.uHit, e.hit[0], e.hit[1])
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }
}

function link(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc)
  if (!vs || !fs) return null
  const p = gl.createProgram()
  if (!p) return null
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  // The shaders are attached to the program, which keeps them alive; the
  // objects themselves are dead weight once linked.
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('[wrapping] link failed:', gl.getProgramInfoLog(p))
    gl.deleteProgram(p)
    return null
  }
  return p
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type)
  if (!s) return null
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('[wrapping] compile failed:', gl.getShaderInfoLog(s))
    gl.deleteShader(s)
    return null
  }
  return s
}
