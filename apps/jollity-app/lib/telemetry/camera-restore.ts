// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { CameraFailure } from "../webrtc/media"

export const CAMERA_RESTORE_KEYS = [
  "rtc.camera_restore_turn_shown",
  "rtc.camera_restore_dead_ms",
  "rtc.camera_restore_auto_retries",
  "rtc.camera_restore_tapped",
  "rtc.camera_restore_tap_ms",
  "rtc.camera_restore_end",
  "rtc.camera_restore_turn_end",
  "rtc.camera_restore_outcome",
  "rtc.camera_restore_first_frame_ms",
  "rtc.camera_restore_frames_5s",
  "rtc.camera_restore_error",
] as const

export const CAMERA_RESTORE_LITERALS = [
  "rtc.camera_restore",
  "recovered",
  "hidden",
  "game_end",
  "frames",
  "still_muted",
  "error",
  "denied",
  "no-camera",
  "busy",
  "timeout",
  "unknown",
] as const

type CameraRestoreEnd = "recovered" | "hidden" | "game_end"
type CameraRestoreOutcome = "frames" | "still_muted" | "error"

export interface CameraRestoreEvent {
  turnShown?: number
  deadMs: number
  autoRetries: number
  tapped: boolean
  tapMs?: number
  end?: CameraRestoreEnd
  turnEnd?: number
  outcome?: CameraRestoreOutcome
  firstFrameMs?: number
  frames5s?: number
  error?: CameraFailure
}

/** Typed scalar attributes for one rtc.camera_restore Logs record. */
export function cameraRestoreAttributes(event: CameraRestoreEvent): Record<string, string | number | boolean> {
  return {
    ...(event.turnShown === undefined ? {} : { "rtc.camera_restore_turn_shown": event.turnShown }),
    "rtc.camera_restore_dead_ms": event.deadMs,
    "rtc.camera_restore_auto_retries": event.autoRetries,
    "rtc.camera_restore_tapped": event.tapped,
    ...(event.tapMs === undefined ? {} : { "rtc.camera_restore_tap_ms": event.tapMs }),
    ...(event.end === undefined ? {} : { "rtc.camera_restore_end": event.end }),
    ...(event.turnEnd === undefined ? {} : { "rtc.camera_restore_turn_end": event.turnEnd }),
    ...(event.outcome === undefined ? {} : { "rtc.camera_restore_outcome": event.outcome }),
    ...(event.firstFrameMs === undefined ? {} : { "rtc.camera_restore_first_frame_ms": event.firstFrameMs }),
    ...(event.frames5s === undefined ? {} : { "rtc.camera_restore_frames_5s": event.frames5s }),
    ...(event.error === undefined ? {} : { "rtc.camera_restore_error": event.error }),
  }
}
