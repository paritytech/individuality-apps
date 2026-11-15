// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Canvas2D sizing, DPR scaling, coating draw, and brush/sampling-context
 * creation. Extracted from engine.ts so the scratch-canvas hook can own
 * canvas sizing decisions without pulling all engine logic into the React
 * component. One-shot initialization — callers receive stable primitives
 * that require no further coordination.
 */

import { bakeBrushes, drawPanelCoating } from "./brush.ts";
import { BRUSH_RADIUS, SAMPLE_H, SAMPLE_W } from "./progress.ts";

export interface CanvasPrimitives {
  ctx: CanvasRenderingContext2D;
  sctx: CanvasRenderingContext2D;
  brushes: HTMLCanvasElement[];
  /** Detaches the deferred coating draw when the art was still loading. */
  detachArtLoad?: () => void;
}

/** Returns canvas contexts and baked brushes after sizing the canvas to its
 *  client dimensions scaled by device pixel ratio (capped at 2). The foil
 *  coating is the silver panel crop of the card art; drawing it on an image
 *  that has not finished loading is a silent no-op, so the draw is deferred
 *  to the art's load event when needed. */
export function initCanvas(
  canvas: HTMLCanvasElement,
  art: HTMLImageElement,
  /** Brushes baked by an earlier call; they do not depend on the size. */
  bakedBrushes?: HTMLCanvasElement[],
): CanvasPrimitives {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const ctx = canvas.getContext("2d");
  if (ctx == null) throw new Error("Scratch canvas 2D context is unavailable.");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  let detachArtLoad: (() => void) | undefined;
  if (art.complete && art.naturalWidth) {
    drawPanelCoating(ctx, art, w, hgt);
  } else {
    const draw = () => drawPanelCoating(ctx, art, w, hgt);
    art.addEventListener("load", draw, { once: true });
    detachArtLoad = () => art.removeEventListener("load", draw);
  }
  const brushes = bakedBrushes ?? bakeBrushes(BRUSH_RADIUS);
  const s = document.createElement("canvas");
  s.width = SAMPLE_W;
  s.height = SAMPLE_H;
  const sctx = s.getContext("2d", { willReadFrequently: true });
  if (sctx == null) throw new Error("Scratch sampling context is unavailable.");
  return { ctx, sctx, brushes, detachArtLoad };
}
