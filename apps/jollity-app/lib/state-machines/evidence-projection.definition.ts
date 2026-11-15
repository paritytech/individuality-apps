// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  emptyEvidenceProjection,
  evidenceProjection,
  type EvidenceProjectionEvent,
  type EvidenceProjectionState,
  type EvidenceVote,
} from "../evidence-projection"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

const EVENTS = ["enter-confirm", "leave-confirm-backward-clock", "gate-ready", "gate-not-ready", "restore", "restore-flipped", "override-seen", "override-no-video"] as const
const OVERRIDES = ["none", "person", "notperson"] as const
const PHASES = ["open", "closed", "gated"] as const

type TestEvent = (typeof EVENTS)[number]
type OverrideKey = (typeof OVERRIDES)[number]
type Phase = (typeof PHASES)[number]
type StateKey = `${Phase}|override:${OverrideKey}|flipped:${0 | 1}`

interface ModelEvidenceState {
  phase: Phase
  evidenceEpoch: number
  override: OverrideKey
  flipped: boolean
  frozenSeen: boolean
}

interface EvidenceObservation {
  phase: Phase
  evidenceEpoch: number
  override: OverrideKey
  flipped: boolean
  frozenSeen: boolean
}

const stateKey = (state: Pick<ModelEvidenceState, "phase" | "override" | "flipped">): StateKey =>
  `${state.phase}|override:${state.override}|flipped:${state.flipped ? 1 : 0}`

function initialReal(phase: Phase, override: OverrideKey, flipped: boolean): EvidenceProjectionState {
  return {
    ...emptyEvidenceProjection(),
    evidenceEpoch: phase === "open" ? 0 : 1,
    intakeClosed: phase !== "open",
    confirmGateOpen: phase === "gated",
    frozenVideoRoleHistory: phase === "gated" ? { peer: { fromTurn: 1 } } : null,
    finalOverrides: override === "none" ? {} : { peer: override },
    unseenFlipped: flipped ? new Set(["peer"]) : new Set(),
  }
}

function initialModel(phase: Phase, override: OverrideKey, flipped: boolean): ModelEvidenceState {
  return {
    phase,
    evidenceEpoch: phase === "open" ? 0 : 1,
    override,
    flipped,
    frozenSeen: phase === "gated",
  }
}

/** A flip can only ever be seen WITH an override. The real reducer sets `unseenFlipped`
 *  in exactly two places, and each one writes `finalOverrides[id]` on the same step:
 *    - `restore-choices` (lib/evidence-projection.ts:75-82) unions the restored
 *      `unseenFlipped` into the state while merging `event.overrides` into
 *      `finalOverrides`; the definition's own `restore-flipped` event carries
 *      `{ overrides: { peer: "notperson" }, unseenFlipped: ["peer"] }`, so both move.
 *    - `override` (lib/evidence-projection.ts:84-93) adds `event.id` to `flipped` only
 *      when `event.noVideo && event.changed`, and on the same step writes
 *      `finalOverrides[event.id] = event.verdict`.
 *  So `override:none` together with `flipped:1` is not a reachable state: it would need a
 *  flip with no override written, and no event does that. Those states are dropped from the
 *  case list entirely, so the table, the witnesses and the arbitrary all stop generating
 *  them; and the table declares every one of their cells impossible, so if the reducer ever
 *  starts producing one the suite fails loudly (framework/runner.ts:67). */
const UNREACHABLE_FLIP_WITHOUT_OVERRIDE = ["open|override:none|flipped:1", "closed|override:none|flipped:1", "gated|override:none|flipped:1"] as const

const stateCases = PHASES.flatMap((phase) =>
  OVERRIDES.flatMap((override) =>
    [false, true]
      .map((flipped) => ({
        key: `${phase}|override:${override}|flipped:${flipped ? 1 : 0}` as StateKey,
        real: initialReal(phase, override, flipped),
        model: initialModel(phase, override, flipped),
      }))
      .filter(({ key }) => !(UNREACHABLE_FLIP_WITHOUT_OVERRIDE as readonly string[]).includes(key)),
  ),
)

function concreteEvent(event: TestEvent): EvidenceProjectionEvent {
  switch (event) {
    case "enter-confirm":
      return { kind: "enter-confirm" }
    case "leave-confirm-backward-clock":
      return { kind: "leave-confirm-backward-clock" }
    case "gate-ready":
      return { kind: "open-confirm-gate", ready: true, videoRoleHistory: { peer: { fromTurn: 1 } } }
    case "gate-not-ready":
      return { kind: "open-confirm-gate", ready: false, videoRoleHistory: { peer: { fromTurn: 1 } } }
    case "restore":
      return { kind: "restore-choices", overrides: { peer: "notperson" }, unseenFlipped: undefined }
    case "restore-flipped":
      return { kind: "restore-choices", overrides: { peer: "notperson" }, unseenFlipped: ["peer"] }
    case "override-seen":
      return { kind: "override", id: "peer", verdict: "person", changed: true, noVideo: false }
    case "override-no-video":
      return { kind: "override", id: "peer", verdict: "person", changed: true, noVideo: true }
  }
}

function modelStep(before: ModelEvidenceState, event: TestEvent): { state: ModelEvidenceState; output: never[] } {
  const state = { ...before }
  switch (event) {
    case "enter-confirm":
      if (state.phase === "open") {
        state.phase = "closed"
        state.evidenceEpoch++
      }
      break
    case "leave-confirm-backward-clock":
      break
    case "gate-ready":
      if (state.phase === "closed") {
        state.phase = "gated"
        state.frozenSeen = true
      }
      break
    case "gate-not-ready":
      break
    case "restore":
      if (state.override === "none") state.override = "notperson"
      break
    case "restore-flipped":
      if (state.override === "none") state.override = "notperson"
      state.flipped = true
      break
    case "override-seen":
      state.override = "person"
      break
    case "override-no-video":
      state.override = "person"
      state.flipped = true
      break
  }
  return { state, output: [] }
}

