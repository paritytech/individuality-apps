// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react"
import type { AutoRejectCue } from "../animations"
import type { TileVerdict } from "./tile-faces"
import { wiggleClock } from "./tile-geometry"

// ── the auto-reject cue ─────────────────────────────────────────────────
// Over the warning window the tile's light sweeps in, its proportions
// breathe and it leans; its wave is tile-layers' TileWave, CSS alone. In
// low power mode the tile keeps it off.

/** the share of the window the wiggle grows over */
const SHAPE_RAMP = 0.3
/** the cue's wiggle reaches this share of the full depth */
const CUE_SOFT = 0.35
/** the breath, on each axis, and the zoom over it, at the full wiggle */
const SHAPE_BREATH = 0.035
const CUE_ZOOM = 0.05
/** the lean about x at its full depth (y leans a quarter more) */
const TILT_DEG = 12
const TILT_K = 0.5
/** while the tile leans, its slab spreads this much deeper, so the side shows */
export const TILT_SLAB_K = 2
/** the cue's shape and light step this often, its lean every frame. A new
 *  outline is a new clip-path, a mask re-rastered over the live feed, and the
 *  light a repaint: at 60 a second for every tile at once they held a
 *  low-end phone's GPU to ~23 fps. The lobes drift slowly enough that a step
 *  this size does not read. */
const SHAPE_STEP_MS = 66

const smoothstep = (u: number) => u * u * (3 - 2 * u)

/** the tile's state that the writer reads, as the last render left it */
interface CueInputs {
  seed: number
  inCue: boolean
  /** the verdict the faces hold (lags the prop through a reset) */
  shown: TileVerdict | undefined
  resetting: boolean
  /** the host and the own tile: their pool is always fully lit */
  roleLit: boolean
}

/** one frame of the cue: the window's progress, and the frame's time */
interface CueFrame {
  progress: number
  at: number
  /** the window's length, ms: how far the progress runs in a step */
  leadMs: number
}

type Written = HTMLElement & { __cueT?: string; __cueL?: string }

/**
 * The cue. Every element that carries `data-cue` has its light ("glow") or its
 * lean ("cue") written here, and nowhere else: the tile does not render per
 * frame. The writer runs after each render and on each cue frame.
 */
