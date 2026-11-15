// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"
import { useSyncExternalStore, type CSSProperties } from "react"
import { TILE_RADIUS_PX } from "../animations"
import { BLOOM_NEAR_PX, SLAB_DEPTH_PX, TILE_PX, fitDepth, showingFaceDepth } from "./tile-geometry"
import type { TileVerdict } from "./tile-faces"
import { LANDING_BAKE_PAD_PX, landingImage, type PoolLook } from "./tile-bake"
import { PoolGlow, SparkBurst } from "./tile-canvas"

/** the approve verdict's light, as the `--tone` channels */
const APPROVE_TONE = "34,197,94"
const REJECT_TONE = "var(--attest-neg-rgb)"
const toneOf = (verdict: TileVerdict | undefined) => (verdict === "approve" ? APPROVE_TONE : REJECT_TONE)

export type RoleTone = "host" | "me" | ""

/**
 * The pool: the verdict's standing glow, as the tile's own back. It sits just
 * behind the slab and turns WITH the tile, one plane per side, each facing its
 * own face with its back hidden, so the GPU culls each at exactly 90°. Both
 * sides mount only while the turn runs. Its light is baked (tile-bake) and
 * coloured in a small canvas (tile-canvas); the cue writer sets its level.
 * A pending tile and a rejected one wear the turning colour wheel; an approved
 * one wears the plain green.
 */
export function TurnBloom({
  active,
  settled,
  verdict,
  flipped,
  roleTone,
  poolGrow,
}: {
  active: boolean
  settled: boolean
  verdict: TileVerdict | undefined
  flipped: boolean
  roleTone: RoleTone
  poolGrow: number
}) {
  const style = verdict === "approve" ? "red" : "rim"
  const look: PoolLook =
    style === "red" ? "verdict" : `${verdict ? "rim-band" : "rim-hair"}${roleTone ? "-role" : ""}`
  const renderPlane = (side: "front" | "back") => {
    const isBack = side === "back"
    const z = isBack ? BLOOM_NEAR_PX : -BLOOM_NEAR_PX
    return (
      <div
        key={side}
        aria-hidden
        className="tile-turn-bloom-plane tile-one-sided"
        style={{
          transform: `translateZ(${z}px)${isBack ? " rotateY(180deg)" : ""} scale(${fitDepth(BLOOM_NEAR_PX, showingFaceDepth(isBack))})`,
        }}
      >
        <PoolGlow
          wheel={style === "red" ? null : roleTone}
          look={look}
          poolGrow={poolGrow}
          tone={toneOf(verdict)}
          on={settled}
          className={`tile-glow is-${style}${settled ? " is-on" : ""}`}
        />
      </div>
    )
  }
  const sides = active ? (["front", "back"] as const) : ([flipped ? "back" : "front"] as const)
  return <>{sides.map(renderPlane)}</>
}

/**
 * The role ring in low power mode: the host's gold and your own silver as the
 * pool's hairline and haze, but in CSS and still. Only the host tile and your
 * own tile wear it.
 */
export function LowPowerRole({ tone }: { tone: Exclude<RoleTone, ""> }) {
  return <div aria-hidden className={`tile-lp-role is-${tone}`} />
}

/** the lesson's press, lit from below: the approved verdict's own pool, at a fraction of its light */
export function HopGlow({ poolGrow }: { poolGrow: number }) {
  return (
    <div
      aria-hidden
      className="tile-turn-bloom-plane"
      style={{ transform: `translateZ(${-BLOOM_NEAR_PX}px)` }}
    >
      <PoolGlow
        wheel={null}
        look="verdict"
        poolGrow={poolGrow}
        tone={APPROVE_TONE}
        on
        cue={false}
        className="tile-glow is-red is-on"
        style={{ "--level": HOP_GLOW_LEVEL, transition: "opacity 220ms ease" } as CSSProperties}
      />
    </div>
  )
}
const HOP_GLOW_LEVEL = 0.55

const noSubscribe = () => () => {}
/** the baked silhouette on the client; none on the server, which has no canvas */
const useLandingImage = (kind: "aura" | "wave" | "wave-faint") =>
  useSyncExternalStore(noSubscribe, () => landingImage(kind), () => "")

