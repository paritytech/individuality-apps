// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Canvas2D scratch engine for the daily-dollar card: silver panel crop as coating, baked -22deg
 * binary-alpha brushes under destination-out, 110ms 64x40 coverage sampling,
 * 0.58 threshold with a 2s stuck rescue. Pointer plumbing lives in input.ts;
 * every animation lives in a scope so StrictMode remounts leak nothing.
 * Canvas setup and drawing primitives are extracted to canvas-setup.ts
 * and canvas-drawing.ts so the scratch-canvas TSX hook can reuse them.
 */

import { animate } from "motion";

import { createDebris } from "./debris.ts";
import { buzz } from "./haptics.ts";
import { animationScope, reducedMotion } from "@shared/motion/motion.ts";
import { backOut, sineInOut } from "@shared/motion/ease.ts";
import { placeAt } from "@shared/hooks/motion.ts";
import {
  BRUSH_RADIUS,
  getScratchBrushRadius,
  RESCUE_AT,
  SAMPLE_H,
  SAMPLE_MS,
  SAMPLE_W,
  shouldRevealScratch,
} from "./progress.ts";
import { buildRevealTimeline } from "./reveal.ts";
import { wirePointerInput, type ScratchCore, type ScratchState } from "./input.ts";
import type { ScratchEngineApi, ScratchEngineOptions } from "./types.ts";
import { initCanvas } from "./canvas-setup.ts";
import { stampAt, strokeSegment } from "./canvas-drawing.ts";

