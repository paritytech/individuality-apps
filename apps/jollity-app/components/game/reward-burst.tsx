// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { useEffect, useRef } from "react"
import { createBurst, type BurstHandle } from "@/lib/reward-burst"
import { useReducedMotion } from "./animations"

/**
 * The reward burst's CANVAS HOST, and nothing else. Every particle, every
 * physics constant and the beat's own numbers live in lib/reward-burst.ts
 * (architecture rule 6) — this file owns one canvas, one rAF loop, and the
 * decision to stop.
 *
 * Two rules hold it together:
 *  - THE CANVAS IS SIZED ONCE. `createBurst` measures the parent and sets the
 *    backing store, and setting a canvas's size CLEARS it — so the handle is
 *    built once and a later wave never resizes.
 *  - THE LOOP RUNS ONLY WHILE PARTICLES LIVE. `step` reports whether anything
 *    is still in flight; when it is not, the loop stops and the next wave
 *    starts it again. A tile that is not celebrating costs nothing.
 *
 * `burst` is a monotonically rising id, or 0 for "never fired". Changing it
 * spawns particles [start, end). The three are plain numbers rather than one
 * range object on purpose: an object literal would be a new identity on every
 * parent render and refire the wave.
 */
export function RewardBurst({
  burst,
  start,
  end,
}: {
  burst: number
  start: number
  end: number
}) {
  // this host is built by the PAGE and handed to the tile as a node, so it
  // cannot take the tile's own answer as a prop — it asks for itself
  const reduce = useReducedMotion()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<BurstHandle | null>(null)
  const rafRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (reduce || !canvas) return
    const handle = createBurst(canvas)
    handleRef.current = handle
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      handleRef.current = null
      handle.destroy()
    }
  }, [reduce])

  useEffect(() => {
    const handle = handleRef.current
    if (!burst || !handle) return
    handle.spawn(start, end)
    if (rafRef.current) return // the loop is already running — the new particles ride along
    let last = performance.now()
    const tick = (now: number) => {
      const alive = handle.step(now - last)
      last = now
      rafRef.current = alive ? requestAnimationFrame(tick) : 0
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [burst, start, end])

  if (reduce) return null
  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0" />
}
