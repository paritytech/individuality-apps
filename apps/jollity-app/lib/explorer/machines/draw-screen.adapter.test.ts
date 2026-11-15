// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { startDrawScreen } from "../../draw/draw-screen"
import {
  drawScreenEventKeys,
  drawScreenMachineDefinition,
  type DrawScreenEventKey,
} from "../../state-machines/draw-screen.definition"
import type { TraceEntry } from "../../state-machines/framework"
import { drawScreenAdapter, drawScreenExplorerDefinition as definition, drawScreenTraceMonitor } from "./draw-screen.adapter"
import { exploreMachine } from "./explore-machine"
import { fromDefinition, plantStaleReal } from "./from-definition"
import { MACHINES } from "./registry"

const EVENTS = [...drawScreenEventKeys].sort()

type Real = ReturnType<typeof definition.initialReal>
type Model = ReturnType<typeof definition.initialModel>
type Entry = Parameters<typeof drawScreenTraceMonitor.step>[1]

/** Walks a path through real and model without the declaration check, so every covered invariant can be judged on any path. */
function walk(events: readonly DrawScreenEventKey[], start?: { real: Real; model: Model; trace: Entry[] }) {
  let real = start?.real ?? definition.initialReal()
  let model = start?.model ?? definition.initialModel()
  const trace: Entry[] = [...(start?.trace ?? [])]
  const verdicts: string[] = []
  for (const event of events) {
    const realResult = definition.realStep(real, event)
    const modelResult = definition.modelStep(model, event)
    const before = definition.realStateKey(real)
    const entry: TraceEntry<DrawScreenEventKey, Entry["real"], Entry["before"], DrawScreenEventKey> = {
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
        .filter((invariant) => drawScreenTraceMonitor.covers.includes(invariant.name))
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
  const monitor = trace.reduce(drawScreenTraceMonitor.step, drawScreenTraceMonitor.initial)
  return { real, model, trace, verdicts, key: drawScreenTraceMonitor.key(monitor), state: JSON.stringify({ real, model }) }
}

describe("draw-screen adapter", () => {
  it("starts only from the normal start state", () => {
    const initial = drawScreenAdapter.initial()
    expect(initial).toHaveLength(1)
    expect(initial[0].label).toBe("start")
    expect(initial[0].state).toEqual({ real: startDrawScreen({ game: 7, override: undefined }), model: drawScreenMachineDefinition.initialModel() })
  })

  it("enables the 24 draw-screen event keys", () => {
    expect(EVENTS).toHaveLength(24)
    expect([...drawScreenAdapter.enabledEvents(drawScreenAdapter.initial()[0].state)].sort()).toEqual(EVENTS)
  })

  it("explores to depth 8 with no violation", () => {
    const report = exploreMachine(drawScreenAdapter, { depth: 8, maxStates: 100_000 })
    expect(report.violations).toEqual([])
    expect(report.states).toBeGreaterThan(1)
    expect(report.frontierClosed || report.depthCompleted === 8).toBe(true)
  })

  it("catches a planted bug", () => {
    const report = exploreMachine(plantStaleReal(drawScreenAdapter, "opened"), { depth: 2, maxStates: 1_000 })
    expect(report.violations.length).toBeGreaterThan(0)
    expect(report.violations[0].trace).toEqual(["start", "opened"])
  })

  it("catches a second result through the trace monitor", () => {
    // a re-answer in the words logs again; sending the result again with it is what only the whole trace can object to
    const planted = {
      ...drawScreenAdapter,
      step: (state: (typeof drawScreenAdapter extends { initial(): readonly { state: infer S }[] } ? S : never), event: DrawScreenEventKey) => {
        const result = drawScreenAdapter.step(state, event)
        if (event !== "load-answered:words" || state.real.phase !== "words") return result
        return {
          state: result.state,
          output: {
            real: [...result.output.real, { kind: "payoff" as const, input: { type: "draw-result" as const } }],
            model: [...result.output.model, "payoff:draw-result"],
          },
        }
      },
    }
    const report = exploreMachine(planted, { depth: 3, maxStates: 10_000 })
    expect(report.violations.map((violation) => violation.message).join("\n")).toMatch(/the result was sent 2 times/)
  })

  it("its trace monitor gives equal verdicts on random path pairs with equal monitor keys", () => {
    const path = fc.array(fc.constantFrom(...(EVENTS as DrawScreenEventKey[])), { maxLength: 10 })
    // an empty trace breaks no invariant
    const clean = drawScreenTraceMonitor.covers.map(() => "ok").join(",")
    let equalKeys = 0
    let equalStates = 0
    fc.assert(
      fc.property(path, path, path, (left, right, suffix) => {
        const a = walk(left)
        const b = walk(right)
        if (a.key !== b.key) return
        equalKeys++
        expect(a.verdicts.at(-1) ?? clean, `${left} | ${right}`).toBe(b.verdicts.at(-1) ?? clean)
        if (a.state !== b.state) return
        equalStates++
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

  it("the monitor covers the trace invariants", () => {
    const readsTrace = drawScreenMachineDefinition.invariants.filter((invariant) => /\btrace\b/.test(invariant.check.toString())).map(({ name }) => name)
    expect([...drawScreenTraceMonitor.covers].sort()).toEqual(readsTrace.sort())
    expect(drawScreenAdapter.excluded ?? []).toEqual([])
  })

  it("catches a flipped declared cell", () => {
    expect(definition.transitionTable.new.opened).toBe("transition")
    const flipped = fromDefinition({
      ...definition,
      transitionTable: { ...definition.transitionTable, new: { ...definition.transitionTable.new, opened: "no-op" } },
    })
    const report = exploreMachine(flipped, { depth: 1, maxStates: 1_000 })
    expect(report.violations.map((violation) => violation.trace)).toEqual([["start", "opened"]])
  })

  it("is registered for npm run explore", () => {
    expect(MACHINES["draw-screen"]).toBe(drawScreenAdapter)
  })
})
