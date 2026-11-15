// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { emptyReason } from "./chest-reason"

describe("why an empty chest is empty", () => {
  it("is a missed report when the chain holds a player row with no report, and no attendance", () => {
    expect(emptyReason({ attended: false, reportSent: false })).toBe("report-missed")
  })
  it("is no attestations when the player attended", () => {
    expect(emptyReason({ attended: true, reportSent: false })).toBe("no-attestations")
  })
  it("is absent when the chain shows neither a report nor a player row", () => {
    expect(emptyReason({ attended: false })).toBe("absent")
    expect(emptyReason({ attended: false, reportSent: true })).toBe("absent")
    expect(emptyReason({})).toBe("absent")
  })
})
