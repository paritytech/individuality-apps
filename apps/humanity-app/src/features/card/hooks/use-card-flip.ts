// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Turns the card over. The angle lives in a ref, Motion moves it, and each
 * step writes `.idcard-body`'s rotateY; the maths (folding, commit, flick) live in
 * `domain/card-flip.ts`. Two ways round: a button (the QR glyph on the
 * front, the whole back on the back), one clean turn per press, and a
 * sideways drag on the card. The code on the back is generated on the first
 * turn, never before: nothing loads for a card nobody flips.
 *
 * A press while the card is already turning does nothing: the turn under
 * way lands where it was going. A touch that never becomes a sideways drag
 * leaves a turn alone too, so a tap can never freeze the card mid-angle.
 * A real drag grabs the card wherever it is, spinning or not, and turns it
 * from there.
 *
 * The root carries `data-dragging` while a drag is live, which pauses the
 * pointer light (`use-card-parallax.ts`); the two never touch the same
 * property. Reduced motion sets the angle rather than tweening it.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { animate, type AnimationPlaybackControls } from "motion";

import { useReducedMotion } from "@shared/hooks/motion.ts";
import { power2Out, power3Out } from "@shared/motion/ease.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import {
  dragAngle,
  dragIntent,
  foldAngle,
  nearestRest,
  releaseTargetFrom,
  settleDuration,
  type DragIntent,
} from "@features/card/domain/card-flip.ts";

const logger = loggerFor("card", "flip");

export interface CardFlipOptions {
  /** Off for a card that is only looked at, e.g. inside the promotion. */
  enabled: boolean;
  /** What the code on the back says; null draws the back without one. */
  payload: string | null;
  /** Called once each time the card comes to rest on the other face. */
  onFlip?: () => void;
}

export interface CardFlip {
  /** Whether the back is showing. Drives the face swap in the DOM. */
  flipped: boolean;
  /** The code for the current payload as a data URL, once it is built. */
  qrMask: string | null;
  /** Turn the card over, whichever way it faces; ignored mid-turn. */
  flip: () => void;
  /** Handlers for the root element. */
  rootProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
}

interface Drag {
  id: number;
  x0: number;
  y0: number;
  intent: DragIntent;
  /** Where the card was, and where the finger was, when the drag took it. */
  basePos: number;
  baseX: number;
  lastPos: number;
  lastT: number;
  velocity: number;
}

/** Build the code as a transparent-ground data URL, for use as a CSS mask. */
async function buildQrMask(payload: string): Promise<string> {
  const { toDataURL } = await import("qrcode");
  return toDataURL(payload, {
    // Four modules of quiet zone, as the spec asks. It is transparent, so the
    // card's own surface is what surrounds the code — exactly what a scanner
    // needs the quiet zone to be.
    margin: 4,
    width: 296,
    color: { dark: "#000000ff", light: "#00000000" },
  });
}

