// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

describe("legacy decision runtime wiring", () => {
  it("pins the room setup observer to every existing useMesh lifecycle boundary", () => {
    const useMesh = source("./webrtc/useMesh.ts")
    const events = [
      'event: "room-open-requested"',
      'event: "camera-ready"',
      'event: "ice-ready"',
      'event: "room-opened"',
      'event: "room-closed"',
    ]
    const offsets = events.map((event) => useMesh.indexOf(event))

    expect(offsets.every((offset) => offset >= 0)).toBe(true)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
    expect(useMesh).toContain("decisionRoomEpoch: lifecycleGeneration")
  })

})
