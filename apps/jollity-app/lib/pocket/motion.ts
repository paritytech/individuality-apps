// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The motion of the Pocket: a cover with weight that follows the finger, falls shut faster and faster once it is
 * past the point and lands with a thud; pieces that drop through the middle of the screen into their cells and land with a squash; and
 * the furniture round it (the invitation's ghost finger, the puff of the landing, the confetti).
 */
import { lerp, seg, smooth, type Book, type Point } from "./book"

/** A value easing toward its target at `rate` per second, whatever the frame rate. */
export const follow = (x: number, target: number, rate: number, dt: number) => x + (target - x) * (1 - Math.exp(-dt * rate))

/** where the falling cover waits until the last piece is in, closed */
export const COVER_WAIT = 0.93
/** the falling cover's least speed, closed per s, and how fast it gathers more, per s² */
const FALL_FROM = 0.8
const FALL_GAIN = 9

/**
 * One step of the cover falling shut by itself: faster and faster, but held at COVER_WAIT while `waiting` (a piece
 * is still on its way in), slowed there so it does not slam the moment it may go on.
 */
export function coverFall(cover: { cov: number; v: number }, dt: number, waiting: boolean): { cov: number; v: number } {
  const v = Math.max(cover.v, FALL_FROM) + FALL_GAIN * dt
  const cov = Math.min(waiting ? COVER_WAIT : 1, cover.cov + v * dt)
  return { cov, v: waiting && cov >= COVER_WAIT ? FALL_FROM : v }
}

/** a piece's trip into its cell, s */
export const FLIGHT = 0.62

/** A quadratic Bézier from `from` through `via` to `to`. */
export function arcAt(from: Point, via: Point, to: Point, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * from.x + 2 * u * t * via.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * via.y + t * t * to.y,
  }
}

/** Where a piece is on its way to its cell, `u` from 0 to 1: it curves in through x = `rayX` (the middle of the screen), halfway down. */
export function flightAt(from: Point, to: Point, rayX: number, u: number): { at: Point; k: number } {
  const k = smooth(u)
  return { at: arcAt(from, { x: rayX, y: (from.y + to.y) / 2 }, to, k), k }
}

/** The short line a flight leaves behind it, how strong for `u` of the way. */
export const trailAlpha = (u: number) => (u > 0.05 && u < 0.5 ? 0.35 * Math.sin(Math.PI * u * 2) : 0)

/** how long a landing glows in its cell, s */
export const LANDING = 0.7

/** A landed piece's squash `k` seconds in: it lands wide and flat and rings back, scale(1 + q, 1 - q). */
export const squash = (k: number) => Math.exp(-8 * k) * Math.cos(24 * k) * 0.28

/** The cover `k` seconds after it lands: it bounces a little open, and the book dips under it, px. */
export const thud = (k: number) => ({
  closed: 1 - 0.07 * Math.abs(Math.sin(k * 15)) * Math.exp(-k * 6),
  dip: 6 * Math.sin(Math.PI * Math.min(1, k / 0.38)) * Math.exp(-k * 2),
})

/** the invitation comes round every this many seconds, and lasts this long */
const INVITE_EVERY = 3.4
const INVITE_FOR = 1.5
/** with nothing opened, the invitation starts this long after the float began, s: until then the collectables
 *  screen's own finger shows how to look at a piece (lib/collectables-scene/hints) */
export const INVITE_LATE = 11
/** once a piece is opened, the invitation starts this long after, s: the collectables screen's finger first shows
 *  that a tap on it swaps its collection */
export const INVITE_AFTER_OPEN = 6

/**
 * The invitation, `since` seconds after the pieces began to float: the cover lifts a little off the table and
 * back (`lift`, added to how closed it is), and a ghost finger shows where to take it (`ghost`, its strength and
 * how far along it is), or nothing between times.
 */
export function invitation(since: number): { lift: number; ghost: { a: number; u: number } | null } {
  const s = (since % INVITE_EVERY) / INVITE_FOR
  if (s >= 1 || s < 0) return { lift: 0, ghost: null }
  return {
    lift: 0.3 * smooth(seg(s, 0.1, 0.6)) * (1 - smooth(seg(s, 0.7, 1))),
    ghost: { a: Math.sin(Math.PI * s), u: s },
  }
}

/** The ghost finger: from the cover's left part to just right of the spine, a little arc over the book. */
export function ghostAt(u: number, book: Book): Point {
  const k = smooth(seg(u, 0.1, 0.6))
  const from = Math.max(44, book.sx - book.pw + 26)
  return { x: lerp(from, book.sx + 34, k), y: book.sy + 10 - 14 * Math.sin(Math.PI * k) }
}

export const PUFF = 28
/** how long the puff lasts, s */
export const PUFF_FOR = 1

/** One speck of the puff `k` seconds after the thud: a breath of the film escaping the shut book's edges. */
export function puffAt(j: number, k: number, book: Book): { x: number; y: number; r: number; alpha: number } {
  const side = j % 4
  const f = ((j * 53) % PUFF) / PUFF
  const speed = 70 + ((j * 31) % 50)
  let x = book.sx + book.pw
  let y = book.sy + (f - 0.5) * book.ph
  let dx = 1
  let dy = (f - 0.5) * 0.6
  if (side < 2) {
    x = book.sx + f * book.pw
    y = book.sy + (side === 0 ? -book.ph / 2 : book.ph / 2)
    dx = (f - 0.5) * 0.6
    dy = side === 0 ? -1 : 1
  }
  const d = ((speed * (1 - Math.exp(-k * 5))) / 5) * 4
  return { x: x + dx * d, y: y + dy * d - 12 * k, r: Math.max(0, 2.2 * (1 - k * 0.6)), alpha: 0.8 * (1 - seg(k, 0.1, 0.9)) }
}

export interface Bit {
  angle: number
  speed: number
  size: number
  hue: number
  turn: number
  round: boolean
}

/** how long a confetti bit flies, s, and how hard it falls, px/s² */
export const CONFETTI_FOR = 1.5
const GRAVITY = 420

/** The confetti of the close: thrown up and out, the same every time for a seed. */
export function confettiFor(count: number, seed = 7): Bit[] {
  let s = seed
  const next = () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
  return Array.from({ length: count }, (_, j) => ({
    angle: -Math.PI / 2 + (next() - 0.5) * 2.6,
    speed: 260 + next() * 300,
    size: 4 + next() * 5,
    hue: j,
    turn: next() * 6,
    round: j % 3 === 0,
  }))
}

/** Where a bit of confetti is `s` seconds after it was thrown from `from`, or null once it is gone. */
export function confettiAt(bit: Bit, s: number, from: Point): { x: number; y: number; turn: number; alpha: number } | null {
  if (s <= 0 || s > CONFETTI_FOR) return null
  return {
    x: from.x + Math.cos(bit.angle) * bit.speed * s * 0.9,
    y: from.y + Math.sin(bit.angle) * bit.speed * s + GRAVITY * s * s,
    turn: bit.turn + s * 6,
    alpha: s < 0.5 ? 1 : 1 - seg(s, 0.5, CONFETTI_FOR),
  }
}
