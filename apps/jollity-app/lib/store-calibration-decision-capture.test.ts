// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { captureLegacyDecisions } from "./webrtc/legacy-decision-capture"

const H = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: (() => void) | void }
  const state = {
    hooks: [] as unknown[],
    index: 0,
    effects: [] as Array<{ slot: number; run: () => (() => void) | void }>,
    body: null as null | (() => void),
    flushing: false,
  }
  const changed = (a?: unknown[], b?: unknown[]) =>
    !a || !b || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]))
  const flush = () => {
    if (!state.body || state.flushing) return
    state.flushing = true
    state.index = 0
    state.body()
    const effects = state.effects
    state.effects = []
    for (const { slot, run } of effects) {
      const effect = state.hooks[slot] as Effect
      if (typeof effect.cleanup === "function") effect.cleanup()
      effect.cleanup = run()
    }
    state.flushing = false
  }
  const useState = <T,>(initial: T) => {
    const slot = state.index++
    if (!(slot in state.hooks)) state.hooks[slot] = { value: initial }
    const cell = state.hooks[slot] as { value: T }
    return [cell.value, (value: T) => {
      cell.value = value
      queueMicrotask(flush)
    }] as const
  }
  const useEffect = (run: () => (() => void) | void, deps?: unknown[]) => {
    const slot = state.index++
    const current = state.hooks[slot] as Effect | undefined
    if (!current) state.hooks[slot] = { deps }
    else if (!changed(current.deps, deps)) return
    else current.deps = deps
    state.effects.push({ slot, run })
  }
  const mount = (body: () => void) => {
    state.hooks = []
    state.effects = []
    state.body = body
    flush()
  }
  const unmount = () => {
    for (const hook of state.hooks) {
      const effect = hook as Effect
      if (typeof effect?.cleanup === "function") effect.cleanup()
    }
    state.body = null
    state.hooks = []
  }
  return { useState, useEffect, mount, unmount }
})
vi.mock("react", () => ({ useState: H.useState, useEffect: H.useEffect }))
vi.mock("./journeys/game-trace", () => ({ storeCalibrated: () => {}, storeClockEvent: () => {} }))

import { CALIBRATION_WAIT_MS, useCalibratedSignalling } from "./store-calibration"

describe("legacy calibration decision capture", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    H.unmount()
    vi.useRealTimers()
  })

  it("records settlement before the timeout", async () => {
    const capture = captureLegacyDecisions()
    const signalling = (() => () => ({})) as never
    const calibrate = async () => ({ outcome: "accepted", marginMs: 0, durationMs: 1, attempts: 1 }) as const
    let output: unknown
    H.mount(() => {
      output = useCalibratedSignalling(signalling, calibrate)
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(output).toBe(signalling)
    expect(capture.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "calibration-release", calibrationRelease: { reason: "settled" } }),
    ]))
    capture.stop()
  })

  it(`releases at exactly ${CALIBRATION_WAIT_MS} ms and records timeout once`, async () => {
    const capture = captureLegacyDecisions()
    const signalling = (() => () => ({})) as never
    const calibrate = () => new Promise<never>(() => {})
    let output: unknown
    H.mount(() => {
      output = useCalibratedSignalling(signalling, calibrate)
    })
    await vi.advanceTimersByTimeAsync(CALIBRATION_WAIT_MS - 1)
    expect(output).toBeUndefined()
    expect(capture.records).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ calibrationRelease: { reason: "timeout" } }),
    ]))
    await vi.advanceTimersByTimeAsync(1)
    expect(output).toBe(signalling)
    expect(capture.records.filter((record) => record.calibrationRelease?.reason === "timeout")).toHaveLength(1)
    capture.stop()
  })

})
