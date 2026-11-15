// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { formatCameraStatus } from "./camera-status"
import type { CameraDiagnosticSnapshot } from "./camera-diagnostics"

describe("camera debug status", () => {
  it("shows the useful live state without raw device or track identifiers", () => {
    const snapshot: CameraDiagnosticSnapshot = {
      streamId: "c2", openedAt: 1, generation: 2, lastEvent: "self.first_frame",
      track: { readyState: "live", muted: false, enabled: true, width: 480, height: 480, frameRate: 24, deviceHash: "d-private" },
      self: { checkpoint: "join", attached: "c2", stale: false, play: "resolved", fps: 23.5 },
      outbound: { links: 4, fps: 22, limitation: "none" }, trail: [],
    }
    const status = formatCameraStatus(snapshot, 1_001)
    expect(status).toContain("camera c2 · age:1000ms · live · 480×480@24 · self:join/current/resolved/23.5fps · out:4/22.0fps/none")
    expect(status).not.toContain("d-private")
  })
})
