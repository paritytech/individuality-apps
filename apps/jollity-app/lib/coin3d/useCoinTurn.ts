// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The coin's turn gesture.
//
// A horizontal drag on a surface turns the coin under the finger. The release
// coasts it to the nearest whole face. This hook owns the pointer handling, the
// rotation arithmetic and the settle loop, and it owns NO drawing.
//
// THE ROTATION IS A REF, NEVER STATE. A drag is a per-frame value, and one
// React render per pointermove would drop the finger. The hook writes
// `turnsRef` and asks for a frame. The shared canvas reads that ref the next
// time it renders, so the DOM and the metal never fight over the number.
//
// `turns` counts FACES and it is UNBOUNDED. The player may turn past the last
// collection and keep going, and ./facetWheel.ts wraps the wheel. A float
// mid-drag, a whole number at rest.
//
// NOTHING HERE IMPORTS three.js. `invalidate` is a plain callback, and the
// canvas (components/collectable/coin-canvas.tsx) hands it its own frame
// request, a no-op until the renderer is built. That is what keeps the gesture
// out of the three.js chunk.
//
// The hook asks for a frame and reports a tap. It does NOT report the face a
// settle landed on. A settled turn changes the item and nothing else — the
// camera stays where it is.

import { useEffect, useRef, type MutableRefObject } from 'react'
import { facetIndex, settleTurns, SPIN_MS, spinEase } from './coinGeometry'
import { prefersReducedMotion } from '@/lib/reduced-motion'

/** Movement under this, in either direction, is still a tap. The game tiles'
 *  tap (components/game/animations.ts, TAP_SLOP_PX) uses the same 8 px, so the
 *  app agrees on where a tap ends and a drag starts. */
const TAP_SLOP_PX = 8

/** How far the finger travels to turn one face, as a share of the coin's own
 *  circumradius. A fraction over 1, so the surface moves about as fast as the
 *  metal does. */
export const PX_PER_STEP_RATIO = 1.1

/** A drag surface, as the hook reads it.
 *
 *  `current` is READ ONLY on purpose. `RefObject<T>` is mutable in the React 19
 *  types, which makes it invariant, and a `RefObject<HTMLDivElement | null>`
 *  would then not fit a `RefObject<HTMLElement | null>` slot. A read-only field
 *  is covariant, so every element ref a caller owns fits. */
interface CoinSurfaceRef {
  readonly current: HTMLElement | null
}

export interface CoinTurnOptions {
  /** Every element that turns the coin — the hit area, and the item art above
   *  it. Read ONCE, when the listeners bind. */
  surfaces: readonly CoinSurfaceRef[]
  /** MAY THE COIN TURN AT ALL RIGHT NOW? Read LIVE, at every press, so the
   *  caller can arm and disarm the gesture without rebinding the listeners.
   *  Leave it out and the coin always turns. */
  enabled?: () => boolean
  /** The turn, in faces. The hook writes it and the canvas reads it. */
  turnsRef: MutableRefObject<number>
  /** How many collections there are — the WHEEL MODULUS, not the side count.
   *  Passing COIN_SIDES here would cap the picker at six collections. */
  count: () => number
  /** The collection square to the camera changed. Fires ONCE PER FACE CROSSED,
   *  mid-drag included, so a flick reports every face it passes. */
  onFacetChange: (index: number) => void
  /** The finger passed the tap threshold. The caller uses this to swallow the
   *  click that trails the drag. */
  onDragStart?: () => void
  /** A press that never passed the tap threshold. */
  onTap?: () => void
  /** Ask for one more frame. This is what drives the canvas. */
  invalidate: () => void
  /** How far the finger travels to turn one face, in px. Read LIVE, so the
   *  travel follows the coin's size. */
  pxPerStep: () => number
}

interface DragState {
  pointerId: number
  /** clientX at pointerdown. */
  startX: number
  /** `turns` at pointerdown, squared to a whole face. */
  startTurns: number
  lastX: number
  /** The last pointermove delta, in px. Feeds settleTurns. */
  velocity: number
  moved: boolean
}

/** A settle in flight: the coin coasting from one face to the next. */
interface SettleState {
  from: number
  to: number
  startedAt: number
  ms: number
}

