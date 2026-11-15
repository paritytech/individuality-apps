// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE rAF. One per page: it owns the clock and nothing else — the elapsed
   time, a dt clamped so a backgrounded tab cannot deliver a two-second step,
   the fps counter, and the frame the scene draws. What happens inside a frame,
   and in what order, is the scene's (scenes/sphere/frame.js). */

export function createLoop({ stats = { fps: 0 }, onFrame = null } = {}) {
  let raf = 0
  let last = 0
  let t0 = 0
  let frames = 0
  let fpsClock = 0
  let held = 0 // JOLLITY: when the clock was held (performance.now ms); 0 while it runs
  let heldFor = 0 // JOLLITY: ms it has spent held, taken off its time
  let frameT = 0 // s, the clock the last frame was drawn at (the picture on screen is at this time)

  function tick(now) {
    raf = requestAnimationFrame(tick)
    if (!t0) {
      t0 = now
      last = now
      if (held) held = now // JOLLITY: held before its first frame: from that frame
    }
    const dt = Math.min(0.05, Math.max(0.0005, (now - last) / 1000))
    last = now
    const t = ((held || now) - t0 - heldFor) / 1000 // JOLLITY: a held clock stands still
    frameT = t

    loop.onFrame?.(t, dt)

    frames++
    fpsClock += dt
    if (fpsClock >= 1) {
      stats.fps = Math.round(frames / fpsClock)
      frames = 0
      fpsClock = 0
    }
  }

  const loop = {
    onFrame,
    start() {
      if (!raf) raf = requestAnimationFrame(tick)
    },
    stop() {
      cancelAnimationFrame(raf)
      raf = 0
    },
    /* JOLLITY: the clock held where it is, and let go again from there */
    hold() {
      if (!held) held = performance.now()
    },
    release() {
      if (!held) return
      if (t0) heldFor += performance.now() - held
      held = 0
    },
    get time() {
      return t0 ? ((held || performance.now()) - t0 - heldFor) / 1000 : 0 // JOLLITY: 0 until the first frame, not the page's age; still while held
    },
    /* the last frame's t: what is on screen is at this clock, not at `time` — a
       hit-test against what a person sees (orbiting: the click) reads this */
    get frameTime() {
      return frameT
    },
  }
  return loop
}
