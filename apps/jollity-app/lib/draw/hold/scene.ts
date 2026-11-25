// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable */
// @ts-nocheck
/**
 * THE HOLD — from the draw's ending to the collectables, with no button.
 * LOGIC ONLY, no React (architecture rule 6): components/draw/hold-to-collectables
 * hosts it and forwards the finger.
 *
 * The draw page's part:
 *
 *  prize  a win: the hold waits while the draw goes back to the wheel by
 *         itself (autoBackToWheel, below: the page runs it whatever its way
 *         on), so every ending, a win, a loss, a draw watched, is the whole
 *         wheel when the hold begins.
 *  ready  the wheel, after the draw (its Continue is not shown). A pulsing
 *         ring and HOLD ANYWHERE, low on the screen. The wheel is there to
 *         look round meanwhile (./look): a tap picks a ticket and says whose
 *         it is, two fingers or a double tap zoom, one finger moves it while
 *         zoomed in. A press becomes the hold only once it has been still for
 *         HOLD_DELAY_MS, so a tap never flashes the bubble. The draw's
 *         timeline, along the bottom, takes the player back to any point of
 *         the spin (components/draw/draw-timeline, `scrubbed`): the picture
 *         read ahead goes, and is read again once the wheel is still.
 *  hold   press and hold anywhere, 1.5 × HOLD_MS. The draw's frame (read
 *         ahead, PREREAD_MS after it ended, so the press only swaps pictures)
 *         is read off the stage's own canvases, and every piece in it (the
 *         tickets, the winners, your disc, and the prize coin) is taken off
 *         the live picture. A bubble forms above the finger and trails it,
 *         growing as it fills. The draw's picture, tickets and all, drains
 *         into it like water down a plughole (./warp, on the GPU; square by
 *         square where that cannot run), nearest first, and the tickets the
 *         bubble keeps show up circling inside as their places go in. Begun
 *         zoomed in, the wheel eases back out to the whole of it first.
 *         Light gathers round it, the room's dust clears where it is, and
 *         the draw's words fade first. A ring shows how far, gold once it
 *         will finish by itself (COMMIT). Let go short and it all goes back,
 *         and the live draw is back.
 *  rise   done: the bubble glides (RISE_S) to where the collectables' bubble
 *         blows up, the pieces circling in it, as the draw fades and the
 *         collectables' room (under the stage) shows. Then onRisen hands
 *         the bubble over (lib/collectables-scene/carry) and the page goes on.
 *
 * The collectables' part (each claim lit from a share of the pieces, the
 * swell, the pop) is the collectables engine's (lib/collectables-scene/engine `carried`).
 *
 * Kept untyped, like the collectables engine: a frame loop over plain numbers.
 *
 * API: createHoldScene(canvas, { stage, hintEl, onRisen, onPick, onBusy, onPhase, hint }) ->
 *   { pointerDown(id, x, y), pointerMove(id, x, y), pointerUp(id), zoomBy(k),
 *     zoomOut(), zoomed(), skip(), progress(), canScrub(), scrubbed(), destroy() };
 *   autoBackToWheel(stage) -> stop (a win, back to the wheel by itself)
 */

import { PRIZE } from "../wheel/proto/render-utils/prize/config.js"
import { drawStars } from "../../collectables-scene/stars"
import { exploreOf } from "../wheel/explore"
import { createLook } from "./look"
import { createWarp, drainPoint } from "./warp"
import { bPath, conicG, FILM, jelly, orb, PIECE_R, refl, stepJelly } from "./film"

const HOLD_MS = 1000      // the hold takes 1.5 × this
const DRAIN_MS = 800      // letting go drains it this fast
const LIFT = 96           // the bubble forms this far above the finger, px
const RISE_S = 1.3        // the glide to the collectables' spot
const COMMIT = 0.85       // held this far, it finishes by itself: let go and it still goes on
const DONE = 0.985        // …and at this it is done, and glides
const R_FROM = 14         // the bubble's radius as the hold starts, and full (px on a 390-wide screen)
const R_FULL = 62
const TILE = 10           // the draw's picture is pulled in in squares this big, px
const TILE_DARK = 20      // a square no brighter than this is the dark, and stays
const KEEP_IN = 80       // at most this many pieces stay circling in the bubble (yours and the winners first); the rest melt into it as they arrive
const HOLD_DELAY_MS = 200 // a press held still this long is the hold; let go sooner and it was a tap (lib/draw/hold/look)
const SLOP = 8            // a finger that moves less than this has not moved, px
const VIEW_SETTLE_MS = 600 // the wheel back at its whole with no picture of it yet: read once it has been still this long
const HOLD_ZOOM_OUT_MS = 900 // a hold begun zoomed in: the wheel eases back out to the whole of it over this long, the drain coming in as it does
const ORBIT_SPEED = 0.22  // how fast they circle, rad/s, all alike
const PREREAD_MS = 2500   // the draw's frame is read this long after the hold is ready, in idle time: a press then only swaps pictures
/* A WIN GOES BACK TO THE WHEEL BY ITSELF (autoBackToWheel), so every way
   into the collectables starts from the same picture, the whole wheel, and
   the draw has no Back to the wheel to press (stage.css hides it). The coin
   goes with the discs round it: the moment they burst off it (the draw's own
   PRIZE.discBurstAtMs from the prize's start), the draw's Back to the wheel
   is pressed for the player, so as they fly off and fade the coin flicks
   back onto their disc, and the wheel comes back where the spin left it,
   zoomed in. BACK_SETTLE_MS after the prize has gone their disc is tapped
   for them (the draw's own: a ticket tapped while zoomed in) and the wheel
   zooms out to the whole of it, done ZOOM_OUT_MS after */
const BURST_MS = PRIZE.confetti ? (PRIZE.confettiKind === "discs" ? PRIZE.discBurstAtMs : PRIZE.confettiAtMs) : PRIZE.chipAtMs + PRIZE.textFadeMs
const BACK_SETTLE_MS = 800
const ZOOM_OUT_MS = 700
const DISC_TRIES = 4       // the player's disc not found (still landing): looked for again, this often…
const DISC_RETRY_MS = 300  // …this far apart
/* where the collectables' bubble blows up on a 390 × 844 phone (where the
   collectables engine blows it up): the engine glides the rest of the way on any other screen */
const SPOT = { x: 195 / 390, y: 361 / 844 }
const R0_390 = 47
/* what counts as a piece of the draw: a blob that stands out from what is
   around it (brighter than LIFT_DIM by CONTRAST over the mean of a window
   AROUND px in reach, so a dim grey ticket counts and the wheel's smooth glow
   does not), of at least MIN_PIECE px² (smaller: the hub's lettering,
   specks) and at most MAX_PIECE (bigger: the scene itself). The prize is
   found on the WebGL layer as the one big round thing brighter than BRIGHT. */
