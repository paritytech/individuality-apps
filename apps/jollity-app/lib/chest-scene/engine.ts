// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* eslint-disable */
// @ts-nocheck
/**
 * The chest scene — LOGIC ONLY, no React, no DOM lookups beyond the canvas
 * it is handed. The collectables are flat sprites (setSprites) in a fixed
 * orthographic camera, so the whole scene draws on a 2D canvas.
 *
 * THE BUBBLE COLLECTS THE CLAIMS. A soap bubble blows up as the screen opens;
 * each claim that comes in (addPiece) is an orb of light, tinted by its
 * rarity, that flies in through the film where it meets it and carries on
 * inside, slowed, until it joins the motes swirling there; the film dents
 * where it went through, and the bubble grows and wobbles on the catch. It opens on open() (the host's
 * timing) or on a tap once something is in (canOpen): it swells one last
 * time and pops into droplets, and the pieces come out where the motes were
 * and drift to their places. A claim that comes after the pop flies straight
 * to its place among the others, who make room.
 *
 * OUT OF THE BUBBLE THEY FLOAT, in no grid (lib/chest-scene/float): the
 * unopened ones settle toward the bottom of the frame, each keeping a halo of
 * room, and a slow wander keeps them drifting. AN OPENED PIECE STAYS,
 * unwrapped: once its shell has broken (openPiece, the host's word) it is
 * drawn as its plain art, turns light, and floats up past the others to
 * gather with the opened ones at the top.
 *
 * A BUBBLE CARRIED FROM THE DRAW (opts.carried, lib/chest-scene/carry): the
 * draw's hold gathered the draw's pieces into it, so it starts blown where
 * it was, and each claim is found from a share of those pieces, merged at
 * its middle, instead of flying in (see THE CARRIED BUBBLE).
 *
 * Kept untyped on purpose: it is a frame loop over plain numbers. Its API is
 * declared in ./index.ts, the only module that imports this file; callers
 * import "@/lib/chest-scene". Change the API here and mirror it there.
 *
 * API: createChestScene(canvas, { count, onEvent, onDiscs, canOpen, carried, onCarriedShown }) ->
 *   { replay, tap, press, move, release, setSprites, openPiece, addPiece, open,
 *     setSpriteHidden, hold, setFloor, resize, destroy }
 */
import { floatLayout } from './float';

export function createChestScene(canvasEl, opts = {}) {

/* ================= seeded randomness ================= */

function hashSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/* mulberry32: small, fast, and stable across browsers, so a chest is laid
   out the same on every device */
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const range = (rnd, lo, hi) => lo + rnd() * (hi - lo);

/* every chest is laid out from this one seed: where the motes swirl, where
   the orbs come from, the scatter's jitter, the pop's droplets */
const SEED = 'MONO';


/* ================= the camera ================= */

const ctx = canvasEl.getContext('2d');
if (!ctx) throw new Error('2d context unavailable');

/* moments the outside world may want to hear (sounds) or feel (haptics) —
   never let a listener error kill the frame loop */
function emit(name, data) {
  try { if (opts.onEvent) opts.onEvent(name, data); } catch { /* listener's problem */ }
}
let DPR = 1, VW = 0, VH = 0;

/* camera basis, fixed for the life of the page */
const AZ = 0.62, POL = 1.19;
const EYE = {
  x: Math.sin(POL) * Math.sin(AZ),
  y: Math.cos(POL),
  z: Math.sin(POL) * Math.cos(AZ),
};
// right = normalize(up x eye), up = eye x right
const RIGHT = (() => {
  const rx = EYE.z, rz = -EYE.x;                 // cross((0,1,0), eye)
  const len = Math.hypot(rx, rz);
  return { x: rx / len, y: 0, z: rz / len };
})();
const UP = {
  x: EYE.y * RIGHT.z - EYE.z * RIGHT.y,
  y: EYE.z * RIGHT.x - EYE.x * RIGHT.z,
  z: EYE.x * RIGHT.y - EYE.y * RIGHT.x,
};

const dot = (a, bx, by, bz) => a.x * bx + a.y * by + a.z * bz;

/* projection state — the only thing that changes is the framing */
const cam = { cx: 0, cy: 0.66, cz: 0, zoom: 1 };
let SCALE = 200;

function project(x, y, z, out) {
  const dx = x - cam.cx, dy = y - cam.cy, dz = z - cam.cz;
  out.x = VW / 2 + dot(RIGHT, dx, dy, dz) * SCALE;
  out.y = VH / 2 - dot(UP, dx, dy, dz) * SCALE;
  out.d = dot(EYE, dx, dy, dz);      // larger = nearer the camera
  return out;
}

const tmp = { x: 0, y: 0, d: 0 };

/* the pieces drawn this frame, sorted back to front */
const pool = [];
let poolUsed = 0;

function claim() {
  if (poolUsed === pool.length) pool.push({ d: 0, x: 0, y: 0, ref: null });
  return pool[poolUsed++];
}


/* ================= the pieces ================= */

/* a piece is a flat sprite holding the camera, with its roundness painted
   on; until its collectable's art is in, a grey disc stands in */
function discSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(46, 42, 4, 64, 64, 66);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.42, '#c8c8c8');
  g.addColorStop(0.82, '#6d6d6d');
  g.addColorStop(1, '#3a3a3a');
  x.fillStyle = g;
  x.beginPath();
  x.arc(64, 64, 63, 0, Math.PI * 2);
  x.fill();
  return c;
}

const DISC = discSprite();

function tintedDisc(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.drawImage(DISC, 0, 0);
  x.globalCompositeOperation = 'multiply';
  x.fillStyle = color;
  x.fillRect(0, 0, 128, 128);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(DISC, 0, 0);
  return c;
}

/* three greys, so neighbouring stand-ins are told apart */
const DISC_SKINS = ['#F2F2F2', '#D8D8D8', '#BDBDBD'].map(tintedDisc);

/** the most pieces a chest holds: a game's credits are its rounds times a group's co-players */
const MAX_PIECES = 10;
const BALL_COUNT = Math.min(MAX_PIECES, Math.max(0, opts.count ?? 6));
const FLOAT_Y = 1.28;     // where the cluster comes to rest

// ── THE FRAME: sized as if the pieces sat in a grid, though they float ─────
// The pieces float free (lib/chest-scene/float), but how BIG they are is
// still a grid's question: the camera frames the grid that would hold the
// whole chest, so one collectable fills the frame and ten share it, and the
// float has just the room it needs.
//
// Everything below is in CELL units — one cell is one collectable's square —
// so the camera scale alone decides the on-screen size.

/** the piece, in cell units */
const BALL_R = 0.38;
/** Air around the grid, in cells: breathing room for the float, and what
 *  stops a chest of one filling the whole frame. */
const GRID_PAD = 0.45;

/** the frame the scene resolves to while the bubble collects, world units,
 *  and its centre: the bubble needs room to grow, and at one collectable
 *  the grid has almost none */
const HOLD_W = 3.3;
const HOLD_H = 5.1;
const HOLD_CY = 0.66;

/**
 * The grid: whichever columns×rows shape wins the most scale in a portrait
 * frame. Tried exhaustively — there are at most ten candidates, and the
 * answer decides how big every collectable is.
 */
function gridFor(count) {
  const TARGET = 0.7; // width / height of a phone's content area
  let best = { cols: 1, rows: Math.max(1, count), w: 0, h: 0, scale: -1 };
  for (let cols = 1; cols <= Math.max(1, count); cols++) {
    const rows = Math.ceil(count / cols);
    const w = cols + GRID_PAD * 2;
    const h = rows + GRID_PAD * 2;
    const scale = Math.min(TARGET / w, 1 / h);
    if (scale > best.scale) best = { cols, rows, w, h, scale };
  }
  return best;
}

/** the grid for the FULL chest — it is what the camera is framed to. It
 *  GROWS as pieces come in (addPiece), and the framing eases to it rather
 *  than jumping. Opening a piece never changes it: the piece stays. */
let fitW = gridFor(Math.max(1, BALL_COUNT)).w;
let fitH = gridFor(Math.max(1, BALL_COUNT)).h;
let targetW = fitW;
let targetH = fitH;
function fitTo(count) {
  const grid = gridFor(Math.max(1, count));
  targetW = grid.w;
  targetH = grid.h;
}
const discs = [];
// the real contents: one sprite per disc (a collectable image), set from
// outside; a disc without a sprite falls back to its stand-in
let sprites = [];
// pieces whose art the WRAPPING layer draws instead (the GL shell replaces
// the flat sprite — both at once would double the image through the glass)
const spriteHidden = new Set();

function makeDisc(i) {
  const rnd = mulberry32(hashSeed(SEED + ':wob' + i));
  return {
    x: 0, y: 0, z: 0, live: false, grow: 1,
    // in the bubble, to come out with the rest; a piece still on its way is not
    inBubble: true,
    // where a claim that arrives after the pop lands (arrivalPoint)
    hx: 0, hy: 0, hz: 0,
    // its own slow rhythm: the float's wander and the wiggle's rock
    wob: [range(rnd, 0.35, 0.7), range(rnd, 0.28, 0.6), range(rnd, 0.4, 0.75),
          rnd() * 6.28, rnd() * 6.28, rnd() * 6.28],
    roll: 0, rollVel: 0, tilt: 0.3,
    skin: i % 3,
    // the pop: 0 intact → 1 burst; the tap stores where it hit so the shell
    // flies apart from the finger
    crack: 0, crackClock: -1, hitX: 0, hitY: 0,
    // broken open: drawn as its plain art, and light (it floats up)
    opened: false,
    // THE FLOAT (lib/chest-scene/float): the piece in the camera's plane —
    // u right, v up, from the frame's centre — its speed there, its depth off
    // the plane (kept), the spot the layout gave it, how far short of the
    // frame's edge it rests (its own), and the finger's point while dragged
    u: 0, v: 0, vu: 0, vv: 0, dep: 0,
    tu: 0, tv: 0, lift: rnd(),
    fu: 0, fv: 0,
    // its rarity's colour (the orb it came in as), and the light it trails as it rises
    tint: '#ffffff', trail: [],
  };
}
for (let i = 0; i < BALL_COUNT; i++) discs.push(makeDisc(i));

/* where a claim that comes after the pop lands: low in the frame, where the
   unopened ones gather, a little off the middle. The float makes room. */
function arrivalPoint(b, index) {
  const { cols, rows } = gridFor(discs.length);
  const rnd = mulberry32(hashSeed(SEED + ':arrive' + index));
  const u = range(rnd, -0.5, 0.5) * Math.max(0, cols - 1);
  const v = -(rows - 1) / 2;
  b.hx = RIGHT.x * u + UP.x * v;
  b.hy = FLOAT_Y + RIGHT.y * u + UP.y * v;
  b.hz = RIGHT.z * u + UP.z * v;
}

