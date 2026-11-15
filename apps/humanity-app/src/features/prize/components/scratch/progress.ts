// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Coverage thresholds and brush geometry for the daily-dollar scratch card.
 * Pure functions so the reveal logic is unit-testable without a DOM. Values
 * are: 26px -22deg binary-alpha brush,
 * 64x40 coverage sampling every 110ms, 0.58 threshold with a stuck rescue
 * to 0.50 after 2s, and a slow-scratch boost to 1.5x after 2.5s.
 */

export const BRUSH_RADIUS = 26;
export const LONG_F = 1.4;
export const SHORT_F = 0.58;
export const BRUSH_ANGLE = (-22 * Math.PI) / 180;
export const VARIANTS = 4;

export const SAMPLE_MS = 110;
export const SAMPLE_W = 64;
export const SAMPLE_H = 40;

const THRESHOLD = 0.58;
export const RESCUE_AT = 0.45;
const RESCUE_TO = 0.5;
const RESCUE_MS = 2000;

const SLOW_MS = 2500;
const SLOW_BOOST = 1.5;

export function shouldRevealScratch(
  cleared: number,
  rescueArmedAt: number | null,
  now: number,
): boolean {
  const threshold =
    rescueArmedAt != null && now - rescueArmedAt >= RESCUE_MS
      ? RESCUE_TO
      : THRESHOLD;
  return cleared >= threshold;
}

export function getScratchBrushRadius(idleMs: number): number {
  if (idleMs < SLOW_MS) return BRUSH_RADIUS;
  const boost = Math.min(
    SLOW_BOOST,
    1 + ((idleMs - SLOW_MS) / 1000) * (SLOW_BOOST - 1),
  );
  return BRUSH_RADIUS * boost;
}
