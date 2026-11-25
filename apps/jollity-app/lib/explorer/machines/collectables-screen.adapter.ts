// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { collectablesScreenMachineDefinition, type CollectablesScreenEventKey } from "../../state-machines/collectables-screen.definition"
import type { MachineDefinition } from "../../state-machines/framework"
import { fromDefinition } from "./from-definition"

type Definition = typeof collectablesScreenMachineDefinition
type Real = ReturnType<Definition["initialReal"]>
type Model = ReturnType<Definition["initialModel"]>
type RealOutput = ReturnType<Definition["realStep"]>["output"]
type ModelOutput = ReturnType<Definition["modelStep"]>["output"]
type Observation = ReturnType<Definition["observeReal"]>
type StateKey = ReturnType<Definition["realStateKey"]>

/**
 * collectables-screen's test events are their keys already ({ key }); the explorer steps the keys themselves, and keeps the
 * reducer, model, observations, declarations and invariants. None of its invariants reads the whole trace, so it needs
 * no trace monitor.
 */
const collectablesScreenExplorerDefinition: MachineDefinition<Real, Model, CollectablesScreenEventKey, RealOutput, ModelOutput, Observation, StateKey, CollectablesScreenEventKey> = {
  name: collectablesScreenMachineDefinition.name,
  initialReal: collectablesScreenMachineDefinition.initialReal,
  initialModel: collectablesScreenMachineDefinition.initialModel,
  realStep: (state, key) => collectablesScreenMachineDefinition.realStep(state, { key }),
  modelStep: (state, key) => collectablesScreenMachineDefinition.modelStep(state, { key }),
  classifyRealStep: collectablesScreenMachineDefinition.classifyRealStep,
  observeReal: collectablesScreenMachineDefinition.observeReal,
  observeModel: collectablesScreenMachineDefinition.observeModel,
  realStateKey: collectablesScreenMachineDefinition.realStateKey,
  modelStateKey: collectablesScreenMachineDefinition.modelStateKey,
  eventKey: (key) => key,
  transitionTable: collectablesScreenMachineDefinition.transitionTable,
  witnesses: [],
  regressions: [],
  invariants: collectablesScreenMachineDefinition.invariants.map((invariant) => ({
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

export const collectablesScreenAdapter = fromDefinition(collectablesScreenExplorerDefinition)