const BRIGHT = 60
const LIFT_DIM = 28
const CONTRAST = 14
const AROUND = 24
const MIN_PIECE = 30
const MAX_PIECE = 2500

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const c01 = (v) => clamp(v, 0, 1)
const ease = (x) => 1 - Math.pow(1 - c01(x), 3)
const smooth = (x) => { x = c01(x); return x * x * (3 - 2 * x); }
const quint = (x) => { x = c01(x); return x * x * x * (x * (6 * x - 15) + 10); }
const seg = (t, a, b) => c01((t - a) / (b - a))
const lerp = (a, b, k) => a + (b - a) * k
function rng(seed) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }
const rgbStr = (c) => `rgb(${c[0]},${c[1]},${c[2]})`
/** seconds, on the clock the collectables engine reads too, so the swirl carries on across the hand-off */
const nowS = () => performance.now() / 1000

/** the brightest colour at a point of the picture (`px`: its pixels, read once), as [r, g, b] */
function colourAt(px, w, h, dpr, x, y) {
  const cx = Math.round(x * dpr), cy = Math.round(y * dpr)
  let best = [200, 200, 200], m = -1
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const qx = cx + dx, qy = cy + dy
    if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue
    const i = (qy * w + qx) * 4, v = Math.max(px[i], px[i + 1], px[i + 2])
    if (v > m) { m = v; best = [px[i], px[i + 1], px[i + 2]]; }
  }
  return best
}
function dotCss(g, x, y, r, css, a) {
  if (a <= 0.005 || r <= 0.1) return
  g.globalAlpha = a; g.fillStyle = css; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1
}

/* ── reading the draw: its picture, and the pieces in it ── */
/** every blob in a canvas: brighter than BRIGHT, or (`contrast`) standing
 *  out from what is around it. `unit`: css px per canvas px */
function blobs(cv, contrast = false, unit = 1) {
  const W = cv.width, H = cv.height
  const d = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data
  const L = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) L[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) * (d[i * 4 + 3] / 255)
  const on = new Uint8Array(W * H)
  if (contrast) {
    // the mean around each pixel, from an integral image
    const S = new Float64Array((W + 1) * (H + 1))
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += L[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
    const r = Math.max(2, Math.round(AROUND / unit))
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (L[i] <= LIFT_DIM) continue
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1)
      const mean = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0))
      if (L[i] - mean > CONTRAST) on[i] = 1
    }
  } else for (let i = 0; i < W * H; i++) if (L[i] > BRIGHT) on[i] = 1
  const seen = new Uint8Array(W * H), out = [], stack = []
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || !on[s]) continue
    let n = 0, sx = 0, sy = 0, sr = 0, sg = 0, sb = 0, x0 = W, x1 = 0, y0 = H, y1 = 0
    stack.push(s); seen[s] = 1
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p / W) | 0
      n++; sx += x; sy += y; sr += d[p * 4]; sg += d[p * 4 + 1]; sb += d[p * 4 + 2]
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      if (x > 0 && !seen[p - 1] && on[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && !seen[p + 1] && on[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !seen[p - W] && on[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && !seen[p + W] && on[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1
    out.push({ n: n * unit * unit, x: (sx / n + 0.5) * unit, y: (sy / n + 0.5) * unit, bw: bw * unit, bh: bh * unit, fill: n / (bw * bh), col: [sr / n, sg / n, sb / n].map(Math.round) })
  }
  return out
}
const isPiece = (b) => b.n >= MIN_PIECE && b.n <= MAX_PIECE && b.fill >= 0.45
/** the stage's canvases, in the order they paint: their z-index, then the page's order */
function stageCanvases(stage) {
  const app = stage.querySelector("#app")
  if (!app) return []
  return [...app.querySelectorAll("canvas")]
    .filter((c) => c.id !== "hold-draw" && c.id !== "slit-arrows" && c.width > 0 && c.height > 0)
    .map((c, i) => ({ c, i, z: parseInt(getComputedStyle(c).zIndex, 10) || 0, r: c.getBoundingClientRect(), op: parseFloat(getComputedStyle(c).opacity) || 1 }))
    .filter((l) => l.r.width > 0 && l.r.height > 0 && getComputedStyle(l.c).visibility !== "hidden")
    .sort((a, b) => a.z - b.z || a.i - b.i)
}
/* the draw's frame, copied in the next animation frame, after the stage has
   drawn it (its WebGL canvas keeps its picture only until the frame is
   shown): pictures only, cheap. Finding the pieces in them is later, in steps
   (findPieces), so no one frame carries it */
function captureDraw(stage, done) {
  // a stage at rest draws nothing; it is asked for a few frames, and read once it has drawn one
  stage.querySelector("#app")?.dispatchEvent(new CustomEvent("jollity:stage-poke", { detail: 4, bubbles: true }))
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const W = innerWidth, H = innerHeight, dpr = Math.min(2, devicePixelRatio || 1)
    const pic = document.createElement("canvas"); pic.width = Math.round(W * dpr); pic.height = Math.round(H * dpr)
    const pg = pic.getContext("2d", { willReadFrequently: true })
    pg.fillStyle = getComputedStyle(stage).backgroundColor || "#000"; pg.fillRect(0, 0, pic.width, pic.height)
    const layers = stageCanvases(stage).map((l) => {
      pg.globalAlpha = l.op
      pg.drawImage(l.c, l.r.left * dpr, l.r.top * dpr, l.r.width * dpr, l.r.height * dpr)
      pg.globalAlpha = 1
      const one = document.createElement("canvas"); one.width = W; one.height = H
      one.getContext("2d", { willReadFrequently: true }).drawImage(l.c, l.r.left, l.r.top, l.r.width, l.r.height)
      // the WebGL layer's own pixels, for the prize's picture
      let own = null
      if (l.c.id === "gl") { own = document.createElement("canvas"); own.width = l.c.width; own.height = l.c.height; own.getContext("2d").drawImage(l.c, 0, 0); }
      return { id: l.c.id, r: l.r, one, own }
    })
    // every ticket, where the stage draws it in this same frame (lib/draw/wheel/explore)
    const tickets = exploreOf(stage)?.tickets() ?? null
    done({ pic, dpr, layers, tickets })
  }))
}
/* the pieces in a captured frame, one layer a step (`step` runs each: in idle
   time, or at once) */
