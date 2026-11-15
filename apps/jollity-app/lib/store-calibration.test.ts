// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { StatementStoreLike, StoreCalibration } from "@jollity/statement-core"
import { resetChainClockForTests, setChainNow } from "./chain-clock"
import { resetDeviceClockForTests } from "./device-clock"
import { resetStoreClockForTests, storeClock } from "./store-clock"
import {
  CALIBRATION_TIMEOUT_MS,
  createStoreCalibrationState,
  storeCalibrationStep,
  storeCalibrator,
} from "./store-calibration"

vi.mock("./journeys/game-trace", () => ({ storeCalibrated: () => {}, storeClockEvent: () => {} }))

const T = 1_800_000_000_000

/** a node whose clock is `ahead` ms past the chain's */
function node(ahead: number, refuse?: string) {
  const submits: bigint[] = []
  const store: StatementStoreLike = {
    createProofAuthorized: async () => "proof",
    submit: async (wire) => {
      submits.push(wire.expiry)
      if (refuse) throw new Error(refuse)
      if (Math.floor((Date.now() + ahead) / 1000) >= Number(wire.expiry >> 32n))
        throw new Error(`statement_submit not accepted: {"reason":"alreadyExpired","status":"invalid"}`)
    },
    subscribe: () => ({}),
  }
  return { store, submits }
}

beforeEach(() => {
  const session = new Map<string, string>() // the page's saved store clock, fresh per test
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => void session.set(key, value),
  })
  vi.useFakeTimers({ now: T })
  resetDeviceClockForTests()
  resetChainClockForTests()
  resetStoreClockForTests()
  setChainNow(() => Date.now())
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the waiting room's calibration (lib/store-calibration.ts)", () => {
  it("offers a pure attempt coordinator without changing the caller's state", () => {
    const before = createStoreCalibrationState()
    const result = storeCalibrationStep(before, { type: "request", nowMs: T })
    expect(before).toEqual(createStoreCalibrationState())
    expect(result).toEqual({ state: { status: "running", failedAtMs: null }, commands: [{ type: "start" }] })
  })

  it("does not start from inconsistent non-failed snapshots", () => {
    expect(storeCalibrationStep({ status: "succeeded", failedAtMs: T }, { type: "request", nowMs: T + 30_000 })).toEqual({
      state: { status: "succeeded", failedAtMs: T },
      commands: [],
    })
    expect(storeCalibrationStep({ status: "failed", failedAtMs: null }, { type: "request", nowMs: T + 30_000 })).toEqual({
      state: { status: "failed", failedAtMs: null },
      commands: [],
    })
  })

  it("learns the page's store-clock margin once, and tells the result", async () => {
    const results: StoreCalibration[] = []
    const { store, submits } = node(45_000)
    const calibrate = storeCalibrator({ resolveStore: async () => store, namespace: "ns", id: "me", onResult: (r) => results.push(r) })
    const [a, b] = await Promise.all([calibrate(), calibrate()])
    expect(a).toBe(b)
    expect(a).toMatchObject({ outcome: "learned", attempts: 2, marginMs: 60_000 })
    expect(storeClock().marginMs()).toBe(60_000)
    expect(await calibrate()).toBe(a) // kept: no second statement
    expect(submits).toHaveLength(2)
    expect(results).toHaveLength(1)
  })

  it("no allowance yet: failed, then tried again after 30 s", async () => {
    const results: StoreCalibration[] = []
    const refused = node(0, `statement_submit not accepted: {"reason":"noAllowance","status":"rejected"}`)
    let store = refused.store
    const calibrate = storeCalibrator({ resolveStore: async () => store, namespace: "ns", id: "me", onResult: (r) => results.push(r) })
    expect(await calibrate()).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/noAllowance/) })
    expect((await calibrate()).outcome).toBe("failed") // within 30 s: the same answer
    store = node(0).store
    vi.advanceTimersByTime(30_000)
    expect(await calibrate()).toMatchObject({ outcome: "accepted", marginMs: 0 })
    expect(results.map((r) => r.outcome)).toEqual(["failed", "accepted"])
  })

  it("no statement store: failed, without a statement", async () => {
    const calibrate = storeCalibrator({ resolveStore: async () => null, namespace: "ns", id: "me", onResult: () => {} })
    expect(await calibrate()).toMatchObject({ outcome: "failed", attempts: 0, durationMs: 0, reason: "no statement store" })
  })

  it("a calibration that never resolves times out as failed, and a later call tries again", async () => {
    let resolveStore: () => Promise<StatementStoreLike | null> = () => new Promise(() => {})
    const calibrate = storeCalibrator({ resolveStore: () => resolveStore(), namespace: "ns", id: "me", onResult: () => {} })
    const hung = calibrate()
    await vi.advanceTimersByTimeAsync(CALIBRATION_TIMEOUT_MS)
    expect(await hung).toMatchObject({ outcome: "failed", durationMs: CALIBRATION_TIMEOUT_MS, reason: "calibration timeout" })
    resolveStore = async () => node(0).store
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await calibrate()).toMatchObject({ outcome: "accepted" })
  })
})
