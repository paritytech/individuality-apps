// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { iceServerCounts } from "./turn-diagnostics"

describe("TURN diagnostic truth", () => {
  it("counts only server entries and exposes no URL or credential", () => {
    expect(iceServerCounts({
      iceServers: [
        { urls: ["stun:one.example", "stun:two.example"] },
        { urls: ["turn:relay.example", "turns:relay.example"], username: "secret", credential: "secret" },
      ],
    })).toEqual({ total: 2, turn: 1 })
  })
})
