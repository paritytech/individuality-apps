// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE CARRIED BUBBLE — how the draw's hold reaches the collectables.
 *
 * Holding on the draw's ending (lib/draw/hold/scene) gathers the draw's own
 * pieces into a bubble and floats it up to where the collectables' bubble
 * blows up. As the draw page leaves it puts that bubble here, and the collectables screen's
 * engine (lib/collectables-scene/engine, `carried`) starts from it: the bubble
 * already blown where it was, the pieces swirling in it, and each claim that
 * comes in lit from a share of them instead of flying in from off screen.
 *
 * Module state, framework-free: the app is one page, so it survives the
 * route change. A hand-off older than CARRY_MAX_AGE_MS is not used (the
 * collectables screen was reached some other way). React runs a mount twice in
 * development, so a take is answered the same way for TAKE_GRACE_MS after
 * the first: both runs of the one showing get the bubble.
 */

/** one of the draw's pieces, swirling in the bubble */
export interface CarriedPiece {
  /** its angle round the bubble's centre at `at`, radians */
  angle: number
  /** how fast it goes round, radians a second */
  speed: number
  /** how far out, as a share of the bubble's radius */
  radius: number
  /** its colour, from the draw */
  color: readonly [number, number, number]
  /** drawn as a little orb rather than a speck */
  lit: boolean
  /** its own number, 0–1: when it is pulled in, among the others */
  seed: number
}

export interface CarriedBubble {
  /** the bubble's centre and radius, viewport px */
  x: number
  y: number
  r: number
  pieces: CarriedPiece[]
  /** a win: the prize went in, and its glint is in the bubble too */
  glint: boolean
  /** performance.now() when it was handed over */
  at: number
}

export const CARRY_MAX_AGE_MS = 4000
export const TAKE_GRACE_MS = 1500

let carried: CarriedBubble | null = null
let taken: { bubble: CarriedBubble; at: number } | null = null

/* BETWEEN THE SCREENS: from the draw page's leaving until the collectables screen's engine
   has drawn the bubble itself, nothing on either page draws it. So a layer at
   the app's root (components/carried-bubble) does, while it is `inFlight` */
let inFlight: CarriedBubble | null = null
const listeners = new Set<(bubble: CarriedBubble | null) => void>()
const tell = () => listeners.forEach((listener) => listener(inFlight))

/** the draw page, leaving with the bubble */
export function carry(bubble: CarriedBubble): void {
  carried = bubble
  taken = null
  inFlight = bubble
  tell()
}

/** the collectables screen's engine has drawn the bubble: nothing need hold it between the screens */
export function carryShown(): void {
  if (!inFlight) return
  inFlight = null
  tell()
}

/** the bubble in flight between the screens, now and as it changes; returns the unsubscribe */
export function watchCarried(listener: (bubble: CarriedBubble | null) => void): () => void {
  listeners.add(listener)
  listener(inFlight)
  return () => {
    listeners.delete(listener)
  }
}

/** the collectables screen, starting: the bubble the draw handed over, once */
export function takeCarried(now: number = performance.now()): CarriedBubble | null {
  if (taken && now - taken.at <= TAKE_GRACE_MS) return taken.bubble
  const bubble = carried
  carried = null
  taken = null
  if (!bubble || now - bubble.at > CARRY_MAX_AGE_MS) return null
  taken = { bubble, at: now }
  return bubble
}
