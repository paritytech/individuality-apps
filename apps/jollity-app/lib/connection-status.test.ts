// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { connectionStatus } from "./connection-status"
import type { PathProbe } from "./webrtc/path-mode"

const probe = (mode: PathProbe["mode"]): PathProbe => ({ mode, nat: "unknown", udp: mode === "direct", relayProtocols: [], candidates: { host: 1, srflx: 0, relay: 0 }, gatherMs: 0, at: 0 })
const rounds = [
  ["a", "b"],
  ["c", "d"],
]

describe("the connecting phase as the player reads it", () => {
  it("checks the network before anything is up", () => {
    const s = connectionStatus({ probe: null, checking: true, links: [], rounds })
    expect(s).toEqual({ network: "checking", connected: 0, expected: 4, quality: null, checking: true })
  })

  it("counts the links up to the co-players of every round, and reads relay when every link is relayed", () => {
    const s = connectionStatus({
      probe: probe("relay"),
      checking: false,
      links: [
        { id: "a", conn: "connected", path: "relay" },
        { id: "b", conn: "connecting", path: "unknown" },
        { id: "c", conn: "connected", path: "relay" },
        { id: "z", conn: "connected", path: "relay" },
      ],
      rounds,
    })
    expect(s).toMatchObject({ network: "relay", connected: 2, expected: 4, checking: false })
  })

  it("is ready when every co-player of every round is up, and counts a player in two rounds once", () => {
    const s = connectionStatus({
      probe: probe("direct"),
      checking: false,
      links: ["a", "b", "c"].map((id) => ({ id, conn: "connected" as const, path: "direct" as const })),
      rounds: [
        ["a", "b"],
        ["b", "c"],
      ],
    })
    expect(s).toMatchObject({ network: "direct", connected: 3, expected: 3 })
  })

  it("reads a blocked network", () => {
    const s = connectionStatus({ probe: probe("blocked"), checking: false, links: [], rounds })
    expect(s).toMatchObject({ network: "blocked", connected: 0 })
  })

  it.each([
    [80, 4],
    [149, 4],
    [150, 3],
    [299, 3],
    [300, 2],
    [599, 2],
    [600, 1],
  ] as const)("reads the slowest round trip of %i ms as %i bars", (rttMs, bars) => {
    const s = connectionStatus({
      probe: probe("direct"),
      checking: false,
      links: [
        { id: "a", conn: "connected", path: "direct", rttMs: 40 },
        { id: "b", conn: "connected", path: "direct", rttMs },
      ],
      rounds,
    })
    expect(s.quality).toBe(bars)
  })

  it("measures only the links that are up to a co-player", () => {
    const s = connectionStatus({
      probe: probe("direct"),
      checking: false,
      links: [
        { id: "a", conn: "connected", path: "direct", rttMs: 90 },
        { id: "b", conn: "connecting", path: "unknown", rttMs: 900 },
        { id: "z", conn: "connected", path: "direct", rttMs: 900 },
      ],
      rounds,
    })
    expect(s.quality).toBe(4)
  })

  it("has no quality with no round trip measured", () => {
    const s = connectionStatus({ probe: probe("direct"), checking: false, links: [{ id: "a", conn: "connected", path: "direct" }], rounds })
    expect(s.quality).toBeNull()
  })
})
