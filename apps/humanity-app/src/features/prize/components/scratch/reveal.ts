// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Win/miss reveal motion: foil + holo dissolve
 * with a pop, then a flash, debris and pellet burst and elastic bounce for a
 * win, or a quiet prize settle for a miss. Reduced motion never reaches this
 * module (the engine short-circuits first). The sequence is registered into
 * the owner's scope so an unmount cannot leak it.
 */

import { animate, type AnimationSequence } from "motion";

import type { Debris } from "./debris.ts";
import { buzz } from "./haptics.ts";
import { pelletBurst, type AnimationScope } from "@shared/motion/motion.ts";
import {
  elasticOut,
  expoIn,
  expoOut,
  power2InOut,
  power2Out,
  power3Out,
} from "@shared/motion/ease.ts";

export interface RevealTargets {
  card: HTMLElement;
  canvas: HTMLCanvasElement;
  holo: HTMLElement;
  flash: HTMLElement;
  prize: HTMLElement;
  panel: HTMLElement;
  debris: Debris;
  burstX: number;
  burstY: number;
  win: boolean;
  scope: AnimationScope;
  onComplete: () => void;
}

export function buildRevealTimeline(t: RevealTargets): void {
  const sequence: AnimationSequence = [
    // A press may have left the card squished; the pop starts from square.
    [t.card, { scale: 1.02, scaleX: 1, scaleY: 1, y: -1 }, { duration: 0.18, ease: power2Out, at: 0 }],
    [[t.canvas, t.holo], { opacity: 0, scale: 1.02 }, { duration: 0.22, ease: power2Out, at: 0 }],
  ];
  if (t.win) {
    buzz([22, 60, 16, 50, 14]);
    sequence.push(
      [t.card, { scale: 0.97 }, { duration: 0.08, ease: expoOut, at: 0.22 }],
      [t.flash, { opacity: 0.45 }, { duration: 0.06, ease: expoOut, at: 0.3 }],
      [t.flash, { opacity: 0 }, { duration: 0.12, ease: expoIn, at: 0.36 }],
      [t.card, { y: -16, scale: 1.05 }, { duration: 0.32, ease: expoOut, at: 0.4 }],
      [t.card, { y: 0, scale: 1 }, { duration: 0.7, ease: elasticOut(1, 0.55), at: 0.72 }],
    );
    t.scope.later(() => {
      t.debris.burst(t.burstX, t.burstY, 44);
      pelletBurst(t.panel, {
        count: 16,
        distMin: 60,
        distMax: 130,
        colors: ["#ffffff", "#d6d2c4", "#aab4c3"],
        scope: t.scope,
      });
    }, 0.4);
  } else {
    sequence.push(
      [t.prize, { scale: [0.96, 1] }, { duration: 0.35, ease: power3Out, at: 0.3 }],
      [t.card, { scale: 1, y: 0 }, { duration: 0.3, ease: power2InOut, at: 0.3 }],
    );
  }
  void t.scope.add(animate(sequence)).then(() => {
    if (!t.scope.stopped) t.onComplete();
  });
}
