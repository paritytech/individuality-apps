// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * GSAP's eases, for Motion. The power, expo and
 * sine curves are the usual cubic-bezier fits of GSAP's polynomials (close,
 * not identical), so Motion can still hand them to the browser; the back and
 * elastic curves overshoot and are plain functions with GSAP's own formulas
 * (`elasticOut` for an amplitude of 1 or more, the only one used).
 */

import { cubicBezier, type EasingFunction } from "motion";

/** power1 is quad, power2 cubic, power3 quart, as in GSAP. */
export const power1In = cubicBezier(0.11, 0, 0.5, 0);
export const power2In = cubicBezier(0.32, 0, 0.67, 0);
export const power2Out = cubicBezier(0.33, 1, 0.68, 1);
export const power2InOut = cubicBezier(0.65, 0, 0.35, 1);
export const power3Out = cubicBezier(0.25, 1, 0.5, 1);
export const power3InOut = cubicBezier(0.76, 0, 0.24, 1);
export const expoIn = cubicBezier(0.7, 0, 0.84, 0);
export const expoOut = cubicBezier(0.16, 1, 0.3, 1);
export const sineInOut = cubicBezier(0.37, 0, 0.63, 1);

/** GSAP's `back.out(overshoot)`. */
export function backOut(overshoot = 1.70158): EasingFunction {
  return (t) => {
    const u = t - 1;
    return 1 + (overshoot + 1) * u * u * u + overshoot * u * u;
  };
}

/** GSAP's `elastic.out(amplitude, period)`. */
export function elasticOut(amplitude = 1, period = 0.3): EasingFunction {
  const a = Math.max(1, amplitude);
  const shift = (period / (2 * Math.PI)) * Math.asin(1 / a);
  return (t) =>
    t <= 0 || t >= 1
      ? t
      : a * 2 ** (-10 * t) * Math.sin(((t - shift) * (2 * Math.PI)) / period) + 1;
}
