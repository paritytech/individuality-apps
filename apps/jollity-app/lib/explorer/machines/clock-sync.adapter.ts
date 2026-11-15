// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { clockSyncMachineDefinition } from "../../state-machines/clock-sync.definition"
import type { MachineDefinition } from "../../state-machines/framework"
import { fromDefinition } from "./from-definition"

/** The four events, with the definition's own representative values — including the
 *  parameterised `tick` (100 ms in the waiting zone), which is the value the definition's
 *  witness map uses. */
const EVENTS = {
  "target-forward": { kind: "target-forward" },
  "target-back": { kind: "target-back" },
  tick: { kind: "tick", elapsedMs: 100, zone: "waiting" },
  "stale-tick": { kind: "stale-tick" },
} as const

type Key = keyof typeof EVENTS
type Definition = typeof clockSyncMachineDefinition
type Real = Parameters<Definition["realStep"]>[0]
type Model = Parameters<Definition["modelStep"]>[0]
type RealResult = ReturnType<Definition["realStep"]>
type ModelResult = ReturnType<Definition["modelStep"]>
type Observation = ReturnType<Definition["observeReal"]>
type StateKey = ReturnType<Definition["realStateKey"]>

/** clock-sync, like store-calibration, has OBJECT events and `eventKey: (event) => event.kind`.
 *  fromDefinition drives a machine by the transition table's string row keys and hands those
 *  keys straight to realStep/modelStep, so this definition re-states only the event plumbing
 *  — the row key back to its event object — and leaves the table, the step functions, the
 *  observe/classify/state-key functions and the invariants pointing at the definition's own. */
const definition: MachineDefinition<Real, Model, Key, RealResult["output"], ModelResult["output"], Observation, StateKey, Key> = {
  name: clockSyncMachineDefinition.name,
  initialReal: () => clockSyncMachineDefinition.initialReal(),
  initialModel: () => clockSyncMachineDefinition.initialModel(),
  realStep: (state, key) => clockSyncMachineDefinition.realStep(state, EVENTS[key]),
  modelStep: (state, key) => clockSyncMachineDefinition.modelStep(state, EVENTS[key]),
  classifyRealStep: (previous, result) => clockSyncMachineDefinition.classifyRealStep(previous, result),
  observeReal: (result) => clockSyncMachineDefinition.observeReal(result),
  observeModel: (result) => clockSyncMachineDefinition.observeModel(result),
  realStateKey: (state) => clockSyncMachineDefinition.realStateKey(state),
  modelStateKey: (state) => clockSyncMachineDefinition.modelStateKey(state),
  eventKey: (key) => key,
  transitionTable: clockSyncMachineDefinition.transitionTable,
  witnesses: [],
  regressions: [],
  // The definition's own invariants, cast for the key type: the event PLUMBING is adapted,
  // the claims are not. Dropping them here would silently switch off "shown clock never runs
  // backward" and "clock state stays finite" for the whole search.
  invariants: clockSyncMachineDefinition.invariants as never,
}

export const clockSyncAdapter = Object.assign(fromDefinition(definition), { definition })
