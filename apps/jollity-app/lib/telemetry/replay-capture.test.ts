// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ log: vi.fn(), game: null as number | null, fail: false, sample: vi.fn() }))
vi.mock("../debug/log-store", () => ({ devLog: mocks.log }))
vi.mock("../debug/flag", () => ({ DEBUG_LOGS: true, APP_VERSION: "captured-build", BUILD_COMMIT: "jollity-build-commit:abc" }))
vi.mock("../debug/session-id", () => ({ SESSION_ID: "phone-page" }))
vi.mock("../device-clock", () => ({ deviceNowMs: mocks.sample }))
vi.mock("../chain-clock", () => ({ chainNowMs: mocks.sample, readChainClock: () => { if (mocks.fail) throw new Error("clock gone"); return mocks.game === null ? null : { offset: mocks.game, block: 123 } } }))
import { captureReplayObservation } from "./replay-capture"

beforeEach(() => { mocks.log.mockReset(); mocks.sample.mockReset(); mocks.game = null; mocks.fail = false })
describe("passive replay capture envelope", () => {
  it("bounds live-game floating tails before JSON serialization without mutating source readings", () => {
    const payload = {
      derivedFps: 14.999999999999998,
      monotonicGapMs: 54.39999999999999,
      sampleTimestampMs: 1792413691511.744,
      nested: { jitter: 0.123456789012345, offsets: [-7.123456789012345, 0, null] },
      missing: Number.NaN,
      peerId: "player-123456789012345",
    }
    const original = structuredClone(payload)
    const now = vi.spyOn(performance, "now").mockReturnValue(39932.399999999994)
    try {
      captureReplayObservation("receiver-quality", payload)
      const value = mocks.log.mock.calls[0][2]
      expect(value).toMatchObject({ numericFractionDigits: 3, timing: { monotonicMs: 39932.4 } })
      expect(value.observation).toEqual({
        derivedFps: 15, monotonicGapMs: 54.4, sampleTimestampMs: 1792413691511.744,
        nested: { jitter: 0.123, offsets: [-7.123, 0, null] }, missing: null,
        peerId: payload.peerId,
      })
      // The real game953 failures were long fractional digit runs scrubbed
      // into unquoted stars. Keep this numeric pattern out of the wire text.
      const wire = JSON.stringify(value)
      expect(wire).not.toMatch(/\d\.\d{4,}/)
      expect(JSON.parse(wire)).toEqual(value)
      expect(payload).toEqual(original)
      expect(mocks.sample).not.toHaveBeenCalled()
    } finally { now.mockRestore() }
  })
  it("retains raw domains, build and session without manufacturing alignment before a clock exists", () => {
    captureReplayObservation("game.snapshot", { game: 259, turn: 2 })
    const [tag, kind, value] = mocks.log.mock.calls[0]
    expect([tag, kind]).toEqual(["replay", "game.snapshot"])
    expect(value).toMatchObject({ schemaVersion: 1, sessionId: "phone-page", buildCommit: "jollity-build-commit:abc", observation: { game: 259, turn: 2 }, timing: { offsetMs: null, lastBlock: null, alignment: "unmeasured" } })
    expect(mocks.sample).not.toHaveBeenCalled()
    expect(value.timing.monotonicMs).toEqual(expect.any(Number))
    expect(value.timing.wallMs).toEqual(expect.any(Number))
  })
  it("records the game estimate independently and keeps a sequence despite a backwards wall step", () => {
    mocks.game = 2
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(5000).mockReturnValue(4000)
    try {
      captureReplayObservation("clock.anchor", {})
      captureReplayObservation("receiver.quality", {})
      const a = mocks.log.mock.calls[0][2], b = mocks.log.mock.calls[1][2]
      expect(b.sequence).toBe(a.sequence + 1)
      expect(b.timing.wallMs).toBeLessThan(a.timing.wallMs)
      expect(b.timing).toMatchObject({ offsetMs: 2000, offsetDomain: "published-wall-relative", lastBlock: 123, alignment: "unmeasured" })
      expect(mocks.sample).not.toHaveBeenCalled()
    } finally { now.mockRestore() }
  })
  it("does not emit nonfinite clock readings as factual zeroes", () => {
    mocks.game = Number.NaN
    captureReplayObservation("clock.anchor", {})
    expect(mocks.log.mock.calls[0][2].timing.offsetMs).toBeNull()
  })
})
