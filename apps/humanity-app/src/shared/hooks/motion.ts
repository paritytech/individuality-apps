// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Motion helpers — entrance stagger (enterStagger) and reduced-motion
 *  awareness (reducedMotion). */
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { animate, stagger } from "motion";

import { power3Out } from "@shared/motion/ease.ts";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/** True when the OS asks for reduced motion. Honoured by every animated
 *  surface; animated CSS also falls back via @media + body.reduced. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia(REDUCED_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(REDUCED_QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Staggered entrance for a screen's blocks — opacity/y/scale rise with a
 *  decelerating soft ease. Reduced motion snaps straight to the settled state. */
export function useEnterStagger(
  refs: Array<RefObject<HTMLElement | null> | null>,
  opts: { y?: number; stagger?: number } = {},
): void {
  const reduced = useReducedMotion();
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    const targets = refs
      .map((r) => (r ? r.current : null))
      .filter((el): el is HTMLElement => el != null);
    if (targets.length === 0) return;
    const { y = 18, stagger: gap = 0.07 } = optsRef.current;
    if (reduced) {
      showSettled(targets);
      return;
    }
    placeAt(targets, { opacity: 0, y, scale: 0.985 });
    const entrance = animate(
      targets,
      { opacity: [0, 1], y: [y, 0], scale: [0.985, 1] },
      { duration: 0.55, ease: power3Out, delay: stagger(gap) },
    );
    return () => entrance.stop();
    // refs identity is stable; re-run only when the motion mode flips
  }, [reduced]);
}

/** Writes a resting place onto entrance targets at once. Motion only
 *  draws an animation's first keyframe on the next frame, so an entrance
 *  places its targets at the start first, or they flash in settled for a
 *  frame; reduced motion places them at the end and animates nothing. */
export function placeAt(
  targets: readonly HTMLElement[],
  { opacity, y = 0, scale = 1 }: { opacity: number; y?: number; scale?: number },
): void {
  const transform = y === 0 && scale === 1 ? "none" : `translateY(${y}px) scale(${scale})`;
  for (const target of targets) {
    target.style.opacity = String(opacity);
    target.style.transform = transform;
  }
}

/** The settled place: shown, with no offset or scale left on. */
export function showSettled(targets: readonly HTMLElement[]): void {
  placeAt(targets, { opacity: 1 });
}
