// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { storeCalibrationMachineDefinition } from "../../state-machines/store-calibration.definition"
import type { MachineDefinition } from "../../state-machines/framework"
import { fromDefinition } from "./from-definition"

/** The four events, as the definition's own witness map writes them. One representative
 *  value per key is faithful here because none of these events carries an input that varies:
 *  the definition's realStep derives any time from the state itself (inputFor takes nowMs
 *  from the state), so two different `request-ready` events cannot behave differently. */
const EVENTS = {
  "request-early": { kind: "request-early" },
  "request-ready": { kind: "request-ready" },
  "settle-accepted": { kind: "settle-accepted" },
  "settle-failed": { kind: "settle-failed" },
} as const

type Key = keyof typeof EVENTS
type Definition = typeof storeCalibrationMachineDefinition
type Real = Parameters<Definition["realStep"]>[0]
type Model = Parameters<Definition["modelStep"]>[0]
type RealResult = ReturnType<Definition["realStep"]>
type ModelResult = ReturnType<Definition["modelStep"]>
type Observation = ReturnType<Definition["observeReal"]>
type StateKey = ReturnType<Definition["realStateKey"]>

/** store-calibration is the first machine whose EVENTS ARE OBJECTS (`{ kind }`) rather than
 *  bare strings: its `eventKey` is `(event) => event.kind`. fromDefinition drives a machine
 *  by the transition table's string row keys and hands those keys straight to
 *  realStep/modelStep, so this definition re-states the event plumbing in terms of the key
 *  and leaves everything else — the table, the step functions, the invariants, the
 *  witnesses — pointing at the definition's own. Nothing about the machine is re-declared. */
const definition: MachineDefinition<Real, Model, Key, RealResult["output"], ModelResult["output"], Observation, StateKey, Key> = {
  name: storeCalibrationMachineDefinition.name,
  initialReal: () => storeCalibrationMachineDefinition.initialReal(),
  initialModel: () => storeCalibrationMachineDefinition.initialModel(),
  realStep: (state, key) => storeCalibrationMachineDefinition.realStep(state, EVENTS[key]),
  modelStep: (state, key) => storeCalibrationMachineDefinition.modelStep(state, EVENTS[key]),
  classifyRealStep: (previous, result) => storeCalibrationMachineDefinition.classifyRealStep(previous, result),
  observeReal: (result) => storeCalibrationMachineDefinition.observeReal(result),
  observeModel: (result) => storeCalibrationMachineDefinition.observeModel(result),
  realStateKey: (state) => storeCalibrationMachineDefinition.realStateKey(state),
  modelStateKey: (state) => storeCalibrationMachineDefinition.modelStateKey(state),
  eventKey: (key) => key,
  transitionTable: storeCalibrationMachineDefinition.transitionTable,
  witnesses: [],
  regressions: [],
  // The definition's own invariants, cast for the key type: the event PLUMBING is adapted,
  // the claims are not. An empty list here would silently switch off "at most one retained
  // attempt starts" and "a failed attempt records its retry epoch" for the whole search,
  // and a planted double-start with matching real and model would pass undetected.
  invariants: storeCalibrationMachineDefinition.invariants as never,
}

export const storeCalibrationAdapter = Object.assign(fromDefinition(definition), { definition })
