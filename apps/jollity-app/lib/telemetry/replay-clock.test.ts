// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { captureReplayObservation } from "./replay-capture"
import { captureReplayClock, createReplayClockAnchorCapture, replayClockReceipt } from "./replay-clock"

vi.mock("./replay-capture", () => ({ captureReplayObservation: vi.fn() }))

beforeEach(() => { vi.mocked(captureReplayObservation).mockReset() })

describe("passive replay clock evidence", () => {
  it("keeps the source's device sample distinct from wall and monotonic receipt readings", () => {
    const receipt = replayClockReceipt(1234)
    expect(receipt).toMatchObject({ deviceMs: 1234, sampling: "sequential-callback-samples" })
    expect(typeof receipt.wallMs).toBe("number")
    expect(typeof receipt.monotonicMs).toBe("number")
    captureReplayClock("clock-anchor", { receipt, blockTimestampS: 10 })
    expect(captureReplayObservation).toHaveBeenCalledWith("clock-anchor", expect.objectContaining({
      receipt,
      rules: expect.objectContaining({ version: 3, offsetUnit: "millisecond", deliveryLatency: "unknown", alignmentUncertainty: "not-measured" }),
    }))
  })

  it("never propagates a capture sink failure", () => {
    vi.mocked(captureReplayObservation).mockImplementation(() => { throw new Error("broken sink") })
    expect(() => captureReplayClock("clock-decision", {})).not.toThrow()
  })

  it("keeps active-game receipts complete but captures unchanged pregame anchors every 30 seconds", () => {
    const capture = createReplayClockAnchorCapture()
    const evidence = { beforeOffsetMs: 0, afterOffsetMs: 0 }
    for (let t = 0; t <= 60_000; t += 6000) capture(evidence, t, false, { game: 1, method: "none" })
    expect(captureReplayObservation).toHaveBeenCalledTimes(3)
    vi.mocked(captureReplayObservation).mockClear()
    for (let t = 66_000; t <= 120_000; t += 6000) capture(evidence, t, true, { game: 1, method: "none" })
    expect(captureReplayObservation).toHaveBeenCalledTimes(10)
  })

  it("captures corrections and state changes immediately between pregame periodic receipts", () => {
    const capture = createReplayClockAnchorCapture()
    capture({ beforeOffsetMs: 0, afterOffsetMs: 0 }, 0, false, { method: "none" })
    capture({ beforeOffsetMs: 0, afterOffsetMs: 2000 }, 6000, false, { method: "none" })
    capture({ beforeOffsetMs: 2000, afterOffsetMs: 2000 }, 12_000, false, { method: "peer" })
    expect(captureReplayObservation).toHaveBeenCalledTimes(3)
  })
})
