// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { watchPageActivity } from "./page-lifecycle"

const EARLY_CAMERA_DENIAL_WINDOW_MS = 1_000
export const CAMERA_DENIAL_RECHECK_DELAY_MS = 1_000

let lastPageShownAt = Date.now()

/** The central foreground tracker reports explicit shows and silent freeze resumes. */
watchPageActivity((hidden) => {
  if (!hidden) lastPageShownAt = Date.now()
})

type CameraPermissionStatus = Pick<PermissionStatus, "state">

const queryCameraPermission = () =>
  navigator.permissions.query({ name: "camera" as PermissionName })

/**
 * Android can briefly report the stale, denied WebView permission while the
 * host is restoring a resumed page. Re-read that one transient answer once;
 * every other state and every later denial remains immediate.
 */
export async function readCameraPermissionState(
  query: () => Promise<CameraPermissionStatus> = queryCameraPermission,
  now: () => number = Date.now,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<CameraPermissionStatus> {
  const status = await query()
  if (status.state !== "denied" || now() - lastPageShownAt > EARLY_CAMERA_DENIAL_WINDOW_MS) {
    return status
  }
  await wait(CAMERA_DENIAL_RECHECK_DELAY_MS)
  return query()
}
