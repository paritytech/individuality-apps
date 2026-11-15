// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { SeatState } from "./webrtc/seat-state"

/** Stable vote eligibility and instantaneous gesture readiness are separate.
 * A tile remains votable while its verdict animation/reset temporarily closes
 * the gesture, so evidence never mistakes animation for an ineligible seat. */
export function tileTapState({
  takesGesture,
  flipping,
  resetting,
}: {
  takesGesture: boolean
  flipping: boolean
  resetting: boolean
}): { votable: boolean; ready: boolean } {
  return { votable: takesGesture, ready: takesGesture && !flipping && !resetting }
}

/** A seat that shows only static (an empty chair, No signal, Can't connect) has
 *  nobody to judge, so its tile takes no tap. This closes the gesture alone:
 *  whether the player is votable stays the session's rule, and an untapped
 *  tile still seals. */
export function seatTakesTap(seat: SeatState | undefined): boolean {
  return seat !== "empty" && seat !== "no-signal" && seat !== "cant-connect"
}
