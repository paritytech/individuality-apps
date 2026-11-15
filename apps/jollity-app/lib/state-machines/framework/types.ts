// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Arbitrary } from "fast-check"

export type TransitionDeclaration = "transition" | "no-op" | "impossible"

export type TransitionTable<StateKey extends string, EventKey extends string> = Record<
  StateKey,
  Record<EventKey, TransitionDeclaration>
>

interface StepResult<State, Output> {
  state: State
  output: Output
}

export interface TraceEntry<Event, Observation, StateKey extends string, EventKey extends string> {
  step: number
  before: StateKey
  eventKey: EventKey
  event: Event
  declared: TransitionDeclaration
  outcome: Exclude<TransitionDeclaration, "impossible">
  real: Observation
  model: Observation
}

interface InvariantContext<RealState, ModelState, Event, Observation, StateKey extends string, EventKey extends string> {
  previousReal: RealState
  previousModel: ModelState
  real: RealState
  model: ModelState
  event: Event
  realObservation: Observation
  modelObservation: Observation
  trace: readonly TraceEntry<Event, Observation, StateKey, EventKey>[]
}

export interface NamedInvariant<RealState, ModelState, Event, Observation, StateKey extends string, EventKey extends string> {
  name: string
  specClause: string
  check(context: InvariantContext<RealState, ModelState, Event, Observation, StateKey, EventKey>): void
}

interface InitialPair<RealState, ModelState> {
  real: RealState
  model: ModelState
}

export interface NamedSequence<Event, RealState = never, ModelState = never> {
  name: string
  events: readonly Event[]
  initial?: InitialPair<RealState, ModelState>
}

export interface MachineDefinition<
  RealState,
  ModelState,
  Event,
  RealOutput,
  ModelOutput,
  Observation,
  StateKey extends string,
  EventKey extends string,
> {
  name: string
  initialReal(): RealState
  initialModel(): ModelState
  initialArbitrary?: Arbitrary<InitialPair<RealState, ModelState>>
  realStep(state: RealState, event: Event): StepResult<RealState, RealOutput>
  modelStep(state: ModelState, event: Event): StepResult<ModelState, ModelOutput>
  classifyRealStep(previous: RealState, result: StepResult<RealState, RealOutput>): Exclude<TransitionDeclaration, "impossible">
  observeReal(result: StepResult<RealState, RealOutput>): Observation
  observeModel(result: StepResult<ModelState, ModelOutput>): Observation
  realStateKey(state: RealState): StateKey
  modelStateKey(state: ModelState): StateKey
  eventKey(event: Event): EventKey
  transitionTable: TransitionTable<StateKey, EventKey>
  witnesses: readonly NamedSequence<Event, RealState, ModelState>[]
  regressions: readonly NamedSequence<Event, RealState, ModelState>[]
  invariants: readonly NamedInvariant<RealState, ModelState, Event, Observation, StateKey, EventKey>[]
  sequenceArbitrary?: Arbitrary<readonly Event[]>
  generatedSequences?: () => readonly (readonly Event[])[]
  numRuns?: number
  reportDirectory?: string
}

export interface CoverageReport {
  machine: string
  seed: number
  declared: number
  hit: number
  missing: string[]
  impossibleObserved: string[]
  hits: Record<string, number>
  generatedSequenceLengths?: {
    count: number
    min: number
    mean: number
    p50: number
    p95: number
    max: number
  }
}
