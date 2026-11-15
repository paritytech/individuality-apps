// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { useEffect, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { PROBE_OPACITY, PROBE_TURN_MS, startProbe, type ProbeStage } from "@/lib/device-probe"
import { FinalTile } from "./tile/final-tile"

const OTHERS = [1, 2, 3, 4, 5]

/**
 * The device check: the round grid at a near-zero opacity over the page, with
 * the tiles turning, while the frame times are measured.
 */
export function DeviceProbe({ stage, stream }: { stage: ProbeStage; stream: MediaStream }): ReactNode {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const turns = setInterval(() => setTick((t) => t + 1), PROBE_TURN_MS)
    const cancelProbe = startProbe(stage)
    return () => {
      clearInterval(turns)
      cancelProbe()
    }
  }, [stage])

  // the opacity stays above 0: a browser skips the paint of a layer at exactly 0
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[1000] flex items-center justify-center px-2"
      style={{ opacity: PROBE_OPACITY }}
    >
      <div className="relative grid w-full max-w-[374px] grid-cols-2 gap-2">
        <FinalTile seed={6} variant="you" stream={stream} mirrored flippable={false} />
        {OTHERS.map((i) => (
          <FinalTile
            key={i}
            seed={i}
            variant="other"
            stream={stream}
            flippable
            verdict={tick === 0 ? undefined : (tick + i) % 2 === 0 ? "approve" : "reject"}
          />
        ))}
      </div>
    </div>,
    document.body,
  )
}
