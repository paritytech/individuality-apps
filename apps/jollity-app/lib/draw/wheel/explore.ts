// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * LOOKING ROUND THE WHEEL, once the draw is over: every ticket where the
 * stage draws it now and whose it is, and a zoom of the player's own over
 * the stage's (the JOLLITY explore edits under ./proto).
 *
 * The stage (./mount.ts) registers this for its host element; the page's
 * hold (lib/draw/hold) reads it. Kept apart from mount.ts, which loads the
 * scene: this file imports nothing, so anything may import it.
 *
 * Everything here is in CSS px on the page.
 */

/** a ticket where the stage draws it now */
export interface WheelTicket {
  /** its slot on the wheel */
  k: number
  x: number
  y: number
  /** its radius */
  r: number
  won: boolean
  /** the player's own */
  you: boolean
}

/** the player's zoom over the stage's: a scale about the stage's top-left corner, then a move */
export interface WheelView {
  s: number
  x: number
  y: number
}

export interface WheelExplore {
  /** every ticket, or null before the wheel is laid out */
  tickets(): WheelTicket[] | null
  /** the name on a ticket ("YOU" on the player's; a code where nobody is named) */
  nameOf(k: number): string | null
  /** light a ticket on the name row, as a tapped one is: the row slides its name over it and a line joins them (−1: nobody). False when the wheel takes no taps now */
  pick(k: number): boolean
  view(): WheelView
  setView(view: WheelView): void
  /** the stage's box on the page: what the view scales and moves */
  box(): DOMRect
  /** where the draw is along its timeline now (also said as it changes: STAGE_TIMELINE) */
  timeline(): WheelTimeline
  /** a hand on the timeline: the wheel shown `at` (0..1) along its spin, and held there. False while the draw takes no hand (the coin not down) */
  scrub(at: number): boolean
  /** the hand let go: the wheel stays where it was let go; let go at the very end, the spin lands, and who's playing is walked through again */
  scrubEnd(): void
  /** the stage is still moving by itself (a spin played on from the timeline, the names walked through again): a picture of it now is not the draw's end */
  busy(): boolean
}

/** THE DRAW'S TIMELINE: the spin, from the wheel's start to its stop */
export interface WheelTimeline {
  /** 0..1 along the spin */
  at: number
  /** the spin has begun: there is a timeline */
  started: boolean
  /** a win's prize is up over the wheel: no timeline under it */
  prizeUp: boolean
}

/** said from the stage's element (#app) whenever the timeline changes, `detail` a WheelTimeline; it bubbles */
export const STAGE_TIMELINE = "jollity:timeline"

/** how far in the player can zoom */
export const ZOOM_MAX = 6

/** a view kept in bounds: never smaller than the stage, never moved off it */
export function clampView(view: WheelView, box: { width: number; height: number }): WheelView {
  const s = Math.min(ZOOM_MAX, Math.max(1, view.s))
  return {
    s,
    x: Math.min(0, Math.max(box.width * (1 - s), view.x)),
    y: Math.min(0, Math.max(box.height * (1 - s), view.y)),
  }
}

/** the view `view` scaled by `k` about the point (px, py), page px; kept in bounds */
export function zoomAbout(view: WheelView, k: number, px: number, py: number, box: DOMRect): WheelView {
  const s = Math.min(ZOOM_MAX, Math.max(1, view.s * k))
  const real = s / view.s
  // the point stays where it is: its place in the stage before, scaled about it
  const ox = px - box.left
  const oy = py - box.top
  return clampView({ s, x: ox - (ox - view.x) * real, y: oy - (oy - view.y) * real }, box)
}

const registry = new WeakMap<Element, WheelExplore>()

/** the stage's, on its own element (#app): registered while it is mounted. Returns the unregister */
export function registerExplore(app: Element, explore: WheelExplore): () => void {
  registry.set(app, explore)
  return () => {
    if (registry.get(app) === explore) registry.delete(app)
  }
}

/** the wheel in this element (the stage's own, or any element round it), if one is up */
export function exploreOf(el: Element | null): WheelExplore | null {
  if (!el) return null
  return registry.get(el) ?? (el.id === "app" ? null : (registry.get(el.querySelector("#app") as Element) ?? null))
}
