// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Brush stamping and stroke interpolation. Extracted from engine.ts so the
 * scratch-canvas hook can invoke stamping without importing the full engine.
 * Both functions are pure drawing helpers — they only touch the coating canvas;
 * all shared state (brush radius, last point) lives in the calling scope.
 */

import {
  BRUSH_ANGLE,
  BRUSH_RADIUS,
  LONG_F,
  SHORT_F,
  VARIANTS,
} from "./progress.ts";

/** Stamp a single brush at (x, y) using the current brush radius. */
export function stampAt(
  ctx: CanvasRenderingContext2D,
  brushes: HTMLCanvasElement[],
  x: number,
  y: number,
  brushRadius: number,
): void {
  const r = brushRadius ?? BRUSH_RADIUS;
  const long = r * LONG_F * 2;
  const short = r * SHORT_F * 2;
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.translate(x, y);
  ctx.rotate(BRUSH_ANGLE);
  const brush = brushes[(Math.random() * VARIANTS) | 0];
  if (brush) ctx.drawImage(brush, -long / 2, -short / 2, long, short);
  ctx.restore();
}

/** Interpolate and stamp a line segment from (x0,y0) to (x1,y1). */
export function strokeSegment(
  ctx: CanvasRenderingContext2D,
  brushes: HTMLCanvasElement[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  brushRadius: number,
): void {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(2, (brushRadius ?? BRUSH_RADIUS) * 0.1);
  const n = Math.ceil(dist / step);
  for (let i = 0; i <= n; i++) {
    stampAt(
      ctx,
      brushes,
      x0 + ((x1 - x0) * i) / n,
      y0 + ((y1 - y0) * i) / n,
      brushRadius,
    );
  }
}
