// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Plain (non-hook) motion helpers shared across features: OS reduced-motion
 * detection (a `reduced` body class or the media query),
 * a scope that stops everything one owner started, and the DOM-pellet
 * celebration burst used on a win. Pellets can be registered into the
 * owner's scope so a StrictMode remount cannot leak them.
 */

import { animate, delay } from "motion";

import { power1In, power2Out } from "./ease.ts";

export function reducedMotion(): boolean {
  return (
    document.body.classList.contains("reduced") ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Animations and timed calls started on behalf of one owner, stopped
 *  together when it goes away. Stopping leaves each value where it was. */
export interface AnimationScope {
  add<T extends { stop: () => void }>(animation: T): T;
  /** Run `fn` after `seconds`, unless the scope is stopped first. */
  later(fn: () => void, seconds: number): void;
  stop(): void;
  /** Whether `stop` has run: work an animation's end would start is moot. */
  readonly stopped: boolean;
}

export function animationScope(): AnimationScope {
  let stops: Array<() => void> = [];
  let stopped = false;
  return {
    add(animation) {
      if (stopped) animation.stop();
      else stops.push(() => animation.stop());
      return animation;
    },
    later(fn, seconds) {
      if (stopped) return;
      // `motion`'s `delay` takes seconds (motion-dom's `delayInSeconds`),
      // not the milliseconds of motion-dom's own `delay`.
      stops.push(delay(() => fn(), seconds));
    },
    stop() {
      stopped = true;
      const current = stops;
      stops = [];
      for (const stop of current) stop();
    },
    get stopped() {
      return stopped;
    },
  };
}

export function pelletBurst(
  host: HTMLElement,
  opts: {
    x?: number;
    y?: number;
    count?: number;
    colors?: string[];
    distMin?: number;
    distMax?: number;
    scope?: AnimationScope;
  } = {},
): void {
  if (reducedMotion()) return;
  const { count = 22, colors = ["#ffffff"], distMin = 90, distMax = 170 } = opts;
  const rect = host.getBoundingClientRect();
  const cx = opts.x ?? rect.width / 2;
  const cy = opts.y ?? rect.height / 2;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    p.className = "pellet";
    const c = colors[i % colors.length]!;
    p.style.background = c;
    p.style.boxShadow = `0 0 6px ${c}, 0 0 16px rgba(81,99,245,.55)`;
    p.style.left = `${cx}px`;
    p.style.top = `${cy}px`;
    host.appendChild(p);
    const ang = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const dist = distMin + Math.random() * (distMax - distMin);
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist;
    const flight = animate([
      [p, { x: [0, dx], y: [0, dy], scale: [1, 1] }, { duration: 0.28, ease: power2Out }],
      [
        p,
        { x: dx * 1.38, y: dy * 1.38 + 40, opacity: 0, scale: 0.5 },
        { duration: 0.65, ease: power1In },
      ],
    ]);
    // A stopped burst takes its pellets with it.
    const pellet = { stop: () => (flight.stop(), p.remove()) };
    opts.scope?.add(pellet);
    void flight.then(() => p.remove());
  }
}