/* a piece's shell has broken (the host's word, once the shatter has played):
   it stays where it is as its plain art, and turns light — its new spot is
   with the opened ones at the top, and it floats up past the unopened ones
   to it. The camera eases back out if it was the focus, so the rise is seen. */
function openPiece(index) {
  const b = discs[index];
  if (!b || b.opened) return;
  b.opened = true;
  if (focusDisc === b) setFocus(false);
  relayout();
}

/* ── THE FLOAT: a spot for every piece, then a spring to it ───────────────
   Not physics. floatLayout (lib/chest-scene/float) gives every live piece a
   loose spot — the opened ones at the top of the frame, the rest at the
   bottom — and only when something changes: the pop, an open, a claim
   landing, a drag let go, a resize. Each frame a piece springs toward its
   spot, breathing around it. The spot is laid out in the FINAL frame (the
   camera settled on the pieces), so the camera's tightening after the pop
   and its dive into a piece change nothing. */
const FLOAT_EASE = 3.2;      // the spring's rate (1/s), critically damped: ~1.5 s to a new spot, no overshoot
const BREATH_U = 0.07;       // how far a piece drifts around its spot, sideways and up and down
const BREATH_V = 0.09;
const DRAG_FOLLOW = 22;      // how fast a dragged piece catches up with the finger (1/s)
const DRAG_HALO = 1.45;      // what a dragged piece pushes aside, in summed radii
const MAKE_WAY = 0.3;        // how much of the overlap a piece gives way, each frame, to an opened one rising past (it springs back after)
const RISING = 0.3;          // an opened piece further than this from its spot is on its way up
const TRAIL_TIME = 0.3;      // s of the path a rising piece trails as light
const EDGE_PAD = 0.04;       // air left between a piece and the screen's edge, units
const EDGE_BOUNCE = 0.45;    // how much of a piece's speed into an edge comes back off it

/* the view without any dive into a piece, as the frame last set it: its
   scale (px a unit) and where its centre is. The screen's edges are its */
let viewScale = 0;
let viewCy = FLOAT_Y;
/* THE FLOOR: the Pocket's book takes the foot of the screen once it is up,
   and the pieces float above it, never behind it (setFloor: px from the
   canvas's top; null, the canvas's own foot) */
let floorPx = null;
function setFloor(px) {
  const next = px == null || !Number.isFinite(px) ? null : px;
  if (next === floorPx || (next !== null && floorPx !== null && Math.abs(next - floorPx) < 1)) return;
  floorPx = next;
  if (seq.burstAt >= 0) relayout();
}

/* THE SCREEN'S EDGES: every piece stays on the screen, whole. Running into
   an edge it stops there and comes back off it a little, as off a wall: the
   pop's throw, a breath, a piece making way or a drag never take it off.
   The edges are the view's without a dive into a piece (a camera zoomed in
   shows less, and that is the camera's, not the pieces') */
function keepOnScreen(b) {
  if (!viewScale) return;
  const r = BALL_R * Math.max(1, b.grow) + EDGE_PAD;
  const hw = VW / 2 / viewScale - r, hh = VH / 2 / viewScale - r;
  if (hw <= 0 || hh <= 0) return;
  const cu = dot(RIGHT, 0, viewCy - FLOAT_Y, 0), cv = dot(UP, 0, viewCy - FLOAT_Y, 0);
  if (b.u < cu - hw) { b.u = cu - hw; if (b.vu < 0) b.vu *= -EDGE_BOUNCE; }
  else if (b.u > cu + hw) { b.u = cu + hw; if (b.vu > 0) b.vu *= -EDGE_BOUNCE; }
  const low = floorPx === null ? cv - hh : Math.max(cv - hh, cv + (VH / 2 - floorPx) / viewScale + r);
  if (b.v < low) { b.v = low; if (b.vv < 0) b.vv *= -EDGE_BOUNCE; }
  else if (b.v > cv + hh) { b.v = cv + hh; if (b.vv > 0) b.vv *= -EDGE_BOUNCE; }
}

/** the piece in the camera's plane, from where it is in the world */
function toPlane(b) {
  const dy = b.y - FLOAT_Y;
  b.u = dot(RIGHT, b.x, dy, b.z);
  b.v = dot(UP, b.x, dy, b.z);
  b.dep = dot(EYE, b.x, dy, b.z);
}

function relayout() {
  const live = discs.filter((b) => b.live);
  if (!live.length || !VW || !VH) return;
  const s = Math.min(VW / targetW, VH / targetH);
  const halfW = VW / 2 / s, halfH = VH / 2 / s;
  const spots = floatLayout(
    live.map((b) => ({ u: b.u, v: b.v, r: BALL_R, opened: b.opened, lift: b.lift })),
    { left: -halfW, right: halfW, bottom: floorPx === null ? -halfH : Math.min(halfH * 0.5, Math.max(-halfH, (VH / 2 - floorPx) / s)), top: halfH },
  );
  live.forEach((b, i) => { b.tu = spots[i].u; b.tv = spots[i].v; });
}

/* out of the popped bubble, each from where its mote was, thrown outward by
   the pop; the float takes it from there */
function burst() {
  const rnd = mulberry32(hashSeed(SEED + ':burst'));
  // a replay starts every piece unopened and still
  for (const b of discs) {
    b.opened = false; b.vu = 0; b.vv = 0; b.trail.length = 0;
  }
  const from = { x: 0, y: 0, z: 0 };
  for (const b of discs) {
    const index = discs.indexOf(b);
    // a piece still on its way flies to a landing place instead (stepOrbs)
    if (!b.inBubble) { arrivalPoint(b, index); continue; }
    b.live = true;
    b.crack = 0; b.crackClock = -1;
    const mote = bub.motes.find((m) => m.index === index);
    if (mote) motePoint(mote, from); else { from.x = 0; from.y = BUBBLE_Y; from.z = 0; }
    b.x = from.x; b.y = from.y; b.z = from.z;
    b.grow = 0.25;
    // outward from the bubble's centre, with a lift
    const du = dot(RIGHT, from.x, from.y - BUBBLE_Y, from.z);
    const dv = dot(UP, from.x, from.y - BUBBLE_Y, from.z);
    const len = Math.hypot(du, dv) || 1;
    const speed = range(rnd, 1.2, 2.4);
    b.vu = (du / len) * speed;
    b.vv = (dv / len) * speed + range(rnd, 0.3, 0.9);
    b.wob = [range(rnd, 0.35, 0.7), range(rnd, 0.28, 0.6), range(rnd, 0.4, 0.75),
             rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
    b.roll = 0;
    b.rollVel = 0;
    b.tilt = range(rnd, 0.14, 0.34);
    toPlane(b);
  }
  relayout();
}

function hideDiscs() {
  for (const b of discs) b.live = false;
}

/* ── THE ORBS: a claim coming in ───────────────────────────────────────────
   Each piece added after the start (addPiece) arrives as an orb of light in
   its rarity's colour. Before the bubble pops it flies at the bubble, speeding
   up as it nears, and goes in through the rim facing it, still moving (the
   bubble's catchMote takes it from there); after, it flies to the piece's
   place among the others, who have already made room, and the piece is there.
   One at a time, ORB_GAP apart, so a chest that fills at once still reads as
   pieces arriving. It flies in screen space, toward a target that is
   projected afresh every frame, so a bubble that pops mid-flight just turns it. */
const ORB_GAP = 0.24;   // s between launches
const ORB_TIME = 0.95;  // s in flight
const FLASH_TIME = 0.4; // s of the ring where it lands
const orbs = [];        // in flight: { index, tint, t0, sx, sy, lift, trail, into }
const orbQueue = [];    // waiting for their turn: { index, tint }
const flashes = [];     // { x, y, z, t0, tint }: world point of a landing
let lastLaunch = -Infinity;

function rgb(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* an orb's curve at `now`, and its velocity (px/s): from off screen, up and
   over, to the point of the bubble's rim that faces it, or to the piece's
   place once the bubble has popped. One launched at the bubble speeds up all
   the way, drawn in, so it meets the film moving and goes through; one
   launched after the pop eases into its place. */
const at = { x: 0, y: 0, vx: 0, vy: 0, dir: 0 };
function orbPath(o, now, out) {
  const s = Math.min(1, (now - o.t0) / ORB_TIME);
  const k = o.into ? s * s : easeInOut(s);
  const dk = o.into ? (2 * s) / ORB_TIME : 0;
  const x0 = o.sx * VW, y0 = o.sy * VH;
  let x1, y1, x2, y2;
  if (seq.burstAt < 0) {
    project(0, BUBBLE_Y + seq.bob, 0, tmp);
    const cx = tmp.x, cy = tmp.y, R = bub.r * SCALE;
    const dir = Math.atan2(Math.min(y0, cy) - o.lift * VH - cy, (x0 + cx) / 2 - cx);
    // the bend sits well clear of the bubble, so it comes in at speed, not round a corner
    const far = Math.max(Math.hypot((x0 - cx) / 2, Math.min(y0, cy) - o.lift * VH - cy), R * 1.6 + 40);
    x1 = cx + Math.cos(dir) * far; y1 = cy + Math.sin(dir) * far;
    const rr = R * bubbleEdge(dir, now);
    x2 = cx + Math.cos(dir) * rr; y2 = cy + Math.sin(dir) * rr;
    out.dir = dir;
  } else {
    const b = discs[o.index];
    project(b.hx, b.hy, b.hz, tmp);
    x2 = tmp.x; y2 = tmp.y;
    x1 = (x0 + x2) / 2; y1 = Math.min(y0, y2) - o.lift * VH;
    out.dir = 0;
  }
  const u = 1 - k;
  out.x = u * u * x0 + 2 * u * k * x1 + k * k * x2;
  out.y = u * u * y0 + 2 * u * k * y1 + k * k * y2;
  out.vx = 2 * (u * (x1 - x0) + k * (x2 - x1)) * dk;
  out.vy = 2 * (u * (y1 - y0) + k * (y2 - y1)) * dk;
  return out;
}

function stepOrbs(now) {
  // into a bubble that is blown, or to a place once it has popped
  const ready = seq.burstAt >= 0 || seq.grounded >= 0;
  while (ready && orbQueue.length && now - lastLaunch >= ORB_GAP) {
    const { index, tint } = orbQueue.shift();
    const rnd = mulberry32(hashSeed(SEED + ':orb' + index));
    // from beyond the left or the right edge, high up, so it sweeps in over the scene
    const side = rnd() < 0.5 ? -0.1 : 1.1;
    orbs.push({ index, tint, t0: now, sx: side, sy: range(rnd, 0.04, 0.34), lift: range(rnd, 0.12, 0.26), trail: [], into: seq.burstAt < 0 });
    lastLaunch = now;
  }
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i];
    if (now - o.t0 < ORB_TIME) continue;
    orbs.splice(i, 1);
    const b = discs[o.index];
    if (seq.burstAt < 0) {
      // through the film: it goes in where it met the rim, still moving, with
      // its tail, and the bubble takes it from there (catchMote)
      b.inBubble = true;
      orbPath(o, now, at);
      project(0, BUBBLE_Y + seq.bob, 0, tmp);
      const R = Math.max(1, bub.r * SCALE);
      catchMote(o.index, o.tint, at.dir, {
        u: (at.x - tmp.x) / R, v: -(at.y - tmp.y) / R,
        vu: at.vx / R, vv: -at.vy / R,
        trail: o.trail.map(([x, y]) => [(x - tmp.x) / R, -(y - tmp.y) / R]),
        // it met the rim between frames: it is already that far in
        late: now - o.t0 - ORB_TIME,
      }, now);
      emit('absorb', { index: o.index });
    } else {
      // there: among the others, with a small hop, and the float makes room
      b.inBubble = true;
      b.live = true;
      b.x = b.hx; b.y = b.hy; b.z = b.hz;
      toPlane(b);
      b.vu = 0; b.vv = 0.9;
      relayout();
      b.grow = 0.3;
      b.crack = 0; b.crackClock = -1;
      flashes.push({ x: b.hx, y: b.hy, z: b.hz, t0: now, tint: o.tint });
      emit('arrive', { index: o.index });
    }
  }
  for (let i = flashes.length - 1; i >= 0; i--) if (now - flashes[i].t0 > FLASH_TIME) flashes.splice(i, 1);
}

