// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The waiting-room dial, a countdown-art module (see registry.tsx). The math
 * is in lib/waiting-dial.ts. One requestAnimationFrame loop reads the injected
 * clock each frame and writes the bars and the digits to the DOM through refs.
 */
import { useEffect, useRef } from "react"
import { BAR_DIM, BAR_LIT, DIAL_BARS, DIAL_SIZE, DIAL_WHITE, DIGIT_FONT, DIGIT_TRACKING, dialDigits, litBars } from "@/lib/waiting-dial"
import type { CountdownArtProps } from "./registry"

const C = DIAL_SIZE / 2
const digitStyle = { font: DIGIT_FONT, letterSpacing: DIGIT_TRACKING, fontVariantNumeric: "tabular-nums" } as const

export function WaitingDial({ endsAt, nowMs, windowSec }: CountdownArtProps) {
  const barsRef = useRef<SVGGElement>(null)
  const digitRef = useRef<SVGTextElement>(null)

  useEffect(() => {
    let raf = 0
    let lastLit = -1
    let lastDigits = ""

    const frame = () => {
      const left = endsAt - nowMs() / 1000
      const lit = litBars(left, windowSec)
      const digits = dialDigits(left, windowSec)

      const bars = barsRef.current?.children
      if (bars && lit !== lastLit) {
        lastLit = lit
        for (let i = 0; i < bars.length; i++) bars[i].setAttribute("stroke-opacity", String(i < lit ? BAR_LIT : BAR_DIM))
      }
      if (digits !== lastDigits && digitRef.current) {
        lastDigits = digits
        digitRef.current.textContent = digits
      }

      // 00 is the last frame that changes
      if (left > 0) raf = requestAnimationFrame(frame)
    }
    frame()
    return () => cancelAnimationFrame(raf)
  }, [endsAt, nowMs, windowSec])

  return (
    <svg aria-hidden viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`} width={DIAL_SIZE} height={DIAL_SIZE} className="block">
      <g ref={barsRef} stroke={DIAL_WHITE} strokeLinecap="round">
        {DIAL_BARS.map((bar, i) => (
          <line key={i} x1={bar.x1} y1={bar.y1} x2={bar.x2} y2={bar.y2} strokeWidth={bar.width} strokeOpacity={BAR_DIM} />
        ))}
      </g>
      <text ref={digitRef} x={C} y={C} textAnchor="middle" dominantBaseline="central" fill={DIAL_WHITE} style={digitStyle} />
    </svg>
  )
}
