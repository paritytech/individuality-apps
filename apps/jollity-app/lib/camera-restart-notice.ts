// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** the words for a camera that stopped sending video and cannot be restarted from the page (#1338) */
export const CAMERA_RESTART_NOTICE = {
  eyebrow: "Camera problem",
  heading: "Restart the Polkadot app",
  body: "Your camera stopped sending video and can't be restarted from here. Close the Polkadot app fully (swipe it away) and open it again. Your place in the game is kept.",
} as const

export const CAMERA_TAP_NOTICE = {
  eyebrow: "Camera problem",
  button: "Turn your camera back on",
  body: "Your camera stopped sending video. Tap once to start it again.",
} as const

/** the notice, when recovery has given up; null otherwise */
export function cameraRestartNotice(gaveUp: boolean): typeof CAMERA_RESTART_NOTICE | null {
  return gaveUp ? CAMERA_RESTART_NOTICE : null
}
