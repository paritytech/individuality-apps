// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * Signal-bars connection indicator — the element behind the "phone signal"
 * health model. Four ascending bars whose fill + colour communicate link quality:
 *
 *   connecting   — bars sweep in a "searching" pulse (amber)
 *   connected    — bars fill to `strength`; green strong / amber middling /
 *                  orange barely
 *   weak         — forced amber, low bars only
 *   disconnected — all bars faded white, none lit (no red, no slash —
 *                  "Disconnected" reads as an EMPTY signal)
 *
 * Presentational only: the health aggregator owns the state machine.
 * Keyframes `sig-search` live in globals.css.
 */

export type SignalState = "connecting" | "connected" | "weak" | "disconnected"

// The design's status palette: status colours, not theme colours, on purpose.
const COLORS = {
  strong: "#35C759", // green  — strong, stable link
  weak: "#FFB300", // amber  — middling / connecting
  poor: "#FF7A00", // orange — connected but barely
  lost: "#FF3123", // red    — dropped
}

/** the EMPTY signal's white. It is the disconnected track's own paint, a touch
 *  firmer, because a 12px word needs more presence than a 3px bar. */
const EMPTY_WHITE = "rgba(255, 255, 255, 0.55)"

/**
 * The word each state wears, and the color the word and the bars share. The
 * design pairs the two in ONE color on purpose, so the pair reads as a single
 * unit, which is why a caller takes both from here
 * and never names a color of its own.
 *
 * `disconnected` takes the empty white rather than the lost red: these bars
 * already read that state as an EMPTY signal, and the softer word belongs
 * with the softer paint.
 */
const STATUS: Record<SignalState, { word: string; color: string }> = {
  connecting: { word: "Connecting", color: COLORS.weak },
  connected: { word: "Connected", color: COLORS.strong },
  weak: { word: "Unstable", color: COLORS.weak },
  disconnected: { word: "Not connected", color: EMPTY_WHITE },
}

/** the state's word and its color, together. The bars pick their own color
 *  off `strength` for a CONNECTED link, so a caller that wants the two to
 *  agree hands the bars full strength for that state. */
export function signalStatus(state: SignalState): { word: string; color: string } {
  return STATUS[state]
}

export function SignalIndicator({
  state = "connected",
  strength = 1,
  bars = 4,
  /** height of the tallest bar in px — everything scales off this */
  size = 64,
  weakThreshold = 0.34,
  strongThreshold = 0.67,
  /** optional "62%" readout to the right of the bars */
  showPercent = false,
}: {
  state?: SignalState
  strength?: number
  bars?: number
  size?: number
  weakThreshold?: number
  strongThreshold?: number
  showPercent?: boolean
}) {
  const isConnecting = state === "connecting"
  const isDisconnected = state === "disconnected"
  const s = Math.max(0, Math.min(1, strength))

  let activeCount: number
  if (isDisconnected) activeCount = 0
  else if (isConnecting) activeCount = 0
  else activeCount = Math.max(1, Math.round(s * bars))

  let activeColor: string
  if (isDisconnected) activeColor = COLORS.lost
  else if (isConnecting) activeColor = COLORS.weak
  else if (state === "weak") activeColor = COLORS.weak
  else if (s >= strongThreshold) activeColor = COLORS.strong
  else if (s >= weakThreshold) activeColor = COLORS.weak
  else activeColor = COLORS.poor

  const barW = size * 0.18
  const gap = size * 0.11
  const radius = barW * 0.42
  const width = bars * barW + (bars - 1) * gap
  const barHeight = (i: number) => size * (0.38 + 0.62 * ((i + 1) / bars))

  // Disconnected shows every bar as a faded white "off" bar — more present
  // than the near-invisible track behind lit bars, so the EMPTY signal reads.
  const trackColor = isDisconnected ? "rgba(255, 255, 255, 0.4)" : "rgba(255, 255, 255, 0.16)"

  const pct = Math.round(s * 100)

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: size * 0.22 }}>
      <div
        style={{
          position: "relative",
          width,
          height: size,
          display: "flex",
          alignItems: "flex-end",
          gap,
        }}
      >
        {Array.from({ length: bars }).map((_, i) => {
          const lit = i < activeCount
          return (
            <div
              key={i}
              className={isConnecting ? "sig-bar-searching" : undefined}
              style={{
                width: barW,
                height: barHeight(i),
                borderRadius: radius,
                background: isConnecting || lit ? activeColor : trackColor,
                // searching sweep: stagger so brightness travels up the ramp
                animationDelay: isConnecting ? `${i * 0.13}s` : undefined,
                transition: "background-color 320ms ease, height 200ms ease",
              }}
            />
          )
        })}
      </div>

      {showPercent && (
        <span
          style={{
            fontFamily: 'ui-monospace, "SF Mono", monospace',
            fontSize: Math.max(11, size * 0.26),
            fontWeight: 600,
            color: isDisconnected ? COLORS.lost : "rgba(255,255,255,0.85)",
            minWidth: size * 0.9,
          }}
        >
          {isDisconnected ? "off" : isConnecting ? "…" : `${pct}%`}
        </span>
      )}
    </div>
  )
}