/**
 * The landing: a glow and two waves rolling out over the surface under the
 * tile, and sparks off its edges and a soft flare over it. `flipped` means the
 * root is turned ±180°, so its z is mirrored.
 */
export function LandingBurst({ verdict, flipped }: { verdict: TileVerdict | undefined; flipped: boolean }) {
  const under = flipped ? SLAB_DEPTH_PX + 4 : -(SLAB_DEPTH_PX + 4)
  const over = flipped ? -(SLAB_DEPTH_PX + 8) : 8
  const tone = { "--tone": toneOf(verdict) } as CSSProperties
  const aura = useLandingImage("aura")
  const wave = useLandingImage("wave")
  const waveFaint = useLandingImage("wave-faint")
  return (
    <>
      <div
        aria-hidden
        className="tile-landing-under"
        style={
          {
            transform: `translateZ(${under}px) scale(${fitDepth(SLAB_DEPTH_PX + 4, showingFaceDepth(flipped))})`,
            "--bake-pad": `${LANDING_BAKE_PAD_PX}px`,
            ...tone,
          } as CSSProperties
        }
      >
        <div className="tile-landing-glow" />
        {/* baked silhouettes (tile-bake): the landing only scales and fades them */}
        <div className="tile-landing-aura" style={{ backgroundImage: aura }} />
        <div className="tile-landing-wave" style={{ backgroundImage: wave }} />
        <div className="tile-landing-wave is-second" style={{ backgroundImage: waveFaint }} />
      </div>
      <div
        aria-hidden
        className="tile-landing-over"
        style={{
          transform: `translateZ(${over}px) scale(${fitDepth(flipped ? -(SLAB_DEPTH_PX + 8) : -8, showingFaceDepth(flipped))})`,
          ...tone,
        }}
      >
        <div className="tile-landing-flare">
          <span className="tile-flip-glint-core" />
        </div>
        {/* every spark in one canvas: twelve sparks as layers of their own were
            the heaviest part of a few tiles landing at once */}
        <SparkBurst />
      </div>
    </>
  )
}

/**
 * The slab: a stack of the tile's own silhouette, one slice per pixel of
 * depth, so the corners stay closed at every angle. Each slice is glass, from
 * a bright lip at the face to a darker back, projected at the showing face's
 * size. While the tile turns, one gleam sweeps down every slice at once.
 */
export function Slab({
  flipped,
  flipping,
  turnMs,
  depthK,
  seen,
}: {
  flipped: boolean
  flipping: boolean
  turnMs: number
  /** how much deeper than the resting slab the slices spread */
  depthK: number
  /** the edge shows (turned or leaning); hidden slices hold no GPU tiles */
  seen: boolean
}) {
  return (
    <>
      {Array.from({ length: SLAB_DEPTH_PX }, (_, i) => {
        const depth = (i + 1) * depthK
        // 0 at the face → 1 at the back plate
        const u = i / Math.max(1, SLAB_DEPTH_PX - 1)
        return (
          <div
            key={i}
            aria-hidden
            // a px inside the face, so its edge never peeks out
            className="pointer-events-none absolute inset-px rounded-[11px]"
            style={
              {
                transform: `translateZ(${-depth}px) scale(${fitDepth(flipped ? -depth : depth, showingFaceDepth(flipped))})`,
                zIndex: 0,
                visibility: seen ? undefined : "hidden",
                "--turn": `${turnMs}ms`,
                background: `linear-gradient(180deg, rgba(255,255,255,${(0.55 * (1 - u)).toFixed(2)}), rgba(225,235,255,${(0.14 + 0.1 * (1 - u)).toFixed(2)}) 45%, rgba(0,0,0,${(0.06 + 0.22 * u).toFixed(2)}))`,
              } as CSSProperties
            }
          >
            {/* one gleam, on the slice at the face: the slices behind it are what it lights */}
            {flipping && i === 0 ? <div className="tile-slab-gleam" /> : null}
          </div>
        )
      })}
    </>
  )
}

/** the star of light on the edge that comes toward the viewer, flaring edge-on */
export function FlipGlint({ dir, turnMs }: { dir: 1 | -1; turnMs: number }) {
  return (
    <div
      aria-hidden
      className="tile-flip-glint"
      style={
        {
          left: dir > 0 ? 0 : "100%",
          "--glint-z": `${-SLAB_DEPTH_PX / 2}px`,
          animationDuration: `${turnMs}ms`,
        } as CSSProperties
      }
    >
      <span className="tile-flip-glint-core" />
    </div>
  )
}