function findPieces(cap, step, done) {
  const { dpr } = cap
  const pieces = []
  let coin = null, i = 0, ticketsIn = false
  const next = () => step(() => {
    const l = cap.layers[i++]
    if (l) {
      // the prize: the one big round thing on the WebGL layer
      if (l.own) for (const b of blobs(l.one)) {
        if (b.n > MAX_PIECE && Math.abs(b.bw - b.bh) < 0.2 * Math.max(b.bw, b.bh)) {
          const r = Math.max(b.bw, b.bh) / 2 + 2, sx = l.own.width / l.r.width, sy = l.own.height / l.r.height
          const img = document.createElement("canvas"); img.width = img.height = Math.ceil(r * 2 * dpr)
          const ig = img.getContext("2d")
          ig.beginPath(); ig.arc(img.width / 2, img.height / 2, r * dpr, 0, Math.PI * 2); ig.clip()
          ig.drawImage(l.own, (b.x - r - l.r.left) * sx, (b.y - r - l.r.top) * sy, 2 * r * sx, 2 * r * sy, 0, 0, img.width, img.height)
          coin = { x: b.x, y: b.y, r, img }
        }
      }
      // the pieces: every ticket on the screen, where the stage says it is; a
      // stage that cannot say has them found in its picture
      if (!cap.tickets) for (const b of blobs(l.one, true)) if (isPiece(b)) pieces.push(b)
    }
    if (!ticketsIn && cap.tickets) {
      ticketsIn = true
      for (const t of cap.tickets) {
        if (t.x < -t.r || t.y < -t.r || t.x > innerWidth + t.r || t.y > innerHeight + t.r) continue
        pieces.push({ n: Math.PI * t.r * t.r, x: t.x, y: t.y, bw: 2 * t.r, bh: 2 * t.r, fill: 1, col: null, won: t.won, you: t.you })
      }
    }
    if (i < cap.layers.length) return next()
    // inside the coin's disc (its lettering) is the coin, not pieces
    done({ pic: cap.pic, dpr, pieces: coin ? pieces.filter((p) => Math.hypot(p.x - coin.x, p.y - coin.y) > coin.r) : pieces, coin })
  })
  next()
}
const now = (fn) => fn()
const inIdle = (fn) => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 16))
/** the colour around a spot, to paint over the piece that leaves it (`px`: the picture's pixels, read once) */
function around(pic, px, dpr, x, y, r) {
  let sr = 0, sg = 0, sb = 0, n = 0
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2, qx = Math.round((x + Math.cos(a) * (r + 4)) * dpr), qy = Math.round((y + Math.sin(a) * (r + 4)) * dpr)
    if (qx < 0 || qy < 0 || qx >= pic.width || qy >= pic.height) continue
    const i = (qy * pic.width + qx) * 4; sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; n++
  }
  return n ? `rgb(${Math.round(sr / n)},${Math.round(sg / n)},${Math.round(sb / n)})` : "#000"
}

/** the player's disc in a captured frame, the wheel zoomed in on it: the
 *  biggest round thing near the top middle, whatever the screen's size */
function findDisc(cap) {
  let best = null
  for (const l of cap.layers) for (const b of blobs(l.one, true)) {
    const round = Math.abs(b.bw - b.bh) < 0.3 * Math.max(b.bw, b.bh) && b.fill >= 0.55 && b.n >= MIN_PIECE * 3
    if (!round || b.y > innerHeight * 0.6 || Math.abs(b.x - innerWidth / 2) > innerWidth * 0.3) continue
    if (!best || b.n > best.n) best = b
  }
  return best
}

/**
 * A win, back to the wheel by itself (see BURST_MS): watches the stage
 * while it is up, whatever the page's way on (the hold, or a stage that
 * failed and the page's own Continue). The stage says what it is doing in
 * `data-wheel`: "going" while it works, "back" when the whole wheel is up, so
 * the hold can wait for it. Returns the stop.
 */
export function autoBackToWheel(stage) {
  let raf = 0, dead = false, prizeAt = -1, backAt = -1, goneAt = -1, outAsked = false, outAt = -1, tries = 0
  /* the player's disc, tapped for them: the wheel zooms out to the whole of
     it. The stage taps it where it draws it (lib/draw/wheel/mount
     STAGE_ZOOM_OUT); a stage that cannot say has it found in its picture */
  const tapDisc = () => {
    const ask = { done: false }
    stage.querySelector("#app")?.dispatchEvent(new CustomEvent("jollity:zoom-out", { detail: ask, bubbles: true }))
    if (ask.done) { outAt = performance.now(); return; }
    findAndTapDisc()
  }
  const findAndTapDisc = () => captureDraw(stage, (cap) => inIdle(() => {
    if (dead) return
    const disc = findDisc(cap)
    if (!disc && ++tries < DISC_TRIES) return void setTimeout(findAndTapDisc, DISC_RETRY_MS)
    if (disc) stage.querySelector("#app")?.dispatchEvent(new PointerEvent("pointerdown", { clientX: disc.x, clientY: disc.y, bubbles: true, isPrimary: true }))
    outAt = performance.now()
  }))
  const tick = (now) => {
    if (dead) return
    raf = requestAnimationFrame(tick)
    const prizeUp = !!stage.querySelector("#app.flow-prize-up")
    // the prize is up: the wheel is on its way back
    if (prizeUp && prizeAt < 0 && backAt < 0) { prizeAt = now; stage.dataset.wheel = "going"; }
    // the discs burst off the coin: the coin goes with them
    if (prizeAt >= 0 && backAt < 0 && now - prizeAt >= BURST_MS) { backAt = now; stage.querySelector("#flow-back")?.click(); }
    if (backAt >= 0 && !prizeUp && goneAt < 0) goneAt = now
    // the wheel is back, zoomed in on the player's disc
    if (goneAt >= 0 && !outAsked && now - goneAt >= BACK_SETTLE_MS) { outAsked = true; tapDisc(); }
    if (outAt >= 0 && now - outAt >= ZOOM_OUT_MS) {
      stage.dataset.wheel = "back"
      // a new draw on this stage (a replay) starts over
      prizeAt = backAt = goneAt = outAt = -1; outAsked = false; tries = 0
    }
  }
  raf = requestAnimationFrame(tick)
  return () => { dead = true; cancelAnimationFrame(raf); }
}