export function useTileCue({
  rootRef,
  autoReject,
  eligible,
  ...state
}: Omit<CueInputs, "inCue"> & {
  rootRef: RefObject<HTMLElement | null>
  autoReject: AutoRejectCue | undefined
  /** votable, undecided and on its front: the only tile the cue is for */
  eligible: boolean
}): { inCue: boolean } {
  // "held": the window has run out, and the shape waits for the verdict
  const [cue, setCue] = useState<"idle" | "running" | "held">("idle")
  if (!eligible && cue !== "idle") setCue("idle")
  else if (eligible && cue === "idle" && autoReject?.active && autoReject.remainingMs > 0) setCue("running")
  const inCue = eligible && cue !== "idle"
  const running = inCue && cue === "running"
  const leadMs = autoReject?.leadMs ?? 0
  const remainingMs = autoReject?.active ? autoReject.remainingMs : 0

  const inputs = useRef<CueInputs | null>(null)
  const frame = useRef<CueFrame>({ progress: 0, at: 0, leadMs: 0 })
  /** the session re-times the window twice a second; the loop runs between two syncs */
  const sync = useRef({ ms: remainingMs, fresh: true })

  const write = useCallback(() => {
    const root = rootRef.current
    const s = inputs.current
    if (!root || !s) return
    const f = frame.current
    // the cue's depth grows in over the window's first stretch; the light steps (SHAPE_STEP_MS)
    const stepped = shapeStep(f)
    const amt = s.inCue ? smoothstep(Math.min(1, stepped.progress / SHAPE_RAMP)) * CUE_SOFT : 0
    const lit = s.inCue ? stepped.progress : f.progress
    const ramp = lit * lit * (3 - 2 * lit)
    const level =
      s.roleLit || (s.shown !== undefined && !s.resetting) ? 1 : s.inCue ? Math.min(1, 0.2 + ramp * 0.9) : 0
    const lvl = level.toFixed(3)
    // the swept reveal: a clockwise wipe from the top centre, open past 360° at full
    const sweep = level >= 1 || !(level > 0) ? "460deg" : `${(100 + level * 360).toFixed(1)}deg`
    const lean = s.inCue ? cueTransform(amt, f, wiggleClock(s.seed)) : "none"

    for (const node of root.querySelectorAll<HTMLElement>("[data-cue]")) {
      const el = node as Written
      for (const k of el.dataset.cue!.split(" ")) {
        if (k === "cue") {
          if (el.__cueT !== lean) {
            el.style.transform = lean
            el.__cueT = lean
          }
        } else if (k === "glow") {
          const light = `${lvl}|${sweep}`
          if (el.__cueL !== light) {
            el.style.setProperty("--level", lvl)
            el.style.setProperty("--sweep", sweep)
            el.__cueL = light
          }
        }
      }
    }
  }, [rootRef])

  // the inputs first, so every write below reads this render's state
  useLayoutEffect(() => {
    inputs.current = { ...state, inCue }
  })
  useLayoutEffect(() => {
    sync.current = { ms: remainingMs, fresh: true }
  }, [remainingMs])

  // the cue's loop. The progress comes from the time LEFT, so a tile that
  // joins mid-window starts where it belongs.
  useLayoutEffect(() => {
    if (!running) return
    let raf = 0
    let anchorMs = sync.current.ms
    let anchorAt = performance.now()
    sync.current.fresh = false
    const progressAt = (now: number) => {
      const left = Math.max(0, anchorMs - (now - anchorAt))
      return leadMs > 0 ? Math.min(1, (leadMs - left) / leadMs) : 1
    }
    frame.current = { progress: progressAt(anchorAt), at: anchorAt, leadMs }
    const step = (now: number) => {
      if (sync.current.fresh) {
        sync.current.fresh = false
        anchorMs = sync.current.ms
        anchorAt = now
      }
      frame.current = { progress: progressAt(now), at: now, leadMs }
      write()
      // at the end of the window the shape holds; the reject comes as the verdict
      if (frame.current.progress >= 1) setCue("held")
      else raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [running, leadMs, write])

  // after every render: a layer that just mounted gets its shape before paint
  useLayoutEffect(write)

  return { inCue }
}

/** the frame the cue's shape and light are drawn for: the last SHAPE_STEP_MS
 *  step's, with the window's progress taken back to it. On the wall clock, so
 *  every tile steps on the same frames. */
function shapeStep(f: CueFrame): CueFrame {
  const at = Math.floor(f.at / SHAPE_STEP_MS) * SHAPE_STEP_MS
  return { at, progress: f.progress >= 1 ? 1 : Math.max(0, f.progress - (f.at - at) / Math.max(1, f.leadMs)), leadMs: f.leadMs }
}

/** the cue's breath, zoom and lean, growing in with the wiggle, each on the tile's own clock */
function cueTransform(amt: number, f: CueFrame, clock: { offset: number; speed: number }): string {
  const t = f.at / 1000
  const out: string[] = []
  if (amt > 0) {
    const bx = 1 + SHAPE_BREATH * amt * Math.sin(t * 2.1 * clock.speed + clock.offset)
    const by = 1 + SHAPE_BREATH * amt * Math.sin(t * 1.6 * clock.speed + clock.offset + 1.9)
    out.push(`scale(${bx.toFixed(4)}, ${by.toFixed(4)})`)
    const z = 1 + CUE_ZOOM * amt * Math.sin(t * 1.45 * clock.speed + clock.offset + 0.9)
    out.push(`scale(${z.toFixed(4)})`)
  }
  const k = smoothstep(Math.min(1, f.progress / SHAPE_RAMP)) * TILT_K
  const rx = TILT_DEG * k * Math.sin(t * 1.3 * clock.speed + clock.offset + 0.7)
  const ry = TILT_DEG * 1.25 * k * Math.sin(t * 0.9 * clock.speed + clock.offset + 2.3)
  const rz = 1.5 * k * Math.sin(t * 1.1 * clock.speed + clock.offset + 4.1)
  out.push(`rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg) rotateZ(${rz.toFixed(3)}deg)`)
  return out.join(" ")
}
