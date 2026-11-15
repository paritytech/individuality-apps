// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * THE WAITING ROOM: one screen on two routes (lib/waiting-room.ts). The home
 * shows it until the handover, and /game shows it until the tiles move in.
 * Top to bottom: the page dots, "Game starting" and the kickoff time, the
 * clock, the connection footer, and "How to play", whose steps slide in over
 * the same screen. The route gives the clock, so the time left does not jump at
 * the handover. The room comes in on the home and goes out on /game.
 */
import { createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { DIAL_ENDS_BEFORE, DIAL_WINDOW } from "@jollity/game-chain/game"
import { resolveCountdownArt, type CountdownArt } from "@/components/countdown/registry"
import type { CameraState } from "@/lib/camera"
import type { CameraTrouble } from "@/lib/camera-help"
import { fetchCountdownArt, type CountdownArtChoice } from "@/lib/countdown-art"
import { formatClock } from "@/lib/format"
import { DIAL_SIZE, DIAL_WHITE, DIGIT_FONT, DIGIT_TRACKING } from "@/lib/waiting-dial"
import { clockFace, howToPlay, swipeStep, type HowToPlayStep, type WaitingClock, type WaitingFooter, type WaitingPeer } from "@/lib/waiting-room"
import { CameraCard } from "./camera-card"
import { ConnectionFooter } from "./connection-footer"
import { HowToPlayFooter, HowToPlaySlides, PageDots, SLIDE_CLASS, slideStyle } from "./how-to-play-slides"

/** run: digits or dial; exit: the room goes out before the tiles move in */
type Stage = "run" | "exit"

/** the length of the exit animation, s: it ends with the 00 second, as the tiles start to move in */
const EXIT_S = 0.48

/** the room's dial: 250, down from the dial's native 274, so
 *  the connection footer fits under it; everything in it, the number too,
 *  scales with it */
const ROOM_DIAL = 250

export function WaitingRoom(props: {
  route: "home" | "game"
  /** the kickoff in the chain frame: the key of the open How to play step */
  gameAt: number
  clock: WaitingClock
  camera: CameraState
  /** non-null shows the camera card */
  cameraHelp: CameraTrouble | null
  footer: WaitingFooter
  /** [] on the home */
  peers: readonly WaitingPeer[]
  rootAttrs?: Record<string, string | number | boolean | undefined>
}) {
  const { route, gameAt, clock, camera, cameraHelp, footer, peers, rootAttrs } = props
  const step = useSyncExternalStore(howToPlay.subscribe, () => howToPlay.get(gameAt), () => -1 as HowToPlayStep)
  const [stage, setStage] = useState<Stage>("run")
  // the pointer down of a swipe on the stage
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null)

  // the steps close as the room goes out
  useEffect(() => {
    if (stage !== "run" && step !== -1) howToPlay.set(gameAt, -1)
  }, [stage, step, gameAt])

  // the art pick of the week; the default dial until it answers
  const [artChoice, setArtChoice] = useState<CountdownArtChoice | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetchCountdownArt().then((fetched) => {
      if (!cancelled) setArtChoice(fetched)
    })
    return () => {
      cancelled = true
    }
  }, [])
  // the art module is resolved once per choice, never re-created per render
  const Art = useMemo(() => resolveCountdownArt(artChoice), [artChoice])

  const exiting = route === "game" && stage === "exit"
  const blockMotion = route === "home" ? "waiting-room-enter" : exiting ? "waiting-room-exit" : ""
  const sideMotion = route === "home" ? "waiting-room-cta-enter" : exiting ? "waiting-room-cta-exit" : ""

  return (
    <div
      {...rootAttrs}
      className="relative flex min-h-dvh flex-1 flex-col overflow-clip bg-background text-foreground"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {cameraHelp ? <CameraCard help={cameraHelp} hidden={step !== -1} className={sideMotion} /> : null}
      <div className={"flex flex-1 flex-col " + blockMotion}>
        <PageDots step={step} className={cameraHelp ? "mt-[25.5px]" : "mt-[9.5px]"} />
        {/* the stage: the room's page in the flow, the steps over it; a horizontal swipe turns the page */}
        <div
          className="relative mt-4 flex flex-1 flex-col"
          style={{ touchAction: "pan-y" }}
          onPointerDown={(e) => {
            if (e.isPrimary && stage === "run") swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
          }}
          onPointerUp={(e) => {
            const down = swipe.current
            if (down?.id !== e.pointerId) return
            swipe.current = null
            const next = swipeStep(step, e.clientX - down.x, e.clientY - down.y)
            if (next !== step) howToPlay.set(gameAt, next)
          }}
          onPointerCancel={() => {
            swipe.current = null
          }}
        >
          <div
            aria-hidden={step !== -1 || undefined}
            className={"flex flex-1 flex-col items-center text-center " + SLIDE_CLASS}
            style={slideStyle(-1, step)}
          >
            <h1 className="w-full max-w-[390px] px-6 font-heading text-[32px] leading-10 font-semibold text-foreground">Game starting</h1>
            <p className="w-full max-w-[390px] px-6 text-lg leading-[22px] font-semibold text-muted-foreground">at {formatClock(clock.kickoffAt)}</p>
            {/* the dial centred between the time line and the footer's top */}
            <div className="flex w-full flex-1 items-center justify-center">
              <ClockSlot kickoffAt={clock.kickoffAt} nowMs={clock.nowMs} Art={Art} onStage={setStage} />
            </div>
            {/* the footer's foot 39 over How to play */}
            <div className="mb-[39px] w-full shrink-0">
              <ConnectionFooter camera={camera} footer={footer} peers={peers} />
            </div>
          </div>
          <HowToPlaySlides step={step} />
        </div>
      </div>
      <footer
        className={"px-6 " + sideMotion}
        style={{ paddingBottom: "max(39px, env(safe-area-inset-bottom))" }}
      >
        {/* the Back and Next row is 4 px taller than the button and grows up */}
        <div className="relative flex h-12 items-end justify-center">
          <HowToPlayFooter step={step} onStep={(next) => howToPlay.set(gameAt, next)} />
        </div>
      </footer>
    </div>
  )
}

