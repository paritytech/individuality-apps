// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * THE COLLECTABLES' SKY: the stars of the draw's hold (lib/collectables-scene/stars),
 * over the dark, behind the whole screen. The hold clears them where its
 * bubble is, and so does this, at the spot where the collectables' bubble
 * blows up, until it pops; then they drift back in. Drawn once and then
 * left alone (the hold's stars drift a few px; here they hold still, which
 * costs nothing a frame): again only on a resize, and frame by frame only
 * while they come back in after the pop.
 */
import { useEffect, useRef } from "react"
import { drawStars, type StarHole } from "@/lib/collectables-scene/stars"

/** where the collectables' bubble blows up on a 390 × 844 phone (the hold's SPOT), and the hole the stars
 *  leave round it: a little wider than the bubble itself (the hold's R0 is 47) */
const SPOT = { x: 195 / 390, y: 361 / 844 }
const BUBBLE_R = 52
/** after the pop, the stars drift back into where the bubble was over this long, s */
const REFILL_S = 0.6

export function Starfield({ bubble }: { bubble: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bubbleRef = useRef(bubble)
  useEffect(() => {
    bubbleRef.current = bubble
  }, [bubble])

  useEffect(() => {
    const canvas = canvasRef.current
    const g = canvas?.getContext("2d")
    if (!canvas || !g) return
    let w = 0
    let h = 0
    let dpr = 1
    let dirty = true
    const size = () => {
      dpr = Math.min(2, devicePixelRatio || 1)
      w = innerWidth
      h = innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      dirty = true
    }
    size()
    addEventListener("resize", size)
    let raf = 0
    let poppedAt = -1
    let drawnShrink = -1
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const t = now / 1000
      if (bubbleRef.current) poppedAt = -1
      else if (poppedAt < 0) poppedAt = t
      // the hole closes as the stars come back in: it shrinks to nothing
      const shrink = poppedAt < 0 ? 1 : 1 - Math.min(1, (t - poppedAt) / REFILL_S)
      // nothing changed since it was drawn: nothing to draw
      if (!dirty && shrink === drawnShrink) return
      dirty = false
      drawnShrink = shrink
      const r = (BUBBLE_R * w) / 390
      const hole: StarHole | null = shrink > 0 ? { x: w * SPOT.x, y: h * SPOT.y, r: r * shrink } : null
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      drawStars(g, w, h, t, 1, hole)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener("resize", size)
    }
  }, [])

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none fixed inset-0 -z-10 h-full w-full" />
}
