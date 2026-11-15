// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import {
  PILL_FILL_MS,
  PILL_H_PX,
  PILL_RADIUS_PX,
  PILL_W_PX,
  chromeDuckStyle,
  turnPill,
  turnPillCount,
  turnPillIndex,
  type TurnCue,
} from "@/components/game/animations"

/**
 * The TURN BAR. One vertical pill per turn, the whole game across the frame:
 * the sum of the rounds' turn counts, by arithmetic — a 6-member group over
 * two rounds makes twelve, a 4-member group eight. A past turn holds full,
 * the current one fills from the bottom over the turn, a future one stays
 * dark. The bar ducks out of sight while the grid is parked or the host is in
 * the spotlight — animations.ts owns both curves.
 *
 * The pills shrink before they overflow: each one is `PILL_W_PX` wide at
 * most and may shrink to fit, with `gap-1` as the floor between them, so a
 * longer game narrows the pills instead of running past the frame.
 */
export function TurnPills({
  cue,
  ducked = false,
  className,
}: {
  cue: TurnCue
  /** true during the intro pose and the round gap */
  ducked?: boolean
  className?: string
}) {
  const count = turnPillCount(cue)
  const at = turnPillIndex(cue)

  return (
    <div
      className={cn("pointer-events-none flex w-full items-center justify-between gap-1", className)}
      style={chromeDuckStyle(ducked)}
      aria-label={`Turn ${at + 1} of ${count}`}
      aria-hidden={ducked}
    >
      {Array.from({ length: count }, (_, i) => {
        const { state, fill } = turnPill(i, cue)
        const turnMs = (cue.turnSec ?? 0) * 1000
        return (
          <div
            key={i}
            className="relative min-w-0 overflow-hidden"
            style={{
              // `flex: 0 1 <w>`: never grow, shrink when the row is short
              flex: `0 1 ${PILL_W_PX}px`,
              maxWidth: PILL_W_PX,
              height: PILL_H_PX,
              borderRadius: PILL_RADIUS_PX,
              background: "var(--game-track)",
            }}
          >
            {state === "current" && turnMs > 0 ? (
              // the live pill, on the turn's own clock — one CSS run, no steps
              <LiveFill key={`live-${i}`} progress={fill} turnMs={turnMs} />
            ) : (
              <div
                className="absolute right-0 bottom-0 left-0"
                style={{
                  height: `${fill * 100}%`,
                  background: "var(--game-track-fill)",
                  // only the live pill tweens. A pill that just became "past"
                  // must not animate its jump to full.
                  transition: state === "current" ? `height ${PILL_FILL_MS}ms linear` : "none",
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The LIVE PILL'S FILL, on one CSS transition per turn.
 *
 * The session clock steps in whole seconds, so a height that follows
 * `cue.progress` climbs in stairs — the eye reads the stairs, not the turn.
 * This layer takes ONE reading, at mount: where the turn already stands, and
 * how much of it is left. It paints that height on the first frame, then asks
 * for full height over the remaining time, linearly. The browser interpolates
 * every frame from there, and a later render writes the same target, so the
 * run never restarts. Each turn owns a fresh pill element, so each turn gets
 * a fresh reading — a mid-turn join included.
 */
function LiveFill({ progress, turnMs }: { progress: number; turnMs: number }) {
  // mount-time only: a lazy initial state keeps the FIRST render's reading,
  // so the clock's later steps cannot re-anchor a run already in flight
  const [{ from, runMs }] = useState(() => {
    const at = Math.min(1, Math.max(0, progress))
    return { from: at, runMs: Math.max(0, (1 - at) * turnMs) }
  })
  const [full, setFull] = useState(false)

  useEffect(() => {
    // two frames: the first paints `from`, the second starts the run. One
    // frame is not enough — the style write would coalesce with the mount.
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setFull(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [])

  return (
    <div
      className="absolute right-0 bottom-0 left-0"
      style={{
        height: full ? "100%" : `${from * 100}%`,
        background: "var(--game-track-fill)",
        transition: full ? `height ${runMs}ms linear` : "none",
      }}
    />
  )
}
