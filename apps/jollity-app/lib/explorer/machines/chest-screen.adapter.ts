// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { chestScreenMachineDefinition, type ChestScreenEventKey } from "../../state-machines/chest-screen.definition"
import type { MachineDefinition } from "../../state-machines/framework"
import { fromDefinition } from "./from-definition"

type Definition = typeof chestScreenMachineDefinition
type Real = ReturnType<Definition["initialReal"]>
type Model = ReturnType<Definition["initialModel"]>
type RealOutput = ReturnType<Definition["realStep"]>["output"]
type ModelOutput = ReturnType<Definition["modelStep"]>["output"]
type Observation = ReturnType<Definition["observeReal"]>
type StateKey = ReturnType<Definition["realStateKey"]>

/**
 * chest-screen's test events are their keys already ({ key }); the explorer steps the keys themselves, and keeps the
 * reducer, model, observations, declarations and invariants. None of its invariants reads the whole trace, so it needs
 * no trace monitor.
 */
const chestScreenExplorerDefinition: MachineDefinition<Real, Model, ChestScreenEventKey, RealOutput, ModelOutput, Observation, StateKey, ChestScreenEventKey> = {
  name: chestScreenMachineDefinition.name,
  initialReal: chestScreenMachineDefinition.initialReal,
  initialModel: chestScreenMachineDefinition.initialModel,
  realStep: (state, key) => chestScreenMachineDefinition.realStep(state, { key }),
  modelStep: (state, key) => chestScreenMachineDefinition.modelStep(state, { key }),
  classifyRealStep: chestScreenMachineDefinition.classifyRealStep,
  observeReal: chestScreenMachineDefinition.observeReal,
  observeModel: chestScreenMachineDefinition.observeModel,
  realStateKey: chestScreenMachineDefinition.realStateKey,
  modelStateKey: chestScreenMachineDefinition.modelStateKey,
  eventKey: (key) => key,
  transitionTable: chestScreenMachineDefinition.transitionTable,
  witnesses: [],
  regressions: [],
  invariants: chestScreenMachineDefinition.invariants.map((invariant) => ({
    name: invariant.name,
    specClause: invariant.specClause,
    check: (context) =>
      invariant.check({
        ...context,
        event: { key: context.event },
        trace: context.trace.map((entry) => ({ ...entry, event: { key: entry.event } })),
      }),
  })),
}

export const chestScreenAdapter = fromDefinition(chestScreenExplorerDefinition)
