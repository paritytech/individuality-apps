// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Binary-alpha brush baking: the foil coating must fracture into flakes when
 * erased, so each stamp is a fixed -22deg ellipse whose alpha is shaped by
 * octave noise and random grooves. Four variants per card, drawn with
 * destination-out so the foil breaks instead of fading.
 */

import { LONG_F, SHORT_F, VARIANTS } from "./progress.ts";

/* Panel geometry from game-end's scratchcard-bounds.json (source pixels). */
const IMG = { w: 1173, h: 1341 };
const PANEL = { x: 221, y: 763, w: 730, h: 372, r: 36 };
export const PCT = {
  left: (PANEL.x / IMG.w) * 100,
  top: (PANEL.y / IMG.h) * 100,
  w: (PANEL.w / IMG.w) * 100,
  h: (PANEL.h / IMG.h) * 100,
  rx: (PANEL.r / PANEL.w) * 100,
  ry: (PANEL.r / PANEL.h) * 100,
};

function octaveNoise(
  size: number,
  octaves: number,
  baseCells: number,
): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 0.5;
  let total = 0;
  let cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const g = cells + 1;
    const grid = Float32Array.from({ length: g * g }, () => Math.random());
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const a = grid[y0 * g + x0]!;
        const b = grid[y0 * g + x0 + 1]!;
        const c = grid[(y0 + 1) * g + x0]!;
        const d = grid[(y0 + 1) * g + x0 + 1]!;
        const idx = y * size + x;
        out[idx] =
          (out[idx] ?? 0) +
          amp * ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty);
      }
    }
    total += amp;
    amp *= 0.6;
    cells *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total;
  return out;
}

export function drawPanelCoating(
  ctx: CanvasRenderingContext2D,
  art: HTMLImageElement,
  w: number,
  h: number,
): void {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(art, PANEL.x, PANEL.y, PANEL.w, PANEL.h, 0, 0, w, h);
}

export function bakeBrushes(r: number): HTMLCanvasElement[] {
  const w = Math.ceil(r * LONG_F * 2);
  const hgt = Math.ceil(r * SHORT_F * 2);
  const size = Math.max(w, hgt);
  const grooveN = 4 + Math.floor(Math.random() * 3);
  const grooves = Array.from({ length: grooveN }, () => ({
    pos: (Math.random() * 2 - 1) * r * SHORT_F * 0.85,
    th: 0.9 + Math.random() * 1.6,
    a: 0.7 + Math.random() * 0.3,
  }));
  return Array.from({ length: VARIANTS }, () => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = hgt;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(w, hgt);
    const chunk = octaveNoise(size, 2, 2);
    const cutoff = octaveNoise(size, 3, 4);
    const along = octaveNoise(size, 3, 4);
    for (let py = 0; py < hgt; py++) {
      const dy = (py - hgt / 2) / (hgt / 2);
      let grooveBase = 0;
      for (const g of grooves) {
        const gd = Math.abs(py - hgt / 2 - g.pos);
        grooveBase = Math.max(grooveBase, Math.max(0, 1 - gd / g.th) * g.a);
      }
      for (let px = 0; px < w; px++) {
        const dx = (px - w / 2) / (w / 2);
        const ch = chunk[(py % size) * size + (px % size)]!;
        const d = Math.hypot(dx, dy) - (ch - 0.5) * 0.64;
        const env = d < 0.65 ? 1 : d >= 1 ? 0 : (1 - d) / 0.35;
        const al = along[px % size]!;
        const intent =
          grooveBase * env * (0.85 + 0.15 * al) * (0.55 + 0.45 * ch);
        const cut = cutoff[(py % size) * size + (px % size)]!;
        img.data[(py * w + px) * 4 + 3] =
          intent + cut * 0.35 > 0.5 ? 255 : 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  });
}