export function createScratchEngine(o: ScratchEngineOptions): ScratchEngineApi {
  const { card, art, panel, canvas, holo, debrisCanvas, hint, flash, prize } =
    o;
  const rm = reducedMotion();
  const debris = createDebris(debrisCanvas);
  const state: ScratchState = {
    revealed: false,
    activePointer: null,
    lastPoint: null,
    lastProgressAt: 0,
  };
  const toDebris = (x: number, y: number) => {
    const pr = panel.getBoundingClientRect();
    const dr = debrisCanvas.getBoundingClientRect();
    return { x: x + pr.left - dr.left, y: y + pr.top - dr.top };
  };

  let ctx: CanvasRenderingContext2D | undefined;
  let sctx: CanvasRenderingContext2D | undefined;
  let brushes: HTMLCanvasElement[] = [];
  let lastSample = 0;
  let sampled = 0;
  let rescueArmedAt: number | null = null;
  let initRaf = 0;
  let artLoad: (() => void) | undefined;

  let sizedW = 0;
  let sizedH = 0;
  let scratched = false;

  const init = () => {
    const w = canvas.clientWidth;
    if (!w) {
      initRaf = requestAnimationFrame(init);
      return;
    }
    artLoad?.();
    const prim = initCanvas(canvas, art, brushes.length > 0 ? brushes : undefined);
    ctx = prim.ctx;
    sctx = prim.sctx;
    brushes = prim.brushes;
    artLoad = prim.detachArtLoad;
    sizedW = w;
    sizedH = canvas.clientHeight;
  };

  // The card can change size after it is drawn: under a Pocket card the host
  // moves the face away once this screen is up, and the page grows with it.
  // The bitmap was sized once, so the foil would stretch and strokes would land
  // off the finger. An untouched foil is simply drawn again at the new size; a
  // scratched one keeps its holes, scaled onto the new bitmap.
  const refit = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (ctx == null || state.revealed || !w || !h) return;
    if (w === sizedW && h === sizedH) return;
    if (!scratched) {
      init();
      return;
    }
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext("2d")?.drawImage(canvas, 0, 0);
    // The ratio initCanvas sized with, not canvas.width / sizedW: the bitmap's
    // width is an integer, so on a 1.5 or 1.75 screen that ratio is truncated
    // and drifts further with every refit.
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(copy, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A stroke in progress continues from where the finger is on the new
    // size, not from the old coordinates, so the next segment does not jump.
    if (state.activePointer != null && state.lastPoint != null) {
      state.lastPoint = {
        x: (state.lastPoint.x * w) / sizedW,
        y: (state.lastPoint.y * h) / sizedH,
      };
    }
    sizedW = w;
    sizedH = h;
  };
  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refit);
  resizeObserver?.observe(canvas);

  const brushRadius = () => {
    if (!state.lastPoint || !state.lastProgressAt) return BRUSH_RADIUS;
    return getScratchBrushRadius(performance.now() - state.lastProgressAt);
  };

  const stamp = (x: number, y: number) => {
    if (!ctx) return;
    scratched = true;
    stampAt(ctx, brushes, x, y, brushRadius());
  };

  const stroke = (x0: number, y0: number, x1: number, y1: number) => {
    if (!ctx) return;
    scratched = true;
    strokeSegment(ctx, brushes, x0, y0, x1, y1, brushRadius());
  };

  const sample = (force = false) => {
    const now = performance.now();
    if (!force && now - lastSample < SAMPLE_MS) return;
    lastSample = now;
    if (sctx == null) return;
    sctx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
    sctx.drawImage(canvas, 0, 0, SAMPLE_W, SAMPLE_H);
    const data = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    let cleared = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! < 16) cleared++;
    const next = cleared / (SAMPLE_W * SAMPLE_H);
    if (next - sampled > 0.01) state.lastProgressAt = now;
    sampled = next;
    if (sampled >= RESCUE_AT && !rescueArmedAt) rescueArmedAt = now;
    if (shouldRevealScratch(sampled, rescueArmedAt, now)) reveal();
  };

  const reveal = () => {
    if (state.revealed) return;
    state.revealed = true;
    state.activePointer = null;
    buzz([12, 40, 12]);
    idle.stop();
    hint.style.opacity = "0";
    const rect = panel.getBoundingClientRect();
    const c = toDebris(rect.width / 2, rect.height / 2);
    if (rm) {
      canvas.style.opacity = "0";
      holo.style.opacity = "0";
      o.onReveal();
      return;
    }
    buildRevealTimeline({
      card, canvas, holo, flash, prize, panel, debris,
      burstX: c.x,
      burstY: c.y,
      win: o.win,
      scope,
      onComplete: o.onReveal,
    });
  };

  // The reveal and its burst, and apart from them the card's idle life (its
  // entrance, the press squish, the hint's pulse), which the reveal ends.
  const scope = animationScope();
  const idle = animationScope();
  flash.style.opacity = "0";
  if (!rm) {
    // Motion writes the first keyframe on the next frame; the card is drawn
    // at rest before that unless it starts where the entrance does.
    placeAt([card], { opacity: 0, y: 12, scale: 0.94 });
    idle.add(
      animate(
        card,
        { scale: [0.94, 1], opacity: [0, 1], y: [12, 0] },
        { duration: 0.55, ease: backOut(1.3) },
      ),
    );
    idle.add(
      animate(
        hint,
        { scale: 1.08, opacity: 1 },
        { duration: 0.9, repeat: Infinity, repeatType: "reverse", ease: sineInOut },
      ),
    );
  }

  const core: ScratchCore = {
    canvas, card, holo, hint,
    rm, idle, debris, state,
    stampAt: stamp, strokeSegment: stroke, sample, reveal, toDebris,
  };
  const detachInput = wirePointerInput(core);
  initRaf = requestAnimationFrame(init);

  const destroy = () => {
    cancelAnimationFrame(initRaf);
    resizeObserver?.disconnect();
    artLoad?.();
    detachInput();
    if (state.activePointer != null && canvas.hasPointerCapture(state.activePointer)) {
      canvas.releasePointerCapture(state.activePointer);
    }
    idle.stop();
    scope.stop();
    debris.dispose();
    canvas.width = 0;
    canvas.height = 0;
  };

  return { reveal, destroy };
}

