// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { sendAdaptationMachineDefinition } from "../../state-machines/send-adaptation.definition"
import type { MachineDefinition } from "../../state-machines/framework"
import { fromDefinition } from "./from-definition"

type Definition = typeof sendAdaptationMachineDefinition
type RealState = Parameters<Definition["realStep"]>[0]
type ModelState = Parameters<Definition["modelStep"]>[0]
type Context = Omit<Parameters<Definition["invariants"][number]["check"]>[0], "event"> & { event: Action }
type Action = Parameters<Definition["eventKey"]>[0]["action"]

/**
 * send-adaptation's events are `{ action }` objects, while fromDefinition's alphabet is the event key itself, so
 * the definition is seen through its action string: the key is the event, and each step and invariant gets the
 * object back. Nothing else about the definition changes.
 */
export const sendAdaptationAsStringEvents = (definition: Definition) => {
  const wrap = (action: Action) => ({ action })
  return fromDefinition({
    ...definition,
    realStep: (state: RealState, action: Action) => definition.realStep(state, wrap(action)),
    modelStep: (state: ModelState, action: Action) => definition.modelStep(state, wrap(action)),
    eventKey: (action: Action) => action,
    invariants: definition.invariants.map((invariant) => ({
      ...invariant,
      check: (context: Context) => invariant.check({ ...context, event: wrap(context.event) }),
    })),
  } as unknown as MachineDefinition<
    Parameters<Definition["realStep"]>[0], Parameters<Definition["modelStep"]>[0], Action,
    ReturnType<Definition["realStep"]>["output"], ReturnType<Definition["modelStep"]>["output"],
    ReturnType<Definition["observeReal"]>, ReturnType<Definition["realStateKey"]>, Action
  >)
}

// every send-adaptation invariant reads one step (previousReal, real, event, realObservation), so there is no trace monitor
export const sendAdaptationAdapter = sendAdaptationAsStringEvents(sendAdaptationMachineDefinition)
