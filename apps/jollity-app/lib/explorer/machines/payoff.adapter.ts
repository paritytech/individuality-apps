// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PayoffInput } from "../../payoff-machine"
import { payoffMachineDefinition } from "../../state-machines/payoff.definition"
import type { MachineDefinition, TraceEntry } from "../../state-machines/framework"
import type { TraceMonitor } from "./contract"
import { fromDefinition } from "./from-definition"

type Definition = typeof payoffMachineDefinition
type Real = ReturnType<Definition["initialReal"]>
type Model = ReturnType<Definition["initialModel"]>
type OriginalEvent = Parameters<Definition["realStep"]>[1]
type RealOutput = ReturnType<Definition["realStep"]>["output"]
type ModelOutput = ReturnType<Definition["modelStep"]>["output"]
type Observation = ReturnType<Definition["observeReal"]>
type StateKey = ReturnType<Definition["realStateKey"]>
type PayoffExplorerEvent = ReturnType<Definition["eventKey"]>
type InputType = PayoffInput["type"]

const INPUTS: Record<InputType, PayoffInput> = {
  "draw-result": { type: "draw-result" },
  "draw-none": { type: "draw-none" },
  "draw-bypass": { type: "draw-bypass" },
  "draw-continue": { type: "draw-continue" },
  "draw-idle": { type: "draw-idle" },
  "draw-error": { type: "draw-error" },
  "draw-offered": { type: "draw-offered" },
  "collectables-opened": { type: "collectables-opened" },
  "collectables-result": { type: "collectables-result" },
  "collectables-error": { type: "collectables-error" },
  "collectables-reread-due": { type: "collectables-reread-due" },
  "collectables-continue": { type: "collectables-continue" },
  "collectables-skip": { type: "collectables-skip" },
  "payoff-stalled": { type: "payoff-stalled", stage: "chest.load" },
  "next-game": { type: "next-game" },
  "return-after-long-absence": { type: "return-after-long-absence" },
  "app-gone": { type: "app-gone" },
  hidden: { type: "hidden", at: 100 },
  visible: { type: "visible", at: 200 },
}

/** One concrete definition event for each finite explorer event key. */
const concreteEvent = (event: PayoffExplorerEvent): OriginalEvent => {
  const separator = event.lastIndexOf("|")
  const type = event.slice(0, separator) as InputType
  return {
    input: INPUTS[type],
    tag: event.endsWith("|current") ? "current" : "stale-game-older",
  }
}

/**
 * Payoff's framework definition uses structured events because its property tests exercise five tag modes. The explorer
 * needs the finite declared keys instead, so this view selects one representative current or stale event per key while
 * retaining the original reducer, model, observations, declarations, and invariants.
 */
export const payoffExplorerDefinition: MachineDefinition<
  Real,
  Model,
  PayoffExplorerEvent,
  RealOutput,
  ModelOutput,
  Observation,
  StateKey,
  PayoffExplorerEvent
> = {
  name: payoffMachineDefinition.name,
  initialReal: payoffMachineDefinition.initialReal,
  initialModel: payoffMachineDefinition.initialModel,
  realStep: (state, event) => payoffMachineDefinition.realStep(state, concreteEvent(event)),
  modelStep: (state, event) => payoffMachineDefinition.modelStep(state, concreteEvent(event)),
  classifyRealStep: payoffMachineDefinition.classifyRealStep,
  observeReal: payoffMachineDefinition.observeReal,
  observeModel: payoffMachineDefinition.observeModel,
  realStateKey: payoffMachineDefinition.realStateKey,
  modelStateKey: payoffMachineDefinition.modelStateKey,
  eventKey: (event) => event,
  transitionTable: payoffMachineDefinition.transitionTable,
  witnesses: [],
  regressions: [],
  invariants: payoffMachineDefinition.invariants.map((invariant) => ({
    name: invariant.name,
    specClause: invariant.specClause,
    check: (context) =>
      invariant.check({
        ...context,
        event: concreteEvent(context.event),
        trace: context.trace.map((entry) => ({ ...entry, event: concreteEvent(entry.event) })),
      }),
  })),
}

type PayoffEntry = TraceEntry<PayoffExplorerEvent, Observation, StateKey, PayoffExplorerEvent>
type PayoffMonitor = { drawShown: number; payoffStalled: number; endPayoff: number; handOff: number }

const count = (commands: readonly string[], prefix: string): number =>
  commands.filter((command) => command.startsWith(prefix)).length

const payoffTraceMonitor: TraceMonitor<PayoffEntry, PayoffMonitor> = {
  initial: { drawShown: 0, payoffStalled: 0, endPayoff: 0, handOff: 0 },
  step: (monitor, entry) => ({
    drawShown: Math.min(2, monitor.drawShown + count(entry.real.commands, "telemetry:drawShown")),
    payoffStalled: Math.min(2, monitor.payoffStalled + count(entry.real.commands, "telemetry:payoffStalled")),
    endPayoff: Math.min(2, monitor.endPayoff + count(entry.real.commands, "end-payoff:")),
    handOff: Math.min(2, monitor.handOff + count(entry.real.commands, "hand-off")),
  }),
  key: (monitor) => `${monitor.drawShown}|${monitor.payoffStalled}|${monitor.endPayoff}|${monitor.handOff}`,
  covers: ["facts and journey end are emitted at most once"],
}

export const payoffAdapter = fromDefinition(payoffExplorerDefinition, { traceMonitor: payoffTraceMonitor })