const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);

function drawOrbs(now) {
  const unit = Math.max(9, Math.min(VW, VH) * 0.034);
  for (const f of flashes) {
    const k = Math.min(1, (now - f.t0) / FLASH_TIME);
    project(f.x, f.y, f.z, tmp);
    const [r, g, bl] = rgb(f.tint);
    ctx.beginPath();
    ctx.arc(tmp.x, tmp.y, unit * (1 + k * 2.6), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${r},${g},${bl},${(1 - k) * 0.85})`;
    ctx.lineWidth = Math.max(1, unit * 0.35 * (1 - k));
    ctx.stroke();
  }
  for (const o of orbs) {
    orbPath(o, now, at);
    const x = at.x, y = at.y;
    o.trail.unshift([x, y]);
    if (o.trail.length > 9) o.trail.length = 9;
    const [r, g, bl] = rgb(o.tint);
    // the tail: fading, shrinking copies of where it has just been
    for (let j = o.trail.length - 1; j >= 1; j--) {
      const a = 0.28 * (1 - j / o.trail.length);
      ctx.beginPath();
      ctx.arc(o.trail[j][0], o.trail[j][1], unit * (0.62 - j * 0.045), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${bl},${a})`;
      ctx.fill();
    }
    // the glow, then the white-hot core
    const glow = ctx.createRadialGradient(x, y, 0, x, y, unit * 2.4);
    glow.addColorStop(0, `rgba(${r},${g},${bl},0.75)`);
    glow.addColorStop(0.35, `rgba(${r},${g},${bl},0.28)`);
    glow.addColorStop(1, `rgba(${r},${g},${bl},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, unit * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, unit * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();
  }
}

/** a piece that came in after the start: an orb flies it in (see THE ORBS) */
function addPiece(tint) {
  if (discs.length >= MAX_PIECES) return -1;
  const index = discs.length;
  const b = makeDisc(index);
  b.inBubble = false;
  b.tint = tint;
  discs.push(b);
  // the full chest is framed; after the pop it lands low, among the unopened ones
  fitTo(discs.length);
  if (seq.burstAt >= 0) arrivalPoint(b, index);
  // a carried bubble lights it from the draw's pieces instead (THE CARRIED BUBBLE)
  if (carry.on && seq.burstAt < 0) {
    clusterQueue.push({ index, tint });
    return index;
  }
  orbQueue.push({ index, tint });
  return index;
}

/* the host's open, rather than a tap's: at once if the bubble is blown, else the moment it is */
let openWanted = false;
function openBubble() {
  if (seq.opening || seq.burstAt >= 0) return;
  if (seq.grounded < 0) {
    openWanted = true;
    return;
  }
  seq.opening = true;
  emit('open', { clock: seq.clock });
}

/* ── THE BUBBLE ───────────────────────────────────────────────────────────
   In world units, in the plane facing the camera (RIGHT, UP) about its
   centre: the motes and the droplets are offsets (u, v) in that plane, v up.
   Drawn like a soap film in a dark room: almost clear in the middle and
   bright at the rim, where the film is seen edge on; its thin-film colours
   swirl round the rim only; a softbox's reflection sits on top; and the
   claims it holds orbit inside and light it. A catch squashes it along the
   line the orb came in on, and it rings back like a jelly. */
const BUBBLE_Y = 0.8;     // its centre: a little above the frame's centre while it collects
const BLOW_TIME = 0.55;   // s from nothing to blown, before it counts as landed
const POP_SWELL = 0.24;   // s of the last breath in before it pops
const HIT_TIME = 0.6;     // s the film rings where an orb went in
const HIT_LIGHT = 0.28;   // s the rim stays lit there: a flash, gone as the light moves on
const POP_FLASH = 0.14;   // s of the flash as it goes
const RING_TIME = 0.34;   // s of the ring the pop leaves
const DROP_LIFE = 0.6;    // s a droplet of the pop lives, at most
const SHARD_LIFE = 0.5;   // s a shred of the film lives, at most
const MOTE_IN = 1;        // s from coming through the film to being one of the swirl
const MOTE_K = 36, MOTE_C = 20;   // the bubble slowing what came in: a spring onto its orbit, over-damped, so it keeps the speed it came with and sheds it smoothly, like a stone into water
const DENT_K = 420, DENT_C = 16;  // the film where it went through: pushed in, and ringing back
const SETTLE_TIME = 1.2;  // s for the camera to turn from the bubble to what came out of it
/* the film's own colours, soft: interference, not a rainbow */
const FILM = ['#ff9ad5', '#c7a4ff', '#86d4ff', '#9cf0cf', '#ffe3a0', '#ffad8c', '#ff9ad5'];
const WARM = [255, 236, 210];
const bub = {
  r: 0, vel: 0,              // its size, on a spring
  sq: 0, sqVel: 0,           // the squash along `dir` (an oval), on a spring
  tri: 0, triVel: 0,         // a third of a wave on top, so it rings rather than breathes
  dir: -Math.PI / 2,         // screen angle of the last catch
  glow: 0,                   // the light of what it holds, eased
  caught: 0, born: -1, swellAt: -1, popAt: -1, popR: 0,
  motes: [], hits: [], drops: [], shards: [],
};
const bubAt = { x: 0, y: 0, d: 0 };
const mAt = { u: 0, v: 0, z: 0 };

/* it grows with what it holds, a step a claim, so each one shows: ten fill
   two thirds of a phone's width */
const bubbleSize = () => 0.4 + 0.068 * Math.min(MAX_PIECES, bub.caught);

function resetBubble() {
  bub.r = 0; bub.vel = 0; bub.sq = 0; bub.sqVel = 0; bub.tri = 0; bub.triVel = 0;
  bub.dir = -Math.PI / 2; bub.glow = 0; bub.caught = 0;
  bub.born = -1; bub.swellAt = -1; bub.popAt = -1; bub.popR = 0;
  bub.motes.length = 0; bub.hits.length = 0; bub.drops.length = 0; bub.shards.length = 0;
}

/* an orb came through the film at screen angle `dir`, at `entry` (where, u
   and v, and how fast, vu and vv, in bubble radii; and its tail): it carries
   on in as a mote, the bubble slowing it onto its orbit; the film dents where
   it went through and rings, and the rim lights in its colour */
function catchMote(index, tint, dir, entry, now) {
  const rnd = mulberry32(hashSeed(SEED + ':mote' + index));
  bub.caught += 1;
  bub.vel += 0.7;
  bub.dir = dir;
  bub.sqVel -= 0.45;   // flattened along the line it came in on first
  bub.triVel += 0.2;
  bub.hits.push({ a: dir, t0: now, tint, dent: 0, dv: 3 });
  // each mote orbits the middle on its own tilted ring, so some pass behind;
  // this one's starts on the side it came in, turning inward and toward the
  // camera, so the swirl carries on the way it was going
  const right = Math.cos(dir) >= 0;
  const jitter = rnd() * 0.3;
  const m = {
    index, tint, t0: now,
    a: right ? jitter : Math.PI - jitter,
    rad: range(rnd, 0.2, 0.55),
    tilt: (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.25, 0.5),
    yo: range(rnd, -0.2, 0.2),
    w: (right ? 1 : -1) * range(rnd, 0.45, 0.9),
    ph: rnd() * 6.28,
    ou: 0, ov: 0, vu: 0, vv: 0,   // how far off its orbit it still is, and how fast
    trail: entry.trail,
    grow: 1, out: 1,              // whole, and in its place (a carried bubble's find grows into both)
  };
  moteAt(m, now, mAt);
  m.ou = entry.u - mAt.u;
  m.ov = entry.v - mAt.v;
  // the speed it came with, all of it, so it does not stall on the film
  const speed = Math.hypot(entry.vu, entry.vv);
  const keep = speed > 0 ? Math.min(16, Math.max(3, speed)) / speed : 0;
  m.vu = entry.vu * keep;
  m.vv = entry.vv * keep;
  m.ou += m.vu * entry.late;
  m.ov += m.vv * entry.late;
  bub.motes.push(m);
}

/* a mote's place in units of the bubble's radius (v up), and how near the camera it is (z, -1 to 1) */
function moteAt(m, t, out) {
  out.u = Math.cos(m.a) * m.rad + m.ou;
  out.v = m.yo + Math.sin(m.a) * m.rad * m.tilt + Math.sin(t * 1.3 + m.ph) * 0.03 + m.ov;
  out.z = Math.sin(m.a);
  return out;
}

/* where a mote is now, as a world point */
function motePoint(m, out) {
  moteAt(m, seq.clock, mAt);
  const u = mAt.u * bub.r, v = mAt.v * bub.r;
  out.x = RIGHT.x * u + UP.x * v;
  out.y = BUBBLE_Y + seq.bob + RIGHT.y * u + UP.y * v;
  out.z = RIGHT.z * u + UP.z * v;
  return out;
}

function popBubble(now) {
  const rnd = mulberry32(hashSeed(SEED + ':pop'));
  bub.popAt = now;
  bub.popR = bub.r;
  // a fine spray in the film's colours, thrown unevenly, as a real one is
  const N = 30;
  for (let i = 0; i < N; i++) {
    const a = rnd() * Math.PI * 2;
    const speed = range(rnd, 1.1, 4.2);
    const from = bub.r * range(rnd, 0.82, 1);
    bub.drops.push({
      u: Math.cos(a) * from, v: Math.sin(a) * from,
      vu: Math.cos(a) * speed, vv: Math.sin(a) * speed,
      t0: now, life: range(rnd, 0.3, DROP_LIFE), size: range(rnd, 0.008, 0.022),
      tint: FILM[i % (FILM.length - 1)],
    });
  }
  // and shreds of the film itself, curling away from where it was
  for (let i = 0; i < 10; i++) {
    bub.shards.push({
      a: (i / 10) * Math.PI * 2 + range(rnd, -0.2, 0.2),
      span: range(rnd, 0.22, 0.42),
      d: bub.r, vd: range(rnd, 0.8, 1.6), spin: range(rnd, -1.2, 1.2),
      t0: now, life: range(rnd, 0.3, SHARD_LIFE),
      tint: FILM[i % (FILM.length - 1)],
    });
  }
  seq.visible = false;
  seq.burstAt = now;
  seq.exitAt = now;
  burst();
  emit('burst', {});
}

function stepBubble(dt, now) {
  seq.clock = now;
  if (bub.born < 0) bub.born = now;
  let want = bubbleSize();
  // the last breath in: it swells and trembles, and goes
  if (seq.opening && bub.popAt < 0) {
    if (bub.swellAt < 0) bub.swellAt = now;
    const k = Math.min(1, (now - bub.swellAt) / POP_SWELL);
    want *= 1 + 0.14 * k;
    if (k >= 1) popBubble(now);
  }
  // a spring, so it blows up past its size and settles back
  bub.vel += (want - bub.r) * 70 * dt - bub.vel * 7.5 * dt;
  bub.r += bub.vel * dt;
  // the jelly: an oval that swaps axes a few times, and a quicker ripple on it
  bub.sqVel += (-bub.sq * 120 - bub.sqVel * 6) * dt;
  bub.sq = Math.max(-0.12, Math.min(0.12, bub.sq + bub.sqVel * dt));
  bub.triVel += (-bub.tri * 260 - bub.triVel * 9) * dt;
  bub.tri = Math.max(-0.05, Math.min(0.05, bub.tri + bub.triVel * dt));
  for (const m of bub.motes) {
    m.a += m.w * dt;
    // what it came in with, worn off by the bubble
    m.vu += (-m.ou * MOTE_K - m.vu * MOTE_C) * dt;
    m.vv += (-m.ov * MOTE_K - m.vv * MOTE_C) * dt;
    m.ou += m.vu * dt;
    m.ov += m.vv * dt;
  }
  for (const h of bub.hits) {
    h.dv += (-h.dent * DENT_K - h.dv * DENT_C) * dt;
    h.dent += h.dv * dt;
  }
  // the more it holds, the brighter it glows; brightest as it goes
  const swell = bub.swellAt >= 0 ? Math.min(1, (now - bub.swellAt) / POP_SWELL) : 0;
  const glowWant = bub.caught ? Math.min(1, 0.35 + (0.65 * bub.caught) / MAX_PIECES) + 0.5 * swell : 0;
  bub.glow += (glowWant - bub.glow) * Math.min(1, dt * 3);
  for (let i = bub.hits.length - 1; i >= 0; i--) if (now - bub.hits[i].t0 > HIT_TIME) bub.hits.splice(i, 1);

  if (seq.grounded < 0 && now - bub.born > BLOW_TIME) {
    seq.grounded = now;
    emit('landed', {});
    if (openWanted && !seq.opening) {
      seq.opening = true;
      emit('open', { clock: seq.clock });
    }
  }
  // blown and waiting: it floats, rising and falling a little
  seq.bob = seq.grounded >= 0 && bub.popAt < 0 ? Math.sin((now - seq.grounded) * 1.7) * 0.035 : 0;

  for (let i = bub.drops.length - 1; i >= 0; i--) {
    const d = bub.drops[i];
    if (now - d.t0 > d.life) { bub.drops.splice(i, 1); continue; }
    const drag = Math.exp(-dt * 3.2);
    d.vu *= drag;
    d.vv = d.vv * drag - 2.4 * dt;
    d.u += d.vu * dt;
    d.v += d.vv * dt;
  }
  for (let i = bub.shards.length - 1; i >= 0; i--) {
    const s = bub.shards[i];
    if (now - s.t0 > s.life) { bub.shards.splice(i, 1); continue; }
    s.vd *= Math.exp(-dt * 2.6);
    s.d += s.vd * dt;
    s.a += s.spin * dt;
  }
  // the camera turns from the bubble to what came out of it
  if (seq.exitAt >= 0) seq.blend = easeOut(Math.min(1, (now - seq.exitAt) / SETTLE_TIME));
}

/* still on screen after the pop: its flash, its ring, its spray or its shreds */
const popShowing = () =>
  bub.drops.length > 0 || bub.shards.length > 0 || (bub.popAt >= 0 && clock - bub.popAt < RING_TIME);

/* the outline: a circle the jelly squashes, dents where orbs went through, a hair of idle drift, a tremble before it goes */
function bubbleEdge(th, t) {
  const a = th - bub.dir;
  let e = 1 + bub.sq * Math.cos(2 * a) + bub.tri * Math.cos(3 * a) + 0.007 * Math.sin(2 * th + t * 1.1);
  // dented where an orb went through
  for (const h of bub.hits) {
    let d = th - h.a;
    d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
    e -= h.dent * Math.exp(-d * d * 8);
  }
  if (bub.swellAt >= 0 && bub.popAt < 0) {
    e += 0.012 * Math.min(1, (t - bub.swellAt) / POP_SWELL) * Math.sin(7 * th + t * 38);
  }
  return e;
}

function bubblePath(g, cx, cy, R, t) {
  g.beginPath();
  for (let k = 0; k <= 72; k++) {
    const th = (k / 72) * Math.PI * 2;
    const rr = R * bubbleEdge(th, t);
    const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr;
    if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
}

/* a stretch of the outline from a0 to a1, `inset` of the way out */
function rimArc(g, cx, cy, R, t, a0, a1, inset) {
  g.beginPath();
  const n = 20;
  for (let k = 0; k <= n; k++) {
    const th = a0 + ((a1 - a0) * k) / n;
    const rr = R * inset * bubbleEdge(th, t);
    const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr;
    if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
}

const ink = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; };

/* the light of what it holds: the motes' colours, warmed */
function insideTint() {
  if (!bub.motes.length) return WARM;
  let r = 0, g = 0, b = 0;
  for (const m of bub.motes) { const c = rgb(m.tint); r += c[0]; g += c[1]; b += c[2]; }
  const n = bub.motes.length;
  return [r / n, g / n, b / n].map((v, i) => Math.round(v * 0.55 + WARM[i] * 0.45));
}

function conic(g, angle, x, y, R, stops) {
  const grad = typeof g.createConicGradient === 'function'
    ? g.createConicGradient(angle, x, y)
    : g.createLinearGradient(x - R, y - R, x + R, y + R);
  stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c));
  return grad;
}

/* the motes on one side of the middle: the far ones smaller and dimmer, seen
   through the film; one that has just come in is still the orb it was, its
   size, its glow and its tail, and settles into the swirl over MOTE_IN. A
   carried bubble's find (THE CARRIED BUBBLE) grows at the middle, small,
   over the drop it set from, a touch big as it leaves, and goes out to its
   place (grow, out) */
function drawMotes(c, R, t, front) {
  const orbUnit = Math.max(9, Math.min(VW, VH) * 0.034) * 1.15;   // the orb's core, in a mote's measure
  for (const m of bub.motes) {
    if (m.grow <= 0) continue;
    moteAt(m, t, mAt);
    if ((m.out < 1 || mAt.z >= 0) !== front) continue;
    const near = (mAt.z + 1) / 2;
    const k = Math.min(1, (t - m.t0) / MOTE_IN), e = k * k * (3 - 2 * k);
    const x = c.x + mAt.u * R * m.out, y = c.y - mAt.v * R * m.out;
    const unit = (orbUnit + (Math.max(4, R * 0.11) * (0.75 + 0.4 * near) - orbUnit) * e) * (0.35 + 0.85 * m.grow - 0.2 * m.out);
    const alpha = (1 + (0.45 + 0.55 * near - 1) * e) * m.grow;
    const [r, g, b] = rgb(m.tint);
    // the tail it came in with, gone in 0.15 s as it slows
    if (m.trail) {
      m.trail.unshift([mAt.u, mAt.v]);
      const keep = Math.round(9 * Math.max(0, 1 - (t - m.t0) / 0.15));
      if (m.trail.length > keep) m.trail.length = keep;
      for (let j = m.trail.length - 1; j >= 1; j--) {
        ctx.beginPath();
        ctx.arc(c.x + m.trail[j][0] * R, c.y - m.trail[j][1] * R, unit * (0.54 - j * 0.04), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${0.28 * (1 - j / m.trail.length) * (1 - e)})`;
        ctx.fill();
      }
      if (!m.trail.length) m.trail = null;
    }
    const spread = 2.09 + 0.51 * e;   // the orb's glow, widening to a mote's
    const glow = ctx.createRadialGradient(x, y, 0, x, y, unit * spread);
    glow.addColorStop(0, `rgba(${r},${g},${b},${(0.75 - 0.15 * e) * alpha})`);
    glow.addColorStop(0.35, `rgba(${r},${g},${b},${(0.28 - 0.1 * e) * alpha})`);
    glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, unit * spread, 0, Math.PI * 2);
    ctx.fill();
    // the claim itself: white-hot in the middle, its colour at the edge
    const core = ctx.createRadialGradient(x - unit * 0.12, y - unit * 0.12, 0, x, y, unit * 0.48);
    core.addColorStop(0, `rgba(255,255,255,${0.98 * alpha})`);
    core.addColorStop(0.55, `rgba(255,255,255,${0.9 * alpha})`);
    core.addColorStop(1, `rgba(${(r + 255) >> 1},${(g + 255) >> 1},${(b + 255) >> 1},${0.75 * alpha})`);
    ctx.beginPath();
    ctx.arc(x, y, unit * 0.48, 0, Math.PI * 2);
    ctx.fillStyle = core;
    ctx.fill();
  }
}

