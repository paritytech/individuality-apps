// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  collectablesRereadStep,
  createCollectablesRereadState,
  type CollectablesRereadCommand,
  type CollectablesRereadEvent,
  type CollectablesRereadState,
} from "../collectables-reread"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

/**
 * Independent model written from the collectables-reread header rules:
 *
 * C1 the already-bounded read is followed at 30 s, then 60 s, then 120 s;
 * C2 the 120 s delay is a cap, not another escalation;
 * C3 a visible foreground return asks immediately;
 * C4 hidden or already-busy triggers coalesce into one owed read;
 * C5 reads never overlap, and a failed owed read starts immediately once visible;
 * C6 a successful read stops the timer loop, while a later foreground return
 *    may still refresh (the pre-extraction closure's documented foreground rule);
 * C7 stop cancels the timer, unsubscribes once and makes every late event inert.
 */

const EVENTS = [
  "start", "timer-visible", "timer-hidden", "shown-visible", "shown-hidden",
  "success-visible", "success-hidden", "failure-visible", "failure-hidden", "stop",
] as const
export type CollectablesRereadTestEvent = (typeof EVENTS)[number]
type StateKey = "idle" | "queued" | "queued-due" | "dormant" | "dormant-due" | "busy" | "busy-due" | "stopped"

interface ModelState {
  life: "new" | "queued" | "busy" | "cancelled"
  misses: number
  wakeOwed: boolean
  alarm: boolean
}
interface Observation {
  life: StateKey
  misses: number
  commands: string[]
}

const eventOf = (event: CollectablesRereadTestEvent): CollectablesRereadEvent => {
  if (event === "start" || event === "stop") return { kind: event }
  const hidden = event.endsWith("hidden")
  if (event.startsWith("timer") || event.startsWith("shown")) return { kind: "trigger", hidden }
  return { kind: "read-finished", recovered: event.startsWith("success"), hidden }
}

const keyOfModel = (state: ModelState): StateKey => {
  if (state.life === "new") return "idle"
  if (state.life === "cancelled") return "stopped"
  if (state.life === "busy") return state.wakeOwed ? "busy-due" : "busy"
  if (!state.alarm) return state.wakeOwed ? "dormant-due" : "dormant"
  return state.wakeOwed ? "queued-due" : "queued"
}
const keyOfReal = (state: CollectablesRereadState): StateKey => {
  if (state.phase === "idle") return "idle"
  if (state.phase === "stopped") return "stopped"
  if (state.phase === "reading") return state.due ? "busy-due" : "busy"
  if (!state.timerHeld) return state.due ? "dormant-due" : "dormant"
  return state.due ? "queued-due" : "queued"
}

const delay = (misses: number): number => misses === 0 ? 30_000 : misses === 1 ? 60_000 : 120_000
const commandWords = (commands: readonly CollectablesRereadCommand[]): string[] => commands.map((command) =>
  command.kind === "schedule" ? `schedule:${command.delayMs}` : command.kind,
)

/** Rule-list model: lifecycle, an alarm token and one coalesced wake token. */
function modelStep(before: ModelState, event: CollectablesRereadTestEvent): { state: ModelState; output: string[] } {
  if (event === "stop") {
    if (before.life === "cancelled") return { state: before, output: [] }
    return { state: { ...before, life: "cancelled", wakeOwed: false, alarm: false }, output: [...(before.alarm ? ["clear-timer"] : []), "unsubscribe"] }
  }
  if (before.life === "cancelled") return { state: before, output: [] }
  if (event === "start") {
    if (before.life !== "new") return { state: before, output: [] }
    return { state: { ...before, life: "queued", alarm: true }, output: [`schedule:${delay(before.misses)}`] }
  }
  if (event.startsWith("success") || event.startsWith("failure")) {
    if (before.life !== "busy") return { state: before, output: [] }
    if (event.startsWith("success")) return { state: { ...before, life: "queued", wakeOwed: false, alarm: false }, output: [] }
    const misses = before.misses + 1
    if (before.wakeOwed && event.endsWith("visible"))
      return { state: { ...before, misses, wakeOwed: false }, output: ["reread"] }
    return { state: { ...before, life: "queued", misses, alarm: true }, output: [`schedule:${delay(misses)}`] }
  }
  if (before.life === "new") return { state: before, output: [] }
  if (event.endsWith("hidden") || before.life === "busy")
    return { state: { ...before, wakeOwed: true }, output: [] }
  return {
    state: { ...before, life: "busy", wakeOwed: false, alarm: false },
    output: [...(before.alarm ? ["clear-timer"] : []), "reread"],
  }
}

