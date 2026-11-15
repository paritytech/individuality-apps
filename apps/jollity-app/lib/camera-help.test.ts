// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"

vi.mock("./camera", () => ({
  useCamera: vi.fn(),
}))
vi.mock("./joined", () => ({ handoverAt: (gameAt: number) => gameAt - 66 }))

const { cameraHelp, warmUpAt, WARM_UP_LEAD_S, WARM_UP_SPREAD_S } = await import("./camera-help")

describe("the waiting room's camera help (#226)", () => {
  it("has nothing to say about a camera that has not failed", () => {
    expect(cameraHelp(null, false)).toBeNull()
  })

  it.each(["timeout", "unknown", "no-camera", "busy", "denied"] as const)("on %s offers nothing to tap", (reason) => {
    expect(cameraHelp(reason, false)).toEqual({ reason, starting: false })
  })

  it("carries whether the handover is due", () => {
    expect(cameraHelp("timeout", true)).toMatchObject({ starting: true })
  })
})

describe("the staggered warm-up", () => {
  const accounts = Array.from({ length: 200 }, (_, i) => `5Account${i}xyz`)

  it("starts every player within the spread after T-2:30", () => {
    for (const account of accounts) {
      const offset = warmUpAt(10_000, account) - (10_000 - WARM_UP_LEAD_S)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThanOrEqual(WARM_UP_SPREAD_S)
      expect(Number.isInteger(offset)).toBe(true)
    }
  })

  it("is the same for one account every time, and spreads a group out", () => {
    expect(warmUpAt(10_000, accounts[7])).toBe(warmUpAt(10_000, accounts[7]))
    const starts = new Set(accounts.map((account) => warmUpAt(10_000, account)))
    expect(starts.size).toBeGreaterThan(15)
  })

  it("starts at T-2:30 without an account", () => {
    expect(warmUpAt(10_000, undefined)).toBe(10_000 - WARM_UP_LEAD_S)
  })
})