export function createHoldScene(canvas, opts = {}) {
  const stage = opts.stage
  const ctx = canvas.getContext("2d")
  // nothing to draw with (a test's DOM): nothing to run
  if (!ctx || !stage) return { pointerDown() {}, pointerMove() {}, pointerUp() {}, zoomBy() {}, zoomOut() {}, zoomed: () => false, skip() {}, progress: () => 0, canScrub: () => false, scrubbed() {}, destroy() {} }
  let W = 0, H = 0, DPR = 1
  function resize() {
    DPR = Math.min(2, devicePixelRatio || 1)
    W = innerWidth; H = innerHeight
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
  }
  /* THE DRAIN: the draw's picture, sucked into the bubble on the GPU (./warp),
     on a canvas of its own just under this one; where it cannot run, the
     picture is pulled in square by square on this canvas instead */
  const glc = document.createElement("canvas")
  glc.setAttribute("aria-hidden", "true")
  glc.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:" + (getComputedStyle(canvas).zIndex || "50")
  canvas.parentNode?.insertBefore(glc, canvas)
  const warp = createWarp(glc)
  // the GPU layer is on the screen only while it has something on it: an empty full-screen layer still costs the compositor
  glc.style.visibility = "hidden"
  let glShown = false
  const showGl = (on) => { if (on !== glShown) { glShown = on; glc.style.visibility = on ? "visible" : "hidden"; } }
  const resizeAll = () => { resize(); warp.resize(W, H, DPR); }
  resizeAll()
  addEventListener("resize", resizeAll)
  canvas.dataset.scenes = String((parseInt(canvas.dataset.scenes, 10) || 0) + 1)

  const s = {
    phase: "prize", p: 0, v: 0, vVel: 0, holding: false, f: { x: W / 2, y: H * 0.73 }, prizeAt: 0, pFrom: 0, since: 0, riseAt: 0,
    bp: null, b: jelly(), S: null, live: null, reading: false, T: 0, from: null, rFrom: 0, r: 0, risen: false, dt: 1 / 60,
    readyAt: 0, full: false, gen: 0,
  }
  const spot = () => ({ x: W * SPOT.x, y: H * SPOT.y })
  const R0 = () => R0_390 * W / 390
  const unit = () => W / 390

  /* the draw's look as it goes: its words fade on their own (stage.css
     [data-holding], --hold-text) as the hold fills, and in the glide the
     stage as a whole fades (an opacity: the compositor's, no repaint), so the
     collectables' room under it is what shows */
  function look(alpha, text) {
    stage.style.opacity = alpha >= 1 ? "" : String(alpha)
    stage.style.setProperty("--hold-text", String(text))
  }
  function unlook() {
    stage.style.opacity = ""
    stage.style.removeProperty("--hold-text")
  }

  /* the draw's frame, ready for the hold: its pieces, their pixels, the
     picture without them, and that picture's squares that are not the dark.
     The expensive part, so it is done ahead (preread), and a press only swaps
     the live stage for it */
  function prepare({ pic, dpr, pieces, coin }) {
      const R = rng(7)
      const px = pic.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, pic.width, pic.height).data
      const dots = pieces.map((b, k) => {
        const col = b.col ?? colourAt(px, pic.width, pic.height, dpr, b.x, b.y)
        return { hx: b.x, hy: b.y, r: clamp(Math.sqrt(b.n / Math.PI), 1.2, 14), sr: Math.max(b.bw, b.bh) / 2 + 1, col, css: rgbStr(col), won: !!b.won, you: !!b.you, a: 1, k, seed: R(), sprite: null, keep: true }
      })
      // the bubble keeps yours, the winners' and enough of the rest to fill it; the others melt into it as they arrive
      dots.slice().sort((a, b) => Number(b.you) - Number(a.you) || Number(b.won) - Number(a.won) || a.seed - b.seed).forEach((d, i) => { d.keep = i < KEEP_IN; })
      // the picture without its pieces: each painted over with what is around it
      const bare = document.createElement("canvas"); bare.width = pic.width; bare.height = pic.height
      const bg = bare.getContext("2d"); bg.drawImage(pic, 0, 0)
      // the tickets stay in the picture: the drain takes them in with the rest of it
      if (coin) { bg.fillStyle = around(pic, px, dpr, coin.x, coin.y, coin.r); bg.beginPath(); bg.arc(coin.x * dpr, coin.y * dpr, (coin.r + 1) * dpr, 0, Math.PI * 2); bg.fill(); }
      // the squares the hold pulls in: those brighter than the dark (read off
      // the frame as it was, a few pixels apart; a piece's square is pulled
      // too, painted over)
      const tiles = [], every = Math.max(1, Math.round(2 * dpr)), pw = pic.width, ph = pic.height
      for (let ty = 0; ty < H; ty += TILE) for (let tx = 0; tx < W; tx += TILE) {
        let m = 0
        const y1 = Math.min(ph, Math.round((ty + TILE) * dpr)), x1 = Math.min(pw, Math.round((tx + TILE) * dpr))
        for (let yy = Math.round(ty * dpr); yy < y1 && m <= TILE_DARK; yy += every) for (let xx = Math.round(tx * dpr); xx < x1; xx += every) {
          const o = (yy * pw + xx) * 4; m = Math.max(m, px[o], px[o + 1], px[o + 2])
        }
        if (m > TILE_DARK) tiles.push({ x: tx + TILE / 2, y: ty + TILE / 2 })
      }
      return { dots, coin, bare, tiles, dpr }
  }
  /* THE DRAW'S WORDS (who's playing along the top, Not this time): the page's
     text, not in the picture. Each one, as it stands at the press, is taken
     to be drawn here and drained with the rest; the page's own then hide */
  function captureWords() {
    const app = stage.querySelector("#app")
    if (!app) return []
    const out = [], seen = new Map()
    const shownOf = (e) => {
      if (!e || e === stage) return 1
      if (seen.has(e)) return seen.get(e)
      const cs = getComputedStyle(e)
      const a = cs.visibility === "hidden" || cs.display === "none" ? 0 : (parseFloat(cs.opacity) || 0) * shownOf(e.parentElement)
      seen.set(e, a)
      return a
    }
    for (const el of app.querySelectorAll("*")) {
      if (el.tagName === "CANVAS") continue
      const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()
      if (!text) continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue
      // how much of it shows: its own opacity and every one round it, up to the stage (each element's worked out once)
      const alpha = shownOf(el)
      if (alpha < 0.02) continue
      const cs = getComputedStyle(el)
      out.push({
        text: cs.textTransform === "uppercase" ? text.toUpperCase() : text,
        font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
        colour: cs.color, spacing: cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing,
        x: r.left + r.width / 2, y: r.top + r.height / 2, alpha,
      })
    }
    return out
  }
  /* the words, where the drain has them this frame */
  function paintWords(g, words, frame) {
    g.save()
    g.textAlign = "center"; g.textBaseline = "middle"
    for (const w of words) {
      const p = drainPoint(w.x, w.y, frame, W, H)
      if (!p) continue
      g.setTransform(DPR, 0, 0, DPR, 0, 0)
      g.translate(p.x, p.y); g.rotate(p.turn); g.scale(p.k, p.k)
      g.globalAlpha = w.alpha * p.alpha
      g.font = w.font; g.fillStyle = w.colour
      if ("letterSpacing" in g) g.letterSpacing = w.spacing
      g.fillText(w.text, 0, 0)
    }
    g.restore()
  }

  /* the live stage hides; its frame, without the pieces, is drawn in its place, square by square */
  function apply(ready) {
    s.S = { dots: ready.dots, coin: ready.coin, bare: ready.bare, tiles: ready.tiles, dpr: ready.dpr, words: captureWords() }
    for (const d of ready.dots) d.in = false
    const hidden = stageCanvases(stage).map((l) => l.c)
    for (const c of hidden) c.classList.add("hold-off")
    stage.setAttribute("data-holding", "")
    // nothing of the live stage shows meanwhile: it stops drawing (lib/draw/wheel/mount STAGE_COVERED)
    stage.querySelector("#app")?.dispatchEvent(new CustomEvent("jollity:stage-covered", { detail: true, bubbles: true }))
    s.live = { hidden }
  }
  /* read ahead, in steps in idle time: the wheel is still by now */
  let prereadTimer = 0
  const preread = (delay = PREREAD_MS) => { clearTimeout(prereadTimer); prereadTimer = setTimeout(() => inIdle(() => {
    // the picture is always of the whole wheel, which is what a hold takes in
    if (s.pre || s.reading || s.phase !== "ready" || dead || lookAt.zoomed()) return
    // the wheel still moving by itself (the spin played on from the timeline): not its end yet
    if (exploreOf(stage)?.busy()) return preread(VIEW_SETTLE_MS)
    s.reading = true
    const gen = s.gen
    captureDraw(stage, (cap) => { cap.whole = !lookAt.zoomed(); findPieces(cap, inIdle, (found) => inIdle(() => {
      s.reading = false
      if (dead) return
      // the timeline moved the wheel while it was read: read it again once it is still
      if (gen !== s.gen) return preread(VIEW_SETTLE_MS)
      // the wheel was zoomed as it was read: not the picture for a hold
      if (!cap.whole) { if (s.wantApply && !s.live) take(); else preread(VIEW_SETTLE_MS); return; }
      s.pre = prepare(found)
      warp.setPicture(s.pre.bare)
      if (s.wantApply && !s.live && (s.phase === "hold" || s.phase === "ready")) apply(s.pre)
    })); })
  }), delay); }
  /* the player zoomed or moved the wheel. The picture read ahead is of the
     whole wheel, and stays: a hold zooms back out to it (holdView) */
  function viewMoved() {
    if (s.live || s.phase !== "ready") return
    // zoomed in, the whole wheel's picture still stands; back out with none yet, it is read
    if (!s.pre && !s.reading && !lookAt.zoomed()) preread(VIEW_SETTLE_MS)
  }
  /* the hold is ready: the hint comes up, and the frame is read ahead */
  function ready() {
    s.phase = "ready"
    s.readyAt = clock
    preread()
  }

  /* the hold begins: the draw's frame, read ahead or now, and its pieces off the live picture */
  function take() {
    if (s.live) return
    // begun zoomed in: the hold takes the whole wheel. The live wheel goes back
    // to the whole of it now (under the picture), and the picture eases out
    // from where the player was to the whole wheel (holdView)
    const zoomed = lookAt.zoomed()
    if (zoomed) {
      const w = exploreOf(stage), v = w.view(), box = w.box()
      s.hv = { from: { s: v.s, ox: box.left * (1 - v.s) + v.x, oy: box.top * (1 - v.s) + v.y }, at: performance.now() }
      lookAt.resetNow()
    } else s.hv = null
    if (s.pre) return apply(s.pre)
    // still reading ahead: it is shown the moment it is ready, and in the
    // meantime nothing has left the live picture
    if (s.reading) { s.wantApply = true; return; }
    s.reading = true
    // zoomed in a moment ago with no picture of the whole yet: the stage draws the whole wheel first
    if (zoomed) s.hv = null
    // the wheel still moving by itself: this picture is of now, for this hold only, not the draw's end
    const moving = !!exploreOf(stage)?.busy()
    const read = () => captureDraw(stage, (cap) => findPieces(cap, now, (found) => {
      s.reading = false
      s.pre = prepare(found)
      s.pre.stale = moving
      warp.setPicture(s.pre.bare)
      if (s.phase === "hold" || s.phase === "ready") apply(s.pre)
    }))
    if (zoomed) requestAnimationFrame(read); else read()
  }
  /* the picture as shown this frame: the zoom a hold began in, easing out to the whole wheel (identity) */
  function holdView(nowMs) {
    const hv = s.hv
    if (!hv) return null
    const u = c01((nowMs - hv.at) / HOLD_ZOOM_OUT_MS)
    if (u >= 1) { s.hv = null; return null; }
    // in and out gently (a sine), the scale on its log, the move with it
    const k = 0.5 - 0.5 * Math.cos(Math.PI * u)
    const sc = Math.pow(hv.from.s, 1 - k), f = hv.from.s === 1 ? k : (hv.from.s - sc) / (hv.from.s - 1)
    return { s: sc, ox: hv.from.ox * (1 - f), oy: hv.from.oy * (1 - f), k }
  }
  function restore() {
    if (s.live) {
      for (const c of s.live.hidden) c.classList.remove("hold-off")
      stage.removeAttribute("data-holding")
      stage.querySelector("#app")?.dispatchEvent(new CustomEvent("jollity:stage-covered", { detail: false, bubbles: true }))
      s.live = null
    }
    s.S = null
    s.hv = null
    warp.clear()
    showGl(false)
    unlook()
  }

  /* how far the hold is NOW, on the clock, from the last press or let-go:
     however slow the frames, a hold is HOLD_MS × 1.5, and a press or a
     let-go between two frames counts from when it was, not from the last frame */
  function pNow() {
    if (s.skipping || s.full) return 1
    const since = (performance.now() - s.since) / 1000
    return s.holding ? Math.min(1, s.pFrom + since / (HOLD_MS / 1000 * 1.5)) : Math.max(0, s.pFrom - since / (DRAIN_MS / 1000))
  }

  /* `real`: the frame's own time, uncapped (to a breath): the hold is a
     timer, and a slow frame must not make it longer. `dt` is capped, for
     the springs */
  function step(dt, real) {
    s.dt = dt
    if (s.phase === "prize") {
      // a win: the draw is going back to the wheel by itself (autoBackToWheel); the hold waits for the wheel
      const prizeUp = !!stage.querySelector("#app.flow-prize-up")
      if (!prizeUp && stage.dataset.wheel !== "going" && clock - s.prizeAt > 0.1) ready()
      return
    }
    if (s.phase === "hold" || s.phase === "ready") {
      s.p = pNow()
      // held this far, it is the player's say: it finishes by itself, let go
      // or not, even if the draw's picture is still on its way (a slow
      // frame); it glides once it is done and the picture is in
      if (!s.full && (s.p >= 1 || (s.holding && Math.max(s.p, s.v) >= COMMIT))) {
        s.full = true
        // the point of no return, felt: a short tick
        try { navigator.vibrate?.(14); } catch { /* no vibration here */ }
      }
      if (s.full && s.S && s.v >= DONE) {
        s.phase = "rise"; s.T = 0; s.holding = false; s.riseAt = performance.now()
        // all of it is in the bubble: nothing of the picture is left to draw
        warp.clear()
        showGl(false)
        s.b.dir = -Math.PI / 2; s.b.sqVel += 0.9
        s.from = s.bp ? { x: s.bp.x, y: s.bp.y } : { x: W / 2, y: H * 0.62 }
        s.rFrom = s.r || R_FULL * unit()
      }
    } else if (s.phase === "rise") s.T = (performance.now() - s.riseAt) / 1000
    // how full it looks follows how far it is held, on a spring with no
    // overshoot while held, and a little bounce when let go short (it springs
    // back), run on the frame's real time in small steps: a slow frame does
    // not hold it back
    const w = 11, zeta = s.holding || s.full ? 1 : 0.55
    for (let left = real; left > 0; left -= 0.02) {
      const h = Math.min(0.02, left)
      s.vVel += (w * w * (s.p - s.v) - 2 * zeta * w * s.vVel) * h
      s.v += s.vVel * h
    }
    if (s.phase === "rise") s.v = 1
    stepJelly(s.b, dt)
    if (!s.holding && s.phase === "hold" && s.vVel < -0.6) s.b.sqVel -= 0.02
    // all drained: the live draw is back
    if (s.phase === "hold" && !s.holding && s.p <= 0 && s.v < 0.004) {
      s.phase = "ready"
      restore()
      s.bp = null
      // a picture of the wheel while it was still moving: read again once it is still
      if (s.pre?.stale) { s.pre = null; preread(VIEW_SETTLE_MS); }
    }
  }

  /* where a piece circles inside the bubble, all at one pace: the same on the collectables screen's side */
  const swirl = (d, t) => t * ORBIT_SPEED + d.k * 2.39
  const reach = (d) => (8 + ((d.k * 7) % 22)) / 47

  /* the room's stars (lib/collectables-scene/stars, the collectables' too): the bubble clears them where it is */
  function paintDust(g, t, bx, by, R, alpha) {
    drawStars(g, W, H, t, alpha, { x: bx, y: by, r: R })
  }

  /* the light gathered round the bubble: on the collectables' room too (app/globals.css .collectables-backdrop) */
  function paintGlow(g, bx, by, a) {
    const u = unit(), gy = by + 30 * u
    const glow = g.createRadialGradient(bx, gy, 0, bx, gy, 260 * u)
    glow.addColorStop(0, `rgba(150,165,255,${0.1 * a})`); glow.addColorStop(1, "rgba(150,165,255,0)")
    // only the square it lights: a gradient over the whole screen costs the whole screen
    g.fillStyle = glow; g.fillRect(bx - 260 * u, gy - 260 * u, 520 * u, 520 * u)
  }

  /* the draw's picture, pulled in square by square: nearest first, each
     twisting round the bubble as it goes, shrinking and fading into it */
  function paintTiles(g, S, bx, by, R, pull, zs = 1, zx = 0, zy = 0) {
    if (pull >= 1) return
    const u = unit(), d = S.dpr, T = TILE
    for (const tl of S.tiles) {
      // where it sits as shown, through the zoom a hold began in
      const tx = zs * tl.x + zx, ty = zs * tl.y + zy
      const dist = Math.hypot(tx - bx, ty - by), o = c01(dist / (460 * u)) * 0.35, k = ease(seg(pull, o, o + 0.65))
      const a = 1 - smooth(seg(k, 0.5, 0.92))
      if (a <= 0.01) continue
      const an = Math.atan2(ty - by, tx - bx) + k * 0.9, rr = lerp(dist, R * 0.4, k), sz = T * zs * lerp(1, 0.3, k)
      g.globalAlpha = a
      g.drawImage(S.bare, (tl.x - T / 2) * d, (tl.y - T / 2) * d, T * d, T * d, bx + rr * Math.cos(an) - sz / 2, by + rr * Math.sin(an) - sz / 2, sz + 0.4, sz + 0.4)
    }
    g.globalAlpha = 1
  }

  function paintHold(g, t, tp) {
    const v = c01(s.v), f = s.f, dt = s.dt, u = unit()
    const A = { x: clamp(f.x, 70, W - 70), y: clamp(f.y - LIFT, 120, H - 160) }
    if (!s.bp) s.bp = { x: A.x, y: A.y, vx: 0, vy: 0 }
    const bp = s.bp
    if (v < 0.02 && !s.holding) { bp.x = A.x; bp.y = A.y; bp.vx = bp.vy = 0; }
    const k = 110, damp = 2 * Math.sqrt(k) * 0.9
    bp.vx += ((A.x - bp.x) * k - bp.vx * damp) * dt; bp.vy += ((A.y - bp.y) * k - bp.vy * damp) * dt
    bp.x += bp.vx * dt; bp.y += bp.vy * dt
    const sp = Math.hypot(bp.vx, bp.vy)
    if (sp > 40) { s.b.dir = Math.atan2(bp.vy, bp.vx); s.b.sqVel += clamp(sp / 9000, 0, 0.03); }
    const bx = bp.x, by = bp.y
    // the draw's words: the page's hide while the hold has the screen (they are drawn, drained, below)
    if (s.phase === "hold") look(1, s.S ? 0 : 1)
    const S = s.S
    if (!S || s.phase !== "hold") return
    const R = (R_FROM + (R_FULL - R_FROM) * ease(v)) * u
    s.r = R
    // light gathers round the bubble as it fills
    paintGlow(g, bx, by, 0.35 + 0.65 * smooth(v))
    paintDust(g, tp, bx, by, R, 0.4 + 0.6 * smooth(v))
    // a hold begun zoomed in: the picture, its pieces and the prize ease out to the whole wheel (holdView)
    const hv = holdView(performance.now())
    const zs = hv ? hv.s : 1, zx = hv ? hv.ox : 0, zy = hv ? hv.oy : 0
    // the drain waits on the zoom-out: it comes in as the wheel settles back to the whole of it
    const pull = hv ? v * smooth(hv.k) : v
    if (warp.ok) { showGl(true); warp.draw({ cx: bx, cy: by, R, pull, t: tp, view: hv ? { s: zs, x: zx, y: zy } : undefined }); }
    else paintTiles(g, S, bx, by, R, pull, zs, zx, zy)
    // the words go in with it, along the same whirlpool
    if (S.words.length) paintWords(g, S.words, { cx: bx, cy: by, R, pull, t: tp })
    paintFilm(g, bx, by, R, t, smooth(seg(v, 0, 0.1)))
    // the tickets come in with the picture, drained; the bubble keeps
    // KEEP_IN of them (yours and the winners first), each showing up inside,
    // circling, the moment the drain has taken in the place it was (the
    // drain's own pace: a spot D away is in once far · pull^1.4 reaches it).
    // The bubble takes the weight: a wobble with each that comes in
    const far = Math.max(Math.hypot(bx, by), Math.hypot(W - bx, by), Math.hypot(bx, H - by), Math.hypot(W - bx, H - by)) + 4
    let arrivals = 0
    for (const d of S.dots) {
      if (!d.keep) continue
      const hx = zs * d.hx + zx, hy = zs * d.hy + zy
      const at = Math.pow(c01(Math.hypot(hx - bx, hy - by) / far), 1 / 1.4)
      const a = smooth(seg(pull, at, at + 0.12))
      if (a > 0.5 && !d.in) { d.in = true; arrivals++; } else if (a < 0.4) d.in = false
      if (a <= 0.01) continue
      const ang = swirl(d, tp), rr = R * reach(d)
      dotCss(g, bx + Math.cos(ang) * rr, by + Math.sin(ang) * rr * 0.85, PIECE_R * (0.5 + 0.5 * a), d.css, 0.9 * a)
    }
    if (arrivals) s.b.sqVel += Math.min(0.03, arrivals * 0.004)
    // the prize goes in last, turning to a glint
    if (S.coin) {
      const kc = smooth((pull - 0.4) / 0.55), c = S.coin
      const cx = lerp(zs * c.x + zx, bx, kc), cy = lerp(zs * c.y + zy, by, kc) - Math.sin(Math.PI * kc) * 30
      const cr = lerp(c.r * zs, 10, ease(kc)), ca = 1 - smooth((kc - 0.75) / 0.25)
      if (ca > 0.01) { g.globalAlpha = ca; g.drawImage(c.img, cx - cr, cy - cr, cr * 2, cr * 2); g.globalAlpha = 1; }
      if (kc > 0.75) orb(g, bx + Math.cos(tp * 0.7) * R * 0.12, by + Math.sin(tp * 0.7) * R * 0.1, 3.4, [242, 242, 242], smooth((kc - 0.75) / 0.25))
    }
    // how far: a ring round it, gold once it will finish by itself
    if (v > 0.005) {
      g.save(); g.globalAlpha = 0.9; g.strokeStyle = s.full ? "#ffc94d" : "#fff"; g.lineWidth = 2; g.lineCap = "round"
      g.beginPath(); g.arc(bx, by, R + 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * v); g.stroke(); g.restore()
    }
    // where the finger is
    if (s.holding) { g.globalAlpha = 0.22; g.fillStyle = "#fff"; g.beginPath(); g.arc(f.x, f.y, 24, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; }
  }

  /* the glide: to the collectables' spot, the pieces circling in it, as the
     draw fades and the room under it shows */
  function paintRise(g, t, tp) {
    const S = s.S, T = s.T
    look(1 - smooth(T / 0.35), 0)
    // handed over: the bubble between the screens draws it now (components/carried-bubble)
    if (s.risen) return
    const SP = spot(), m = quint(T / RISE_S)
    const cx = lerp(s.from.x, SP.x, m), cy = lerp(s.from.y, SP.y, m)
    if (T < RISE_S) { const vy = (cy - (s._lastCy ?? cy)) / s.dt; if (Math.abs(vy) > 30) s.b.dir = vy < 0 ? -Math.PI / 2 : Math.PI / 2; }
    s._lastCy = cy
    const R = lerp(s.rFrom, R0(), m)
    // the room's light and its stars go with it: the collectables' room has both, where it lands
    paintGlow(g, cx, cy, 1)
    paintDust(g, tp, cx, cy, R, 1)
    paintFilm(g, cx, cy, R, t, 1)
    for (const d of S.dots) {
      if (!d.keep) continue
      const ang = swirl(d, tp), rr = R * reach(d)
      dotCss(g, cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr * 0.85, PIECE_R, d.css, 0.9)
    }
    if (S.coin) orb(g, cx + Math.cos(tp * 0.7) * R * 0.12, cy + Math.sin(tp * 0.7) * R * 0.1, 3.4, [242, 242, 242], 1)
    // there: the collectables take it from here
    if (T >= RISE_S && !s.risen) {
      s.risen = true
      opts.onRisen?.({
        x: cx, y: cy, r: R, glint: !!S.coin, at: performance.now(),
        pieces: S.dots.filter((d) => d.keep).map((d) => ({ angle: swirl(d, tp), speed: ORBIT_SPEED, radius: reach(d), color: d.col, lit: false, seed: d.seed })),
      })
    }
  }

  const iri = document.createElement("canvas"); iri.width = iri.height = 64
  const ictx = iri.getContext("2d")
  function paintFilm(g, x, y, R, t, a) {
    const b = s.b
    if (R < 0.5 || a <= 0.001) return
    g.save()
    bPath(g, b, x, y, R, t)
    const fg = g.createRadialGradient(x - R * 0.15, y - R * 0.2, 0, x, y, R)
    fg.addColorStop(0, `rgba(170,195,255,${0.02 * a})`); fg.addColorStop(0.62, `rgba(170,195,255,${0.035 * a})`)
    fg.addColorStop(0.86, `rgba(190,210,255,${0.09 * a})`); fg.addColorStop(0.97, `rgba(220,232,255,${0.22 * a})`)
    fg.addColorStop(1, `rgba(240,246,255,${0.3 * a})`)
    g.fillStyle = fg; g.fill()
    const need = Math.ceil(R * 2.3) + 8
    if (iri.width < need) iri.width = iri.height = Math.ceil(need / 64) * 64
    const S = iri.width, h = S / 2
    ictx.setTransform(1, 0, 0, 1, 0, 0); ictx.globalCompositeOperation = "source-over"; ictx.clearRect(0, 0, S, S)
    ictx.save(); bPath(ictx, b, h, h, R, t); ictx.clip()
    ictx.fillStyle = conicG(ictx, t * 0.35, h + Math.sin(t * 0.5) * R * 0.18, h + Math.cos(t * 0.4) * R * 0.14, R, FILM)
    ictx.fillRect(0, 0, S, S); ictx.restore()
    ictx.globalCompositeOperation = "destination-in"
    const m = ictx.createRadialGradient(h, h, R * 0.6, h, h, R * 1.02)
    m.addColorStop(0, "rgba(0,0,0,0)"); m.addColorStop(0.6, "rgba(0,0,0,0.22)"); m.addColorStop(1, "rgba(0,0,0,0.9)")
    ictx.fillStyle = m; ictx.fillRect(0, 0, S, S)
    g.globalCompositeOperation = "screen"; g.globalAlpha = 0.55 * a; g.drawImage(iri, x - h, y - h); g.globalAlpha = 1
    g.globalCompositeOperation = "lighter"
    bPath(g, b, x, y, R, t)
    const rim = g.createLinearGradient(x - R, y - R, x + R, y + R)
    rim.addColorStop(0, `rgba(255,255,255,${0.55 * a})`); rim.addColorStop(0.5, `rgba(255,255,255,${0.1 * a})`); rim.addColorStop(1, `rgba(255,255,255,${0.35 * a})`)
    g.strokeStyle = rim; g.lineWidth = Math.max(1, R * 0.014); g.stroke()
    g.globalCompositeOperation = "source-over"
    refl(g, b, x, y, R, t, -2.62, -1.72, 0.72, 0.86, 0.5 * a); refl(g, b, x, y, R, t, 0.35, 1.1, 0.8, 0.88, 0.14 * a)
    const sx = x + Math.cos(-2.3) * R * 0.62, sy = y + Math.sin(-2.3) * R * 0.62
    const sp = g.createRadialGradient(sx, sy, 0, sx, sy, R * 0.045)
    sp.addColorStop(0, `rgba(255,255,255,${0.95 * a})`); sp.addColorStop(0.35, `rgba(255,255,255,${0.6 * a})`); sp.addColorStop(1, "rgba(255,255,255,0)")
    g.fillStyle = sp; g.beginPath(); g.arc(sx, sy, R * 0.045, 0, Math.PI * 2); g.fill()
    g.restore()
  }

  /* the invitation, low on the screen: a breathing ring and HOLD ANYWHERE. It
     is a small layer of its own (opts.hintEl, app/globals.css .hold-hint)
     that the compositor breathes, so waiting for the hold redraws nothing;
     only how much of it shows is set from here, when that changes */
  function paintHint(t) {
    const el = opts.hintEl
    if (!el) return
    const a = opts.hint !== false && (s.phase === "ready" || s.phase === "hold") ? smooth(seg(t, s.readyAt, s.readyAt + 0.6)) * (1 - c01(s.v * 5)) : 0
    const shown = a <= 0.01 ? 0 : Math.round(a * 50) / 50
    if (shown !== s.hintShown) { s.hintShown = shown; el.style.opacity = String(shown); }
  }

  /* ── THE FINGERS, after the draw: a tap picks a ticket (lib/draw/hold/look),
     a press held still is the hold, a press that moves while zoomed in moves
     the wheel, and two fingers zoom it. A press becomes the hold only once it
     has been still HOLD_DELAY_MS, so tapping round the wheel never flashes the
     bubble; that wait counts toward the hold ── */
  const lookAt = createLook(stage, opts.onPick)
  const fingers = new Map()   // pointer id -> { x, y, x0, y0, at }
  let mode = "idle"           // 'idle' | 'pending' | 'hold' | 'pan' | 'pinch'
  let pinch = null            // the two fingers' spread and middle, last frame
  const two = () => { const [a, b] = [...fingers.values()]; return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; }
  function holdDown(x, y, at) {
    s.pFrom = s.phase === "hold" ? pNow() : 0
    s.phase = "hold"; s.holding = true; s.f = { x, y }; s.since = at
    lookAt.clear()
    take()
  }
  function holdUp() {
    if (!s.holding) return
    const p = pNow()
    // let go past the point: it finishes by itself
    if (p >= COMMIT) s.full = true
    s.holding = false; s.pFrom = p; s.since = performance.now()
  }
  /* a press still for HOLD_DELAY_MS (or, unzoomed, however it moves): the hold */
  function settle(nowMs) {
    if (mode !== "pending" || fingers.size !== 1) return
    const f = fingers.values().next().value
    if (nowMs - f.at < HOLD_DELAY_MS) return
    if (lookAt.zoomed() && Math.hypot(f.x - f.x0, f.y - f.y0) > SLOP) return
    mode = "hold"
    holdDown(f.x, f.y, f.at)
  }

  let clock = 0, last = performance.now(), raf = 0, dead = false
  function frame(now) {
    if (dead) return
    raf = requestAnimationFrame(frame)
    const real = Math.max(0, Math.min(0.25, (now - last) / 1000))
    const dt = Math.min(0.05, real)
    last = now
    clock += dt
    settle(now)
    if (lookAt.step(now)) viewMoved()
    step(dt, real)
    // nothing to draw (the wheel waiting for a hold): the canvas is cleared once, then left alone
    const active = s.phase === "rise" || (s.phase === "hold" && !!s.S)
    if (active || s.dirty) { ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H); }
    s.dirty = active
    const tp = nowS()
    // the film's time is the swirl's: the clock the bubble keeps between the screens and in the collectables screen
    if (s.phase === "rise") paintRise(ctx, tp, tp)
    else paintHold(ctx, tp, tp)
    paintHint(clock)
    // the hold under way, or the bubble gliding off: the page puts its own controls away
    const busy = s.phase === "rise" || (s.phase === "hold" && (s.holding || s.v > 0.02))
    if (busy !== s.busy) { s.busy = busy; opts.onBusy?.(busy); }
    if (s.phase !== s.saidPhase) { s.saidPhase = s.phase; opts.onPhase?.(s.phase); }
    // where the hold is, on its canvas, for a test to read (written only when it changes)
    const said = `${s.phase} ${s.holding ? "held" : "free"} ${s.S ? "read" : s.reading ? "reading" : "unread"} ${s.full ? "full" : ""}`
    if (canvas.dataset.hold !== said) canvas.dataset.hold = said
  }
  raf = requestAnimationFrame(frame)

  return {
    /** a finger down (its pointer id, page px) */
    pointerDown(id, x, y) {
      // the prize is up, or the bubble is gliding off: nothing to touch
      if (s.phase !== "ready" && s.phase !== "hold") return
      fingers.set(id, { x, y, x0: x, y0: y, at: performance.now() })
      if (s.full) return
      if (fingers.size >= 2) {
        // two fingers: a zoom, never a hold
        if (mode === "hold") holdUp()
        mode = "pinch"
        pinch = two()
        return
      }
      mode = "pending"
    },
    pointerMove(id, x, y) {
      const f = fingers.get(id)
      if (!f) return
      const px = f.x, py = f.y
      f.x = x; f.y = y
      if (mode === "hold") { if (s.holding) s.f = { x, y }; return; }
      if (mode === "pinch" && fingers.size >= 2) {
        const now2 = two()
        lookAt.pinch(now2.d / pinch.d, now2.mx, now2.my, now2.mx - pinch.mx, now2.my - pinch.my)
        pinch = now2
        viewMoved()
        return
      }
      if (mode === "pan") { lookAt.pan(x - px, y - py); viewMoved(); return; }
      // zoomed in, a press that moves: it moves the wheel
      if (mode === "pending" && lookAt.zoomed() && Math.hypot(x - f.x0, y - f.y0) > SLOP) {
        mode = "pan"
        lookAt.pan(x - f.x0, y - f.y0)
        viewMoved()
      }
    },
    pointerUp(id) {
      const f = fingers.get(id)
      fingers.delete(id)
      if (!f) return
      if (mode === "pinch") {
        // one finger left: it moves the wheel on
        mode = fingers.size === 1 ? (lookAt.zoomed() ? "pan" : "idle") : fingers.size ? "pinch" : "idle"
        if (mode === "pinch") pinch = two()
        return
      }
      if (mode === "hold") { holdUp(); mode = "idle"; return; }
      // let go before it was a hold, and hardly moved: a tap
      if (mode === "pending" && Math.hypot(f.x - f.x0, f.y - f.y0) <= SLOP) lookAt.tap(f.x, f.y, performance.now())
      if (!fingers.size) mode = "idle"
    },
    /** zoom by k, for a caller's buttons: in (k > 1) or out, about the middle */
    zoomBy(k) { if (s.phase === "ready" || s.phase === "hold") lookAt.zoomBy(k, performance.now()); },
    /** back to the whole wheel */
    zoomOut() { lookAt.reset(performance.now()); },
    /** zoomed in now */
    zoomed: () => lookAt.zoomed(),
    /** the way on with no hold (a keyboard, a screen reader): the hold, done */
    skip() {
      if (s.phase !== "ready" && s.phase !== "hold") return
      s.phase = "hold"; take(); s.skipping = true; s.holding = false
    },
    /** how far the hold is, 0–1 */
    progress: () => s.p,
    /** the draw's timeline may take a hand: the wheel is up and nobody is holding */
    canScrub: () => s.phase === "ready",
    /** the timeline moved the wheel: the picture read ahead is not of it any more, nor is the pick */
    scrubbed() {
      s.gen += 1
      s.pre = null
      lookAt.clear()
      opts.onPick?.(null)
      preread(VIEW_SETTLE_MS)
    },
    destroy() {
      dead = true
      clearTimeout(prereadTimer)
      cancelAnimationFrame(raf)
      removeEventListener("resize", resizeAll)
      warp.destroy()
      glc.remove()
      // the page is going: leave the stage as it was, in case it stays
      if (!s.risen) restore()
    },
  }
}
