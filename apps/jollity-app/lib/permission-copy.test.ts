// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { DenialReason, PermissionId, PermissionRowState } from "./permissions"
import {
  CAMERA_BUSY_LINE,
  CAMERA_OFF_LINE,
  HOST_FAILED_LINE,
  NO_CAMERA_LINE,
  REFUSED_LINE,
  guidanceFor,
} from "./permission-copy"

const granted: PermissionRowState = { kind: "granted" }

function rows(failed: Partial<Record<PermissionId, DenialReason>>): Record<PermissionId, PermissionRowState> {
  const all: Record<PermissionId, PermissionRowState> = { camera: granted, network: granted, webrtc: granted, statements: granted }
  for (const [id, reason] of Object.entries(failed)) all[id as PermissionId] = { kind: "denied", reason: reason! }
  return all
}

describe("the line under a failed permission pass", () => {
  it.each([
    ["denied", CAMERA_OFF_LINE],
    ["blocked", CAMERA_OFF_LINE],
    ["busy", CAMERA_BUSY_LINE],
    ["no-camera", NO_CAMERA_LINE],
    ["host-error", HOST_FAILED_LINE],
    ["timeout", HOST_FAILED_LINE],
  ] as const)("a camera %s reads its own line", (reason, line) => {
    expect(guidanceFor(rows({ camera: reason }))).toBe(line)
  })

  it("puts the camera first when another row failed too", () => {
    expect(guidanceFor(rows({ camera: "denied", statements: "host-error" }))).toBe(CAMERA_OFF_LINE)
  })

  it.each(["host-error", "timeout"] as const)("asks for an update when a host call gave %s", (reason) => {
    expect(guidanceFor(rows({ statements: reason }))).toBe(HOST_FAILED_LINE)
  })

  it("asks for an update over a refusal of another row", () => {
    expect(guidanceFor(rows({ network: "denied", webrtc: "host-error" }))).toBe(HOST_FAILED_LINE)
  })

  it("sends a refusal of another row to a reopen", () => {
    expect(guidanceFor(rows({ network: "denied" }))).toBe(REFUSED_LINE)
  })

  it.each([CAMERA_OFF_LINE, CAMERA_BUSY_LINE, NO_CAMERA_LINE, HOST_FAILED_LINE, REFUSED_LINE])(
    "never offers a retry: %s",
    (line) => {
      expect(line.toLowerCase()).not.toContain("try again")
    },
  )
})
