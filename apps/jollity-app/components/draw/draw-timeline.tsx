// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * THE DRAW'S TIMELINE, along the bottom: the spin, from the wheel's start to
 * its stop, filled white as far as the draw is (the draw's own line, scene.js
 * #phase: 3 px, #353535, 26 px in from the sides at y 780 of its 844).
 *
 * While the draw plays it only shows where it is. Once it is over (`live`) it
 * takes a hand: drag along it, or tap it, to go back to any point of the spin,
 * and the wheel stays where it is let go; let go at the very end and the spin
 * lands, who's playing walked through again (lib/draw/wheel/explore). It
 * sits over the hold's layer, so a finger on it is never a hold.
 *
 * Where the draw is comes from the stage as it changes (STAGE_TIMELINE) and is
 * written straight onto the line (--at): no render per frame.
 */
import { useEffect, useRef, useState } from "react"
import { exploreOf, STAGE_TIMELINE, type WheelTimeline } from "@/lib/draw/wheel/explore"

/** the draw's frame, and where the line sits on it (scene.js BAR_Y; style.css's 26 px in) */
const NOMINAL_H = 844
const LINE_Y = 780
const INSET = 26
/** the band a finger takes it in, px on the 844-tall frame */
const HIT = 44
/** a key moves it this far along */
const KEY_STEP = 0.05

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function DrawTimeline({
  stage,
  live,
  away,
  onScrub,
}: {
  /** the stage's element (.wheel-host) */
  stage: HTMLElement | null
  /** the draw is over: the line takes a hand */
  live: boolean
  /** the hold has the screen: the line steps aside */
  away: boolean
  /** a hand moved the draw (once per drag) */
  onScrub?: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(false)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ id: number; said: boolean } | null>(null)
  const scrubRef = useRef(onScrub)
  useEffect(() => {
    scrubRef.current = onScrub
  }, [onScrub])

  // where the draw is: written onto the line as the stage says it
  useEffect(() => {
    const el = ref.current
    if (!stage || !el) return
    let placed = false
    // on the stage's own frame, wherever it is on the page
    const place = () => {
      const box = exploreOf(stage)?.box()
      if (!box || !box.height) return
      placed = true
      const k = box.height / NOMINAL_H
      const width = box.width - 2 * INSET * k
      Object.assign(el.style, {
        left: `${box.left + INSET * k}px`,
        width: `${width}px`,
        top: `${box.top + (LINE_Y - HIT / 2) * k}px`,
        height: `${HIT * k}px`,
      })
      el.style.setProperty("--k", String(k))
      el.style.setProperty("--w", `${width}px`)
    }
    const show = (t: WheelTimeline) => {
      if (!placed) place()
      el.style.setProperty("--at", t.at.toFixed(4))
      el.setAttribute("aria-valuenow", String(Math.round(t.at * 100)))
      setShown(t.started && !t.prizeUp)
    }
    const said = (e: Event) => show((e as CustomEvent<WheelTimeline>).detail)
    stage.addEventListener(STAGE_TIMELINE, said)
    const now = exploreOf(stage)?.timeline()
    if (now) show(now)
    addEventListener("resize", place)
    return () => {
      stage.removeEventListener(STAGE_TIMELINE, said)
      removeEventListener("resize", place)
    }
  }, [stage])

  const scrubTo = (x: number) => {
    const el = ref.current
    const wheel = exploreOf(stage)
    if (!el || !wheel) return
    const r = el.getBoundingClientRect()
    const at = clamp01((x - r.left) / Math.max(1, r.width))
    if (!wheel.scrub(at)) return
    // the line follows the finger at once, not a frame later
    el.style.setProperty("--at", at.toFixed(4))
    if (drag.current && !drag.current.said) {
      drag.current.said = true
      scrubRef.current?.()
    }
  }
  const letGo = () => {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
    exploreOf(stage)?.scrubEnd()
  }
  // the hold took the screen mid-drag (another finger): the hand lets go
  useEffect(() => {
    if (!live || away) letGo()
  })

  const on = live && !away
  return (
    <div
      ref={ref}
      role="slider"
      aria-label="The draw's spin"
      aria-valuemin={0}
      aria-valuemax={100}
      // where it is from then on is written as the stage says it (show, above): the prop never changes, so React leaves it
      aria-valuenow={0}
      aria-disabled={!on}
      tabIndex={on ? 0 : -1}
      className="draw-timeline"
      data-shown={shown && !away ? "" : undefined}
      data-live={on ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      onPointerDown={(e) => {
        if (!on) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { id: e.pointerId, said: false }
        setDragging(true)
        scrubTo(e.clientX)
      }}
      onPointerMove={(e) => {
        if (drag.current?.id === e.pointerId) scrubTo(e.clientX)
      }}
      onPointerUp={(e) => {
        if (drag.current?.id === e.pointerId) letGo()
      }}
      onPointerCancel={(e) => {
        if (drag.current?.id === e.pointerId) letGo()
      }}
      onKeyDown={(e) => {
        if (!on) return
        const step = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -KEY_STEP : e.key === "ArrowRight" || e.key === "ArrowUp" ? KEY_STEP : 0
        const wheel = exploreOf(stage)
        if (!step || !wheel) return
        e.preventDefault()
        if (wheel.scrub(clamp01(wheel.timeline().at + step))) {
          scrubRef.current?.()
          wheel.scrubEnd()
        }
      }}
    >
      <i className="draw-timeline-line">
        <i className="draw-timeline-fill" />
      </i>
      <i className="draw-timeline-thumb" />
    </div>
  )
}
