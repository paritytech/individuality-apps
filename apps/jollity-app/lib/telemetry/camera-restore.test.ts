// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { cameraRestoreAttributes } from "./camera-restore"

describe("camera restore Logs attributes", () => {
  it.each([
    ["frames", { outcome: "frames", firstFrameMs: 120, frames5s: 96 }],
    ["still_muted", { outcome: "still_muted", frames5s: 0 }],
    ["error", { outcome: "error", error: "busy" }],
  ] as const)("keeps typed fields for %s", (_name, success) => {
    const attributes = cameraRestoreAttributes({
      turnShown: 4,
      deadMs: 9_750,
      autoRetries: 3,
      tapped: true,
      tapMs: 840,
      ...success,
    })

    expect(attributes).toMatchObject({
      "rtc.camera_restore_turn_shown": 4,
      "rtc.camera_restore_dead_ms": 9_750,
      "rtc.camera_restore_auto_retries": 3,
      "rtc.camera_restore_tapped": true,
      "rtc.camera_restore_tap_ms": 840,
      "rtc.camera_restore_outcome": success.outcome,
    })
    expect(typeof attributes["rtc.camera_restore_turn_shown"]).toBe("number")
    expect(typeof attributes["rtc.camera_restore_dead_ms"]).toBe("number")
    expect(typeof attributes["rtc.camera_restore_auto_retries"]).toBe("number")
    expect(typeof attributes["rtc.camera_restore_tapped"]).toBe("boolean")
  })

  it("records an untapped end without inapplicable tap fields", () => {
    expect(cameraRestoreAttributes({
      deadMs: 12_000,
      autoRetries: 4,
      tapped: false,
      end: "hidden",
      turnEnd: 5,
    })).toEqual({
      "rtc.camera_restore_dead_ms": 12_000,
      "rtc.camera_restore_auto_retries": 4,
      "rtc.camera_restore_tapped": false,
      "rtc.camera_restore_end": "hidden",
      "rtc.camera_restore_turn_end": 5,
    })
  })
})
