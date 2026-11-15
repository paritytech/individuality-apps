// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import { clockSyncStep, createClockSync, type ClockEvent, type ClockSync } from "../clock-sync"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

/** Extraction-parity definition for the mutable page clock. Its separately
 * written model primarily proves preservation across reducer extraction;
 * named invariants retain the independently stated clock safety claims. */

type StateKey = "fresh" | "steady" | "pending" | "correcting"
type Event =
  | { kind: "target-forward" }
  | { kind: "target-back" }
  | { kind: "tick"; elapsedMs: number; zone: "waiting" | "game" | "boundary" }
  | { kind: "stale-tick" }
type EventKey = Event["kind"]

interface ModelClock {
  targetMs: number
  shownMs: number
  correcting: boolean
  lastDeviceMs?: number
}

interface Observation {
  targetMs: number
  shownMs: number
  correcting: boolean
  lastDeviceMs?: number
  commands: ClockEvent[]
}

const stateKey = (state: ClockSync | ModelClock): StateKey =>
  state.lastDeviceMs === undefined
    ? "fresh"
    : state.correcting
      ? "correcting"
      : Math.abs(state.targetMs - state.shownMs) > 250
        ? "pending"
        : "steady"

const targetFor = (state: ClockSync | ModelClock, event: Event): { targetMs: number } | null => {
  if (event.kind === "target-forward") return { targetMs: state.targetMs + 3_000 }
  if (event.kind === "target-back") return { targetMs: state.targetMs - 3_000 }
  return null
}

const gameFromFor = (state: ClockSync | ModelClock, event: Extract<Event, { kind: "tick" }>): number | undefined => {
  if (event.zone === "waiting") return undefined
  if (event.zone === "game") return 0
  return (state.lastDeviceMs ?? 0) + state.shownMs + 1_000
}

const realStep = (state: ClockSync, event: Event) => {
  const target = targetFor(state, event)
  if (target) return clockSyncStep(state, { type: "set-target", ...target })
  const last = state.lastDeviceMs ?? 0
  return clockSyncStep(state, {
    type: "advance",
    deviceMs: event.kind === "tick" ? last + event.elapsedMs : last,
    ...(event.kind === "tick" ? { gameFromMs: gameFromFor(state, event) } : {}),
  })
}

/** Separately written extraction-parity model of docs/time-and-clocks.md Rule 1. */
function modelStep(before: ModelClock, event: Event): { state: ModelClock; output: ClockEvent[] } {
  const state = { ...before }
  const output: ClockEvent[] = []
  const target = targetFor(state, event)
  if (target) {
    state.targetMs = target.targetMs
    state.correcting = false
    return { state, output }
  }

  const previousDeviceMs = state.lastDeviceMs
  const deviceMs = event.kind === "tick" ? (previousDeviceMs ?? 0) + event.elapsedMs : (previousDeviceMs ?? 0)
  if (previousDeviceMs !== undefined && deviceMs <= previousDeviceMs) return { state, output }
  state.lastDeviceMs = deviceMs
  if (previousDeviceMs === undefined) return { state, output }

  const gap = state.targetMs - state.shownMs
  if (!state.correcting && Math.abs(gap) <= 250) return { state, output }
  const gameFromMs = event.kind === "tick" ? gameFromFor(before, event) : undefined
  const waiting = gameFromMs === undefined || previousDeviceMs + state.shownMs < gameFromMs
  const big = Math.abs(gap) > 5_000
  const speed = gap > 0
    ? (waiting ? (big ? 4 : 2) : (big ? "jump" : 1.5))
    : (waiting ? (big ? 0.25 : 0.5) : (big ? 0.25 : 0.67))
  if (speed === "jump") {
    output.push({ kind: "jump", reason: "game", fromMs: state.shownMs, toMs: state.targetMs })
    state.shownMs = state.targetMs
    state.correcting = false
    return { state, output }
  }
  if (!state.correcting) {
    state.correcting = true
    if (Math.abs(gap) > 1_000)
      output.push({ kind: "correction", fromMs: state.shownMs, toMs: state.targetMs, speed })
  }
  const move = (speed - 1) * (deviceMs - previousDeviceMs)
  state.shownMs = Math.abs(move) >= Math.abs(gap) ? state.targetMs : state.shownMs + move
  if (
    waiting
    && gameFromMs !== undefined
    && deviceMs + state.shownMs >= gameFromMs
    && state.targetMs - state.shownMs > 250
  ) {
    output.push({ kind: "jump", reason: "tiles-enter", fromMs: state.shownMs, toMs: state.targetMs })
    state.shownMs = state.targetMs
    state.correcting = false
  } else if (state.shownMs === state.targetMs) {
    state.correcting = false
    output.push({ kind: "corrected", offsetMs: state.shownMs })
  }
  return { state, output }
}

const clockState = (key: StateKey): ClockSync => {
  if (key === "fresh") return createClockSync()
  if (key === "steady") return { targetMs: 0, shownMs: 0, correcting: false, lastDeviceMs: 1_000 }
  if (key === "pending") return { targetMs: 3_000, shownMs: 0, correcting: false, lastDeviceMs: 1_000 }
  return { targetMs: 3_000, shownMs: 100, correcting: true, lastDeviceMs: 1_000 }
}

