// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The maths of turning the card over. One continuous angle drives the flip,
 * in degrees and unbounded: rest positions are multiples of 180, even ones
 * face front. Rendering folds the angle into (-90, 90] and picks the face,
 * so no face is ever drawn mirrored and the front stays pixel-identical.
 *
 * Two ways round: a tap on the QR glyph (one clean turn) and a sideways
 * drag, which the card follows and which commits past a modest angle or
 * with a flick — a nudge, never a haul. A flick keeps its momentum, hard
 * ones for several turns, and always lands on the other side from where it
 * started, so a flick is never wasted.
 */

/** Sideways travel below this is a tap, not a drag. */
const TAP_PX = 6;
/** Degrees of drag that commit the turn on release: well short of the 90°
 *  face swap, so a flip feels like a nudge. */
export const COMMIT_DEG = 55;
/** Release velocity, in degrees per ms, that counts as a flick. */
const FLICK_DEG_PER_MS = 0.35;
/** How long a flick's release velocity keeps travelling. */
const COAST_MS = 260;
/** The ceiling on a coast (five full turns), so a wild flick still lands. */
const COAST_CAP_DEG = 1800;
/** A finger held still this long before release has no velocity to speak of. */
const STALE_MS = 120;
/** How far into a drag the velocity sample must reach to count as a flick. */
const FLICK_MIN_TRAVEL_DEG = 15;

export interface FoldedAngle {
  /** The angle to render the body at, in (-90, 90]. */
  angle: number;
  /** Whether the back faces the viewer at this position. */
  flipped: boolean;
}

/** Fold an unbounded angle onto the face that shows and the angle it shows at. */
export function foldAngle(pos: number): FoldedAngle {
  const a = ((pos % 360) + 540) % 360 - 180; // [-180, 180)
  const flipped = Math.abs(a) > 90;
  return { angle: flipped ? a - 180 * Math.sign(a) : a, flipped };
}

/** Sideways drag as an angle: a soft, rubber-band ceiling where about a third
 *  of the card's width reaches the 90° edge and the angle never runs away. */
export function dragAngle(rest: number, dx: number, width: number): number {
  const w = width > 0 ? width : 330;
  return rest + 180 * Math.tanh(dx / (w * 0.6));
}

export type DragIntent = "undecided" | "horizontal" | "vertical";

/** Whether a pointer that has moved this far means to turn the card. A
 *  vertical intent releases the pointer to the page. */
export function dragIntent(dx: number, dy: number): DragIntent {
  if (Math.abs(dx) < TAP_PX && Math.abs(dy) < TAP_PX) return "undecided";
  return Math.abs(dy) > Math.abs(dx) ? "vertical" : "horizontal";
}

export interface Release {
  /** Where the drag left the angle. */
  pos: number;
  /** Velocity at the last move, degrees per ms. */
  velocity: number;
  /** ms between the last move and the release. */
  sinceLastMove: number;
}

/** The rest angle to settle to when a drag lets go. A flick back toward
 *  where the drag started is the person changing their mind: it settles
 *  home, however far the drag had gone. */
export function releaseTarget(rest: number, release: Release): number {
  const travelled = release.pos - rest;
  const v = release.sinceLastMove > STALE_MS ? 0 : release.velocity;
  const fast = Math.abs(v) > FLICK_DEG_PER_MS;
  if (fast && travelled !== 0 && Math.sign(v) !== Math.sign(travelled)) return rest;
  const flick = fast && Math.abs(travelled) > FLICK_MIN_TRAVEL_DEG;
  if (flick) {
    const coast = Math.max(-COAST_CAP_DEG, Math.min(COAST_CAP_DEG, v * COAST_MS));
    const total = travelled + coast;
    let halves = Math.round(total / 180);
    // An odd number of half turns lands on the other face, every time.
    if (halves % 2 === 0) halves += Math.sign(total) || Math.sign(v) || 1;
    return rest + 180 * halves;
  }
  return Math.abs(travelled) > COMMIT_DEG ? rest + 180 * Math.sign(travelled) : rest;
}

/** The rest angle nearest an angle: a multiple of 180. */
export function nearestRest(pos: number): number {
  return Math.round(pos / 180) * 180;
}

/** The rest angle to settle to when a drag lets go, measured from where the
 *  finger took the card. From a rest this is `releaseTarget`. From mid-turn
 *  (a card grabbed while it was still turning) the angle it was already at is
 *  not travel: holding still lands on the face that shows, a drag past the
 *  commit angle goes on to the next face in its direction, and a flick
 *  coasts from where it let go. */
export function releaseTargetFrom(grabbedAt: number, release: Release): number {
  const rest = nearestRest(grabbedAt);
  if (Math.abs(grabbedAt - rest) < 1e-6) return releaseTarget(rest, release);
  const travelled = release.pos - grabbedAt;
  const v = release.sinceLastMove > STALE_MS ? 0 : release.velocity;
  const ahead = (pos: number, direction: number) =>
    direction > 0 ? Math.ceil(pos / 180) * 180 : Math.floor(pos / 180) * 180;
  if (Math.abs(v) > FLICK_DEG_PER_MS && Math.abs(travelled) > FLICK_MIN_TRAVEL_DEG) {
    const coast = Math.max(-COAST_CAP_DEG, Math.min(COAST_CAP_DEG, v * COAST_MS));
    return ahead(release.pos + coast, Math.sign(v));
  }
  if (Math.abs(travelled) > COMMIT_DEG) return ahead(release.pos, Math.sign(travelled));
  return nearestRest(release.pos);
}

/** Short settles are snappy; a long coast decelerates like friction. */
export function settleDuration(distanceDeg: number): number {
  const d = Math.abs(distanceDeg);
  return d <= 180 ? Math.min(0.6, 0.25 + d / 400) : Math.min(2.6, 0.6 + d / 700);
}
