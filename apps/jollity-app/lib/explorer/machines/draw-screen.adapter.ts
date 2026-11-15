// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  drawScreenMachineDefinition,
  representative,
  type DrawScreenEventKey,
} from "../../state-machines/draw-screen.definition"
import type { MachineDefinition, TraceEntry } from "../../state-machines/framework"
import type { TraceMonitor } from "./contract"
import { fromDefinition } from "./from-definition"

type Definition = typeof drawScreenMachineDefinition
type Real = ReturnType<Definition["initialReal"]>
type Model = ReturnType<Definition["initialModel"]>
type RealOutput = ReturnType<Definition["realStep"]>["output"]
type ModelOutput = ReturnType<Definition["modelStep"]>["output"]
type Observation = ReturnType<Definition["observeReal"]>
type StateKey = ReturnType<Definition["realStateKey"]>

/**
 * draw-screen's definition uses structured events, so its property tests can vary the draw, the held mount and the stale
 * epoch. The explorer needs the finite declared keys instead: this view takes the definition's own representative for each
 * key (the one every witness ends on), and keeps the reducer, model, observations, declarations and invariants.
 */
export const drawScreenExplorerDefinition: MachineDefinition<Real, Model, DrawScreenEventKey, RealOutput, ModelOutput, Observation, StateKey, DrawScreenEventKey> = {
  name: drawScreenMachineDefinition.name,
  initialReal: drawScreenMachineDefinition.initialReal,
  initialModel: drawScreenMachineDefinition.initialModel,
  realStep: (state, event) => drawScreenMachineDefinition.realStep(state, representative[event]),
  modelStep: (state, event) => drawScreenMachineDefinition.modelStep(state, representative[event]),
  classifyRealStep: drawScreenMachineDefinition.classifyRealStep,
  observeReal: drawScreenMachineDefinition.observeReal,
  observeModel: drawScreenMachineDefinition.observeModel,
  realStateKey: drawScreenMachineDefinition.realStateKey,
  modelStateKey: drawScreenMachineDefinition.modelStateKey,
  eventKey: (event) => event,
  transitionTable: drawScreenMachineDefinition.transitionTable,
  witnesses: [],
  regressions: [],
  invariants: drawScreenMachineDefinition.invariants.map((invariant) => ({
    name: invariant.name,
    specClause: invariant.specClause,
    check: (context) =>
      invariant.check({
        ...context,
        event: representative[context.event],
        trace: context.trace.map((entry) => ({ ...entry, event: representative[entry.event] })),
      }),
  })),
}

type DrawScreenEntry = TraceEntry<DrawScreenEventKey, Observation, StateKey, DrawScreenEventKey>
/** What the four trace invariants of draw-screen.definition.ts read, and nothing more, each count saturating at 2. */
type DrawScreenMonitor = { leaves: number; onward: number; results: number; releases: number; offers: number }

const count = (commands: readonly string[], match: (command: string) => boolean): number => commands.filter(match).length

export const drawScreenTraceMonitor: TraceMonitor<DrawScreenEntry, DrawScreenMonitor> = {
  initial: { leaves: 0, onward: 0, results: 0, releases: 0, offers: 0 },
  step: (m: DrawScreenMonitor, entry: DrawScreenEntry): DrawScreenMonitor => {
    const { commands } = entry.real
    const wheel = entry.before.startsWith("wheel|")
    return {
      leaves: Math.min(2, m.leaves + (wheel ? count(commands, (c) => c === "ceremony-report:tap" || c === "ceremony-report:idle") : 0)),
      onward: Math.min(2, m.onward + (wheel ? count(commands, (c) => c === "payoff:draw-continue" || c === "payoff:draw-idle") : 0)),
      results: Math.min(2, m.results + count(commands, (c) => c.startsWith("payoff:draw-result") || c.startsWith("payoff:draw-none"))),
      releases: Math.min(2, m.releases + count(commands, (c) => c === "release-stage")),
      offers: Math.min(2, m.offers + count(commands, (c) => c === "payoff:draw-offered")),
    }
  },
  key: (m: DrawScreenMonitor) => `${m.leaves}|${m.onward}|${m.results}|${m.releases}|${m.offers}`,
  covers: [
    "the wheel is left at most once",
    "draw-result or draw-none is sent at most once",
    "a held mount only while the intro is up, released at most once",
    "the idle is offered once, and only with a way on",
  ],
}

export const drawScreenAdapter = fromDefinition(drawScreenExplorerDefinition, { traceMonitor: drawScreenTraceMonitor })