function observeReal(state: EvidenceProjectionState): EvidenceObservation {
  const override = state.finalOverrides.peer as EvidenceVote | undefined
  return {
    phase: state.confirmGateOpen ? "gated" : state.intakeClosed ? "closed" : "open",
    evidenceEpoch: state.evidenceEpoch,
    override: override ?? "none",
    flipped: state.unseenFlipped.has("peer"),
    frozenSeen: state.frozenVideoRoleHistory?.peer !== undefined,
  }
}

const observeModel = (state: ModelEvidenceState): EvidenceObservation => ({ ...state })

const modelOutcome = (before: ModelEvidenceState, event: TestEvent): "transition" | "no-op" => {
  const after = modelStep(before, event)
  return JSON.stringify(before) === JSON.stringify(after.state) ? "no-op" : "transition"
}

/** Every cell of an unreachable state is impossible: the state itself cannot be entered.
 *  The rows are still PRESENT in the table, so the guarantee is declared rather than merely
 *  absent, and an observed one fails the suite (framework/runner.ts:67). */
export const evidenceProjectionTransitionTable = defineTransitionTable<StateKey, TestEvent>()(
  Object.fromEntries([
    // the reachable states, judged by the model
    ...stateCases.map(({ key, model }) => [key, Object.fromEntries(EVENTS.map((event) => [event, modelOutcome(model, event)]))] as const),
    // the unreachable ones, every cell impossible
    ...UNREACHABLE_FLIP_WITHOUT_OVERRIDE.map((key) => [key, Object.fromEntries(EVENTS.map((event) => [event, "impossible" as const]))] as const),
  ]) as Record<StateKey, Record<TestEvent, "transition" | "no-op" | "impossible">>,
)

export const evidenceProjectionWitnesses: NamedSequence<TestEvent, EvidenceProjectionState, ModelEvidenceState>[] = stateCases.flatMap(
  ({ key, real, model }) => EVENTS.map((event) => ({ name: `${key} × ${event}`, initial: { real, model }, events: [event] })),
)

export const evidenceProjectionRegressionCorpus: NamedSequence<TestEvent, EvidenceProjectionState, ModelEvidenceState>[] = [
  { name: "confirm boundary and delayed gate", events: ["enter-confirm", "gate-not-ready", "gate-ready"] },
  { name: "confirm boundary is one-way after backward clock correction", events: ["enter-confirm", "leave-confirm-backward-clock", "gate-ready"] },
  { name: "local override wins over restore", events: ["override-seen", "restore"] },
  { name: "unseen flip provenance is sticky", events: ["override-no-video", "override-seen", "restore"] },
]

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const invariants: NamedInvariant<EvidenceProjectionState, ModelEvidenceState, TestEvent, EvidenceObservation, StateKey, TestEvent>[] = [
  {
    name: "evidence epoch never regresses or skips",
    specClause: "the freeze epoch never decreases",
    check: ({ previousReal, real }) =>
      assert(real.evidenceEpoch === previousReal.evidenceEpoch || real.evidenceEpoch === previousReal.evidenceEpoch + 1, "evidence epoch skipped or regressed"),
  },
  {
    name: "confirm closes intake one way",
    specClause: "the confirm latch is one-way",
    check: ({ previousReal, real }) => {
      if (previousReal.intakeClosed) assert(real.intakeClosed, "evidence intake reopened")
    },
  },
  {
    name: "confirm gate opens one way",
    specClause: "confirm waits for the books and the clock",
    check: ({ previousReal, real }) => {
      if (previousReal.confirmGateOpen) assert(real.confirmGateOpen, "confirm gate closed")
    },
  },
  {
    name: "frozen evidence never changes",
    specClause: "frozen evidence is projected exactly",
    check: ({ previousReal, real }) => {
      if (previousReal.frozenVideoRoleHistory !== null)
        assert(JSON.stringify(real.frozenVideoRoleHistory) === JSON.stringify(previousReal.frozenVideoRoleHistory), "frozen evidence changed")
    },
  },
]

const eventArbitrary = fc.constantFrom<TestEvent>(...EVENTS)

export const evidenceProjectionMachineDefinition: MachineDefinition<
  EvidenceProjectionState,
  ModelEvidenceState,
  TestEvent,
  never[],
  never[],
  EvidenceObservation,
  StateKey,
  TestEvent
> = {
  name: "evidence-projection",
  initialReal: () => initialReal("open", "none", false),
  initialModel: () => initialModel("open", "none", false),
  initialArbitrary: fc.constantFrom(...stateCases.map(({ real, model }) => ({ real, model }))),
  realStep: (state, event) => ({ state: evidenceProjection(state, concreteEvent(event)), output: [] }),
  modelStep,
  classifyRealStep: (previous, result) => JSON.stringify(observeReal(previous)) === JSON.stringify(observeReal(result.state)) ? "no-op" : "transition",
  observeReal: ({ state }) => observeReal(state),
  observeModel: ({ state }) => observeModel(state),
  realStateKey: (state) => stateKey(observeReal(state)),
  modelStateKey: stateKey,
  eventKey: (event) => event,
  transitionTable: evidenceProjectionTransitionTable,
  witnesses: evidenceProjectionWitnesses,
  regressions: evidenceProjectionRegressionCorpus,
  invariants,
  sequenceArbitrary: fc.array(eventArbitrary, { minLength: 0, maxLength: 60, size: "max" }),
  numRuns: 300,
}
