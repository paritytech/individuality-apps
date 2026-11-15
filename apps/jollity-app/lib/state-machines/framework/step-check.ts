// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { MachineDefinition, TraceEntry, TransitionDeclaration } from "./types"

export interface StepCheckInput<R, M, E, Ob, SK extends string, EK extends string> {
  definition: MachineDefinition<R, M, E, unknown, unknown, Ob, SK, EK>
  real: R
  model: M
  event: E
  step: number
  label: string
  trace: TraceEntry<E, Ob, SK, EK>[]
}

export interface StepCheckOutput<R, M, SK extends string, EK extends string> {
  real: R
  model: M
  stateKey: SK
  eventKey: EK
  outcome: Exclude<TransitionDeclaration, "impossible">
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]))
  }
  return value
}

const stable = (value: unknown): string => JSON.stringify(canonical(value))

function observationsEqual(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right)
}

/**
 * One step of the framework's check: state keys agree, the pair is declared, the real outcome matches the
 * declaration, observations agree and every invariant holds. Pushes onto input.trace. onRecord sees the pair
 * where coverage is recorded: "impossible" before the throw, the classified outcome before the declaration check.
 */
export function checkStep<R, M, E, Ob, SK extends string, EK extends string>(
  input: StepCheckInput<R, M, E, Ob, SK, EK>,
  onRecord?: (stateKey: SK, eventKey: EK, outcome: TransitionDeclaration) => void,
): StepCheckOutput<R, M, SK, EK> {
  const { definition, event, step, label, trace } = input
  const realBefore = input.real
  const modelBefore = input.model
  const realKey = definition.realStateKey(realBefore)
  const modelKey = definition.modelStateKey(modelBefore)
  if (realKey !== modelKey) throw new Error(`${definition.name}/${label} step ${step}: state-key mismatch ${realKey} != ${modelKey}`)
  const eventKey = definition.eventKey(event)
  const declared = definition.transitionTable[realKey]?.[eventKey]
  if (!declared) throw new Error(`${definition.name}/${label} step ${step}: undeclared pair ${realKey}::${eventKey}`)
  if (declared === "impossible") {
    onRecord?.(realKey, eventKey, "impossible")
    throw new Error(`${definition.name}/${label} step ${step}: observed impossible pair ${realKey}::${eventKey}`)
  }

  const realResult = definition.realStep(realBefore, event)
  const modelResult = definition.modelStep(modelBefore, event)
  const outcome = definition.classifyRealStep(realBefore, realResult)
  onRecord?.(realKey, eventKey, outcome)
  if (outcome !== declared) {
    throw new Error(`${definition.name}/${label} step ${step}: declared ${realKey}::${eventKey} as ${declared}, observed ${outcome}`)
  }
  const real = realResult.state
  const model = modelResult.state
  const realObservation = definition.observeReal(realResult)
  const modelObservation = definition.observeModel(modelResult)
  trace.push({ step, before: realKey, eventKey, event, declared, outcome, real: realObservation, model: modelObservation })
  if (!observationsEqual(realObservation, modelObservation)) {
    throw new Error(
      `${definition.name}/${label} step ${step} observation mismatch\nevent=${JSON.stringify(event)}\nreal=${JSON.stringify(realObservation)}\nmodel=${JSON.stringify(modelObservation)}`,
    )
  }
  for (const invariant of definition.invariants) {
    try {
      invariant.check({ previousReal: realBefore, previousModel: modelBefore, real, model, event, realObservation, modelObservation, trace })
    } catch (error) {
      throw new Error(
        `${definition.name}/${label} step ${step} invariant ${invariant.name} (${invariant.specClause}) failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return { real, model, stateKey: realKey, eventKey, outcome }
}