export function useCardFlip(
  rootRef: RefObject<HTMLElement | null>,
  bodyRef: RefObject<HTMLElement | null>,
  { enabled, payload, onFlip }: CardFlipOptions,
): CardFlip {
  const reduced = useReducedMotion();
  const [flipped, setFlipped] = useState(false);
  const [built, setBuilt] = useState<{ payload: string; url: string } | null>(null);
  const turn = useRef({ pos: 0, rest: 0 });
  /** The turn under way, until it lands or something takes the card. */
  const turning = useRef<AnimationPlaybackControls | null>(null);
  const drag = useRef<Drag | null>(null);
  const flippedRef = useRef(false);
  // The face the card last came to rest on, so `onFlip` fires only when a
  // turn really lands on the other one.
  const restedOnBack = useRef(false);
  const onFlipRef = useRef(onFlip);
  onFlipRef.current = onFlip;
  const building = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const stopTurning = useCallback(() => {
    turning.current?.stop();
    turning.current = null;
  }, []);

  const render = useCallback(() => {
    const body = bodyRef.current;
    const { angle, flipped: onBack } = foldAngle(turn.current.pos);
    if (onBack !== flippedRef.current) {
      flippedRef.current = onBack;
      setFlipped(onBack);
    }
    if (body != null) body.style.transform = `rotateY(${angle}deg)`;
  }, [bodyRef]);

  // The code is built the first time the back shows for a payload, and again
  // if the payload changes. Only unmounting abandons a build: turning the
  // card back while it loads must not lose it, and a failed build is tried
  // again on the next turn.
  useEffect(() => {
    if (!flipped || payload == null) return;
    if (built?.payload === payload || building.current === payload) return;
    building.current = payload;
    buildQrMask(payload)
      .then((url) => {
        if (mounted.current) setBuilt({ payload, url });
      })
      .catch((error: unknown) => {
        logger.warning("could not draw the card's code: {error}", { error });
      })
      .finally(() => {
        if (building.current === payload) building.current = null;
      });
  }, [flipped, payload, built]);

  const settle = useCallback(
    (to: number, ease = power2Out) => {
      turn.current.rest = to;
      stopTurning();
      const finish = () => {
        const back = foldAngle(to).flipped;
        if (back !== restedOnBack.current) {
          restedOnBack.current = back;
          onFlipRef.current?.();
        }
      };
      if (reduced) {
        turn.current.pos = to;
        render();
        finish();
        return;
      }
      const turnTo = animate(turn.current.pos, to, {
        duration: settleDuration(to - turn.current.pos),
        ease,
        onUpdate: (pos) => {
          turn.current.pos = pos;
          render();
        },
        onComplete: () => {
          if (turning.current === turnTo) turning.current = null;
          finish();
        },
      });
      turning.current = turnTo;
    },
    [reduced, render, stopTurning],
  );

  const flip = useCallback(() => {
    if (!enabled || drag.current?.intent === "horizontal") return;
    if (turning.current != null) return;
    settle(turn.current.rest + 180);
  }, [enabled, settle]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled || drag.current != null || e.button !== 0) return;
      drag.current = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        intent: "undecided",
        basePos: turn.current.pos,
        baseX: e.clientX,
        lastPos: turn.current.pos,
        lastT: e.timeStamp,
        velocity: 0,
      };
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      const root = rootRef.current;
      if (d == null || e.pointerId !== d.id || root == null) return;
      if (d.intent === "undecided") {
        const intent = dragIntent(e.clientX - d.x0, e.clientY - d.y0);
        if (intent === "undecided") return;
        if (intent === "vertical") {
          // A vertical intent is the page's, not the card's.
          drag.current = null;
          return;
        }
        // The drag takes the card from wherever it is, mid-turn included.
        stopTurning();
        d.intent = "horizontal";
        d.basePos = turn.current.pos;
        d.baseX = e.clientX;
        d.lastPos = turn.current.pos;
        d.lastT = e.timeStamp;
        turn.current.rest = nearestRest(turn.current.pos);
        root.dataset["dragging"] = "1";
        root.setPointerCapture?.(e.pointerId);
      }
      const width = root.getBoundingClientRect().width;
      turn.current.pos = dragAngle(d.basePos, e.clientX - d.baseX, width);
      const dt = Math.max(1, e.timeStamp - d.lastT);
      d.velocity = (turn.current.pos - d.lastPos) / dt;
      d.lastPos = turn.current.pos;
      d.lastT = e.timeStamp;
      render();
    },
    [render, rootRef],
  );

  const release = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (d == null || e.pointerId !== d.id) return;
      drag.current = null;
      // A tap: the buttons on either face do the turning, and a turn already
      // under way carries on.
      if (d.intent !== "horizontal") return;
      const root = rootRef.current;
      if (root != null) delete root.dataset["dragging"];
      if (e.type !== "pointerup") {
        settle(turn.current.rest);
        return;
      }
      const target = releaseTargetFrom(d.basePos, {
        pos: turn.current.pos,
        velocity: d.velocity,
        sinceLastMove: e.timeStamp - d.lastT,
      });
      settle(target, Math.abs(target - turn.current.rest) > 180 ? power3Out : power2Out);
    },
    [rootRef, settle],
  );

  useEffect(() => {
    const body = bodyRef.current;
    return () => {
      stopTurning();
      if (body != null) body.style.transform = "";
    };
  }, [bodyRef, stopTurning]);

  return {
    flipped,
    qrMask: payload != null && built?.payload === payload ? built.url : null,
    flip,
    rootProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: release,
      onPointerCancel: release,
    },
  };
}
