// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { createMessageExpiryClock } from "../../store-clock"
import { messageExpiryMachineDefinition } from "../../state-machines/message-expiry-clock.definition"
import { exploreMachine } from "./explore-machine"
import { plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"
import { messageExpiryClockAdapter, messageExpiryClockAsStringEvents } from "./message-expiry-clock.adapter"

const EVENTS = [
  "accept-plain",
  "accept-push",
  "accept-sibling",
  "margin",
  "reject-learn",
  "reject-plain",
  "retry-fresh",
  "retry-stale",
  "stamp",
  "stamp-device",
]

describe("message-expiry-clock adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = messageExpiryClockAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state.real).toEqual(createMessageExpiryClock())
  })

  it("enables the 10 message-expiry-clock event keys", () => {
    expect([...messageExpiryClockAdapter.enabledEvents(messageExpiryClockAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })

  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(messageExpiryClockAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })

  it("catches a planted bug on reject-learn", () => {
    const report = exploreMachine(plantStaleReal(messageExpiryClockAdapter, "reject-learn"), { depth: 2, maxStates: 1_000 })
    expect(report.violations.length).toBeGreaterThan(0)
  })

  it("needs no trace monitor: every invariant reads one step", () => {
    expect(messageExpiryClockAdapter.traceMonitor).toBeUndefined()
    expect(messageExpiryClockAdapter.excluded ?? []).toEqual([])
  })

  it("is registered for npm run explore", () => {
    expect(MACHINES["message-expiry-clock"]).toBe(messageExpiryClockAdapter)
  })

  it("catches a planted real/model mismatch", () => {
    const planted = {
      ...messageExpiryClockAdapter,
      step: (state: Parameters<typeof messageExpiryClockAdapter.step>[0], event: string) => {
        const result = messageExpiryClockAdapter.step(state, event as never)
        if (event !== "stamp") return result
        return {
          state: result.state,
          output: {
            real: [...result.output.real, { type: "margin" as const, marginMs: 1 }],
            model: result.output.model,
          },
        }
      },
    }
    const report = exploreMachine(planted as never, { depth: 1, maxStates: 1_000 })
    expect(report.violations.length).toBeGreaterThan(0)
  })

  it("catches a flipped declared cell", () => {
    const row = "absent|reported:0" as const
    expect(messageExpiryMachineDefinition.transitionTable[row]["reject-learn"]).toBe("transition")
    const flipped = messageExpiryClockAsStringEvents({
      ...messageExpiryMachineDefinition,
      transitionTable: {
        ...messageExpiryMachineDefinition.transitionTable,
        [row]: { ...messageExpiryMachineDefinition.transitionTable[row], "reject-learn": "no-op" },
      },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "reject-learn"]])
  })

  it("reports an unknown cell list for an adapter without a cell index", () => {
    const bare = { ...messageExpiryClockAdapter }
    expect(exploreMachine(bare, { depth: 1, maxStates: 100 }).unreachedCells).toBe("cell list unknown")
    expect(exploreMachine(messageExpiryClockAdapter, { depth: 1, maxStates: 100 }).unreachedCells).not.toBe("cell list unknown")
  })
})