/* THE FILM'S COLOURS, at the rim only. Drawn off screen at css px (they are
   soft, so no need for the device's pixels): the bands turn slowly round a
   centre that drifts, so they swirl, and a radial mask keeps them to the rim. */
const iri = document.createElement('canvas');
iri.width = iri.height = 64;   // not the default 300 × 150: it is square, and grows
const ictx = iri.getContext('2d');
function drawIridescence(c, R, t, swell) {
  if (!ictx) return;
  const need = Math.ceil(R * 2.3) + 8;
  if (iri.width < need) iri.width = iri.height = Math.ceil(need / 64) * 64;
  // (both sides at once: a canvas sized one side at a time keeps the other's default)
  const S = iri.width, h = S / 2;
  ictx.setTransform(1, 0, 0, 1, 0, 0);
  ictx.globalCompositeOperation = 'source-over';
  ictx.globalAlpha = 1;
  ictx.clearRect(0, 0, S, S);
  ictx.save();
  bubblePath(ictx, h, h, R, t);
  ictx.clip();
  ictx.fillStyle = conic(ictx, t * 0.35, h + Math.sin(t * 0.5) * R * 0.18, h + Math.cos(t * 0.4) * R * 0.14, R, FILM);
  ictx.fillRect(0, 0, S, S);
  ictx.restore();
  ictx.globalCompositeOperation = 'destination-in';
  const mask = ictx.createRadialGradient(h, h, R * 0.6, h, h, R * 1.02);
  mask.addColorStop(0, 'rgba(0,0,0,0)');
  mask.addColorStop(0.6, 'rgba(0,0,0,0.22)');
  mask.addColorStop(1, 'rgba(0,0,0,0.9)');
  ictx.fillStyle = mask;
  ictx.fillRect(0, 0, S, S);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.55 + 0.3 * swell;
  ctx.drawImage(iri, c.x - h, c.y - h);
  ctx.restore();
}

