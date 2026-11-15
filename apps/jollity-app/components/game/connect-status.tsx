// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

import { SignalIndicator, signalStatus, type SignalState } from "./signal-indicator"

/**
 * THE ROTATION TILE'S LINK BADGE: a scrim down the top of the tile, the
 * signal bars flush in the top-left, and one status word in the top-right.
 * The word and the bars take the SAME color, from `signalStatus`, so the two
 * read as one badge and nothing here names a color of its own.
 *
 * The scrim is what makes both legible over a face or over grain, so it
 * arrives and leaves with them. A seat with nobody in it takes no badge.
 */
export function ConnectStatus({ state, leaving = false }: { state: SignalState; leaving?: boolean }) {
  const status = signalStatus(state)
  return (
    <>
      <div
        aria-hidden
        className={`${leaving ? "connect-status-out" : "connect-scrim-in"} pointer-events-none absolute inset-0`}
        style={{
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.35) 35%, rgba(0,0,0,0) 65%)",
        }}
      />
      <div className={`${leaving ? "connect-status-out" : "connect-badge-in"} pointer-events-none absolute top-3 left-3`}>
        {/* full strength for a held link, so the bars land on the same green
            the word takes; a weak one lights the lower two bars */}
        <SignalIndicator
          state={state}
          strength={state === "weak" ? 0.4 : 1}
          size={20}
        />
      </div>
      <span
        className={`${leaving ? "connect-status-out" : "connect-badge-in"} pointer-events-none absolute top-[14px] right-[10px] text-[12px] leading-5 font-semibold tracking-[0.24px] whitespace-nowrap`}
        style={{ color: status.color }}
      >
        {status.word}
      </span>
    </>
  )
}