const realCases: Record<StateKey, CollectablesRereadState> = {
  idle: { phase: "idle", failedRereads: 0, due: false, timerHeld: false },
  queued: { phase: "waiting", failedRereads: 1, due: false, timerHeld: true },
  "queued-due": { phase: "waiting", failedRereads: 2, due: true, timerHeld: true },
  dormant: { phase: "waiting", failedRereads: 1, due: false, timerHeld: false },
  "dormant-due": { phase: "waiting", failedRereads: 1, due: true, timerHeld: false },
  busy: { phase: "reading", failedRereads: 1, due: false, timerHeld: false },
  "busy-due": { phase: "reading", failedRereads: 2, due: true, timerHeld: false },
  stopped: { phase: "stopped", failedRereads: 2, due: false, timerHeld: false },
}
const modelCases: Record<StateKey, ModelState> = {
  idle: { life: "new", misses: 0, wakeOwed: false, alarm: false },
  queued: { life: "queued", misses: 1, wakeOwed: false, alarm: true },
  "queued-due": { life: "queued", misses: 2, wakeOwed: true, alarm: true },
  dormant: { life: "queued", misses: 1, wakeOwed: false, alarm: false },
  "dormant-due": { life: "queued", misses: 1, wakeOwed: true, alarm: false },
  busy: { life: "busy", misses: 1, wakeOwed: false, alarm: false },
  "busy-due": { life: "busy", misses: 2, wakeOwed: true, alarm: false },
  stopped: { life: "cancelled", misses: 2, wakeOwed: false, alarm: false },
}

/** Contract outcomes transcribed from C1-C7 above, not inferred by executing
 * the reference model or the production reducer. */
export const collectablesRereadTransitionTable = defineTransitionTable<StateKey, CollectablesRereadTestEvent>()({
  idle: {
    start: "transition", "timer-visible": "no-op", "timer-hidden": "no-op", "shown-visible": "no-op", "shown-hidden": "no-op",
    "success-visible": "no-op", "success-hidden": "no-op", "failure-visible": "no-op", "failure-hidden": "no-op", stop: "transition",
  },
  queued: {
    start: "no-op", "timer-visible": "transition", "timer-hidden": "transition", "shown-visible": "transition", "shown-hidden": "transition",
    "success-visible": "no-op", "success-hidden": "no-op", "failure-visible": "no-op", "failure-hidden": "no-op", stop: "transition",
  },
  "queued-due": {
    start: "no-op", "timer-visible": "transition", "timer-hidden": "no-op", "shown-visible": "transition", "shown-hidden": "no-op",
    "success-visible": "no-op", "success-hidden": "no-op", "failure-visible": "no-op", "failure-hidden": "no-op", stop: "transition",
  },
  dormant: {
    start: "no-op", "timer-visible": "transition", "timer-hidden": "transition", "shown-visible": "transition", "shown-hidden": "transition",
    "success-visible": "no-op", "success-hidden": "no-op", "failure-visible": "no-op", "failure-hidden": "no-op", stop: "transition",
  },
  "dormant-due": {
    start: "no-op", "timer-visible": "transition", "timer-hidden": "no-op", "shown-visible": "transition", "shown-hidden": "no-op",
    "success-visible": "no-op", "success-hidden": "no-op", "failure-visible": "no-op", "failure-hidden": "no-op", stop: "transition",
  },
  busy: {
    start: "no-op", "timer-visible": "transition", "timer-hidden": "transition", "shown-visible": "transition", "shown-hidden": "transition",
    "success-visible": "transition", "success-hidden": "transition", "failure-visible": "transition", "failure-hidden": "transition", stop: "transition",
  },
  "busy-due": {
    start: "no-op", "timer-visible": "no-op", "timer-hidden": "no-op", "shown-visible": "no-op", "shown-hidden": "no-op",
    "success-visible": "transition", "success-hidden": "transition", "failure-visible": "transition", "failure-hidden": "transition", stop: "transition",
  },
  stopped: {
    start: "no-op", "timer-visible": "no-op", "timer-hidden": "no-op", "shown-visible": "no-op", "shown-hidden": "no-op",
    "success-visible": "no-op", "success-hidden": "no-op", "failure-visible": "no-op", "failure-hidden": "no-op", stop: "no-op",
  },
})

