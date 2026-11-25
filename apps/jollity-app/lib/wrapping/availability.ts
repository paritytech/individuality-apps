// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Part of the wrapping effect: its names are Wrapping*, except the shader exports (SHELL_*).
// Can this screen actually draw wrappings?
//
// The answer must be available OUTSIDE the lazy GL chunk. The chest scene
// (components/chest/chest-scene.tsx) and the Pocket's scene
// (lib/pocket/scene.ts) decide from it whether to import
// `WrappingRenderer` at all, and the chest decides at the same moment whether
// its flat sprites show the art or leave it to the wrapping, so both need the
// answer synchronously. Nothing here imports the renderer.
//
// Reduced motion does not turn the wrapping off. The renderer can freeze the
// sway per entry (`WrappingDrawEntry.still`); the chest does not use it yet.
//
// The unavailable latch is ONE-WAY. Recovery would need a full screen remount,
// so once the wrapping is gone for a session it stays gone. A flickering broken
// canvas is worse than the flat art.

let unavailable = false

/**
 * Cached, because a probe context is not free — but ONLY WHEN IT SUCCEEDS.
 *
 * A negative is not cached, because it can change: the probe runs the first
 * time anything asks, which is during a screen's first render, and a GPU
 * process that is not up yet answers no. Caching that answer would disable the
 * effect for the whole session. An embedded browser whose compositor starts
 * late shows this; a host WebView cold-starting is the same shape of risk.
 *
 * So a failure is left uncached and simply re-probed on the next ask. A
 * genuinely unsupported browser pays a handful of cheap failed getContext
 * calls; one that was merely slow recovers. The one-way `unavailable` latch is
 * still the thing that stops retrying for real (a lost context, a failed
 * compile) — that is a fact about this session, this is not.
 */
let webglOk: true | null = null

function webglSupported(): boolean {
  if (webglOk !== null) return webglOk
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl')
    // Hand the probe context straight back. Browsers cap live contexts at
    // around sixteen, and the chest screen runs other canvases too.
    const lose = gl && (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')
    if (lose) lose.loseContext()
    if (!gl) return false
    webglOk = true
    return true
  } catch {
    return false
  }
}

/** Latch the wrapping off for the rest of the session. Called on a lost WebGL
 *  context, on a failed lazy import and on a failed compile — all three mean
 *  the remaining items must keep their flat art. */
export function markWrappingUnavailable(reason: string): void {
  if (unavailable) return
  unavailable = true
  console.warn(`[wrapping] wrappings disabled (${reason}) — the art falls back to a static blur`)
}

/** True when this screen will mount the wrapping canvas. The canvas host and the
 *  flat sprites must never disagree: a sprite that waits for a canvas nobody
 *  mounts shows the raw art. */
export function wrappingExpected(): boolean {
  return !unavailable && webglSupported()
}