/* a curved band of reflected light hugging the rim, fading at both ends */
function reflection(c, R, t, a0, a1, r0, r1, alpha) {
  rimArc(ctx, c.x, c.y, R, t, a0, a1, r1);
  const n = 20;
  for (let k = n; k >= 0; k--) {
    const th = a0 + ((a1 - a0) * k) / n;
    const rr = R * r0 * bubbleEdge(th, t);
    ctx.lineTo(c.x + Math.cos(th) * rr, c.y + Math.sin(th) * rr);
  }
  ctx.closePath();
  const span = (a1 - a0) / (Math.PI * 2);
  if (typeof ctx.createConicGradient === 'function') {
    const g = ctx.createConicGradient(a0, c.x, c.y);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(span * 0.35, `rgba(255,255,255,${alpha})`);
    g.addColorStop(span * 0.65, `rgba(255,255,255,${alpha})`);
    g.addColorStop(span, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = `rgba(255,255,255,${alpha * 0.6})`;
  }
  ctx.fill();
}

function drawBubble(t) {
  if (!seq.visible) return;
  const c = project(0, BUBBLE_Y + seq.bob, 0, bubAt);
  // a carried bubble: where the draw left it, gliding to its spot
  c.x += carry.dx; c.y += carry.dy;
  const R = bub.r * SCALE;
  if (R < 0.5) return;
  const swell = bub.swellAt >= 0 ? Math.min(1, (t - bub.swellAt) / POP_SWELL) : 0;
  const [gr, gg, gb] = insideTint();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // what it holds lights the room around it
  if (bub.glow > 0.01) {
    const halo = ctx.createRadialGradient(c.x, c.y, R * 0.2, c.x, c.y, R * 2.1);
    halo.addColorStop(0, `rgba(${gr},${gg},${gb},${(0.16 * bub.glow).toFixed(3)})`);
    halo.addColorStop(0.5, `rgba(${gr},${gg},${gb},${(0.05 * bub.glow).toFixed(3)})`);
    halo.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R * 2.1, 0, Math.PI * 2);
    ctx.fill();
  }
  // the far motes, behind the film
  drawMotes(c, R, t, false);
  // a carried bubble's pieces, inside it
  drawCarriedInside(c, R, t);
  ctx.globalCompositeOperation = 'source-over';
  // the film: clear in the middle, brighter towards the rim
  bubblePath(ctx, c.x, c.y, R, t);
  const film = ctx.createRadialGradient(c.x - R * 0.15, c.y - R * 0.2, 0, c.x, c.y, R);
  film.addColorStop(0, 'rgba(170,195,255,0.02)');
  film.addColorStop(0.62, 'rgba(170,195,255,0.035)');
  film.addColorStop(0.86, 'rgba(190,210,255,0.09)');
  film.addColorStop(0.97, 'rgba(220,232,255,0.22)');
  film.addColorStop(1, 'rgba(240,246,255,0.3)');
  ctx.fillStyle = film;
  ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  // and lit from inside
  if (bub.glow > 0.01) {
    const inner = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R * 0.8);
    inner.addColorStop(0, `rgba(${gr},${gg},${gb},${(0.14 * bub.glow).toFixed(3)})`);
    inner.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
    ctx.fillStyle = inner;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R * 0.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  drawIridescence(c, R, t, swell);
  ctx.globalCompositeOperation = 'lighter';
  // the near motes, in front of the middle
  drawMotes(c, R, t, true);
  // the rim: lit from the top left, a bounce at the bottom right
  bubblePath(ctx, c.x, c.y, R, t);
  const rim = ctx.createLinearGradient(c.x - R, c.y - R, c.x + R, c.y + R);
  rim.addColorStop(0, `rgba(255,255,255,${(0.55 + 0.3 * swell).toFixed(3)})`);
  rim.addColorStop(0.5, 'rgba(255,255,255,0.1)');
  rim.addColorStop(1, `rgba(255,255,255,${(0.35 + 0.3 * swell).toFixed(3)})`);
  ctx.strokeStyle = rim;
  ctx.lineWidth = Math.max(1, R * 0.014);
  ctx.stroke();
  ctx.lineCap = 'round';
  // an orb on its way lights the film it is about to go through, brighter as it nears
  if (seq.burstAt < 0) {
    for (const o of orbs) {
      if (!o.into) continue;
      orbPath(o, t, at);
      const near = Math.min(1, 1 - (Math.hypot(at.x - c.x, at.y - c.y) - R) / (R * 1.2));
      if (near <= 0) continue;
      rimArc(ctx, c.x, c.y, R, t, at.dir - 0.32, at.dir + 0.32, 0.995);
      ctx.strokeStyle = ink(o.tint, (0.75 * near * near).toFixed(3));
      ctx.lineWidth = Math.max(1, R * 0.04 * near);
      ctx.stroke();
    }
  }
  // where it went in, a flash in its colour, gone as the light moves on
  for (const hit of bub.hits) {
    const k = Math.min(1, (t - hit.t0) / HIT_LIGHT);
    if (k >= 1) continue;
    const spread = 0.32 + 0.2 * k;
    rimArc(ctx, c.x, c.y, R, t, hit.a - spread, hit.a + spread, 0.995);
    ctx.strokeStyle = ink(hit.tint, (0.9 * (1 - k) * (1 - k)).toFixed(3));
    ctx.lineWidth = Math.max(1, R * 0.04 * (1 - k));
    ctx.stroke();
  }
  drawCarriedFront(c, R, t);
  ctx.globalCompositeOperation = 'source-over';
  // the reflections: a softbox in the top left, its faint bounce in the bottom right
  reflection(c, R, t, -2.62, -1.72, 0.72, 0.86, 0.5);
  reflection(c, R, t, 0.35, 1.1, 0.8, 0.88, 0.14);
  // and the sun's glint in it: small and sharp
  const sx = c.x + Math.cos(-2.3) * R * 0.62, sy = c.y + Math.sin(-2.3) * R * 0.62;
  const spec = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 0.045);
  spec.addColorStop(0, 'rgba(255,255,255,0.95)');
  spec.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  ctx.beginPath();
  ctx.arc(sx, sy, R * 0.045, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPop(t) {
  if (bub.popAt < 0) return;
  const c = project(0, BUBBLE_Y, 0, bubAt);
  const R = bub.popR * SCALE;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  // the flash as it goes
  const f = (t - bub.popAt) / POP_FLASH;
  if (f < 1) {
    const flash = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R * 1.1);
    flash.addColorStop(0, `rgba(255,255,255,${(0.35 * (1 - f)).toFixed(3)})`);
    flash.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = flash;
    ctx.beginPath();
    ctx.arc(c.x, c.y, R * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  // the ring it leaves
  const k = (t - bub.popAt) / RING_TIME;
  if (k < 1) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, R * (1 + k * 0.45), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(235,240,255,${(0.45 * (1 - k) * (1 - k)).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.75, R * 0.02 * (1 - k));
    ctx.stroke();
  }
  // shreds of the film, shrinking as they curl away
  for (const s of bub.shards) {
    const life = 1 - (t - s.t0) / s.life;
    const half = (s.span / 2) * life;
    ctx.beginPath();
    ctx.arc(c.x, c.y, s.d * SCALE, s.a - half, s.a + half);
    ctx.strokeStyle = ink(s.tint, (0.75 * life).toFixed(3));
    ctx.lineWidth = Math.max(1, R * 0.02 * life);
    ctx.stroke();
  }
  // the spray, each droplet a short streak along its way
  for (const d of bub.drops) {
    const life = 1 - (t - d.t0) / d.life;
    const x = c.x + d.u * SCALE, y = c.y - d.v * SCALE;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - d.vu * SCALE * 0.025, y + d.vv * SCALE * 0.025);
    ctx.strokeStyle = ink(d.tint, (0.85 * life).toFixed(3));
    ctx.lineWidth = Math.max(0.8, d.size * SCALE * life);
    ctx.stroke();
  }
  ctx.restore();
}

function stepDiscs(dt, t) {
  for (const b of discs) {
    if (!b.live) continue;
    // a piece that came out small (a claim landing, the bubble's pop) swells to its size
    b.grow += (1 - b.grow) * Math.min(1, dt * 7);
    // no rotation — just a slight wiggle: a rock around upright plus the
    // usual breathing tilt
    b.roll = Math.sin(t * b.wob[2] * 1.2 + b.wob[5]) * 0.07;
    b.tiltX = Math.sin(t * b.wob[0] * 1.3 + b.wob[3]) * b.tilt * 0.6;
    b.tiltY = Math.cos(t * b.wob[1] * 1.1 + b.wob[4]) * b.tilt * 0.6;
  }
}

/* every live piece springs toward its spot, breathing around it; a dragged
   one follows the finger instead. What is on the move pushes what it meets
   aside: the finger's piece firmly, an opened one rising past gently and
   mostly sideways, so the pile edges out of its way and settles back. A
   rising piece trails a little light in its rarity's colour. */
function floatDiscs(dt, t) {
  const k = FLOAT_EASE * FLOAT_EASE, c = 2 * FLOAT_EASE;
  const held = dragging && dragDisc && dragDisc.live ? dragDisc : null;
  for (const b of discs) {
    if (!b.live) continue;
    if (b === held) {
      const f = Math.min(1, dt * DRAG_FOLLOW);
      b.u += (b.fu - b.u) * f;
      b.v += (b.fv - b.v) * f;
      b.vu = 0; b.vv = 0;
      continue;
    }
    const su = b.tu + Math.sin(t * b.wob[0] + b.wob[3]) * BREATH_U;
    const sv = b.tv + Math.sin(t * b.wob[1] + b.wob[4]) * BREATH_V;
    b.vu += ((su - b.u) * k - b.vu * c) * dt;
    b.vv += ((sv - b.v) * k - b.vv * c) * dt;
    b.u += b.vu * dt;
    b.v += b.vv * dt;
  }
  const reach = BALL_R * 2 * DRAG_HALO;
  for (const m of discs) {
    if (!m.live) continue;
    const firm = m === held;
    if (!firm && !(m.opened && Math.hypot(m.tu - m.u, m.tv - m.v) > RISING)) continue;
    for (const b of discs) {
      if (b === m || b === held || !b.live) continue;
      const du = b.u - m.u, dv = b.v - m.v;
      const d = Math.hypot(du, dv);
      if (d >= reach) continue;
      if (firm) {
        const nu = d < 1e-6 ? 1 : du / d, nv = d < 1e-6 ? 0 : dv / d;
        b.u = m.u + nu * reach;
        b.v = m.v + nv * reach;
      } else {
        // aside, not ahead: mostly sideways, so it is not carried up
        const side = du >= 0 ? 1 : -1;
        const len = Math.hypot(1, dv * 0.3) || 1;
        const give = (reach - d) * MAKE_WAY;
        b.u += (side / len) * give;
        b.v += ((dv * 0.3) / len) * give;
      }
    }
  }
  for (const b of discs) {
    if (!b.live) continue;
    keepOnScreen(b);
    b.x = RIGHT.x * b.u + UP.x * b.v + EYE.x * b.dep;
    b.y = FLOAT_Y + RIGHT.y * b.u + UP.y * b.v + EYE.y * b.dep;
    b.z = RIGHT.z * b.u + UP.z * b.v + EYE.z * b.dep;
    if (b.opened && b !== held && Math.hypot(b.vu, b.vv) > 0.5) b.trail.push({ x: b.x, y: b.y, z: b.z, t });
    while (b.trail.length && t - b.trail[0].t > TRAIL_TIME) b.trail.shift();
  }
}

const trailing = () => discs.some((b) => b.live && b.trail.length > 0);

/* a rising piece's light: a soft stroke from where it is back along its path,
   in its rarity's colour, gone at the far end. Under the piece's own image. */
function drawTrails() {
  for (const b of discs) {
    if (!b.live || b.trail.length < 2) continue;
    project(b.trail[0].x, b.trail[0].y, b.trail[0].z, tmp);
    const x0 = tmp.x, y0 = tmp.y;
    project(b.x, b.y, b.z, tmp);
    if (Math.hypot(tmp.x - x0, tmp.y - y0) < 2) continue;
    const [r, g, bl] = rgb(b.tint);
    const grad = ctx.createLinearGradient(tmp.x, tmp.y, x0, y0);
    grad.addColorStop(0, `rgba(${r},${g},${bl},0.42)`);
    grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = BALL_R * SCALE * 0.9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tmp.x, tmp.y);
    ctx.lineTo(x0, y0);
    ctx.stroke();
  }
}

