// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { pageHidden, watchPageActivity } from "./page-lifecycle"

export const CAMERA_FRAME_TIMEOUT_MS = 3_000
export const CAMERA_FPS_WINDOW_MS = 10_000

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export interface FrameObservation {
  stop(): void
}

export interface FrameObserverOptions {
  timeoutMs?: number
  windowMs?: number
  hidden?: () => boolean
  watchActivity?: (listener: (hidden: boolean, suspended: boolean) => void) => () => void
  now?: () => number
  onFirstFrame(elapsedVisibleMs: number): void
  onFrame?(frames: number, elapsedVisibleMs: number): void
  onWindow?(frames: number, elapsedVisibleMs: number): void
  onTimeout(): void
}

/** Observe frames presented by one real local video element. The timeout and
 *  fps windows advance only while the page is visible. rVFC is proof of a
 *  presented frame; older WebViews fall back to currentTime advancing. */
export function observeCameraFrames(video: HTMLVideoElement, options: FrameObserverOptions): FrameObservation {
  const el = video as FrameVideo
  const timeoutMs = options.timeoutMs ?? CAMERA_FRAME_TIMEOUT_MS
  const windowMs = options.windowMs ?? CAMERA_FPS_WINDOW_MS
  const hidden = options.hidden ?? pageHidden
  const now = options.now ?? (() => performance.now())
  const watchActivity = options.watchActivity ?? watchPageActivity
  let stopped = false
  let paused = hidden()
  let activeAt = paused ? 0 : now()
  let visibleMs = 0
  let first = false
  let frames = 0
  let frameHandle: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  let initialTime = Number.isFinite(el.currentTime) ? el.currentTime : 0
  const usesRvfc = typeof el.requestVideoFrameCallback === "function"

  const elapsed = () => visibleMs + (paused ? 0 : Math.max(0, now() - activeAt))
  const clearScheduled = () => {
    if (frameHandle !== undefined) el.cancelVideoFrameCallback?.(frameHandle)
    if (timer) clearTimeout(timer)
    if (poll) clearInterval(poll)
    frameHandle = undefined
    timer = undefined
    poll = undefined
  }
  const seen = () => {
    if (stopped || paused) return
    frames += 1
    options.onFrame?.(frames, elapsed())
    if (!first) {
      first = true
      const firstMs = elapsed()
      options.onFirstFrame(firstMs)
      if (timer) clearTimeout(timer)
      timer = undefined
      if (!usesRvfc) {
        if (poll) clearInterval(poll)
        poll = undefined
        return
      }
      visibleMs = 0
      activeAt = now()
      armTimer()
    }
  }
  const armFrame = () => {
    if (stopped || paused) return
    if (usesRvfc) {
      const loop: VideoFrameRequestCallback = () => {
        frameHandle = undefined
        seen()
        armFrame()
      }
      frameHandle = el.requestVideoFrameCallback(loop)
    } else {
      poll = setInterval(() => {
        const current = el.currentTime
        if (Number.isFinite(current) && current > initialTime + 0.0001) {
          initialTime = current
          seen()
        }
      }, 100)
    }
  }
  const armTimer = () => {
    if (stopped || paused) return
    const remaining = (first ? windowMs : timeoutMs) - elapsed()
    timer = setTimeout(() => {
      timer = undefined
      if (stopped || paused) return
      if (!first) {
        options.onTimeout()
        return
      }
      const took = windowMs
      options.onWindow?.(frames, took)
      frames = 0
      activeAt = now()
      visibleMs = 0
      armTimer()
    }, Math.max(0, remaining))
  }
  const pause = () => {
    if (stopped || paused) return
    const ran = Math.max(0, now() - activeAt)
    visibleMs += ran
    paused = true
    clearScheduled()
  }
  const resume = (restart = false) => {
    if (stopped || hidden()) return
    if (!paused && !restart) return
    clearScheduled()
    paused = false
    // A returning WebView, or one whose foreground ticker just observed a
    // silent suspension, gets a fresh visible budget. Charging the time from
    // before the interruption made iOS reopen a camera while it was waking.
    visibleMs = 0
    activeAt = now()
    armFrame()
    armTimer()
  }
  const unwatch = watchActivity((isHidden, suspended) => {
    if (isHidden) pause()
    else resume(suspended)
  })
  if (!paused) {
    armFrame()
    armTimer()
  }
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearScheduled()
      unwatch()
    },
  }
}