export const collectablesRereadWitnesses: NamedSequence<CollectablesRereadTestEvent, CollectablesRereadState, ModelState>[] =
  (Object.keys(modelCases) as StateKey[]).flatMap((key) => EVENTS.map((event) => ({
    name: `${key} × ${event}`,
    initial: { real: realCases[key], model: modelCases[key] },
    events: [event],
  })))

export const collectablesRereadRegressions: NamedSequence<CollectablesRereadTestEvent, CollectablesRereadState, ModelState>[] = [
  { name: "30 s, 60 s, then capped 120 s", events: ["start", "timer-visible", "failure-visible", "timer-visible", "failure-visible", "timer-visible", "failure-visible"] },
  { name: "hidden timer is owed and foreground fires immediately", events: ["start", "timer-hidden", "shown-visible"] },
  { name: "duplicate busy triggers coalesce into one follow-up", events: ["start", "timer-visible", "shown-visible", "timer-visible", "failure-visible"] },
  { name: "successful read cancels cadence but a later foreground refreshes", events: ["start", "timer-visible", "success-visible", "shown-visible"] },
  { name: "late failure and duplicate stop are inert", events: ["start", "timer-visible", "stop", "failure-visible", "stop", "shown-visible"] },
  { name: "stale completions before any read are ignored", events: ["failure-visible", "success-hidden", "start"] },
]

const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
const invariants: NamedInvariant<CollectablesRereadState, ModelState, CollectablesRereadTestEvent, Observation, StateKey, CollectablesRereadTestEvent>[] = [
  {
    name: "retry cadence is 30 s, 60 s, then capped at 120 s",
    specClause: "C1/C2 collectables-reread module header",
    check: ({ realObservation }) => realObservation.commands.filter((word) => word.startsWith("schedule:")).forEach((word) => {
      assert(["schedule:30000", "schedule:60000", "schedule:120000"].includes(word), `bad delay ${word}`)
    }),
  },
  {
    name: "hidden triggers never begin a read",
    specClause: "C3/C4 foreground return and hidden coalescing",
    check: ({ event, realObservation }) => {
      if (event.endsWith("hidden")) assert(!realObservation.commands.includes("reread"), `${event} read while hidden`)
    },
  },
  {
    name: "at most one read is in flight and busy triggers only create one debt",
    specClause: "C4/C5",
    check: ({ real, realObservation }) => {
      assert(realObservation.commands.filter((word) => word === "reread").length <= 1, "multiple reads commanded")
      assert(!(real.phase === "reading" && real.due && realObservation.commands.includes("reread")), "read started without clearing debt")
    },
  },
  {
    name: "stop is terminal and unsubscribes once",
    specClause: "C7",
    check: ({ previousReal, real, event, realObservation }) => {
      if (previousReal.phase === "stopped") assert(real === previousReal && realObservation.commands.length === 0, `${event} escaped stop`)
      assert(realObservation.commands.filter((word) => word === "unsubscribe").length <= 1, "duplicate unsubscribe")
    },
  },
]

const observe = (state: CollectablesRereadState | ModelState, commands: string[]): Observation => ({
  life: "phase" in state ? keyOfReal(state) : keyOfModel(state),
  misses: "phase" in state ? state.failedRereads : state.misses,
  commands,
})

export const collectablesRereadMachineDefinition: MachineDefinition<
  CollectablesRereadState, ModelState, CollectablesRereadTestEvent, CollectablesRereadCommand[], string[], Observation, StateKey, CollectablesRereadTestEvent
> = {
  name: "collectables-reread",
  initialReal: createCollectablesRereadState,
  initialModel: () => ({ life: "new", misses: 0, wakeOwed: false, alarm: false }),
  realStep: (state, event) => {
    const result = collectablesRereadStep(state, eventOf(event))
    return { state: result.state, output: result.commands }
  },
  modelStep,
  classifyRealStep: (previous, result) => JSON.stringify(previous) === JSON.stringify(result.state) && result.output.length === 0 ? "no-op" : "transition",
  observeReal: ({ state, output }) => observe(state, commandWords(output)),
  observeModel: ({ state, output }) => observe(state, output),
  realStateKey: keyOfReal,
  modelStateKey: keyOfModel,
  eventKey: (event) => event,
  transitionTable: collectablesRereadTransitionTable,
  witnesses: collectablesRereadWitnesses,
  regressions: collectablesRereadRegressions,
  invariants,
  sequenceArbitrary: fc.array(fc.constantFrom(...EVENTS), { minLength: 0, maxLength: 70 }),
  numRuns: 300,
}
