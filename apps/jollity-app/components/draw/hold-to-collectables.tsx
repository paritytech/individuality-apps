// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * THE WAY ON FROM THE DRAW, WITH NO BUTTON: hold, and the draw is pulled into
 * the collectables' bubble. The brains are
 * lib/draw/hold/scene (framework-free, architecture rule 6); this only hosts
 * it, over the stage, once the draw has offered its way on, and forwards the
 * finger.
 *
 * Under the stage, the collectables' room's dark (app/globals.css
 * .collectables-backdrop--plain; the hold draws its stars and glow): as the bubble
 * glides off and the draw fades, the room is what shows. When the bubble
 * is up, it is handed over (lib/collectables-scene/carry) and the page goes on:
 * `onContinue`, the page's way on (the draw screen's `continue`).
 *
 * Until the hold, the wheel is there to look round (lib/draw/hold/look): tap a
 * ticket to see whose it is, pinch or double-tap to zoom, drag to move it
 * while zoomed in; and the draw's timeline along the bottom goes back to any
 * point of the spin (./draw-timeline).
 */
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { collectablesHref } from "@/lib/draw/collectables-href"
import { createHoldScene } from "@/lib/draw/hold/scene"
import { DrawTimeline } from "@/components/draw/draw-timeline"
import { carry, type CarriedBubble } from "@/lib/collectables-scene/carry"

export function HoldToCollectables({
  stage,
  offered,
  onContinue,
}: {
  /** the stage's element (.wheel-host): its frame is read, and it falls back */
  stage: HTMLElement | null
  /** the draw has ended and offers its way on: the hold is live */
  offered: boolean
  onContinue: () => void
}) {
  const router = useRouter()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const hintRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<ReturnType<typeof createHoldScene> | null>(null)
  const continueRef = useRef(onContinue)
  // the ticket picked on the wheel, said for a screen reader
  const [picked, setPicked] = useState("")
  // where the hold is (lib/draw/hold/scene's phases), and whether it has the screen: the timeline follows
  const [phase, setPhase] = useState("prize")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    continueRef.current = onContinue
  }, [onContinue])

  // A PINCH IS THE WHEEL'S, NEVER THE PAGE'S: on the hold's layer the
  // browser's own touch handling is off, so two fingers zoom the wheel, not
  // the page, a double tap does not zoom the page, and a drag can neither
  // scroll it nor pull it down to reload. `touch-action: none` does this where
  // it is honoured; the touches themselves and iOS's gesture events are
  // cancelled for the browsers that zoom anyway. The wheel's own pointer
  // events still come, ahead of these. Pull-to-refresh is off while it is up
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const stop = (e: Event) => {
      if (e.cancelable) e.preventDefault()
    }
    const kinds = ["touchstart", "touchmove", "gesturestart", "gesturechange", "gestureend"]
    for (const kind of kinds) canvas.addEventListener(kind, stop, { passive: false })
    const root = document.documentElement
    const was = root.style.overscrollBehavior
    root.style.overscrollBehavior = "none"
    return () => {
      for (const kind of kinds) canvas.removeEventListener(kind, stop)
      root.style.overscrollBehavior = was
    }
  }, [])

  // the collectables screen's page, fetched while the hold goes, so the step to it is short
  useEffect(() => {
    if (offered) router.prefetch(collectablesHref())
  }, [offered, router])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!offered || !stage || !canvas) return
    const scene = createHoldScene(canvas, {
      stage,
      hintEl: hintRef.current,
      onPick: (p: { name: string; won: boolean; you: boolean } | null) =>
        setPicked(p ? `${p.you ? "Your ticket" : p.name}${p.won ? ", a winner" : ""}` : ""),
      onPhase: setPhase,
      onBusy: setBusy,
      onRisen: (bubble: CarriedBubble) => {
        carry(bubble)
        continueRef.current()
      },
    })
    sceneRef.current = scene
    return () => {
      scene.destroy()
      sceneRef.current = null
    }
  }, [offered, stage])

  const at = (e: React.PointerEvent) => [e.pointerId, e.clientX, e.clientY] as const
  return (
    <>
      <div aria-hidden className="collectables-backdrop--plain pointer-events-none fixed inset-0 -z-10" />
      <canvas
        ref={canvasRef}
        aria-hidden
        className="fixed inset-0 z-50 h-full w-full"
        style={{ pointerEvents: offered ? "auto" : "none", touchAction: "none" }}
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* capture is a nicety (as on the collectables screen's canvas): never lose the press */
          }
          sceneRef.current?.pointerDown(...at(e))
        }}
        onPointerMove={(e) => sceneRef.current?.pointerMove(...at(e))}
        onPointerUp={(e) => sceneRef.current?.pointerUp(e.pointerId)}
        onPointerCancel={(e) => sceneRef.current?.pointerUp(e.pointerId)}
      />
      {/* HOLD ANYWHERE: its own small layer, breathed by CSS (app/globals.css), faded by the scene */}
      <div ref={hintRef} aria-hidden className="hold-hint">
        <i className="hold-hint-ring" />
        <span className="hold-hint-label">HOLD ANYWHERE</span>
      </div>
      {/* the draw's timeline, over the hold's layer: back to any point of the spin once the draw is over */}
      <DrawTimeline
        stage={stage}
        live={offered && phase === "ready"}
        away={busy}
        onScrub={() => sceneRef.current?.scrubbed()}
      />
      <p aria-live="polite" className="sr-only">
        {picked}
      </p>
      {offered ? (
        // no visible button: the way on for a keyboard or a screen reader
        <button type="button" className="sr-only" onClick={() => sceneRef.current?.skip()}>
          Continue to your collectables
        </button>
      ) : null}
    </>
  )
}
