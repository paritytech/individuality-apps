// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The faces a co-player's tile wears when their video is not simply there
 * (lib/webrtc/seat-state.ts says which). Every one of them is static:
 *
 *   near-black       nothing of theirs can come through: No signal, and an
 *                    empty chair (final-tile's GhostTile). No word, no tap
 *   over the photo   their face is not coming through: Can't connect with its
 *                    word beside the bars and the can't-reach static's band
 *                    (#1349); Away and Camera off with their icon alone, the
 *                    static fading in. Their last photo lies under the static.
 *                    With no photo, the static is alone
 *   over the face    Connecting…: the static over the last frame, the word
 *                    beside the searching bars
 *   clean face       Weak signal: the live face, with the bars on the top shade
 *
 * The corner is the page's SignalCorner, on TOP_SHADE.
 */
import type { LucideIcon } from "lucide-react"
import type { SeatState } from "@/lib/webrtc/seat-state"

/** the word each seat state wears: only a link still trying to form has one */
export const SEAT_WORD: Record<SeatState, string | undefined> = {
  empty: undefined,
  "no-signal": undefined,
  connecting: "Connecting…",
  "cant-connect": "Can't connect",
  live: undefined,
  weak: undefined,
  away: undefined,
  "camera-off": undefined,
}

/** the top gradient that keeps the corner's bars and word legible */
export const TOP_SHADE = "linear-gradient(180deg, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0) 82.4%)"

/** how long the static takes to cover a face that is failing rather than
 *  gone; every other state's static cuts in, and every state's clears at once */
export const SEAT_STATIC_FADE_MS: Partial<Record<SeatState, number>> = {
  away: 2_000,
  "camera-off": 2_000,
  connecting: 1_500,
  "cant-connect": 1_500,
}

/** a link still trying to form, or to come back: the light grain
 *  (GRAIN_DIM_RECOVERING) rather than the static of a feed that is gone */
export const seatRecovering = (state: string | null): boolean =>
  state === "connecting" || state === "cant-connect"

/** an icon over a word, centred: the banned face's layout */
function SeatMark({ icon: Icon, word }: { icon: LucideIcon; word: string }) {
  return (
    <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2">
      <Icon aria-hidden size={28} strokeWidth={1.75} className="text-white/50" />
      <span className="text-[18px] leading-[22px] font-semibold whitespace-nowrap text-[var(--game-banned-fg)]">
        {word}
      </span>
    </div>
  )
}

/** a flat surface with an icon and a word: the confirm screen's tile for a
 *  player with no photo to show */
export function SeatPanel({ icon, word }: { icon: LucideIcon; word: string }) {
  return (
    <div className="tile-round pointer-events-none absolute inset-0 bg-[var(--game-banned)]">
      <SeatMark icon={icon} word={word} />
    </div>
  )
}
