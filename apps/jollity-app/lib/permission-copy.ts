// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PermissionId, PermissionRowState } from "./permissions"

/** Canonical copy for terminal camera failures on the one-time permission gate. */
export const CAMERA_PERMISSION_COPY = {
  denied: { row: "Denied" },
  blocked: { row: "Blocked" },
  "no-camera": { row: "No camera found" },
} as const

/** The camera line for a refusal and for a block alike.
 *
 * The host stores a refusal of its own prompt for the product (record_decision
 * in the permissions.rs of truapi) and iOS keeps its own answer for the
 * Polkadot app, so after a refusal every later ask answers no without a
 * prompt, and only Settings turns the camera back on. */
export const CAMERA_OFF_LINE = "Turn on the camera for the Polkadot app in Settings, then come back."
export const CAMERA_BUSY_LINE = "Another app is using the camera. Close it and come back."
export const NO_CAMERA_LINE = "No camera was found on this device. The game is played on camera, so it needs one to run."
/** The wording of the hosts themselves, whose failure lines open with
 * "Something went wrong." and whose old-version line is "Please update the app." */
export const HOST_FAILED_LINE = "Something went wrong. Please update the Polkadot app."
export const REFUSED_LINE = "Jollity can't run without it. Turn it on in Settings, then come back."

/** What stands between the player and the game, phrased as what to do. */
export function guidanceFor(states: Record<PermissionId, PermissionRowState>): string {
  const camera = states.camera
  if (camera.kind === "denied") {
    if (camera.reason === "denied" || camera.reason === "blocked") return CAMERA_OFF_LINE
    if (camera.reason === "busy") return CAMERA_BUSY_LINE
    if (camera.reason === "no-camera") return NO_CAMERA_LINE
  }
  const hostFailed = Object.values(states).some(
    (state) => state.kind === "denied" && (state.reason === "host-error" || state.reason === "timeout"),
  )
  return hostFailed ? HOST_FAILED_LINE : REFUSED_LINE
}
