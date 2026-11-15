// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pointer plumbing for the scratch engine:
 * one tracked pointer at a time, coalesced events, velocity-gated debris
 * emission and buzz haptics, press squish and settle, first-scratch hint
 * fade, and the holo shimmer that follows the pointer across the card.
 * All scratch state lives in `state` so the engine and this module share
 * live bindings. Returns a detach function for unmount cleanup.
 */

import { animate } from "motion";

import type { Debris } from "./debris.ts";
import { buzz } from "./haptics.ts";
import type { AnimationScope } from "@shared/motion/motion.ts";
import { backOut, power2In, power2Out } from "@shared/motion/ease.ts";

export interface ScratchState {
  revealed: boolean;
  activePointer: number | null;
  lastPoint: { x: number; y: number } | null;
  lastProgressAt: number;
}

export interface ScratchCore {
  canvas: HTMLCanvasElement;
  card: HTMLElement;
  holo: HTMLElement;
  hint: HTMLElement;
  rm: boolean;
  /** The card's idle animations, which the reveal stops. */
  idle: AnimationScope;
  debris: Debris;
  state: ScratchState;
  stampAt(x: number, y: number): void;
  strokeSegment(x0: number, y0: number, x1: number, y1: number): void;
  sample(force?: boolean): void;
  reveal(): void;
  toDebris(x: number, y: number): { x: number; y: number };
}

const pos = (e: PointerEvent, rect: DOMRect) => ({
  x: e.clientX - rect.left,
  y: e.clientY - rect.top,
});

export function wirePointerInput(core: ScratchCore): () => void {
  const { canvas, card, holo, hint, rm, idle, debris, state } = core;
  let started = false;
  let pressStart = 0;
  let velocityEMA = 0;

  const onDown = (e: PointerEvent) => {
    if (
      state.revealed ||
      (e.button !== 0 && e.pointerType === "mouse") ||
      state.activePointer !== null
    ) {
      return;
    }
    state.activePointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    state.lastPoint = pos(e, rect);
    state.lastProgressAt = performance.now();
    pressStart = performance.now();
    if (!started) {
      started = true;
      idle.add(animate(hint, { opacity: 0, scale: 0.85 }, { duration: 0.25, ease: power2Out }));
    }
    if (!rm) {
      idle.add(animate(card, { scaleX: 1.005, scaleY: 0.995 }, { duration: 0.08, ease: power2In }));
    }
    core.stampAt(state.lastPoint.x, state.lastPoint.y);
    core.sample();
  };

  const onMove = (e: PointerEvent) => {
    if (state.revealed || e.pointerId !== state.activePointer || !state.lastPoint) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events) {
      const p = pos(ev as PointerEvent, rect);
      const d = Math.hypot(p.x - state.lastPoint.x, p.y - state.lastPoint.y);
      if (d < 1) continue;
      core.strokeSegment(state.lastPoint.x, state.lastPoint.y, p.x, p.y);
      const v = d / Math.max(1, 8);
      velocityEMA = velocityEMA * 0.8 + v * 0.2;
      if (velocityEMA >= 0.05) {
        const dp = core.toDebris(p.x, p.y);
        debris.emit(
          dp.x,
          dp.y,
          Math.atan2(p.y - state.lastPoint.y, p.x - state.lastPoint.x),
          velocityEMA,
        );
        if (velocityEMA > 0.2) buzz(6, 80);
      }
      state.lastPoint = p;
    }
    core.sample();
  };

  const onEnd = (e: PointerEvent) => {
    if (e.pointerId !== state.activePointer) return;
    state.activePointer = null;
    state.lastPoint = null;
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    if (!rm && !state.revealed && performance.now() - pressStart > 80) {
      idle.add(animate(card, { scaleX: 1, scaleY: 1 }, { duration: 0.22, ease: backOut(1.4) }));
    }
    if (!state.revealed) core.sample(true);
  };

  const onCardMove = (e: PointerEvent) => {
    const r = card.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    holo.style.backgroundPosition = `${50 + nx * 22}% ${50 + ny * 14}%, ${
      50 - nx * 10
    }% ${50 - ny * 8}%`;
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onEnd);
  canvas.addEventListener("pointercancel", onEnd);
  canvas.addEventListener("pointerleave", onEnd);
  if (!rm) card.addEventListener("pointermove", onCardMove);

  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onEnd);
    canvas.removeEventListener("pointercancel", onEnd);
    canvas.removeEventListener("pointerleave", onEnd);
    if (!rm) card.removeEventListener("pointermove", onCardMove);
  };
}
