// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  createStoreCalibrationState,
  storeCalibrationStep,
  type StoreCalibrationCommand,
  type StoreCalibrationState,
} from "../store-calibration"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

/** Extraction-parity definition for the retained calibration coordinator. Its
 * separately written model primarily proves preservation across extraction;
 * named invariants retain the independently stated attempt-safety claims. */

type StateKey = StoreCalibrationState["status"]
type Event =
  | { kind: "request-early" }
  | { kind: "request-ready" }
  | { kind: "settle-accepted" }
  | { kind: "settle-failed" }
type EventKey = Event["kind"]

interface ModelState {
  status: StateKey
  failedAtMs: number | null
}

interface Observation {
  state: ModelState
  commands: string[]
}

const realState = (key: StateKey): StoreCalibrationState =>
  key === "failed" ? { status: "failed", failedAtMs: 10_000 } : { status: key, failedAtMs: null }

const modelState = (key: StateKey): ModelState => ({ ...realState(key) })

const inputFor = (state: StoreCalibrationState | ModelState, event: Event) => {
  if (event.kind === "request-early") {
    return { type: "request" as const, nowMs: state.failedAtMs === null ? 10_000 : state.failedAtMs + 29_999 }
  }
  if (event.kind === "request-ready") {
    return { type: "request" as const, nowMs: state.failedAtMs === null ? 10_000 : state.failedAtMs + 30_000 }
  }
  return {
    type: "settled" as const,
    nowMs: 20_000,
    outcome: event.kind === "settle-failed" ? "failed" as const : "accepted" as const,
  }
}

/** Separately written extraction-parity model of the retained calibration contract. */
function modelStep(before: ModelState, event: Event): { state: ModelState; output: StoreCalibrationCommand[] } {
  const input = inputFor(before, event)
  if (input.type === "request") {
    const mayStart = before.status === "idle"
      || (before.status === "failed" && before.failedAtMs !== null && input.nowMs - before.failedAtMs >= 30_000)
    return mayStart
      ? { state: { status: "running", failedAtMs: null }, output: [{ type: "start" }] }
      : { state: { ...before }, output: [] }
  }
  if (before.status !== "running") return { state: { ...before }, output: [] }
  return input.outcome === "failed"
    ? { state: { status: "failed", failedAtMs: input.nowMs }, output: [] }
    : { state: { status: "succeeded", failedAtMs: null }, output: [] }
}

export const storeCalibrationTransitionTable = defineTransitionTable<StateKey, EventKey>()({
  idle: { "request-early": "transition", "request-ready": "transition", "settle-accepted": "no-op", "settle-failed": "no-op" },
  running: { "request-early": "no-op", "request-ready": "no-op", "settle-accepted": "transition", "settle-failed": "transition" },
  succeeded: { "request-early": "no-op", "request-ready": "no-op", "settle-accepted": "no-op", "settle-failed": "no-op" },
  failed: { "request-early": "no-op", "request-ready": "transition", "settle-accepted": "no-op", "settle-failed": "no-op" },
})

const events: Record<EventKey, Event> = {
  "request-early": { kind: "request-early" },
  "request-ready": { kind: "request-ready" },
  "settle-accepted": { kind: "settle-accepted" },
  "settle-failed": { kind: "settle-failed" },
}

export const storeCalibrationWitnesses: NamedSequence<Event, StoreCalibrationState, ModelState>[] =
  Object.entries(storeCalibrationTransitionTable).flatMap(([key, row]) =>
    Object.entries(row).map(([eventKey]) => ({
      name: `${key} ${eventKey}`,
      initial: { real: realState(key as StateKey), model: modelState(key as StateKey) },
      events: [events[eventKey as EventKey]],
    })),
  )

export const storeCalibrationRegressions: NamedSequence<Event, StoreCalibrationState, ModelState>[] = [
  {
    name: "failed calibration is retained before 30 seconds and retries at the boundary",
    initial: { real: realState("failed"), model: modelState("failed") },
    events: [{ kind: "request-early" }, { kind: "request-ready" }],
  },
  {
    name: "only the running attempt may settle",
    events: [{ kind: "settle-failed" }, { kind: "request-ready" }, { kind: "settle-accepted" }],
  },
]

const invariants: NamedInvariant<StoreCalibrationState, ModelState, Event, Observation, StateKey, EventKey>[] = [
  {
    name: "at most one retained attempt starts",
    specClause: "docs/time-and-clocks.md Rule 2: calibration runs at most once at a time",
    check: ({ real, realObservation }) => {
      if (realObservation.commands.length > 1) throw new Error("multiple start commands")
      if (realObservation.commands.length === 1 && real.status !== "running") throw new Error("start outside running")
    },
  },
  {
    name: "a failed attempt records its retry epoch",
    specClause: "lib/store-calibration.ts RETRY_AFTER_MS retention rule",
    check: ({ real }) => {
      if ((real.status === "failed") !== (real.failedAtMs !== null)) throw new Error("failedAtMs/status mismatch")
    },
  },
]

const observe = (state: StoreCalibrationState | ModelState, commands: StoreCalibrationCommand[]): Observation => ({
  state: { ...state },
  commands: commands.map((command) => command.type),
})

export const storeCalibrationMachineDefinition: MachineDefinition<
  StoreCalibrationState,
  ModelState,
  Event,
  StoreCalibrationCommand[],
  StoreCalibrationCommand[],
  Observation,
  StateKey,
  EventKey
> = {
  name: "store-calibration",
  initialReal: createStoreCalibrationState,
  initialModel: () => ({ status: "idle", failedAtMs: null }),
  realStep: (state, event) => {
    const result = storeCalibrationStep(state, inputFor(state, event))
    return { state: result.state, output: result.commands }
  },
  modelStep,
  classifyRealStep: (previous, result) =>
    JSON.stringify(previous) === JSON.stringify(result.state) && result.output.length === 0 ? "no-op" : "transition",
  observeReal: ({ state, output }) => observe(state, output),
  observeModel: ({ state, output }) => observe(state, output),
  realStateKey: (state) => state.status,
  modelStateKey: (state) => state.status,
  eventKey: (event) => event.kind,
  transitionTable: storeCalibrationTransitionTable,
  witnesses: storeCalibrationWitnesses,
  regressions: storeCalibrationRegressions,
  invariants,
  sequenceArbitrary: fc.array(fc.constantFrom<Event>(...Object.values(events)), { minLength: 0, maxLength: 40 }),
  numRuns: 300,
}
