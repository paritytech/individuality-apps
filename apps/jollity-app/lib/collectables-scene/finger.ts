// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE GHOST FINGER: the hints' (./hints) way of showing a tap. It comes in from
 * below and to the side, presses with a ripple and goes, on a target it follows
 * while it plays (a piece still settling, the bubble or a piece breathing), and
 * runs the hint's own effect on the press (the bubble's breath, a piece's
 * rock). With reduced motion it only fades in and out on its target, and the
 * press does nothing.
 *
 * Framework-free (architecture rule 6): the component
 * (components/collectables/collectables-scene) renders the three elements, an
 * anchor holding the ripple and the finger, and hands them here.
 */

/** where a hint taps, in the anchor's own px (the canvas's); null while it is not on the screen */
export type FingerTarget = () => { x: number; y: number } | null

export interface Finger {
  /** play one hint on `target`; `onPress` runs as the finger presses */
  play(target: FingerTarget, onPress: () => void): void
  /** stop one under way at once: no fade, no press */
  stop(): void
}

/** how long one showing lasts, ms */
export const FINGER_MS = 1500
/** how far through it the finger presses */
export const FINGER_PRESS_AT = 0.48
/** where it comes in from, px off its target */
const FROM: readonly [number, number] = [34, 46]

export function createFinger(els: { anchor: HTMLElement; finger: HTMLElement; ripple: HTMLElement }): Finger {
  let follow = 0
  let press: ReturnType<typeof setTimeout> | null = null
  const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

  const stop = () => {
    if (press) clearTimeout(press)
    press = null
    cancelAnimationFrame(follow)
    for (const el of [els.finger, els.ripple]) el.getAnimations().forEach((running) => running.cancel())
  }

  const play = (target: FingerTarget, onPress: () => void) => {
    stop()
    if (!target()) return
    const track = () => {
      const at = target()
      if (at) els.anchor.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`
      follow = requestAnimationFrame(track)
    }
    track()
    const done = () => cancelAnimationFrame(follow)
    if (still()) {
      els.finger.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: FINGER_MS }).onfinish =
        done
      return
    }
    const from = `translate(${FROM[0]}px, ${FROM[1]}px)`
    // each step its own easing: one curve over the whole would pull the press (and the fade) forward
    els.finger.animate(
      [
        { transform: `${from} scale(1)`, opacity: 0, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
        { transform: "translate(0, 0) scale(1)", opacity: 1, offset: FINGER_PRESS_AT - 0.1, easing: "ease-in" },
        { transform: "translate(0, 0) scale(0.78)", opacity: 1, offset: FINGER_PRESS_AT, easing: "ease-out" },
        { transform: "translate(0, 0) scale(1)", opacity: 1, offset: FINGER_PRESS_AT + 0.14, easing: "ease-in" },
        { transform: "translate(0, 0) scale(1)", opacity: 0 },
      ],
      { duration: FINGER_MS },
    ).onfinish = done
    els.ripple.animate(
      [
        { transform: "scale(0.4)", opacity: 0 },
        { transform: "scale(0.4)", opacity: 0.6, offset: FINGER_PRESS_AT, easing: "ease-out" },
        { transform: "scale(1.9)", opacity: 0 },
      ],
      { duration: FINGER_MS },
    )
    press = setTimeout(() => {
      press = null
      onPress()
    }, FINGER_MS * FINGER_PRESS_AT)
  }

  return { play, stop }
}
