// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The hint pills — the tutorial's three pills and the missing-host pill. This
 * file draws them and nothing else: the placement, the slide and the
 * tutorial's three-pill sequence all come from components/game/animations.ts,
 * and the page runs that sequence — the second pill is also the tiles' cue.
 *
 * All four pills stay mounted so an exit animates. Only one of them is ever
 * visible, and a missing host wins over the tutorial — the glowing pill is the
 * only cue then.
 */
import {
  HINT_PILL_H_PX,
  HINT_PILL_FONT_PX,
  HINT_PILL_LINE_PX,
  HINT_PILL_RADIUS_PX,
  hintAnchoredPillStyle,
  hintBoxStyle,
  hintTailStyle,
  useReducedMotion,
  type HintKind,
} from "@/components/game/animations"
// "generated portrait" by Thomas Meerseman, from the Noun Project
import portrait from "@/components/game/tile/portrait.png"

/** the pill's own surface — the two hint tokens, one shape for all four */
const PILL_SURFACE = {
  height: HINT_PILL_H_PX,
  background: "var(--game-hint-bg)",
  borderRadius: HINT_PILL_RADIUS_PX,
} as const

/** Inter 600 at 16/20, on the hint's foreground token */
const PILL_TEXT = {
  fontFamily: "var(--font-sans)",
  fontWeight: 600,
  fontSize: HINT_PILL_FONT_PX,
  lineHeight: `${HINT_PILL_LINE_PX}px`,
  letterSpacing: 0,
  color: "var(--game-hint-fg)",
  whiteSpace: "nowrap",
} as const

/** Material `waving_hand`, filled — the gesture pill's mark */
function WavingHandIcon() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 22.005 22.005"
      fill="none"
      className="block shrink-0"
      aria-hidden
    >
      <path
        d="M22.005 16C22.005 19.31 19.315 22 16.005 22V20.5C18.485 20.5 20.505 18.48 20.505 16H22.005ZM0.00500005 6C0.00500005 2.69 2.695 0 6.005 0V1.5C3.525 1.5 1.505 3.52 1.505 6H0.00500005ZM7.015 3.32L2.415 7.92C-0.805 11.14 -0.805 16.37 2.415 19.59C5.635 22.81 10.865 22.81 14.085 19.59L21.155 12.52C21.645 12.03 21.645 11.24 21.155 10.75C20.665 10.26 19.875 10.26 19.385 10.75L14.965 15.17L14.255 14.46L20.795 7.92C21.285 7.43 21.285 6.64 20.795 6.15C20.305 5.66 19.515 5.66 19.025 6.15L13.195 11.98L12.485 11.27L19.375 4.38C19.865 3.89 19.865 3.1 19.375 2.61C18.885 2.12 18.095 2.12 17.605 2.61L10.715 9.5L10.025 8.8L15.505 3.32C15.995 2.83 15.995 2.04 15.505 1.55C15.015 1.06 14.225 1.06 13.735 1.55L6.115 9.17C7.335 10.74 7.225 13.01 5.785 14.45L5.075 13.74C6.245 12.57 6.245 10.67 5.075 9.5L4.725 9.15L8.795 5.08C9.285 4.59 9.285 3.8 8.795 3.31C8.295 2.83 7.505 2.83 7.015 3.32Z"
        fill="var(--game-hint-fg)"
      />
    </svg>
  )
}

/** the hand of Material `touch_app` (viewBox 0 0 15 21, the fingertip at 6.75, 3): the tile's tutorial tap draws it too */
export const TAP_FINGER_D =
  "M14.09 12.87L9.55 10.61C9.38 10.54 9.2 10.5 9.01 10.5H8.25V4.5C8.25 3.67 7.58 3 6.75 3C5.92 3 5.25 3.67 5.25 4.5V15.24C1.65 14.48 1.71 14.49 1.58 14.49C1.27 14.49 0.99 14.62 0.79 14.82L0 15.62L4.94 20.56C5.21 20.83 5.59 21 6 21H12.79C13.54 21 14.12 20.45 14.23 19.72L14.98 14.45C14.99 14.38 15 14.31 15 14.25C15 13.63 14.62 13.09 14.09 12.87Z"
/** the ripple arc over the hand */
const TAP_RIPPLE_D =
  "M4.25 8.24V4.5C4.25 3.12 5.37 2 6.75 2C8.13 2 9.25 3.12 9.25 4.5V8.24C10.46 7.43 11.25 6.06 11.25 4.5C11.25 2.01 9.24 0 6.75 0C4.26 0 2.25 2.01 2.25 4.5C2.25 6.06 3.04 7.43 4.25 8.24Z"

/** Material `touch_app`, filled — the "Tap to Identify Humans" mark */
function TouchAppIcon() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 15 21"
      fill="none"
      className="block shrink-0"
      aria-hidden
    >
      <path d={TAP_RIPPLE_D + TAP_FINGER_D} fill="var(--game-hint-fg)" />
    </svg>
  )
}