/* the live pieces whose flat art this canvas draws (the wrapping layer draws the rest) */
function collectDiscs() {
  poolUsed = 0;
  for (let i = 0; i < discs.length; i++) {
    const b = discs[i];
    if (!b.live || spriteHidden.has(i)) continue;
    project(b.x, b.y, b.z, tmp);
    const it = claim();
    it.d = tmp.d;
    it.x = tmp.x;
    it.y = tmp.y;
    it.ref = b;
  }
}

function drawDisc(it) {
  const b = it.ref;
  const r = BALL_R * SCALE * b.grow;
  ctx.save();
  ctx.translate(it.x, it.y);
  ctx.rotate(b.roll);
  // leaning off the camera squashes the circle: the whole of the 2.5D effect
  ctx.scale(Math.cos(b.tiltY || 0), Math.cos(b.tiltX || 0));
  const entry = sprites[discs.indexOf(b)];
  const sprite = entry && entry.image ? entry.image : entry;
  if (sprite && sprite.width) {
    // a collectable: contain-fit the artwork in the disc's box. `scale`
    // comes from the wrapping layer's own fit math (art bbox at BASE.fit of
    // the box), so the flat art and the wrapped art are the SAME size and
    // the break never pops the picture bigger.
    const fit = entry && entry.scale ? entry.scale : 1;
    const k = (r * 2 * fit) / Math.max(sprite.width, sprite.height);
    const w = sprite.width * k, h = sprite.height * k;
    ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
  } else {
    ctx.drawImage(DISC_SKINS[b.skin], -r, -r, r * 2, r * 2);
  }
  ctx.restore();
}


/* ── THE CARRIED BUBBLE: the draw's hold ─────────────────────────────────
   Holding on the draw's ending (lib/draw/hold/scene) gathers the draw's own
   pieces into a bubble and floats it up to where this one blows up, and hands
   it over (lib/chest-scene/carry → opts.carried). Then the bubble does not
   blow up from nothing: it is already blown, where it was, and glides the
   last of the way to its spot, the draw's pieces swirling in it as little
   dots in their own colours. And a claim that comes in does not fly in from
   off screen: it is FOUND from those pieces. It takes a share of the pieces still free; they take its
   colour and come straight to the middle, each reaching for the drop there
   with a neck over its last stretch, and merge into it like drops of water.
   The drop swells as they join and wobbles, flashes white, and sets into the
   claim's mote, which grows there and then goes out to its own place in the
   swirl while a gleam of its colour runs along the rim on that side. As it
   goes out the claim counts: the bubble takes the kick and grows. The room
   stays the dark of the draw's hold, its stars behind (components/chest/starfield).
   Claims start FIND_GAP apart, so one is still setting as the next gathers.
   A win's prize went in as a glint: it joins the drop of the first claim
   that is not common. As the bubble swells to pop, whatever is left melts
   into the film. How many claims there will be is never needed: each takes
   a share of what is left. */
const FIND_TIME = 1.4;      // s from a claim taking its pieces to its mote settled in its place
const FIND_GAP = 0.6;       // s from one claim's start to the next one's, so they overlap
const FIND_SHARE = 0.25;    // of the pieces still free, the share a claim takes
/* a find's steps, as shares of FIND_TIME */
const PIECE_STAGGER = 0.14; // its pieces set off over this much, each at its own seed
const PIECE_RUN = 0.42;     // one piece's way to the middle
const TINT_RUN = 0.12;      // its pieces taking its colour, from the start
const SET_FROM = 0.58;      // the drop setting into the mote, which grows at the middle...
const SET_TO = 0.74;        // ...until it goes out to its place, and the claim counts
const FLASH_FROM = 0.6, FLASH_TO = 0.72;   // the white flash as it sets
const NECK = 22;            // px from the middle where a piece reaches for the drop
const DOT_R = 3;            // px, a piece swirling free
const PIECE_END_R = 2.25;   // px, a piece as it joins the drop
const GLEAM_SPAN = 1;       // radians of rim the gleam lights, round the find's place
const COMMON = '#e3ecff';   // the common tier's colour (components/chest/chest-scene TIER_TINT)
const GLINT = [242, 242, 242];
const dust = [];           // the draw's pieces: { ang, w, rr, col, ink, seed, k, find, u0, v0, spent }
const clusters = [];       // claims being found: { index, tint, col, ink, glow, m (its mote), t0, n, joined, shown, lit }
const clusterQueue = [];   // claims waiting their turn: { index, tint }
const carry = { on: false, placed: false, told: false, from: null, base: 0, dx: 0, dy: 0, vx: 0, vy: 0, glint: null, since: 0 };
let lastCluster = -Infinity;
const carrySmooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
/** how far x is from a to b, 0–1 */
const between = (x, a, b) => Math.max(0, Math.min(1, (x - a) / (b - a)));
/** where a piece is round the middle: the draw page's swirl, carried on, on the same clock */
const dustAngle = (d) => d.ang + d.w * (performance.now() / 1000 - carry.base);

function startCarried(c) {
  // the bubble's clock is the one it was carried on (performance.now()), so its
  // film and its swirl carry on from the draw without a jump
  clock = performance.now() / 1000;
  seq.clock = clock;
  last = performance.now();
  carry.on = true; carry.placed = false; carry.told = false; carry.from = c; carry.base = c.at / 1000;
  carry.dx = carry.dy = carry.vx = carry.vy = 0;
  carry.glint = c.glint ? { find: null, spent: false } : null;
  carry.since = clock;
  dust.length = 0;
  c.pieces.forEach((p, k) => dust.push({
    ang: p.angle, w: p.speed, rr: p.radius, col: p.color, ink: `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`,
    seed: p.seed, k, find: null, u0: 0, v0: 0, spent: false,
  }));
  // already blown: it counts as landed on its first step
  bub.born = -BLOW_TIME - 0.01;
  lastCluster = clock;
}
function dropCarried() {
  carry.on = false; carry.placed = false; carry.from = null; carry.glint = null;
  dust.length = 0; clusters.length = 0; clusterQueue.length = 0;
}
/* the first frame with a camera: the bubble where the draw left it; then the glide to its spot */
function placeCarried(dt) {
  if (!carry.on) return;
  if (!carry.placed) {
    carry.placed = true;
    const rect = canvasEl.getBoundingClientRect();
    project(0, BUBBLE_Y + seq.bob, 0, tmp);
    carry.dx = carry.from.x - rect.left - tmp.x;
    carry.dy = carry.from.y - rect.top - tmp.y;
    bub.r = carry.from.r / SCALE;
    bub.vel = 0;
    return;
  }
  const k = 40, damp = 2 * Math.sqrt(k);
  carry.vx += (-carry.dx * k - carry.vx * damp) * dt; carry.dx += carry.vx * dt;
  carry.vy += (-carry.dy * k - carry.vy * damp) * dt; carry.dy += carry.vy * dt;
}
/* a claim's mote, as catchMote would have it, before it is found: drawn
   only once it sets (grow), at the middle until it goes out (out) */
function pendingMote(index, tint, now) {
  const rnd = mulberry32(hashSeed(SEED + ':mote' + index));
  const right = index % 2 === 0;
  const jitter = rnd() * 0.3;
  return {
    index, tint, t0: now,
    a: (right ? jitter : Math.PI - jitter) + index * 1.3,
    rad: range(rnd, 0.2, 0.55),
    tilt: (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.25, 0.5),
    yo: range(rnd, -0.2, 0.2),
    w: (right ? 1 : -1) * range(rnd, 0.45, 0.9),
    ph: rnd() * 6.28,
    ou: 0, ov: 0, vu: 0, vv: 0, trail: null,
    grow: 0, out: 0,
  };
}
/* a soft glow in a find's colour, its colour at the middle and gone at the
   edge: drawn once a colour, so a piece's glow each frame is one drawImage */
const glows = new Map();
function glowSprite(ink, clear) {
  let s = glows.get(ink);
  if (s) return s;
  s = document.createElement('canvas');
  s.width = s.height = 64;
  const x = s.getContext('2d');
  if (x) {
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, ink); g.addColorStop(1, clear);
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  }
  glows.set(ink, s);
  return s;
}
/* a claim is found: it takes its share of the pieces still free, every so
   many of them, so they come to the middle from all round the bubble */
