// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE DRAW LEFT WAITING MOVES ON BY ITSELF. The wheel (lib/draw/wheel/proto)
 * goes on only when the player taps, and a player who walks away has probably
 * put the app in the background, and would otherwise never reach the collectables screen.
 * After DRAW_IDLE_MS without a tap the host takes the player to the collectables screen.
 *
 * Framework-free (architecture rule 6): lib/draw/draw-screen-deps.ts wires
 * it. It does NOT mark the draw seen, so the chat card keeps offering what
 * the player missed, and the draw result is still there to open.
 *
 * The clock (docs/time-and-clocks.md rule 3): the elapsed time is the larger of
 * the monotonic clock and the device clock since the start. A hidden iOS page
 * freezes both its timers and `performance.now()`, so the device clock (which
 * keeps a forward move across a hidden page) tells how long the player was
 * away, and the check also runs when the page becomes visible again. The
 * start is stored as a device-clock stamp so a reload keeps counting (rule 4:
 * a coarse window, nothing about the game's phase).
 */

import { deviceNowMs } from "../device-clock"

export const DRAW_IDLE_MS = 60_000

export interface DrawIdleDeps {
  /** one draw: the stored start is kept per key */
  key: string
  onAdvance: () => void
  deviceNowMs: () => number
  monoNowMs: () => number
  store: { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void }
  /** a timer; returns its cancel */
  setTimer: (fn: () => void, ms: number) => () => void
  /** calls `fn` whenever the page becomes visible; returns its cancel */
  onVisible: (fn: () => void) => () => void
  /** true once the page is being unloaded (a reload): only then does detach() keep the stored start */
  unloading?: () => boolean
}

const PREFIX = "jollity.draw-idle."

export function createDrawIdle(deps: DrawIdleDeps) {
  const storeKey = PREFIX + deps.key
  let startDevice = 0
  let startMono = 0
  let cancelTimer: (() => void) | null = null
  let cancelVisible: (() => void) | null = null
  let running = false
  let done = false

  const elapsed = () => Math.max(deps.monoNowMs() - startMono, deps.deviceNowMs() - startDevice)

  const advance = () => {
    if (done) return
    done = true
    stop()
    deps.onAdvance()
  }
  const check = () => {
    if (!running || done) return
    const left = DRAW_IDLE_MS - elapsed()
    if (left <= 0) return advance()
    cancelTimer?.()
    cancelTimer = deps.setTimer(check, left)
  }
  const save = () => {
    try {
      deps.store.set(storeKey, String(startDevice))
    } catch {
      // no storage here: a reload then starts the 60 s again
    }
  }

  function detach() {
    running = false
    cancelTimer?.()
    cancelVisible?.()
    cancelTimer = cancelVisible = null
  }
  function stop() {
    detach()
    forget()
  }
  function forget() {
    try {
      deps.store.remove(storeKey)
    } catch {
      // nothing to clear
    }
  }

  return {
    /** the draw is tappable: count from now, or from the stored start after a reload */
    start() {
      if (running || done) return
      running = true
      startMono = deps.monoNowMs()
      startDevice = deps.deviceNowMs()
      try {
        const saved = Number(deps.store.get(storeKey))
        // a stamp in the future is not ours (a clock set back): start fresh
        if (Number.isFinite(saved) && saved > 0 && saved <= startDevice) startDevice = saved
      } catch {
        // no storage: start now
      }
      save()
      cancelVisible = deps.onVisible(check)
      check()
    },
    /** the player tapped: the 60 s start again */
    touch() {
      if (!running || done) return
      startMono = deps.monoNowMs()
      startDevice = deps.deviceNowMs()
      save()
      check()
    },
    /** the player is done with the draw: forget the stored start */
    stop,
    /** the page unmounts: a reload keeps the stored start, any other unmount forgets it (the next open is a fresh 60 s) */
    detach() {
      detach()
      if (!deps.unloading?.()) forget()
    },
  }
}

/** a tap anywhere in the container (capture, so the stage cannot swallow it) restarts the 60 s; returns its cancel */
export function touchOnPointerDown(
  host: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  idle: { touch(): void },
): () => void {
  const touch = () => idle.touch()
  host.addEventListener("pointerdown", touch, true)
  return () => host.removeEventListener("pointerdown", touch, true)
}

/** the idle watch on this page's real clocks, storage and visibility; its
 *  `detach` also takes back the window listeners it adds */
export function createBrowserDrawIdle(key: string, onAdvance: () => void) {
  let unloading = false
  const hide = () => (unloading = true)
  const show = () => (unloading = false)
  window.addEventListener("pagehide", hide)
  window.addEventListener("pageshow", show)
  const idle = createDrawIdle({
    key,
    unloading: () => unloading,
    onAdvance,
    deviceNowMs,
    monoNowMs: () => performance.now(),
    store: {
      get: (k) => sessionStorage.getItem(k),
      set: (k, v) => sessionStorage.setItem(k, v),
      remove: (k) => sessionStorage.removeItem(k),
    },
    setTimer: (fn, ms) => {
      const id = setTimeout(fn, ms)
      return () => clearTimeout(id)
    },
    onVisible: (fn) => {
      const on = () => {
        if (document.visibilityState === "visible") fn()
      }
      document.addEventListener("visibilitychange", on)
      return () => document.removeEventListener("visibilitychange", on)
    },
  })
  return {
    ...idle,
    detach() {
      idle.detach()
      window.removeEventListener("pagehide", hide)
      window.removeEventListener("pageshow", show)
    },
  }
}