/** the portrait mark — the "No tap means it's a bot" pill's icon */
function PortraitIcon() {
  const mask = `url(${portrait.src})`
  return (
    <span
      aria-hidden
      className="block size-6 shrink-0"
      style={{
        background: "var(--game-hint-fg)",
        // prefixed too: Chrome before 120 knows only -webkit-mask
        WebkitMaskImage: mask,
        maskImage: mask,
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  )
}

/**
 * The rounded triangle under the anchored pill. The native apex points UP, so
 * the wrapper turns it half a turn and it aims at the host tile.
 */
function HintTail() {
  return (
    <div className="absolute" style={hintTailStyle()} aria-hidden>
      <svg viewBox="0 0 22.786 19.1666" fill="none" className="block h-full w-full">
        <path
          d="M8.86281 1.38809C10.0419 -0.462698 12.744 -0.462696 13.9231 1.38809L22.3112 14.5547C23.5836 16.5518 22.149 19.1666 19.7811 19.1666H3.00487C0.636914 19.1666 -0.797605 16.5518 0.474705 14.5547L8.86281 1.38809Z"
          fill="var(--game-hint-bg)"
        />
      </svg>
    </div>
  )
}

/** the travelling box every pill rides in */
function HintBox({
  visible,
  glow,
  shadow,
  reduced,
  children,
}: {
  visible: boolean
  glow?: boolean
  shadow: boolean
  reduced: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className="absolute inset-x-0"
      style={hintBoxStyle({ visible, glow: glow === true, shadow, reduced })}
      aria-hidden={!visible}
    >
      {children}
    </div>
  )
}

/**
 * The game's hint layer. It sits over the tiles and takes no pointer. Only
 * the visible pill takes a tap, and the tap hides it.
 *
 * The SEQUENCE is the page's, not this file's: the tutorial's second pill also
 * fires the tiles' gesture lesson, so one useHintCue runs above both and hands
 * its answer down here.
 */
export function GameHints({
  cue,
  gestureLabel,
  shadow,
  className,
  onDismiss,
}: {
  /** the pill showing right now, or null */
  cue: HintKind | null
  /** pill one's text: it names the host by role */
  gestureLabel: string
  /** false: the pills paint no lift and no glow */
  shadow: boolean
  className?: string
  /** hides the pill showing now */
  onDismiss: () => void
}) {
  const reduced = useReducedMotion()
  return (
    // z-40: stays above a busy tile slot (tile.css, z-index 30)
    <div className={"pointer-events-none absolute inset-0 z-40 select-none " + (className ?? "")}>
      {/* pill one — anchored over the host tile, so the tail names who to copy */}
      <HintBox visible={cue === "show-gesture"} shadow={shadow} reduced={reduced}>
        <div
          className={
            "absolute top-0 flex items-center gap-2 px-4" +
            (cue === "show-gesture" ? " pointer-events-auto" : "")
          }
          style={{ ...PILL_SURFACE, ...hintAnchoredPillStyle() }}
          onClick={cue === "show-gesture" ? onDismiss : undefined}
        >
          <WavingHandIcon />
          <span style={PILL_TEXT}>{gestureLabel}</span>
        </div>
        <HintTail />
      </HintBox>

      {/* pill two — the whole grid is the subject, so it takes no tail */}
      <HintBox visible={cue === "tap-to-identify"} shadow={shadow} reduced={reduced}>
        <div className="absolute inset-x-0 top-0 flex justify-center px-2">
          <div
            className={"flex items-center gap-1 px-6" + (cue === "tap-to-identify" ? " pointer-events-auto" : "")}
            style={PILL_SURFACE}
            onClick={cue === "tap-to-identify" ? onDismiss : undefined}
          >
            <TouchAppIcon />
            <span style={PILL_TEXT}>Tap to Identify Humans</span>
          </div>
        </div>
      </HintBox>

      {/* pill three — the same as pill two: an untouched tile is a reject */}
      <HintBox visible={cue === "no-tap-bot"} shadow={shadow} reduced={reduced}>
        <div className="absolute inset-x-0 top-0 flex justify-center px-2">
          <div
            className={"flex items-center gap-1 px-6" + (cue === "no-tap-bot" ? " pointer-events-auto" : "")}
            style={PILL_SURFACE}
            onClick={cue === "no-tap-bot" ? onDismiss : undefined}
          >
            <PortraitIcon />
            <span style={PILL_TEXT}>No tap means it&apos;s a bot</span>
          </div>
        </div>
      </HintBox>

      {/* the missing host — the same pill, lit, and the only cue while it shows */}
      <HintBox visible={cue === "no-host"} glow shadow={shadow} reduced={reduced}>
        <div className="absolute inset-x-0 top-0 flex justify-center px-2">
          <div
            className={"flex items-center justify-center px-6" + (cue === "no-host" ? " pointer-events-auto" : "")}
            style={PILL_SURFACE}
            onClick={cue === "no-host" ? onDismiss : undefined}
          >
            <span style={PILL_TEXT}>No host - copy other players</span>
          </div>
        </div>
      </HintBox>
    </div>
  )
}