function startFind(index, tint, now) {
  const [r, g, b] = rgb(tint);
  const ink = `rgb(${r},${g},${b})`, clear = `rgba(${r},${g},${b},0)`;
  const f = {
    index, tint, col: [r, g, b], ink, glow: glowSprite(ink, clear),
    m: pendingMote(index, tint, now), t0: now, n: 0, joined: 0, shown: false, lit: false,
  };
  let free = 0;
  for (const d of dust) if (!d.find) free++;
  const take = Math.ceil(free * FIND_SHARE);
  let k = 0;
  for (const d of dust) {
    if (d.find) continue;
    if (f.n < take && k === Math.floor((f.n * free) / take)) {
      d.find = f;
      // where it sets off from, round the middle in radii, until it does
      const a = dustAngle(d);
      d.u0 = Math.cos(a) * d.rr; d.v0 = Math.sin(a) * d.rr * 0.85;
      f.n++;
    }
    k++;
  }
  if (carry.glint && !carry.glint.find && String(tint).toLowerCase() !== COMMON) carry.glint.find = f;
  clusters.push(f);
}
function stepClusters(dt, now) {
  if (!carry.on) return;
  // its place keeps turning until its mote is in the bubble, which turns it from then
  for (const f of clusters) if (!f.shown) f.m.a += f.m.w * dt;
  // popped before they counted: the rest fly to their places as orbs
  if (seq.burstAt >= 0) {
    for (const f of clusters) {
      if (f.lit) { f.m.grow = f.m.out = 1; continue; }
      if (f.shown) bub.motes.splice(bub.motes.indexOf(f.m), 1);
      orbQueue.push({ index: f.index, tint: f.tint });
    }
    while (clusterQueue.length) orbQueue.push(clusterQueue.shift());
    clusters.length = 0;
    return;
  }
  if (seq.grounded >= 0 && !seq.opening) {
    while (clusterQueue.length && now - lastCluster >= FIND_GAP) {
      const { index, tint } = clusterQueue.shift();
      startFind(index, tint, now);
      lastCluster = now;
    }
  }
  for (let i = clusters.length - 1; i >= 0; i--) {
    const f = clusters[i], q = (now - f.t0) / FIND_TIME;
    f.m.grow = carrySmooth((q - SET_FROM) / (SET_TO - SET_FROM));
    f.m.out = carrySmooth((q - SET_TO) / (1 - SET_TO));
    if (!f.shown && q >= SET_FROM) {
      // the drop sets: its mote is in the bubble, already a mote (no orb to settle from)
      f.shown = true;
      f.m.t0 = now - MOTE_IN;
      bub.motes.push(f.m);
    }
    if (!f.lit && q >= SET_TO) lightCluster(f, now);
    if (q < 1) continue;
    clusters.splice(i, 1);
    for (const d of dust) if (d.find === f) d.spent = true;
    if (carry.glint && carry.glint.find === f) carry.glint.spent = true;
  }
}
/* the find goes out to its place and the claim counts: the bubble takes the
   kick, stretched toward where it goes, and grows */
