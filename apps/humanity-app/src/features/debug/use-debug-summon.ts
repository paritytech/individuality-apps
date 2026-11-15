// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Hidden summon gestures for the debug panel.
 *
 * The panel has no visible affordance, so it can ship in a production build
 * without an operator control sitting on top of the app. Two gestures reach
 * it instead: `Cmd`/`Ctrl`+`D` on a desktop keyboard, and — where there is no
 * keyboard — five quick taps in the top third of the screen. The card lives
 * there and takes taps of its own, so anything inside `[data-summon-ignore]`
 * is left out of the count. `Escape` closes it.
 *
 * The pointer listener is passive and never calls `preventDefault`: a stray
 * tap must still reach whatever it landed on.
 */
import { useEffect } from "react";

const TAP_COUNT = 5;
const TAP_WINDOW_MS = 1_500;
/** Taps only count in the top third of the viewport. */
const TOP_FRACTION = 1 / 3;

/** Binds the summon gestures for as long as the caller is mounted. */
export function useDebugSummon(handlers: { toggle: () => void; close: () => void }): void {
  const { toggle, close } = handlers;

  useEffect(() => {
    // The keyboard shortcut collides with "bookmark this page", so the browser
    // default has to go for the panel to open at all.
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        toggle();
        return;
      }
      if (event.key === "Escape") close();
    };

    const taps: number[] = [];
    const onPointerDown = (event: PointerEvent) => {
      // The card sits inside the top third and is tapped and flipped; its
      // taps are ordinary use and end the run rather than count toward it.
      const target = event.target as Element | null;
      if (target?.closest?.("[data-summon-ignore]") != null) {
        taps.length = 0;
        return;
      }
      if (event.clientY > window.innerHeight * TOP_FRACTION) {
        // A tap anywhere else is ordinary use of the app, and ends the run.
        taps.length = 0;
        return;
      }
      const now = Date.now();
      let oldest = taps[0];
      while (oldest !== undefined && now - oldest > TAP_WINDOW_MS) {
        taps.shift();
        oldest = taps[0];
      }
      taps.push(now);
      if (taps.length >= TAP_COUNT) {
        taps.length = 0;
        toggle();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [toggle, close]);
}