/** the hairline every tile carries on its outline */
export function TileStroke() {
  return (
    <svg className="a-tile-stroke" viewBox="0 0 183 183" aria-hidden style={{ transform: "translateZ(1.4px)" }}>
      <rect className="a-tile-stroke-base" width="183" height="183" rx="12" />
    </svg>
  )
}

// ── the wiggle's wave ───────────────────────────────────────────────────
/** the wave's depth at its deepest, tile px */
const WAVE_DEPTH_PX = 1.75
/** one lobe and the next, along an edge */
const WAVE_LENGTH_PX = 106
/** a lobe travels its own length in this long, in the cue, and on a rejected card */
const WAVE_LAP_MS = 5100
const WAVE_SLOW_LAP_MS = 17900
/** the wave deepens in over the cue's first stretch */
const WAVE_IN_MS = 1200
const EDGE_PX = TILE_PX - 2 * TILE_RADIUS_PX
/** the strip's height: the deepest lobe and its hairline */
const STRIP_PX = 3

/** a row of lobes, WAVE_LENGTH_PX apart, over the edge and one lobe more (it slides by one) */
const WAVE_D = (() => {
  const w = EDGE_PX + WAVE_LENGTH_PX
  const k = (Math.PI * 2) / WAVE_LENGTH_PX
  // the shape's own lobe, a second harmonic over it (periodic in one lobe, so the row repeats)
  const depth = (x: number) => {
    const d = 0.5 + 0.5 * Math.sin(k * x) + 0.25 * Math.sin(2 * k * x - 1.7)
    return (Math.min(1.25, Math.max(0, d)) / 1.25) * WAVE_DEPTH_PX
  }
  const pts: string[] = []
  for (let x = 0; x <= w; x += 2) pts.push(`${x} ${depth(x).toFixed(2)}`)
  return { fill: `M 0 0 L ${pts.join(" L ")} L ${w} 0 Z`, line: `M ${pts.join(" L ")}`, width: w }
})()

/** each straight edge's strip, clockwise from the top: placed, and turned so its inside is the tile's */
const EDGES = [
  `translate(${TILE_RADIUS_PX}px, 0px)`,
  `translate(${TILE_PX}px, ${TILE_RADIUS_PX}px) rotate(90deg)`,
  `translate(${TILE_PX - TILE_RADIUS_PX}px, ${TILE_PX}px) rotate(180deg)`,
  `translate(0px, ${TILE_PX - TILE_RADIUS_PX}px) rotate(270deg)`,
]

/**
 * The warning's wave: a row of lobes per straight edge, in the page's ground
 * with a hairline, drawn once and slid along by CSS, so nothing repaints or
 * masks the feed. Corners stay round. `slow` is a rejected card's drift;
 * `deepen` fades it in as the cue opens.
 */
export function TileWave({ onBack, slow, deepen }: { onBack: boolean; slow: boolean; deepen: boolean }) {
  return (
    <div
      aria-hidden
      className={deepen ? "tile-wave is-deepening" : "tile-wave"}
      style={
        {
          transform: onBack ? `translateZ(${-(SLAB_DEPTH_PX + 2.2)}px) rotateY(180deg)` : "translateZ(2.2px)",
          "--wave-lap": `${slow ? WAVE_SLOW_LAP_MS : WAVE_LAP_MS}ms`,
          "--wave-in": `${WAVE_IN_MS}ms`,
          "--wave-run": `${-WAVE_LENGTH_PX}px`,
        } as CSSProperties
      }
    >
      {EDGES.map((place, i) => (
        <div key={i} className="tile-wave-edge" style={{ width: EDGE_PX, height: STRIP_PX, transform: place }}>
          <svg className="tile-wave-row" width={WAVE_D.width} height={STRIP_PX} viewBox={`0 0 ${WAVE_D.width} ${STRIP_PX}`}>
            <path d={WAVE_D.fill} style={{ fill: "var(--background)" }} />
            <path d={WAVE_D.line} className="a-tile-stroke-base" fill="none" />
          </svg>
        </div>
      ))}
    </div>
  )
}
