// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * How the hidden debug sheet is summoned. Two gestures, no visible affordance:
 *
 *  - Desktop: Cmd+D / Ctrl+D toggles it (we preventDefault the browser's
 *    bookmark shortcut).
 *  - Phone: tap the TOP THIRD of the screen 5 times within 1.5s.
 *
 * The tap gesture is a PASSIVE window listener — it never intercepts the touch,
 * so the app's own top-of-screen UI (headers, buttons) keeps working; we only
 * count taps that happen to land up top. 5-in-1.5s is deliberately hard to hit
 * by accident.
 */
import { useCallback, useEffect, useState } from "react"

const TAP_COUNT = 5
const TAP_WINDOW_MS = 1500
/** taps only count in the top third of the viewport */
const TOP_FRACTION = 1 / 3

export function useDebugSheet(): { open: boolean; setOpen: (open: boolean) => void } {
  const [open, setOpen] = useState(false)

  const toggle = useCallback(() => setOpen((v) => !v), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault()
        toggle()
      }
      if (e.key === "Escape") setOpen(false)
    }

    let taps: number[] = []
    const onPointer = (e: PointerEvent) => {
      if (e.clientY > window.innerHeight * TOP_FRACTION) {
        taps = []
        return
      }
      const now = Date.now()
      taps = taps.filter((t) => now - t < TAP_WINDOW_MS)
      taps.push(now)
      if (taps.length >= TAP_COUNT) {
        taps = []
        toggle()
      }
    }

    window.addEventListener("keydown", onKey)
    // passive: we watch, we never intercept — the app's top UI still works
    window.addEventListener("pointerdown", onPointer, { passive: true })
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pointerdown", onPointer)
    }
  }, [toggle])

  return { open, setOpen }
}
