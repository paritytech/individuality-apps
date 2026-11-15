// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Wires the card's light to a hovering pointer and to the device's
 * orientation. The surface maths, and why touch drives neither, live in
 * `domain/card-parallax.ts`. The light is CSS variables on the card root
 * (the sheen and holo transitions in CSS smooth them); nothing here touches
 * the card's geometry, so a flip in progress has nothing to fight. While the
 * card is being dragged round (`data-dragging`), the pointer path pauses:
 * a drag is not a hover.
 */
import { useEffect, type RefObject } from "react";

import { useReducedMotion } from "@shared/hooks/motion.ts";
import {
  orientationOffset,
  pointerOffset,
  pointerTilts,
  restingSurface,
  surfaceFrom,
  type CardSurface,
} from "@features/card/domain/card-parallax.ts";

export function useCardParallax(rootRef: RefObject<HTMLElement | null>): void {
  const reduced = useReducedMotion();

  useEffect(() => {
    const root = rootRef.current;
    if (reduced || root == null) return;

    const apply = (light: CardSurface) => {
      if (root.dataset["dragging"] === "1") return;
      root.style.setProperty("--sheen-x", `${light.sheenX}%`);
      root.style.setProperty("--sheen-y", `${light.sheenY}%`);
      root.style.setProperty("--holo-x", `${light.holoX}px`);
      root.style.setProperty("--holo-y", `${light.holoY}px`);
      root.style.setProperty("--tilt-x", String(light.tiltX));
      root.style.setProperty("--tilt-y", String(light.tiltY));
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointerTilts(e.pointerType)) return;
      const { nx, ny } = pointerOffset(e, root.getBoundingClientRect());
      apply(surfaceFrom(nx, ny));
    };
    const onPointerLeave = (e: PointerEvent) => {
      if (!pointerTilts(e.pointerType)) return;
      apply(restingSurface());
    };
    const onOrientation = (e: DeviceOrientationEvent) => {
      const offset = orientationOffset(e);
      if (offset == null) return;
      apply(surfaceFrom(offset.nx, offset.ny));
    };

    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerleave", onPointerLeave);
    if ("DeviceOrientationEvent" in window) {
      window.addEventListener("deviceorientation", onOrientation);
    }
    return () => {
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("deviceorientation", onOrientation);
    };
    // The ref's identity is stable; only the motion mode re-runs this.
  }, [reduced]);
}