function lightCluster(f, now) {
  f.lit = true;
  bub.caught += 1;
  bub.vel += 0.7;
  moteAt(f.m, now, mAt);
  bub.dir = Math.atan2(-mAt.v, mAt.u);
  bub.sqVel += 0.3;
  bub.triVel += 0.15;
  const tier = String(f.tint).toLowerCase();
  const b = discs[f.index];
  if (b) b.inBubble = true;
  emit('absorb', { index: f.index });
}
function glowDot(x, y, r, col, a) {
  if (a <= 0.005) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
  g.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
  g.addColorStop(0.22, `rgba(${col[0]},${col[1]},${col[2]},${a.toFixed(3)})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, Math.PI * 2); ctx.fill();
}
/** a piece's colour on its way to its claim's, `k` of the way */
const towards = (a, b, k) =>
  `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)})`;
/* inside the film: the draw's pieces swirling; a claim's coming to the
   middle and merging there into its drop; a win's glint */
function drawCarriedInside(c, R, t) {
  if (!carry.on) return;
  const tp = performance.now() / 1000, TAU = Math.PI * 2;
  const melt = bub.swellAt >= 0 ? carrySmooth((t - bub.swellAt) / 0.35) : 0;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  bubblePath(ctx, c.x, c.y, Math.max(1, R - 1), t);
  ctx.clip();
  // the free ones: dots in their own colours, all alike, swirling on as they did on the draw
  if (melt < 1) {
    ctx.globalAlpha = 0.9 * (1 - melt);
    for (const d of dust) {
      if (d.find) continue;
      const a = dustAngle(d), rr = R * (d.rr + (0.94 - d.rr) * melt);
      ctx.fillStyle = d.ink;
      ctx.beginPath(); ctx.arc(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr * 0.85, DOT_R, 0, TAU); ctx.fill();
    }
  }
  // a claim's: its colour, then straight to the middle, the last of the way
  // reaching for the drop with a neck as wide as itself
  for (const f of clusters) f.joined = 0;
  ctx.lineCap = 'round';
  for (const d of dust) {
    const f = d.find;
    if (!f || d.spent) continue;
    const q = (t - f.t0) / FIND_TIME, dl = PIECE_STAGGER * d.seed, e = between(q, dl, dl + PIECE_RUN);
    if (e >= 1) { f.joined++; continue; }
    if (e <= 0) { const a = dustAngle(d); d.u0 = Math.cos(a) * d.rr; d.v0 = Math.sin(a) * d.rr * 0.85; }
    const m = e * e * (3 - 2 * e), tint = carrySmooth(q / TINT_RUN);
    const px = c.x + d.u0 * R * (1 - m), py = c.y + d.v0 * R * (1 - m);
    const pr = (DOT_R + (PIECE_END_R - DOT_R) * m) * (1 + 0.15 * Math.sin(Math.PI * m));
    const near = 1 - Math.min(1, Math.hypot(px - c.x, py - c.y) / NECK);
    if (near > 0) {
      ctx.globalAlpha = 0.55 * near; ctx.strokeStyle = f.ink; ctx.lineWidth = pr * 2;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(c.x, c.y); ctx.stroke();
    }
    if (tint > 0) {
      ctx.globalAlpha = 0.5 * tint;
      ctx.drawImage(f.glow, px - pr * 2.6, py - pr * 2.6, pr * 5.2, pr * 5.2);
    }
    ctx.globalAlpha = 0.9 + 0.1 * tint;
    ctx.fillStyle = tint >= 1 ? f.ink : towards(d.col, f.col, tint);
    ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // a win's glint, at the middle; with its claim's pieces, into its drop
  const gl = carry.glint;
  if (gl && !gl.spent) {
    let x = c.x + Math.cos(tp * 0.7) * R * 0.12, y = c.y + Math.sin(tp * 0.7) * R * 0.1, col = GLINT, e = 0;
    const f = gl.find;
    if (f) {
      const q = (t - f.t0) / FIND_TIME;
      e = between(q, 0, PIECE_RUN);
      const m = e * e * (3 - 2 * e);
      x += (c.x - x) * m; y += (c.y - y) * m;
      if (q > TINT_RUN * 0.5) col = f.col;
    }
    if (e < 1) glowDot(x, y, 3.4, col, 1 - melt);
  }
  // the drop at the middle: it swells as each piece joins it and wobbles,
  // flashes, and sets into the claim's mote (drawMotes grows that over it)
  for (const f of clusters) {
    const q = (t - f.t0) / FIND_TIME;
    const set = carrySmooth((q - SET_FROM) / (SET_TO - SET_FROM));
    const joined = f.n ? f.joined / f.n : between(q, 0, PIECE_STAGGER + PIECE_RUN);
    const dropR = (3 + 8 * Math.sqrt(joined)) * (1 + 0.08 * Math.sin(t * 14) * (1 - set)) * (1 - set);
    if (dropR > 0.3) {
      ctx.globalAlpha = 0.35;
      ctx.drawImage(f.glow, c.x - dropR * 2.6, c.y - dropR * 2.6, dropR * 5.2, dropR * 5.2);
      const wob = 0.06 * Math.sin(t * 11);
      ctx.globalAlpha = 1; ctx.fillStyle = f.ink; ctx.shadowColor = f.ink; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.ellipse(c.x, c.y, dropR * (1 + wob), dropR * (1 - wob), 0, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.7; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(c.x - dropR * 0.3, c.y - dropR * 0.35, dropR * 0.28, 0, TAU); ctx.fill();
    }
    const flash = Math.sin(Math.PI * between(q, FLASH_FROM, FLASH_TO));
    if (flash > 0.01) {
      ctx.globalAlpha = 0.6 * flash; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(c.x, c.y, 6 + 8 * flash, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}
/* over the film: a find going out to its place lights the rim on that side */
function drawCarriedFront(c, R, t) {
  if (!carry.on || !clusters.length) return;
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  for (const f of clusters) {
    const a = 0.5 * Math.sin(Math.PI * between((t - f.t0) / FIND_TIME, SET_TO, 1));
    if (a <= 0.01) continue;
    moteAt(f.m, t, mAt);
    const dir = Math.atan2(-mAt.v, mAt.u);
    rimArc(ctx, c.x, c.y, R, t, dir - GLEAM_SPAN / 2, dir + GLEAM_SPAN / 2, 1);
    ctx.globalAlpha = a; ctx.strokeStyle = f.ink; ctx.lineWidth = 2.5;
    ctx.shadowColor = f.ink; ctx.shadowBlur = 10;
    ctx.stroke();
  }
  ctx.restore();
}

/* ================= the sequence ================= */

const seq = {
  grounded: -1, opening: false, burstAt: -1, exitAt: -1,
  blend: 0, clock: 0, visible: true, bob: 0,
};

function replay() {
  dropCarried();
  hideDiscs();
  for (const b of discs) b.inBubble = true;
  orbs.length = 0;
  orbQueue.length = 0;
  flashes.length = 0;
  openWanted = false;
  resetBubble();
  focusDisc = null; setFocus(false); focusK = 0;
  seq.grounded = -1; seq.opening = false;
  seq.burstAt = -1; seq.exitAt = -1; seq.blend = 0;
  seq.visible = true; seq.bob = 0;
}

/* ── the zoom: tap a collectable and the camera dives into it ─────────────
   focusDisc is kept while easing back out so the camera has a place to
   return from; it clears only once the ease has fully settled. */
let focusDisc = null;
let focusOn = false;
/** the zoom in or out, said once when it changes */
function setFocus(on) {
  if (focusOn === on) return;
  focusOn = on;
  emit('focus', { on });
}
let focusK = 0;

function discAt(px, py) {
  let best = null;
  let bestDist = Infinity;
  for (const b of discs) {
    if (!b.live) continue;
    project(b.x, b.y, b.z, tmp);
    const d = Math.hypot(tmp.x - px, tmp.y - py);
    if (d <= BALL_R * SCALE * 1.15 && d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

/* ── dragging: pieces can be pushed around the frame ──────────────────────
   A press on a piece arms a drag; real movement starts it (a clean
   press-release stays a tap). The pointer moves the point the float holds
   the piece to, in the camera plane, and the piece follows it closely, so it
   trails the finger instead of teleporting and shoves the others aside. Let
   go, and it keeps the speed it had: a flick throws it, and the float brings
   it back to its own kind. */
const DRAG_THRESHOLD = 6; // css px of travel before a press becomes a drag
let dragDisc = null;
let dragging = false;
let pressed = false;
/** the engine clock at the last touch */
let inputAt = -Infinity;
let pressX = 0, pressY = 0;

function press(px, py) {
  inputAt = clock;
  pressed = true;
  dragging = false;
  pressX = px; pressY = py;
  dragDisc = !focusOn && seq.burstAt >= 0 ? discAt(px, py) : null;
}

function move(px, py) {
  if (!pressed || !dragDisc) return;
  inputAt = clock;
  if (!dragging) {
    if (Math.hypot(px - pressX, py - pressY) < DRAG_THRESHOLD) return;
    dragging = true;
    dragDisc.fu = dragDisc.u;
    dragDisc.fv = dragDisc.v;
  }
  const dx = px - pressX, dy = py - pressY;
  pressX = px; pressY = py;
  // screen delta → plane delta (screen y runs down)
  dragDisc.fu += dx / SCALE;
  dragDisc.fv -= dy / SCALE;
}

function release() {
  if (!pressed) return;
  pressed = false;
  const wasDrag = dragging;
  dragging = false;
  dragDisc = null;
  // let go, the layout runs again from where things are: the dropped piece
  // floats back to its own kind, and the pile makes room for it
  if (wasDrag) relayout();
  else tap(pressX, pressY);
}

/* a tap: on an opened piece → the host's picker over it; on another
   collectable → zoom into it; anywhere while zoomed → back out.
   Before the bubble has popped there is nothing to focus: once it is blown,
   and something is in it, a tap is what pops it. */
function tap(px, py) {
  if (seq.burstAt < 0) {
    if (seq.grounded >= 0 && !seq.opening && (!opts.canOpen || opts.canOpen())) {
      seq.opening = true;
      emit('open', { clock: seq.clock });
    }
    return;
  }
  const hit = px !== undefined ? discAt(px, py) : null;
  if (hit && hit.opened) {
    // the box its art is drawn in (drawDisc's fit), canvas-local px: the
    // picker opens out of it and flies back into it
    project(hit.x, hit.y, hit.z, tmp);
    const entry = sprites[discs.indexOf(hit)];
    const fit = entry && entry.scale ? entry.scale : 1;
    setFocus(false);
    emit('inspect', { index: discs.indexOf(hit), x: tmp.x, y: tmp.y, side: BALL_R * SCALE * 2 * hit.grow * fit });
    return;
  }
  if (hit) {
    // the tap that pulls a piece into focus only zooms — it never pops.
    // Once focused, ONE tap bursts the wrapping (the layer above runs the
    // shatter from this hit point).
    if (!(focusOn && hit === focusDisc)) {
      focusDisc = hit;
      setFocus(true);
      return;
    }
    if (hit.crack < 1) {
      hit.crack = 1;
      hit.crackClock = seq.clock;
      hit.hitX = px;
      hit.hitY = py;
      emit('pop', { index: discs.indexOf(hit) });
      // TODO(haptics): fire a heavy hit haptic here. Android WebView has
      // navigator.vibrate; iOS needs a host bridge — none in TrUAPI today.
    }
    return;
  }
  setFocus(false);
}

/* ================= resize ================= */

function resize(w, h) {
  DPR = Math.min(devicePixelRatio || 1, 2);
  VW = w;
  VH = h;
  canvasEl.width = Math.round(VW * DPR);
  canvasEl.height = Math.round(VH * DPR);
  // a new frame: new spots in it
  if (seq.burstAt >= 0) relayout();
}
resize(canvasEl.clientWidth || 300, canvasEl.clientHeight || 300);

/* ================= loop ================= */

let last = performance.now();
let clock = 0;
let raf = 0;
let skip = false;
function calm() {
  if (seq.visible || seq.burstAt < 0 || clock - seq.burstAt < 2.5) return false;
  if (pressed || focusOn || focusK > 0 || clock - inputAt < 0.6) return false;
  if (orbs.length || orbQueue.length || flashes.length || popShowing()) return false;
  if (clusters.length || clusterQueue.length) return false;
  // a piece on its way to a new spot runs at the full rate; only the breathing is calm
  if (trailing()) return false;
  for (const b of discs) if (b.live && (Math.hypot(b.vu, b.vv) > 0.15 || (b.crackClock >= 0 && clock - b.crackClock < 0.8))) return false;
  return true;
}
let dead = false;
/** the host has put something over the scene for good (the inventory): no frames until it lets go */
let held = false;
function hold(on) {
  if (held === on || dead) return;
  held = on;
  if (on) {
    cancelAnimationFrame(raf);
  } else {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
}
/** the last frame left something on the canvas (see the paint below) */
let painted = true;

function frame(now) {
  if (dead || held) return;
  raf = requestAnimationFrame(frame);
  // at rest (settled, untouched, nothing breaking) only the breath moves: half rate
  if (calm() && (skip = !skip)) return;
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;
  const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
  for (let i = 1; i <= steps; i++) stepBubble(dt / steps, clock + (dt * i) / steps);
  clock += dt;
  stepOrbs(clock);
  stepClusters(dt, clock);
  // the camera is locked; it only tightens from framing the bubble to framing
  // what came out of it — unless a collectable holds the focus, in which
  // case it dives in (and tracks the piece, which keeps breathing).
  // It ends up looking AT THE PIECES: FLOAT_Y is where they come to rest, so
  // blending to exactly that centres them in the frame.
  const baseCy = HOLD_CY + seq.blend * (FLOAT_Y - HOLD_CY);
  // FIT BOTH AXES, and blend the frame it fits: in a 390px-wide phone the
  // arrangement is WIDER than the frame, so height alone would pin the pieces
  // to the walls. The frame also MOVES: the bubble needs HOLD_W × HOLD_H, the
  // scatter needs only its own grid once it is out — which is what makes a
  // chest of one collectable fill the screen and a chest of ten tile it.
  fitW += (targetW - fitW) * Math.min(1, dt * 3);
  fitH += (targetH - fitH) * Math.min(1, dt * 3);
  const baseScale = Math.min(
    VW / (HOLD_W - seq.blend * (HOLD_W - fitW)),
    VH / (HOLD_H - seq.blend * (HOLD_H - fitH)),
  );
  viewScale = baseScale;
  viewCy = baseCy;
  const wantK = focusOn && focusDisc ? 1 : 0;
  focusK += (wantK - focusK) * Math.min(1, dt * 6);
  if (!focusOn && focusK < 0.002) { focusK = 0; focusDisc = null; }
  const fe = focusK * focusK * (3 - 2 * focusK); // smoothstep on the eased k
  if (focusDisc) {
    cam.cx = focusDisc.x * fe;
    cam.cy = baseCy + (focusDisc.y - baseCy) * fe;
    cam.cz = focusDisc.z * fe;
    SCALE = baseScale + ((VH * 0.3) / BALL_R - baseScale) * fe;
  } else {
    cam.cx = 0;
    cam.cy = baseCy;
    cam.cz = 0;
    SCALE = baseScale;
  }
  placeCarried(dt);
  stepDiscs(dt, clock);
  if (seq.burstAt >= 0) floatDiscs(dt, clock);

  collectDiscs();

  // NOTHING TO PAINT AND NOTHING TO ERASE: leave the canvas alone. Once the
  // wrapping layer draws every piece this canvas is empty, but a clear is
  // still a new frame to present, and a 2D canvas presenting every frame
  // keeps a full-size backing per frame in flight (~4 MB each at DPR 2).
  const list = pool.slice(0, poolUsed);
  const flying = orbs.length > 0 || flashes.length > 0 || seq.visible || popShowing() || trailing();
  if (list.length || painted || flying) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, VW, VH);
    drawBubble(clock);
    list.sort((a, b) => a.d - b.d);
    drawTrails();
    for (const it of list) drawDisc(it);
    drawPop(clock);
    if (flying) drawOrbs(clock);
  }
  painted = list.length > 0 || flying;
  // a carried bubble, drawn here for the first time: whoever held it between the screens can let go
  if (carry.on && carry.placed && !carry.told) {
    carry.told = true;
    try { opts.onCarriedShown?.(); } catch { /* the listener's problem */ }
  }

  // hand the piece placements to whoever draws on top (the wrapping layer):
  // canvas-local CSS px, the piece's box side, its wiggle as a rotation
  if (opts.onDiscs) {
    const placements = [];
    for (let i = 0; i < discs.length; i++) {
      const b = discs[i];
      if (!b.live) continue;
      project(b.x, b.y, b.z, tmp);
      placements.push({
        index: i,
        cx: tmp.x,
        cy: tmp.y,
        size: BALL_R * SCALE * 2 * b.grow,
        rotation: b.roll * (180 / Math.PI),
        crack: b.crack,
        crackAge: b.crackClock < 0 ? Infinity : Math.max(0, seq.clock - b.crackClock),
        hitX: b.hitX,
        hitY: b.hitY,
        // the breathing tilt, as drawDisc squashes the circle by it
        sx: Math.cos(b.tiltY || 0),
        sy: Math.cos(b.tiltX || 0),
      });
    }
    opts.onDiscs(placements, seq.blend);
  }
}
raf = requestAnimationFrame(frame);


/* ================= start ================= */

replay();
// the draw's hold brought the bubble here (THE CARRIED BUBBLE)
if (opts.carried) startCarried(opts.carried);

return {
  /** start over: the bubble blows up again, empty */
  replay,
  /** a user tap: pop the bubble (once something is in), zoom into a piece, or crack the focused one */
  tap,
  /** pointer gestures: press/move/release — drag pieces, tap to zoom */
  press,
  move,
  release,
  /** the collectable artwork, one entry per piece — an image, or
   *  { image, scale } where scale matches the wrapping layer's fit */
  setSprites(next) { sprites = next; },
  /** a piece came in (a claim): an orb in this colour flies it into the
   *  bubble, or to its place once the bubble has popped. Its index, or -1
   *  when the chest is full. */
  addPiece,
  /** pop the bubble: now if it is blown, else the moment it is */
  open: openBubble,
  /** the piece's shell has broken: it stays as its plain art and floats up
   *  to the opened ones (see openPiece) */
  openPiece,
  /** stop (true) or restart (false) the frames while something covers the scene */
  hold,
  /** the pieces float above this, px from the canvas's top (the Pocket's book); null: the canvas's foot */
  setFloor,
  /** the wrapping layer draws this piece now — stop painting its flat art */
  setSpriteHidden(index, hidden) {
    if (hidden) spriteHidden.add(index);
    else spriteHidden.delete(index);
  },
  /** the host element changed size */
  resize,
  destroy() { dead = true; cancelAnimationFrame(raf); },
};


}
