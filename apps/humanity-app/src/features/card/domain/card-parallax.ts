// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The card's light: where the sheen, the holo and the etched back's shading
 * sit for one reading of one input. The card itself never rotates in 3D —
 * it is printed on the phone, so tilting the phone tilts the card with it,
 * and what the person sees move is the light across a fixed face. The one
 * rotation the card makes is the flip (`card-flip.ts`).
 *
 * Touch drives none of it. A finger has no hover state, so a tilt on touch
 * can only fire on contact — the card lurching under the thumb that came to
 * tap it. `pointermove` fires for touch as well as for a mouse, which is how
 * that used to happen; `pointerTilts` is the gate that stops it.
 */

/** How far the sheen's gradient travels across the card. */
const SHEEN_TRAVEL_X_PCT = 45;
const SHEEN_TRAVEL_Y_PCT = 35;
/** How far the holo layer travels. */
const HOLO_TRAVEL_X_PX = 26;
const HOLO_TRAVEL_Y_PX = 14;

/**
 * `deviceorientation` degrees per unit of normalised travel. `gamma` is the
 * left-right roll and `beta` the front-back pitch, so a ~28°/~32° swing in
 * either takes the light from edge to edge — a wrist's worth of movement,
 * not an arm's.
 */
const GAMMA_PER_UNIT = 28;
const BETA_PER_UNIT = 32;

/**
 * The pitch treated as level. A phone being looked at rests reclined, not
 * flat on a table, so `beta` sits near 40° at the neutral position rather
 * than 0 — without this offset the light starts pinned to one edge.
 */
const BETA_NEUTRAL = 40;

/** The card's light for one input reading, in the units its CSS wants. */
export interface CardSurface {
  /** `--sheen-x` / `--sheen-y`, as background-position percentages. */
  sheenX: number;
  sheenY: number;
  /** `--holo-x` / `--holo-y`, in px. */
  holoX: number;
  holoY: number;
  /** `--tilt-x` / `--tilt-y`, unitless -1..1: the light direction anything
   *  on the card can shade itself against, such as the etched code. */
  tiltX: number;
  tiltY: number;
}

const clampUnit = (v: number): number => Math.max(-1, Math.min(1, v));

/** Negation that yields 0 rather than -0, so a settled card compares equal to
 *  `restingSurface()` instead of merely rendering the same. */
const clean = (v: number): number => (v === 0 ? 0 : v);

/** The settled card: light centred. Where a mouse leaving the card returns
 *  it to, and where it sits when nothing is driving it. */
export function restingSurface(): CardSurface {
  return { sheenX: 50, sheenY: 50, holoX: 0, holoY: 0, tiltX: 0, tiltY: 0 };
}

/** The light from normalised card-relative coordinates, both -1..1 from the
 *  card's centre. */
export function surfaceFrom(nx: number, ny: number): CardSurface {
  const x = clean(clampUnit(nx));
  const y = clean(clampUnit(ny));
  return {
    sheenX: 50 + x * SHEEN_TRAVEL_X_PCT,
    sheenY: 50 + y * SHEEN_TRAVEL_Y_PCT,
    holoX: clean(x * HOLO_TRAVEL_X_PX),
    holoY: clean(y * HOLO_TRAVEL_Y_PX),
    tiltX: x,
    tiltY: y,
  };
}

/** Where a pointer sits within the card's box, as -1..1 from its centre. */
export function pointerOffset(
  point: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
): { nx: number; ny: number } {
  return {
    nx: ((point.clientX - rect.left) / rect.width) * 2 - 1,
    ny: ((point.clientY - rect.top) / rect.height) * 2 - 1,
  };
}

/**
 * A `deviceorientation` reading as card-relative offsets, or null when the
 * event carries no usable angles — a browser with no sensor either never
 * fires the event or fires it with nulls, and neither may drive the card.
 */
export function orientationOffset(
  reading: Pick<DeviceOrientationEvent, "beta" | "gamma">,
): { nx: number; ny: number } | null {
  const { beta, gamma } = reading;
  if (beta == null || gamma == null) return null;
  if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  return {
    nx: gamma / GAMMA_PER_UNIT,
    ny: (beta - BETA_NEUTRAL) / BETA_PER_UNIT,
  };
}

/**
 * Whether a pointer of this type should drive the card.
 *
 * Hovering devices only. A mouse or a pen reports a position while merely
 * near the card and can leave it again; touch can do neither, so it is
 * excluded here rather than at the listener — `pointermove` fires for touch
 * too, which is exactly how the tilt used to land on taps.
 */
export function pointerTilts(pointerType: string): boolean {
  return pointerType === "mouse" || pointerType === "pen";
}