/**
 * The clock: the digits while more than one dial turn is left, then the art
 * for the turn. One frame loop reads the route's clock. It sets
 * state only when the shown face or the stage changes.
 */
function ClockSlot({
  kickoffAt,
  nowMs,
  Art,
  onStage,
}: {
  kickoffAt: number
  nowMs: () => number
  Art: CountdownArt
  onStage: (stage: Stage) => void
}) {
  // the digits text, or "art"; empty until the first frame
  const [face, setFace] = useState("")
  useEffect(() => {
    let raf = 0
    let shown = ""
    let stage: Stage | null = null
    const frame = () => {
      const f = clockFace({ kickoffAt, nowMs }, nowMs())
      const next = f.kind === "digits" ? f.text : "art"
      if (next !== shown) {
        shown = next
        setFace(next)
      }
      const nextStage: Stage = f.kind === "ended" || (f.kind === "dial" && f.left <= EXIT_S) ? "exit" : "run"
      if (nextStage !== stage) {
        stage = nextStage
        onStage(nextStage)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [kickoffAt, nowMs, onStage])

  return (
    <div className="relative shrink-0" style={{ width: ROOM_DIAL, height: ROOM_DIAL }}>
      {/* the dial and the digits drawn at their native 274, scaled to the room's dial */}
      <div className="absolute top-0 left-0 origin-top-left" style={{ width: DIAL_SIZE, height: DIAL_SIZE, transform: `scale(${ROOM_DIAL / DIAL_SIZE})` }}>
        {face === "art" ? (
          // createElement, not JSX: the module is a memoised value, and the
          // static-components rule reads JSX on it as a component made in render
          createElement(Art, { endsAt: kickoffAt - DIAL_ENDS_BEFORE, nowMs, windowSec: DIAL_WINDOW })
        ) : (
          // tabular-nums after the font shorthand: the shorthand resets it, and a class loses to the inline style
          <p
            className="grid h-full place-items-center"
            style={{ font: DIGIT_FONT, fontVariantNumeric: "tabular-nums", letterSpacing: DIGIT_TRACKING, color: DIAL_WHITE }}
          >
            {face}
          </p>
        )}
      </div>
    </div>
  )
}
