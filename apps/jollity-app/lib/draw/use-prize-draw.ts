// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The prize draw screen for React: one host (lib/draw/draw-screen-host) for
 * the page's life, its view read with useSyncExternalStore, and the page's
 * own happenings (Continue, visibility, leaving) sent in.
 */
import { useEffect, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { useScene } from "@/lib/telemetry/use-scene"
import { browserDrawScreenDeps } from "@/lib/draw/draw-screen-deps"
import { createDrawScreenHost, type DrawScreenHost } from "@/lib/draw/draw-screen-host"
import type { DrawScreenView } from "@/lib/draw/draw-screen"

export function usePrizeDraw(): { view: DrawScreenView; host: DrawScreenHost } {
  const router = useRouter()
  const [host] = useState(() => createDrawScreenHost(browserDrawScreenDeps(router)))
  const view = useSyncExternalStore(host.subscribe, host.view, host.view)

  useEffect(() => {
    host.attach()
    const visibility = () => host.send({ type: document.visibilityState === "hidden" ? "hidden" : "visible" })
    const left = () => host.send({ type: "page-left" })
    document.addEventListener("visibilitychange", visibility)
    window.addEventListener("pagehide", left)
    return () => {
      document.removeEventListener("visibilitychange", visibility)
      window.removeEventListener("pagehide", left)
      host.detach()
    }
  }, [host])

  // the draw's frame timing, once its result (the wheel or the words) is on screen
  useScene("draw.wheel", view.kind === "wheel" || view.kind === "words")
  return { view, host }
}
