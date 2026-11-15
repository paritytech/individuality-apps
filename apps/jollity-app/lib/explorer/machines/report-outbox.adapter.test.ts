// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { TraceEntry } from "../../state-machines/framework"
import { reportOutboxMachineDefinition as definition, type ReportOutboxTestEvent } from "../../state-machines/report-outbox.definition"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"
import { reportOutboxAdapter, reportOutboxTraceMonitor } from "./report-outbox.adapter"

const EVENTS = [
  "arm", "beat", "chain-closed", "close", "confirm", "fire", "handover-gone", "handover-missed", "handover-pending", "handover-sent",
  "late-confirm", "late-retry", "refused", "retry", "sent", "stale-sent", "tap", "unmount", "verdict-changed",
]

type Real = ReturnType<typeof definition.initialReal>
type Model = ReturnType<typeof definition.initialModel>
type Entry = Parameters<typeof reportOutboxTraceMonitor.step>[1]

/** Walks a path through real and model without the declaration check, so every covered invariant can be judged on any path. */
function walk(events: readonly ReportOutboxTestEvent[], start?: { real: Real; model: Model; trace: Entry[] }) {
  let real = start?.real ?? definition.initialReal()
  let model = start?.model ?? definition.initialModel()
  const trace: Entry[] = [...(start?.trace ?? [])]
  const verdicts: string[] = []
  for (const event of events) {
    const realResult = definition.realStep(real, event)
    const modelResult = definition.modelStep(model, event)
    const before = definition.realStateKey(real)
    const entry: TraceEntry<ReportOutboxTestEvent, Entry["real"], Entry["before"], ReportOutboxTestEvent> = {
      step: trace.length,
      before,
      eventKey: event,
      event,
      declared: definition.transitionTable[before][event],
      outcome: definition.classifyRealStep(real, realResult),
      real: definition.observeReal(realResult),
      model: definition.observeModel(modelResult),
    }
    trace.push(entry)
    const previousReal = real
    const previousModel = model
    real = realResult.state
    model = modelResult.state
    verdicts.push(
      definition.invariants
        .filter((invariant) => reportOutboxTraceMonitor.covers.includes(invariant.name))
        .map((invariant) => {
          try {
            invariant.check({ previousReal, previousModel, real, model, event, realObservation: entry.real, modelObservation: entry.model, trace })
            return "ok"
          } catch {
            return "fail"
          }
        })
        .join(","),
    )
  }
  const monitor = trace.reduce(reportOutboxTraceMonitor.step, reportOutboxTraceMonitor.initial)
  return { real, model, trace, verdicts, key: reportOutboxTraceMonitor.key(monitor), state: JSON.stringify({ real, model }) }
}

describe("report-outbox adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = reportOutboxAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state).toEqual({ real: definition.initialReal(), model: definition.initialModel() })
  })

  it("enables the 19 report-outbox event keys", () => {
    expect([...reportOutboxAdapter.enabledEvents(reportOutboxAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })

  it("its trace monitor gives equal verdicts on random path pairs with equal monitor keys", () => {
    const path = fc.array(fc.constantFrom(...(EVENTS as ReportOutboxTestEvent[])), { maxLength: 10 })
    // an empty trace breaks no invariant
    const clean = reportOutboxTraceMonitor.covers.map(() => "ok").join(",")
    let equalKeys = 0
    let equalStates = 0
    fc.assert(
      fc.property(path, path, path, (left, right, suffix) => {
        const a = walk(left)
        const b = walk(right)
        if (a.key !== b.key) return
        equalKeys++
        // now: the covered invariants judge both whole traces alike
        expect(a.verdicts.at(-1) ?? clean, `${left} | ${right}`).toBe(b.verdicts.at(-1) ?? clean)
        if (a.state !== b.state) return
        equalStates++
        // later: the same state and monitor key go on to judge every common suffix alike
        const laterA = walk(suffix, a)
        const laterB = walk(suffix, b)
        expect(laterA.verdicts, `${left} | ${right} | ${suffix}`).toEqual(laterB.verdicts)
        expect(laterA.key).toBe(laterB.key)
      }),
      { numRuns: 500, seed: 1_592_598_566 },
    )
    expect(equalKeys).toBeGreaterThan(100)
    expect(equalStates).toBeGreaterThan(0)
  })

  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(reportOutboxAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })

  it("lists declared cells not reached from the normal start", () => {
    const report = exploreMachine(reportOutboxAdapter, { depth: 4, maxStates: 100_000 })
    const declared = Object.values(definition.transitionTable).reduce((total, row) => total + Object.keys(row).length, 0)
    expect(report.unreachedCells.length).toBeGreaterThan(0)
    expect(report.unreachedCells.length).toBeLessThan(declared)
    // chain closure without a lock never happens from the normal start
    expect(report.unreachedCells).toContain("countdown|locked:0|submitted:0|closed:1|rushed:0|pending:0|restart:0::arm")
    expect(report.unreachedCells).not.toContain("idle|locked:0|submitted:0|closed:0|rushed:0|pending:0::arm")
    expect([...report.unreachedCells].sort()).toEqual(report.unreachedCells)
  })

  it("catches a planted bug", () => {
    const report = exploreMachine(plantStaleReal(reportOutboxAdapter, "arm"), { depth: 2, maxStates: 1_000 })
    expect(report.violations.length).toBeGreaterThan(0)
    expect(report.violations[0].trace).toEqual(["start", "arm"])
  })

  it("never uses the definition's arbitrary initial states", () => {
    const guarded = Object.defineProperty({ ...definition }, "initialArbitrary", {
      get() {
        throw new Error("initialArbitrary was read")
      },
    })
    const adapter = fromDefinition(guarded, { traceMonitor: reportOutboxTraceMonitor })
    expect(adapter.initial()).toEqual([{ label: "start", state: { real: definition.initialReal(), model: definition.initialModel() } }])
    expect(exploreMachine(adapter, { depth: 3, maxStates: 10_000 }).states).toBeGreaterThan(1)
    expect(MACHINES["report-outbox"]).toBe(reportOutboxAdapter)
  })
})
