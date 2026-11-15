// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { HOST_ONLY_GATHER_DWELL_MS, NoUsableNetworkPathGate, noUsableNetworkPath } from "./path-health"
import type { PeerReport } from "./mesh"

const row = (overrides: Partial<PeerReport> = {}): PeerReport => ({
  id: "peer",
  away: false,
  conn: "failed",
  ice: "failed",
  gather: "complete",
  sig: "stable",
  send: [],
  recv: [],
  gathered: {
    counts: { host: 1, srflx: 0, relay: 0, other: 0 },
    ms: 10,
    errors: [],
  },
  ...overrides,
})

describe("noUsableNetworkPath", () => {
  it("accepts host-only evidence while gathering is still in progress", () => {
    expect(noUsableNetworkPath([row()])).toBe(true)
    expect(noUsableNetworkPath([row({ gather: "gathering" })])).toBe(true)
  })

  it("requires observed candidates on every disconnected peer", () => {
    expect(noUsableNetworkPath([])).toBe(false)
    expect(noUsableNetworkPath([row({ conn: "connected" })])).toBe(false)
    expect(noUsableNetworkPath([row({ gather: "new" })])).toBe(false)
    expect(noUsableNetworkPath([row({ gathered: undefined })])).toBe(false)
    expect(
      noUsableNetworkPath([
        row(),
        row({
          id: "still-empty",
          gather: "gathering",
          gathered: { counts: { host: 0, srflx: 0, relay: 0, other: 0 }, errors: [] },
        }),
      ]),
    ).toBe(false)
  })

  it("clears host-only blame as soon as STUN or TURN finds another candidate", () => {
    expect(
      noUsableNetworkPath([
        row({ gather: "gathering", gathered: { counts: { host: 1, srflx: 1, relay: 0, other: 0 }, errors: [] } }),
      ]),
    ).toBe(false)
    expect(
      noUsableNetworkPath([
        row({ gather: "gathering", gathered: { counts: { host: 1, srflx: 0, relay: 1, other: 0 }, errors: [] } }),
      ]),
    ).toBe(false)
    expect(
      noUsableNetworkPath([row({ gathered: { counts: { host: 1, srflx: 0, relay: 0, other: 1 }, errors: [] } })]),
    ).toBe(false)
  })
})

describe("NoUsableNetworkPathGate", () => {
  it("never opens when a normal gather finds srflx after its first host candidate", () => {
    const gate = new NoUsableNetworkPathGate()
    const gathering = row({ gather: "gathering" })
    const withSrflx = row({
      gather: "gathering",
      gathered: { counts: { host: 1, srflx: 1, relay: 0, other: 0 }, errors: [] },
    })

    expect(gate.update([gathering], 0)).toBe(false)
    expect(gate.update([withSrflx], 1_000)).toBe(false)
    expect(gate.update([withSrflx], 10_000)).toBe(false)
  })

  it("opens after host-only gathering persists beyond the dwell", () => {
    const gate = new NoUsableNetworkPathGate()
    const gathering = row({ gather: "gathering" })

    expect(gate.update([gathering], 0)).toBe(false)
    expect(gate.update([gathering], HOST_ONLY_GATHER_DWELL_MS - 1)).toBe(false)
    expect(gate.update([gathering], 10_000)).toBe(true)
  })

  it("does not treat one completed peer as completed gathering for all peers", () => {
    const gate = new NoUsableNetworkPathGate()
    expect(gate.update([row({ id: "done" }), row({ id: "pending", gather: "gathering" })], 0)).toBe(false)
    expect(gate.update([row({ id: "done" }), row({ id: "pending", gather: "gathering" })], HOST_ONLY_GATHER_DWELL_MS)).toBe(true)
  })

  it("keeps completed host-only gathering as immediate conclusive proof", () => {
    expect(new NoUsableNetworkPathGate().update([row()], 0)).toBe(true)
  })
})
