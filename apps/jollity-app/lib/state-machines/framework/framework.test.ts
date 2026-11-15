// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { DEFAULT_STATE_MACHINE_SEED, checkStep, defineTransitionTable, runStateMachineSuite } from "./index"
import type { MachineDefinition, TraceEntry } from "./index"

type ToggleState = "off" | "on"
type ToggleEvent = { type: "toggle" } | { type: "inspect" }

const table = defineTransitionTable<ToggleState, ToggleEvent["type"]>()({
  off: { toggle: "transition", inspect: "no-op" },
  on: { toggle: "transition", inspect: "no-op" },
})

describe("state-machine framework", () => {
  it("runs deterministic witnesses before generated cases and writes complete coverage", async () => {
    const result = await runStateMachineSuite({
      name: "toggle",
      initialReal: () => "off" as ToggleState,
      initialModel: () => "off" as ToggleState,
      realStep: (state, event) => ({ state: event.type === "toggle" ? (state === "off" ? "on" : "off") : state, output: event.type }),
      modelStep: (state, event) => ({ state: event.type === "toggle" ? (state === "off" ? "on" : "off") : state, output: event.type }),
      classifyRealStep: (previous, result) => (previous === result.state ? "no-op" : "transition"),
      observeReal: ({ state, output }) => ({ state, output }),
      observeModel: ({ state, output }) => ({ state, output }),
      realStateKey: (state) => state,
      modelStateKey: (state) => state,
      eventKey: (event) => event.type,
      transitionTable: table,
      witnesses: [
        { name: "off toggle", events: [{ type: "toggle" }] },
        { name: "off inspect", events: [{ type: "inspect" }] },
        { name: "on toggle", events: [{ type: "toggle" }, { type: "toggle" }] },
        { name: "on inspect", events: [{ type: "toggle" }, { type: "inspect" }] },
      ],
      regressions: [],
      invariants: [{ name: "states agree", specClause: "test", check: ({ real, model }) => expect(real).toBe(model) }],
      generatedSequences: () => [[{ type: "toggle" }, { type: "inspect" }]],
    })

    expect(result.coverage).toMatchObject({ declared: 4, hit: 4, missing: [] })
    expect(result.coverage.hits["off::toggle::transition"]).toBeGreaterThan(0)
    expect(result.seed).toBe(DEFAULT_STATE_MACHINE_SEED)
  })

  it("fails when a declared pair has no deterministic witness", async () => {
    await expect(
      runStateMachineSuite({
        name: "missing",
        initialReal: () => "off" as ToggleState,
        initialModel: () => "off" as ToggleState,
        realStep: (state, event) => ({ state, output: event.type }),
        modelStep: (state, event) => ({ state, output: event.type }),
        classifyRealStep: () => "no-op",
        observeReal: ({ state, output }) => ({ state, output }),
        observeModel: ({ state, output }) => ({ state, output }),
        realStateKey: (state) => state,
        modelStateKey: (state) => state,
        eventKey: (event) => event.type,
        transitionTable: table,
        witnesses: [{ name: "one cell", events: [{ type: "inspect" }] }],
        regressions: [],
        invariants: [],
        generatedSequences: () => [],
      }),
    ).rejects.toThrow(/missing deterministic coverage/i)
  })

  it("validates declarations on generated property steps", async () => {
    type ProbeEvent = { type: "inspect"; mutate: boolean }
    await expect(
      runStateMachineSuite({
        name: "generated-declaration-mismatch",
        initialReal: () => "off" as ToggleState,
        initialModel: () => "off" as ToggleState,
        realStep: (state, event: ProbeEvent) => ({ state: event.mutate ? (state === "off" ? "on" : "off") : state, output: event.type }),
        modelStep: (state, event: ProbeEvent) => ({ state: event.mutate ? (state === "off" ? "on" : "off") : state, output: event.type }),
        classifyRealStep: (previous, result) => (previous === result.state ? "no-op" : "transition"),
        observeReal: ({ state, output }) => ({ state, output }),
        observeModel: ({ state, output }) => ({ state, output }),
        realStateKey: (state) => state,
        modelStateKey: (state) => state,
        eventKey: (event) => event.type,
        transitionTable: {
          off: { inspect: "no-op" },
          on: { inspect: "no-op" },
        },
        witnesses: [
          { name: "off inspect", events: [{ type: "inspect", mutate: false }] },
          { name: "on inspect", initial: { real: "on", model: "on" }, events: [{ type: "inspect", mutate: false }] },
        ],
        regressions: [],
        invariants: [],
        sequenceArbitrary: fc.constant([{ type: "inspect", mutate: true }] as const),
        numRuns: 1,
      }),
    ).rejects.toThrow(/Property failed after 1 tests/i)
  })

  it("can generate runs from alternate initial states", async () => {
    const result = await runStateMachineSuite({
      name: "alternate-initial",
      initialReal: () => "off" as ToggleState,
      initialModel: () => "off" as ToggleState,
      initialArbitrary: fc.constant({ real: "on" as ToggleState, model: "on" as ToggleState }),
      realStep: (state, event) => ({ state, output: event.type }),
      modelStep: (state, event) => ({ state, output: event.type }),
      classifyRealStep: () => "no-op",
      observeReal: ({ state, output }) => ({ state, output }),
      observeModel: ({ state, output }) => ({ state, output }),
      realStateKey: (state) => state,
      modelStateKey: (state) => state,
      eventKey: (event) => event.type,
      transitionTable: {
        off: { toggle: "no-op", inspect: "no-op" },
        on: { toggle: "no-op", inspect: "no-op" },
      },
      witnesses: [
        { name: "off toggle", events: [{ type: "toggle" }] },
        { name: "off inspect", events: [{ type: "inspect" }] },
        { name: "on toggle", initial: { real: "on", model: "on" }, events: [{ type: "toggle" }] },
        { name: "on inspect", initial: { real: "on", model: "on" }, events: [{ type: "inspect" }] },
      ],
      regressions: [],
      invariants: [],
      sequenceArbitrary: fc.constant([{ type: "inspect" }] as const),
      numRuns: 1,
    })

    expect(result.coverage.hits["on::inspect::no-op"]).toBeGreaterThan(1)
  })

  it("checkStep throws the runner's own messages for a model mismatch and an undeclared pair", () => {
    const definition: MachineDefinition<ToggleState, ToggleState, ToggleEvent, unknown, unknown, unknown, ToggleState, ToggleEvent["type"]> = {
      name: "step",
      initialReal: () => "off",
      initialModel: () => "off",
      realStep: (state, event) => ({ state: event.type === "toggle" ? (state === "off" ? "on" : "off") : state, output: event.type }),
      modelStep: (state) => ({ state, output: "model" }),
      classifyRealStep: (previous, result) => (previous === result.state ? "no-op" : "transition"),
      observeReal: ({ state }) => state,
      observeModel: ({ state }) => state,
      realStateKey: (state) => state,
      modelStateKey: (state) => state,
      eventKey: (event) => event.type,
      transitionTable: table,
      witnesses: [],
      regressions: [],
      invariants: [],
    }
    const input = (model: ToggleState, event: ToggleEvent, trace: TraceEntry<ToggleEvent, unknown, ToggleState, ToggleEvent["type"]>[] = []) => ({
      definition,
      real: "off" as ToggleState,
      model,
      event,
      step: 3,
      label: "unit",
      trace,
    })
    expect(() => checkStep(input("on", { type: "toggle" }))).toThrow("step/unit step 3: state-key mismatch off != on")
    expect(() => checkStep(input("off", { type: "unknown" } as unknown as ToggleEvent))).toThrow("step/unit step 3: undeclared pair off::unknown")
    const seen: string[] = []
    const trace: TraceEntry<ToggleEvent, unknown, ToggleState, ToggleEvent["type"]>[] = []
    expect(() => checkStep(input("off", { type: "toggle" }, trace), (state, key, outcome) => seen.push(`${state}::${key}::${outcome}`))).toThrow(
      "step/unit step 3 observation mismatch",
    )
    expect(seen).toEqual(["off::toggle::transition"])
    expect(trace).toHaveLength(1)
  })
})
