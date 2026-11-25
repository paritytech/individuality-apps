// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The prize draw as the WHEEL — what is drawn over the stage (architecture
 * rule 6). Everything the draw does — the coin into the slit, the spin, who's
 * playing, the prize or the fall — is the stage's, which
 * lib/draw/wheel/stage-runner mounts in the element handed to `stageRef`.
 * Over it: a SPECTATOR's intro (words fading in a line at a time over the draw
 * itself, held on the frame it opens on), and for a stage that failed, the
 * chain's result in words with this page's own Continue. When each shows is
 * the draw screen's (lib/draw/draw-screen).
 *
 * The stage's STYLESHEETS are imported here, statically, so they arrive with
 * the page: loaded with the stage's chunk they came late, and until they did
 * the page's own Continue sat unstyled at the top of the screen.
 */
import "@/lib/draw/wheel/proto/tokens.css"
import "@/lib/draw/wheel/proto/styles.css"
import "@/lib/draw/wheel/proto/scenes/wheel/slit/style.css"
import "@/lib/draw/wheel/proto/scenes/wheel/flow/style.css"
import "@/lib/draw/wheel/stage.css"
import type { CSSProperties } from "react"
import { Button } from "@/components/ui/button"
import { PrizeText } from "@/components/prize-text"
import { PRIZE_UNIT } from "@/lib/draw/prize-unit"

/** THE INTRO's beats, ms from its start: the heading, the prize's chip, then
 *  each line a step after the one before (stage.css .wheel-intro-part) */
const INTRO_HEAD_MS = 200
const INTRO_CHIP_MS = 700
const INTRO_LINES_MS = 1500
const INTRO_STEP_MS = 1200
const introAt = (ms: number) => ({ "--at": `${ms}ms` }) as CSSProperties

export function WheelStage({
  stageRef,
  intro,
  fallback,
  onContinue,
  hold = false,
  hostRef,
}: {
  /** the element the stage mounts in */
  stageRef: (element: HTMLDivElement | null) => void
  /** the way on is the hold (components/draw/hold-to-collectables): the stage's own
   *  Continue is never shown (stage.css [data-hold]) */
  hold?: boolean
  /** the stage's own element, for the hold to read and move */
  hostRef?: (element: HTMLDivElement | null) => void
  /** a player not in the draw: the draw explained over it (lib/draw/draw-miss
   *  drawIntro), fading out as the stage is let go */
  intro: { heading: string; prize: string; paragraphs: string[]; leaving: boolean } | null
  /** the stage failed: the chain's result in words (lib/draw/draw-miss drawResultLine) */
  fallback: { heading: string; body: string | null } | null
  onContinue: () => void
}) {
  return (
    // the chip draws the CASH wordmark in place of the word (stage.css)
    <div
      ref={hostRef}
      className="wheel-host"
      data-cash-wordmark={PRIZE_UNIT === "CASH" ? "" : undefined}
      data-hold={hold ? "" : undefined}
    >
      <div ref={stageRef} className="contents" />
      {fallback ? (
        <div className="wheel-note wheel-fallback" role="status">
          <p className="wheel-note-heading">{fallback.heading}</p>
          {fallback.body ? <p className="wheel-note-body">{fallback.body}</p> : null}
          <p className="wheel-note-body">The animation could not finish, but the chain result above is final.</p>
        </div>
      ) : null}
      {intro ? (
        <div className={`wheel-intro${intro.leaving ? " is-leaving" : ""}`} aria-live="polite">
          <h1 className="wheel-intro-head wheel-intro-part" style={introAt(INTRO_HEAD_MS)}>
            {intro.heading}
          </h1>
          <p className="wheel-intro-chip wheel-intro-part" style={introAt(INTRO_CHIP_MS)}>
            <PrizeText text={intro.prize} as="title" />
          </p>
          <div className="wheel-intro-lines">
            {intro.paragraphs.map((line, i) => (
              <p key={i} className="wheel-intro-part" style={introAt(INTRO_LINES_MS + i * INTRO_STEP_MS)}>
                {line}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      {/* for a stage that failed (the draw has its own Continue): rendered
          then, never merely hidden, so no load order can show it before the
          coin */}
      {fallback ? (
        <div className="wheel-continue">
          <Button size="lg" className="w-full max-w-sm" onClick={onContinue}>
            Continue
          </Button>
        </div>
      ) : null}
    </div>
  )
}
