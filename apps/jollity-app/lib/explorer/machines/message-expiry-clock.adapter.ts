// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { messageExpiryMachineDefinition } from "../../state-machines/message-expiry-clock.definition"
import type { MachineDefinition } from "../../state-machines/framework"
import { fromDefinition } from "./from-definition"

type Definition = typeof messageExpiryMachineDefinition
type EventKey = Parameters<Definition["eventKey"]>[0]["kind"]
type RealState = Parameters<Definition["realStep"]>[0]
type ModelState = Parameters<Definition["modelStep"]>[0]
type DefinitionInvariantContext = Parameters<Definition["invariants"][number]["check"]>[0]
type StringEventInvariantContext = Omit<DefinitionInvariantContext, "event"> & { event: EventKey }

/**
 * message-expiry-clock's events are `{ kind }` objects, while fromDefinition's alphabet is the event key itself,
 * so the definition is seen through its kind string. Each step and single-step invariant gets the object back.
 */
export const messageExpiryClockAsStringEvents = (definition: Definition) => {
  const wrap = (kind: EventKey) => ({ kind })
  return fromDefinition({
    ...definition,
    realStep: (state: RealState, kind: EventKey) => definition.realStep(state, wrap(kind)),
    modelStep: (state: ModelState, kind: EventKey) => definition.modelStep(state, wrap(kind)),
    eventKey: (kind: EventKey) => kind,
    invariants: definition.invariants.map((invariant) => ({
      ...invariant,
      check: (context: StringEventInvariantContext) => invariant.check({ ...context, event: wrap(context.event) }),
    })),
  } as unknown as MachineDefinition<
    Parameters<Definition["realStep"]>[0], Parameters<Definition["modelStep"]>[0], EventKey,
    ReturnType<Definition["realStep"]>["output"], ReturnType<Definition["modelStep"]>["output"],
    ReturnType<Definition["observeReal"]>, ReturnType<Definition["realStateKey"]>, EventKey
  >)
}

// every message-expiry-clock invariant reads one step only, so there is no trace monitor
export const messageExpiryClockAdapter = messageExpiryClockAsStringEvents(messageExpiryMachineDefinition)
