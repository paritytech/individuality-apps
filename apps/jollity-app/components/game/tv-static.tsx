// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The TV-static tile fill: a film grain, BAKED: ten frames of per-pixel monochrome random luminance
 * (128×128, a pure-white sparkle scattered through the grain) as one looping
 * GIF at 25 fps (public/grain.gif), scaled up by CSS: nothing per frame.
 *
 * `TvStatic` composes it as the design's lost tiles do: a dim under the
 * grain, both OVER the feed rather than instead of it. A player we can't
 * reach (#1349) gets the can't-reach static: the same grain, now and then
 * collecting into a tracking band (lib/tracking-band.ts).
 */
import { useEffect, useRef } from "react"
import { asset } from "@/lib/asset"
import { useLowPower } from "@/lib/low-power"
import { prefersReducedMotion } from "@/lib/reduced-motion"
import { bandRows, episodeEnvelope, episodeLife, GRAIN_PX, nextEpisodeIn, paintBand } from "@/lib/tracking-band"

/** DEFAULT_GRAIN.opacity — the grain over the dim */
const GRAIN_OPACITY = 0.55
/** DEFAULT_GRAIN.blackOpacity: the ONE grain. Every tile is a registered
 *  player's, and a player whose feed is not here — a no-show or a dropped
 *  link — may still be behind it, so the dim stops where a face would be
 *  faintly visible through it. */
export const GRAIN_DIM_LOST = 0.35
/** the host is gone: near-black static, no face behind it */
export const GRAIN_DIM_HOST_MISSING = 0.92
/** A link still trying (Connecting…, Can't connect): the player is coming
 *  back or nearly here, so the face stays plainly visible under a light
 *  grain. Full static is for a feed that is really gone. */
export const GRAIN_DIM_RECOVERING = 0.15
export const GRAIN_OPACITY_RECOVERING = 0.25

/** the band's frames, at the grain's own 25 fps */
const BAND_FRAME_MS = 40

/**
 * The analogue static, as an OVERLAY: it lays two layers over whatever the
 * tile already shows and leaves that showing through. The dim decides how much
 * of the face survives; the grain draws on its own alpha over it.
 *
 * `fadeInMs` lets the static creep over the face rather than cut to it, for a
 * feed that is failing rather than gone. `cantReach` adds the tracking band.
 * Unmounting clears it at once.
 */
export function TvStatic({
  dim = GRAIN_DIM_LOST,
  grain = GRAIN_OPACITY,
  fadeInMs,
  cantReach = false,
}: {
  dim?: number
  grain?: number
  fadeInMs?: number
  cantReach?: boolean
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={fadeInMs ? { animation: `tv-static-in ${fadeInMs}ms linear both` } : undefined}
    >
      <div
        className="absolute inset-0"
        style={{ background: "var(--game-grain-dim)", opacity: dim }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- a looping texture, not content */}
      <img
        src={asset("/grain.gif")}
        alt=""
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full select-none"
        style={{ opacity: grain }}
      />
      {cantReach ? <TrackingBand quiet={grain} /> : null}
    </div>
  )
}

/**
 * The can't-reach static's band, on its own 128 × 128 layer over the grain.
 * Nothing runs between episodes but the timer to the next one; during one, a
 * frame at the grain's rate. Off in low-power mode and for reduced motion,
 * where the tile keeps the plain static. `quiet`: the grain's opacity, so a
 * pixel the band quiets covers the grain pixel under it.
 */
function TrackingBand({ quiet }: { quiet: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const lowPower = useLowPower()
  useEffect(() => {
    const ctx = ref.current?.getContext("2d")
    if (!ctx || lowPower || prefersReducedMotion()) return
    const img = ctx.createImageData(GRAIN_PX, GRAIN_PX)
    let timer = 0
    const episode = () => {
      const start = performance.now()
      const life = episodeLife(Math.random()) * 1000
      const seed = Math.random() * 1000
      const frame = () => {
        const t = performance.now() - start
        if (t >= life) {
          ctx.clearRect(0, 0, GRAIN_PX, GRAIN_PX)
          timer = window.setTimeout(episode, nextEpisodeIn(Math.random()) * 1000)
          return
        }
        paintBand(img.data, bandRows(t / 1000, seed), episodeEnvelope(t / life), quiet, Math.random)
        ctx.putImageData(img, 0, 0)
        timer = window.setTimeout(frame, BAND_FRAME_MS)
      }
      frame()
    }
    timer = window.setTimeout(episode, nextEpisodeIn(Math.random()) * 1000)
    return () => {
      window.clearTimeout(timer)
      ctx.clearRect(0, 0, GRAIN_PX, GRAIN_PX)
    }
  }, [lowPower, quiet])
  return <canvas ref={ref} width={GRAIN_PX} height={GRAIN_PX} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
}