const modelState = (key: StateKey): ModelClock => ({ ...clockState(key) })
const events: Record<EventKey, Event> = {
  "target-forward": { kind: "target-forward" },
  "target-back": { kind: "target-back" },
  tick: { kind: "tick", elapsedMs: 100, zone: "waiting" },
  "stale-tick": { kind: "stale-tick" },
}

export const clockSyncTransitionTable = defineTransitionTable<StateKey, EventKey>()({
  // A first sample while fresh is NOT impossible: applyAdvance's `last !== undefined` guard
  // does not fire when there is no baseline yet, so it stamps lastDeviceMs from this sample
  // and sends nothing. The state moves fresh -> steady, and the model stamps the same
  // baseline (ChiefOfStaff ruling, 29 Oct: the reducer is right, the table was written from
  // the model's early return rather than from the reducer).
  fresh: { "target-forward": "transition", "target-back": "transition", tick: "transition", "stale-tick": "transition" },
  steady: { "target-forward": "transition", "target-back": "transition", tick: "transition", "stale-tick": "no-op" },
  pending: { "target-forward": "transition", "target-back": "transition", tick: "transition", "stale-tick": "no-op" },
  correcting: { "target-forward": "transition", "target-back": "transition", tick: "transition", "stale-tick": "no-op" },
})

// The table declares no cell impossible (fresh × stale-tick is a transition),
// so the outcome is narrowed rather than compared against a value the type excludes.
export const clockSyncWitnesses: NamedSequence<Event, ClockSync, ModelClock>[] = Object.entries(clockSyncTransitionTable)
  .flatMap(([key, row]) => Object.entries(row).flatMap(([eventKey, outcome]) => [{
    name: `${key} ${eventKey} ${outcome}`,
    initial: { real: clockState(key as StateKey), model: modelState(key as StateKey) },
    events: [events[eventKey as EventKey]],
  }]))

export const clockSyncRegressions: NamedSequence<Event, ClockSync, ModelClock>[] = [
  {
    name: "smooth correction never reverses shown time (#1060)",
    initial: { real: clockState("steady"), model: modelState("steady") },
    events: [{ kind: "target-back" }, { kind: "tick", elapsedMs: 100, zone: "waiting" }],
  },
  {
    name: "tiles-enter boundary jumps a still-behind waiting clock",
    initial: {
      real: { targetMs: 3_000, shownMs: 0, correcting: false, lastDeviceMs: 0 },
      model: { targetMs: 3_000, shownMs: 0, correcting: false, lastDeviceMs: 0 },
    },
    events: [{ kind: "tick", elapsedMs: 500, zone: "boundary" }],
  },
  {
    name: "non-increasing device samples are inert",
    initial: { real: clockState("steady"), model: modelState("steady") },
    events: [{ kind: "stale-tick" }],
  },
  {
    name: "a first sample while fresh establishes the baseline and sends nothing",
    events: [{ kind: "stale-tick" }],
  },
]

const invariants: NamedInvariant<ClockSync, ModelClock, Event, Observation, StateKey, EventKey>[] = [
  {
    name: "shown clock never runs backward",
    specClause: "docs/time-and-clocks.md Rule 1; the shown clock updates smoothly (#1060)",
    check: ({ previousReal, real }) => {
      const before = (previousReal.lastDeviceMs ?? 0) + previousReal.shownMs
      const after = (real.lastDeviceMs ?? 0) + real.shownMs
      if (after < before) throw new Error(`${after} < ${before}`)
    },
  },
  {
    name: "clock state stays finite",
    specClause: "docs/time-and-clocks.md Rule 1 correction state",
    check: ({ real }) => {
      if (![real.targetMs, real.shownMs, real.lastDeviceMs ?? 0].every(Number.isFinite)) throw new Error("non-finite clock")
    },
  },
]

const observe = (state: ClockSync | ModelClock, commands: ClockEvent[]): Observation => ({ ...state, commands })

export const clockSyncMachineDefinition: MachineDefinition<ClockSync, ModelClock, Event, ClockEvent[], ClockEvent[], Observation, StateKey, EventKey> = {
  name: "clock-sync",
  initialReal: createClockSync,
  initialModel: () => ({ targetMs: 0, shownMs: 0, correcting: false }),
  realStep: (state, event) => {
    const result = realStep(state, event)
    return { state: result.state, output: result.commands }
  },
  modelStep,
  classifyRealStep: (previous, result) =>
    JSON.stringify(previous) === JSON.stringify(result.state) && result.output.length === 0 ? "no-op" : "transition",
  observeReal: ({ state, output }) => observe(state, output),
  observeModel: ({ state, output }) => observe(state, output),
  realStateKey: stateKey,
  modelStateKey: stateKey,
  eventKey: (event) => event.kind,
  transitionTable: clockSyncTransitionTable,
  witnesses: clockSyncWitnesses,
  regressions: clockSyncRegressions,
  invariants,
  sequenceArbitrary: fc.array(fc.oneof(
    fc.constant<Event>({ kind: "target-forward" }),
    fc.constant<Event>({ kind: "target-back" }),
    fc.constant<Event>({ kind: "stale-tick" }),
    fc.record({
      kind: fc.constant("tick" as const),
      elapsedMs: fc.integer({ min: 1, max: 2_000 }),
      zone: fc.constantFrom("waiting" as const, "game" as const, "boundary" as const),
    }),
  ), { minLength: 0, maxLength: 59 }).map((events) => [
    { kind: "tick" as const, elapsedMs: 1, zone: "waiting" as const },
    ...events,
  ]),
  numRuns: 300,
}
