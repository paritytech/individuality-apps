// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { startCameraRecovery } from "../../camera"
import { cameraMachineDefinition } from "../../state-machines/camera.definition"
import { cameraAdapter } from "./camera.adapter"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"

const EVENTS = ["busy", "clear", "fire", "fire-hidden", "fire-unheld", "frame", "hidden", "live", "open-hidden-unheld", "other", "override", "recover",
  "recover-hidden", "recover-hidden-unheld", "recover-unheld", "retry-hidden", "retry-unheld", "shown", "shown-unavailable", "stale-fire", "still-muted-quick",
  "still-muted-slow", "stop", "tap", "tap-error", "tap-frames", "tap-muted", "unmuted"]

describe("camera adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = cameraAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state.real).toEqual(startCameraRecovery())
  })
  it("enables the 28 camera event keys", () => {
    expect([...cameraAdapter.enabledEvents(cameraAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })
  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(cameraAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })
  it("catches a planted bug on busy", () => {
    expect(exploreMachine(plantStaleReal(cameraAdapter, "busy"), { depth: 2, maxStates: 1000 }).violations.length).toBeGreaterThan(0)
  })
  it("needs no trace monitor, because no invariant reads the trace", () => {
    expect(cameraAdapter.traceMonitor).toBeUndefined()
    expect(cameraMachineDefinition.invariants.every((invariant) => !/\btrace\b/.test(invariant.check.toString()))).toBe(true)
  })
  it("is registered for npm run explore", () => {
    expect(MACHINES.camera).toBe(cameraAdapter)
  })
  it("catches a flipped declared cell", () => {
    const row = "ready" as const
    expect(cameraMachineDefinition.transitionTable[row].recover).toBe("transition")
    const flipped = fromDefinition({
      ...cameraMachineDefinition,
      transitionTable: { ...cameraMachineDefinition.transitionTable, [row]: { ...cameraMachineDefinition.transitionTable[row], recover: "no-op" } },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "recover"]])
  })
  it("reports an unknown cell list for an adapter without a cell index", () => {
    const bare = { ...cameraAdapter }
    expect(exploreMachine(bare, { depth: 1, maxStates: 100 }).unreachedCells).toBe("cell list unknown")
    expect(exploreMachine(cameraAdapter, { depth: 1, maxStates: 100 }).unreachedCells).not.toBe("cell list unknown")
  })
})
