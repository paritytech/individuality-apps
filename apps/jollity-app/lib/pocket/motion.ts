// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The motion of the Pocket, in the language of the chest's bubble: springs that overshoot and settle, pieces that
 * lean into the ray before they go, and a book that catches each one.
 */
import { clamp01, type Point, type Pose } from "./book"

export interface Spring {
  x: number
  v: number
}

export interface SpringTune {
  k: number
  c: number
}

export const SNUG: SpringTune = { k: 320, c: 30 }
export const BOUNCY: SpringTune = { k: 150, c: 13 }
export const JELLY: SpringTune = { k: 420, c: 14 }

/** One step of a damped spring towards `target`, never longer than a frame at 30 fps so a stall cannot blow it up. */
export function stepSpring(spring: Spring, target: number, tune: SpringTune, dt: number): Spring {
  const h = Math.min(dt, 1 / 30)
  const v = spring.v + ((target - spring.x) * tune.k - spring.v * tune.c) * h
  return { x: spring.x + v * h, v }
}

export const settled = (spring: Spring, target: number, within = 0.002) =>
  Math.abs(spring.x - target) < within && Math.abs(spring.v) < within * 10

/** How far a piece leans into the ray while the finger holds it: towards the ray, down a little, a little bigger. */
export function leaning({ from, rayX, progress, wobble }: { from: Point; rayX: number; progress: number; wobble: number }): Pose {
  const p = clamp01(progress)
  return {
    x: (rayX - from.x) * 0.22 * p,
    y: 28 * p,
    rotate: wobble * 6 * p,
    scale: 1 + 0.08 * p,
    opacity: 1,
  }
}

/** A quadratic Bézier: from where the piece let go, into the ray, and down the ray onto its cell. */
export function arcAt(from: Point, via: Point, to: Point, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * from.x + 2 * u * t * via.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * via.y + t * t * to.y,
  }
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/**
 * Where a piece is on its way to the book, `t` from 0 to 1: it gathers speed into the ray like something falling
 * into light, shrinks to the cell, turns back upright, and hands over to the art on the page at the very end.
 */
export function flightAt({
  from,
  rayX,
  to,
  t,
  startScale,
  endScale,
  startRotate,
}: {
  from: Point
  rayX: number
  to: Point
  t: number
  startScale: number
  endScale: number
  startRotate: number
}): { at: Point; scale: number; rotate: number; opacity: number } {
  const k = easeInOutCubic(clamp01(t))
  const via = { x: rayX, y: from.y + (to.y - from.y) * 0.45 }
  return {
    at: arcAt(from, via, to, k),
    scale: startScale + (endScale - startScale) * k,
    rotate: startRotate * (1 - k) + Math.sin(k * Math.PI) * 10 * Math.sign(from.x - rayX || 1),
    opacity: 1 - clamp01((k - 0.88) / 0.12),
  }
}

/**
 * How far the cover has swung shut, `t` from 0 to 1: it lifts off slowly, gathers speed over the spine and lands
 * still moving, so the landing reads as a soft thud rather than a stop.
 */
export function coverSwing(t: number): number {
  const k = clamp01(t)
  return 0.6 * k * k * (3 - 2 * k) + 0.4 * k * k
}

/**
 * How far the book has stood up off the table, `t` from 0 to 1: quick off the table, slowing as it comes upright,
 * and leaning a hair past upright before it settles, the way a book is lifted by hand.
 */
export function standUp(t: number): number {
  const k = clamp01(t)
  const lean = 1.1
  const u = k - 1
  return 1 + (lean + 1) * u * u * u + lean * u * u
}

/** The pieces nearest the book go first. */
export function departureOrder(starts: Point[], book: Point): number[] {
  return starts
    .map((at, index) => ({ index, distance: Math.hypot(at.x - book.x, at.y - book.y) }))
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.index)
}

export interface Spark {
  dx: number
  rise: number
  fall: number
  turn: number
  size: number
  delay: number
  hue: number
}

/** The confetti of the close: a fan thrown up and out that gravity brings down, the same every time for a seed. */
export function sparksFor(count: number, seed = 7): Spark[] {
  let s = seed
  const next = () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
  return Array.from({ length: count }, (_, k) => {
    const angle = -Math.PI / 2 + ((k / Math.max(1, count - 1)) * 2 - 1) * (Math.PI * 0.42) + (next() - 0.5) * 0.3
    const speed = 150 + next() * 130
    return {
      dx: Math.cos(angle) * speed,
      rise: -Math.abs(Math.sin(angle) * speed),
      fall: 180 + next() * 160,
      turn: (next() - 0.5) * 720,
      size: 6 + next() * 6,
      delay: next() * 90,
      hue: k,
    }
  })
}