export function useCoinTurn(options: CoinTurnOptions): void {
  // Every callback reads through this, so the pointer effect binds ONCE and a
  // re-render that hands us new callback identities cannot tear the listeners
  // down under the finger.
  const optsRef = useRef(options)
  useEffect(() => { optsRef.current = options })

  const dragRef = useRef<DragState | null>(null)
  const settleRef = useRef<SettleState | null>(null)
  const rafRef = useRef(0)
  // The collection last reported. Seeded from the live turn when the listeners
  // bind, so the mount reports nothing and the first real turn reports a
  // change.
  const shownRef = useRef(0)

  useEffect(() => {
    const opts = optsRef.current
    const surfaces = opts.surfaces
      .map((r) => r.current)
      .filter((el): el is HTMLElement => el !== null)
    if (surfaces.length === 0) return
    shownRef.current = facetIndex(opts.turnsRef.current, opts.count())

    /** Report the collection now square to the camera, if it changed. */
    function present(): void {
      const o = optsRef.current
      const i = facetIndex(o.turnsRef.current, o.count())
      if (i === shownRef.current) return
      shownRef.current = i
      o.onFacetChange(i)
    }

    function stopSettle(): void {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      settleRef.current = null
    }

    /** Coast to a whole face.
     *
     *  A mesh has no CSS transitions, so the curve is driven here — which is also why the faces the coin
     *  passes THROUGH on the way report themselves, instead of the target
     *  reporting itself the instant the finger lifts. */
    function startSettle(to: number): void {
      stopSettle()
      const o = optsRef.current
      const from = o.turnsRef.current
      const ms = prefersReducedMotion() ? 0 : SPIN_MS
      if (ms <= 0 || from === to) {
        o.turnsRef.current = to
        present()
        o.invalidate()
        return
      }
      settleRef.current = { from, to, startedAt: performance.now(), ms }
      rafRef.current = requestAnimationFrame(advance)
    }

    function advance(now: number): void {
      rafRef.current = 0
      const s = settleRef.current
      if (!s) return
      const o = optsRef.current
      const p = Math.min(1, (now - s.startedAt) / s.ms)
      o.turnsRef.current = s.from + (s.to - s.from) * spinEase(p)
      present()
      o.invalidate()
      if (p < 1) {
        rafRef.current = requestAnimationFrame(advance)
        return
      }
      settleRef.current = null
      // Land on the exact face. The curve overshoots and comes back, so the
      // last frame is close but not square.
      o.turnsRef.current = s.to
      present()
      o.invalidate()
    }

    function onDown(e: PointerEvent): void {
      if (!e.isPrimary || dragRef.current) return
      // THE GATE, READ AT THE PRESS. A disarmed surface takes no capture and
      // starts no drag, so the press falls through to whatever else wants it —
      // the tile's own tap, for one.
      if (optsRef.current.enabled?.() === false) return
      const el = e.currentTarget as HTMLElement
      try { el.setPointerCapture(e.pointerId) } catch { /* capture is a nicety */ }
      // Start from a whole face: a press part-way through a settle must not
      // inherit that fraction and drift.
      stopSettle()
      const o = optsRef.current
      o.turnsRef.current = Math.round(o.turnsRef.current)
      // Start from what the coin ACTUALLY shows. The face this hook reported
      // last is not always the face standing now — a settle can land after the
      // report — and a stale value would report a change that never happened.
      // ONE hook writes one `turnsRef` since the camera replaced the lifted
      // layer. Re-seeding is correct either way.
      shownRef.current = facetIndex(o.turnsRef.current, o.count())
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startTurns: o.turnsRef.current,
        lastX: e.clientX,
        velocity: 0,
        moved: false
      }
    }

    function onMove(e: PointerEvent): void {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      const o = optsRef.current
      const dx = e.clientX - d.startX
      if (!d.moved) {
        if (Math.abs(dx) <= TAP_SLOP_PX) return
        d.moved = true
        o.onDragStart?.()
      }
      o.turnsRef.current = d.startTurns - dx / o.pxPerStep()
      d.velocity = e.clientX - d.lastX
      d.lastX = e.clientX
      present()
      o.invalidate()
    }

    function onUp(e: PointerEvent): void {
      const d = dragRef.current
      if (!d || d.pointerId !== e.pointerId) return
      dragRef.current = null
      const el = e.currentTarget as HTMLElement
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId)
      const o = optsRef.current
      if (!d.moved) {
        o.onTap?.()
        return
      }
      startSettle(settleTurns(o.turnsRef.current, d.velocity))
    }

    for (const el of surfaces) {
      el.addEventListener('pointerdown', onDown)
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
      el.addEventListener('pointercancel', onUp)
    }
    return () => {
      stopSettle()
      for (const el of surfaces) {
        el.removeEventListener('pointerdown', onDown)
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', onUp)
        el.removeEventListener('pointercancel', onUp)
      }
    }
    // Bind once. The surfaces are the same DOM nodes for the life of the
    // caller, and every callback reads through optsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
