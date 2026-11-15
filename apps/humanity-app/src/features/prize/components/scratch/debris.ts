// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Canvas2D steel-flake debris pool that sprays from the brush while scratching
 * and bursts on a win: 140-flake pool, gravity
 * and drag, 'lighter' composite, flake shape drawn as a dark square with a
 * bright streak. Reduced motion halves burst counts and disables rotation.
 */

import { reducedMotion } from "@shared/motion/motion.ts";

interface Flake {
  on: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  s: number;
  life: number;
  max: number;
  rot: number;
  vr: number;
}

export interface Debris {
  emit(x: number, y: number, tangent: number, velocity: number): void;
  burst(x: number, y: number, count: number): void;
  dispose(): void;
}

export function createDebris(canvas: HTMLCanvasElement): Debris {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const ctx = canvas.getContext("2d")!;
  const pool: Flake[] = Array.from({ length: 140 }, () => ({
    on: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    s: 0,
    life: 0,
    max: 0,
    rot: 0,
    vr: 0,
  }));
  let raf = 0;
  let last = 0;
  let alive = 0;
  const rm = reducedMotion();

  const resize = () => {
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  // The page can grow under it (the Pocket card's face moving away), and a
  // bitmap sized once would draw the flakes stretched.
  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  resizeObserver?.observe(canvas);

  function tick(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.globalCompositeOperation = "lighter";
    alive = 0;
    for (const p of pool) {
      if (!p.on) continue;
      p.life -= dt * 1000;
      if (p.life <= 0) {
        p.on = false;
        continue;
      }
      alive++;
      p.vy += 200 * dt;
      const drag = Math.exp(-2.5 * dt);
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const a = Math.min(1, p.life / (p.max * 0.3));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = `rgba(170,180,195,${0.25 * a})`;
      ctx.fillRect(-p.s, -p.s, p.s * 2, p.s * 2);
      ctx.fillStyle = `rgba(235,240,250,${0.95 * a})`;
      ctx.fillRect(-p.s * 0.7, -p.s * 0.18, p.s * 1.4, p.s * 0.36);
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";
    raf = alive ? requestAnimationFrame(tick) : 0;
  }

  const wake = () => {
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  };

  return {
    emit(x, y, tangent, velocity) {
      const n = Math.min(
        6,
        Math.max(
          1,
          Math.round(
            (2 + Math.random() * 2) * Math.min(1.8, 0.7 + velocity * 0.6),
          ),
        ),
      );
      for (let i = 0; i < n; i++) {
        const p = pool.find((f) => !f.on);
        if (!p) break;
        const ang =
          tangent +
          (Math.random() * 2 - 1) * (Math.PI / 7) +
          (Math.random() < 0.09 ? Math.PI : 0);
        const sp =
          (60 + Math.random() * 80) *
          (1.4 + Math.random() * 0.8) *
          Math.min(2, 0.7 + velocity * 0.5);
        Object.assign(p, {
          on: true,
          x,
          y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - 30,
          s: 5 + Math.random() * 4,
          life: rm ? 400 : 800 + Math.random() * 700,
          max: 1200,
          rot: Math.random() * 6.28,
          vr: rm ? 0 : (Math.random() * 2 - 1) * 8,
        });
      }
      wake();
    },
    burst(x, y, count) {
      for (let i = 0; i < (rm ? count / 2 : count); i++) {
        const p = pool.find((f) => !f.on);
        if (!p) break;
        const ang = -Math.PI / 2 + (Math.random() * 2 - 1) * (Math.PI / 4);
        const sp = 120 + Math.random() * 160;
        Object.assign(p, {
          on: true,
          x,
          y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          s: 5 + Math.random() * 5,
          life: 700 + Math.random() * 400,
          max: 1100,
          rot: Math.random() * 6.28,
          vr: rm ? 0 : (Math.random() * 2 - 1) * 8,
        });
      }
      wake();
    },
    dispose() {
      resizeObserver?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
