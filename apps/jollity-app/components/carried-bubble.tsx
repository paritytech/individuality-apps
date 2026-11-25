// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * THE BUBBLE BETWEEN THE SCREENS. The draw's hold carries the bubble to
 * /collectables (lib/collectables-scene/carry), and for the moment of the route change
 * neither page draws it: the draw page is gone, and the collectables screen's engine has
 * not drawn its first frame. This holds it there, still swirling, from the
 * draw page's leaving until the engine has drawn its own (carryShown), then
 * lets go in a breath. It is the one layer that outlives a screen, and it
 * draws nothing at all unless a bubble is in flight.
 */
import { useEffect, useRef, useState } from "react"
import { CARRY_MAX_AGE_MS, watchCarried, type CarriedBubble } from "@/lib/collectables-scene/carry"
import { drawCarriedBubble } from "@/lib/draw/hold/film"

/** how long it takes to let go, once the collectables screen has the bubble */
const LET_GO_MS = 160

export function CarriedBubbleLayer() {
  const [bubble, setBubble] = useState<CarriedBubble | null>(null)
  const [letGo, setLetGo] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(
    () =>
      watchCarried((next) => {
        if (next) {
          setBubble(next)
          setLetGo(false)
        } else setLetGo(true)
      }),
    [],
  )

  // let go: the fade, then nothing
  useEffect(() => {
    if (!letGo) return
    const timer = setTimeout(() => setBubble(null), LET_GO_MS)
    return () => clearTimeout(timer)
  }, [letGo])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!bubble || !canvas) return
    const g = canvas.getContext("2d")
    if (!g) return
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      // the collectables screen never took it (it was reached some other way): let go
      if (performance.now() - bubble.at > CARRY_MAX_AGE_MS) setLetGo(true)
      const dpr = Math.min(2, devicePixelRatio || 1)
      const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, innerWidth, innerHeight)
      drawCarriedBubble(g, bubble, performance.now() / 1000)
    }
    frame()
    return () => cancelAnimationFrame(raf)
  }, [bubble])

  if (!bubble) return null
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[60] h-full w-full transition-opacity"
      style={{ opacity: letGo ? 0 : 1, transitionDuration: `${LET_GO_MS}ms` }}
    />
  )
}
