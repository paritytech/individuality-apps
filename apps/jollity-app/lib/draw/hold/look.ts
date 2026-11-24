// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * LOOKING ROUND THE WHEEL after the draw, from the hold's layer: tap any
 * ticket to see whose it is (the draw lights it on its own row of names along
 * the top: the row slides its name over it, and a line joins the two), and
 * zoom in and out to reach the small ones (pinch, or a double tap); one finger moves the wheel while it is zoomed. The wheel itself
 * (lib/draw/wheel/explore) says where every ticket is, lights it, and draws
 * the zoom, so the dots stay crisp.
 *
 * Logic only, no React (architecture rule 6): lib/draw/hold/scene routes the
 * fingers here. Page px throughout.
 */
import { clampView, exploreOf, zoomAbout, type WheelView } from "@/lib/draw/wheel/explore"

/** a tap reaches a ticket this far past its edge, px: a fingertip, not a pixel */
const REACH = 16
/** a tap with another ticket nearly as near is too close to call: it zooms in there instead, unless the dots are this big already, px */
const BIG_ENOUGH = 7
/** …nearly as near: the second within this many px of the nearest, and the finger on neither (further than ON from the nearest's edge) */
const TOO_CLOSE = 6
const ON = 2
/** a double tap: the second this soon after the first, and this near it */
const DOUBLE_MS = 320
const DOUBLE_PX = 36
/** a double tap or a tap too close to call zooms in this much */
const STEP = 2.5
/** zoomed in this far already, a tap picks the nearest ticket rather than zooming again */
const ZOOMED = 1.5
/** a zoom that is not a pinch eases over this long */
const EASE_MS = 280
export interface Picked {
  k: number
  name: string
  won: boolean
  you: boolean
}

export interface Look {
  /** a tap at page (x, y): picks the ticket there; one too close to call zooms in there; nothing there lets go of the pick */
  tap(x: number, y: number, now: number): void
  /** two fingers: the zoom multiplied by k about (x, y), and moved by (dx, dy) */
  pinch(k: number, x: number, y: number, dx: number, dy: number): void
  /** one finger, zoomed in: the wheel moved by (dx, dy) */
  pan(dx: number, dy: number): void
  /** in (k > 1) or out (k < 1), about (x, y) or the middle, eased */
  zoomBy(k: number, now: number, x?: number, y?: number): void
  /** back to the whole wheel, eased */
  reset(now: number): void
  /** back to the whole wheel at once (a hold has the screen: nobody sees it go) */
  resetNow(): void
  zoomed(): boolean
  /** a frame: an eased zoom moves on. True while the view is changing */
  step(now: number): boolean
  picked(): Picked | null
  /** forget the pick (the wheel keeps it lit) */
  clear(): void
}

const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3)

export function createLook(stage: Element, onPick?: (picked: Picked | null) => void): Look {
  let pick: (Picked & { at: number }) | null = null
  let lastTap: { x: number; y: number; at: number } | null = null
  let anim: { from: WheelView; to: WheelView; at: number } | null = null
  const wheel = () => exploreOf(stage)

  const set = (p: typeof pick) => {
    pick = p
    // the wheel lights it on its row of names (or nobody)
    wheel()?.pick(p ? p.k : -1)
    onPick?.(p ? { k: p.k, name: p.name, won: p.won, you: p.you } : null)
  }
  const ease_to = (to: WheelView, now: number) => {
    const w = wheel()
    if (!w) return
    anim = { from: w.view(), to: clampView(to, w.box()), at: now }
  }
  const stopAnim = () => {
    anim = null
  }

  const look: Look = {
    tap(x, y, now) {
      const w = wheel()
      if (!w) return
      const double = lastTap && now - lastTap.at < DOUBLE_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < DOUBLE_PX
      lastTap = double ? null : { x, y, at: now }
      if (double) {
        // in where it was tapped, or back out to the whole wheel
        const v = w.view()
        if (v.s > 1.05) look.reset(now)
        else look.zoomBy(STEP, now, x, y)
        return
      }
      const near = (w.tickets() ?? [])
        .map((t) => ({ t, d: Math.max(0, Math.hypot(t.x - x, t.y - y) - t.r) }))
        .filter((c) => c.d <= REACH)
        .sort((a, b) => a.d - b.d)
      const first = near[0]
      if (!first) return void set(null)
      const second = near[1]
      // too close to call, and small, on the whole wheel: closer, there (zoomed in already, the nearest it is)
      if (second && first.t.r < BIG_ENOUGH && first.d > ON && second.d - first.d < TOO_CLOSE && w.view().s < ZOOMED) {
        look.zoomBy(STEP, now, x, y)
        return
      }
      set({ k: first.t.k, name: w.nameOf(first.t.k) ?? "", won: first.t.won, you: first.t.you, at: now })
    },
    pinch(k, x, y, dx, dy) {
      const w = wheel()
      if (!w) return
      stopAnim()
      const box = w.box()
      const v = zoomAbout(w.view(), k, x, y, box)
      w.setView(clampView({ s: v.s, x: v.x + dx, y: v.y + dy }, box))
    },
    pan(dx, dy) {
      const w = wheel()
      if (!w) return
      stopAnim()
      const v = w.view()
      w.setView(clampView({ s: v.s, x: v.x + dx, y: v.y + dy }, w.box()))
    },
    zoomBy(k, now, x, y) {
      const w = wheel()
      if (!w) return
      const box = w.box()
      const base = anim ? anim.to : w.view()
      ease_to(zoomAbout(base, k, x ?? box.left + box.width / 2, y ?? box.top + box.height / 2, box), now)
    },
    reset(now) {
      ease_to({ s: 1, x: 0, y: 0 }, now)
    },
    resetNow() {
      anim = null
      wheel()?.setView({ s: 1, x: 0, y: 0 })
    },
    zoomed: () => (wheel()?.view().s ?? 1) > 1.02,
    step(now) {
      const w = wheel()
      if (!anim || !w) return false
      const k = ease((now - anim.at) / EASE_MS)
      const { from, to } = anim
      // the scale eases on its log, so a step in and a step out feel the same
      const s = from.s * Math.pow(to.s / from.s, k)
      // the move follows: the point the zoom is about stays put
      const f = to.s === from.s ? k : (s - from.s) / (to.s - from.s)
      w.setView({ s, x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f })
      if (k >= 1) anim = null
      return true
    },
    picked: () => (pick ? { k: pick.k, name: pick.name, won: pick.won, you: pick.you } : null),
    clear() {
      pick = null
    },
  }
  return look
}
