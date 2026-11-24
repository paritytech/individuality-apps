// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable */
// @ts-nocheck
/**
 * THE BUBBLE'S FILM, AND THE BUBBLE BETWEEN THE SCREENS. The soap film the
 * hold draws its bubble with (./scene) and the carried bubble the root layout
 * draws while the route changes (components/carried-bubble), kept apart from
 * the hold's scene so that the layout, on every page, loads this alone and
 * not the hold (its warp, the wheel's explore, the prize's config).
 */

/** a piece circling in the bubble: a dot of its colour this big (the chest draws them so too) */
export const PIECE_R = 3
export const FILM = ["#ff9ad5", "#c7a4ff", "#86d4ff", "#9cf0cf", "#ffe3a0", "#ffad8c", "#ff9ad5"]

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const rgbStr = (c) => `rgb(${c[0]},${c[1]},${c[2]})`

function dot(g, x, y, r, col, a) {
  if (a <= 0.005 || r <= 0.1) return
  g.globalAlpha = a; g.fillStyle = rgbStr(col); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1
}
export function orb(g, x, y, r, col, a = 1) {
  if (a <= 0.005) return
  const gr = g.createRadialGradient(x, y, 0, x, y, r * 3.2)
  gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(0.22, rgbStr(col)); gr.addColorStop(1, "rgba(0,0,0,0)")
  g.globalAlpha = a; g.fillStyle = gr; g.beginPath(); g.arc(x, y, r * 3.2, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1
}

/* ── the soap film: the chest engine's drawBubble, copied ── */
export const jelly = () => ({ sq: 0, sqVel: 0, tri: 0, triVel: 0, dir: -Math.PI / 2 })
export function stepJelly(b, dt) {
  b.sqVel += (-b.sq * 120 - b.sqVel * 6) * dt; b.sq = clamp(b.sq + b.sqVel * dt, -0.12, 0.12)
  b.triVel += (-b.tri * 260 - b.triVel * 9) * dt; b.tri = clamp(b.tri + b.triVel * dt, -0.05, 0.05)
}
const bEdge = (b, th, t) => { const a = th - b.dir; return 1 + b.sq * Math.cos(2 * a) + b.tri * Math.cos(3 * a) + 0.007 * Math.sin(2 * th + t * 1.1); }
export function bPath(g, b, cx, cy, R, t) {
  g.beginPath()
  for (let k = 0; k <= 72; k++) { const th = (k / 72) * Math.PI * 2, rr = R * bEdge(b, th, t); k ? g.lineTo(cx + Math.cos(th) * rr, cy + Math.sin(th) * rr) : g.moveTo(cx + Math.cos(th) * rr, cy + Math.sin(th) * rr); }
  g.closePath()
}
export function conicG(g, ang, x, y, R, stops) {
  const gr = g.createConicGradient ? g.createConicGradient(ang, x, y) : g.createLinearGradient(x - R, y - R, x + R, y + R)
  stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c)); return gr
}
export function refl(g, b, x, y, R, t, a0, a1, r0, r1, al) {
  g.beginPath()
  for (let k = 0; k <= 20; k++) { const th = a0 + ((a1 - a0) * k) / 20, rr = R * r1 * bEdge(b, th, t); k ? g.lineTo(x + Math.cos(th) * rr, y + Math.sin(th) * rr) : g.moveTo(x + Math.cos(th) * rr, y + Math.sin(th) * rr); }
  for (let k = 20; k >= 0; k--) { const th = a0 + ((a1 - a0) * k) / 20, rr = R * r0 * bEdge(b, th, t); g.lineTo(x + Math.cos(th) * rr, y + Math.sin(th) * rr); }
  g.closePath()
  const span = (a1 - a0) / (Math.PI * 2)
  if (g.createConicGradient) {
    const gr = g.createConicGradient(a0, x, y)
    gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(span * 0.35, `rgba(255,255,255,${al})`)
    gr.addColorStop(span * 0.65, `rgba(255,255,255,${al})`); gr.addColorStop(span, "rgba(255,255,255,0)"); gr.addColorStop(1, "rgba(255,255,255,0)")
    g.fillStyle = gr
  } else g.fillStyle = `rgba(255,255,255,${al * 0.6})`
  g.fill()
}

/* the film for the bubble between the screens (drawCarriedBubble): the same
   as the scene's, still (no jelly), its iridescence canvas made on first use */
let iriShared = null
function stillFilm(g, x, y, R, t, a) {
  if (!iriShared) { const c = document.createElement("canvas"); c.width = c.height = 64; iriShared = { c, x: c.getContext("2d") }; }
  const b = jelly(), iri = iriShared.c, ictx = iriShared.x
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
/**
 * The carried bubble between the screens (components/carried-bubble): where
 * the rise left it, the pieces swirling on, until the chest's engine has
 * drawn its own (lib/chest-scene/carry carryShown). `tp`: performance.now()
 * in seconds, the clock the swirl is on.
 */
export function drawCarriedBubble(g, c, tp) {
  const R = c.r, since = tp - c.at / 1000
  g.save(); bPath(g, jelly(), c.x, c.y, Math.max(1, R - 1), tp); g.clip()
  for (const p of c.pieces) {
    const ang = p.angle + p.speed * since, rr = R * p.radius
    const x = c.x + Math.cos(ang) * rr, y = c.y + Math.sin(ang) * rr * 0.85
    dot(g, x, y, PIECE_R, p.color, 0.9)
  }
  if (c.glint) orb(g, c.x + Math.cos(tp * 0.7) * R * 0.12, c.y + Math.sin(tp * 0.7) * R * 0.1, 3.4, [242, 242, 242], 1)
  g.restore()
  stillFilm(g, c.x, c.y, R, tp, 1)
}
