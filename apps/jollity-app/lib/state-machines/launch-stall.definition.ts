// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  LAUNCH_STALL_GRACE_MS,
  launchStallStep,
  startLaunchStall,
  type LaunchStallCommand,
  type LaunchStallEvent,
  type LaunchStallState,
} from "../launch-stall"
import type { ChainHealthResult } from "../chain-health"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

/** Model from launch-stall.ts's contract: L1 no source at the first bound is
 * host-unanswered; L2 only an explicit host loss stalls immediately; L3 a
 * timeout-flavoured host loss is host-unanswered; L4 all other probe answers
 * receive the full grace; L5 cancel and the first stall are terminal. */
type EventKey = "deadline-empty" | "deadline-source" | "probe-lost" | "probe-timeout" | "probe-other" | "grace" | "cancel"
type StateKey = LaunchStallState["phase"]
type TestEvent = EventKey
interface ModelState { station: "watch" | "check" | "mercy" | "said" | "void" }
interface Observation { state: StateKey; commands: string[] }
const EVENTS: TestEvent[] = ["deadline-empty", "deadline-source", "probe-lost", "probe-timeout", "probe-other", "grace", "cancel"]
const result = (event: TestEvent): ChainHealthResult | undefined => {
  if (event === "probe-lost") return { outcome: "host-chain-lost", latencyMs: 4, errorClass: "subscription-dropped", error: "lost" }
  if (event === "probe-timeout") return { outcome: "host-chain-lost", latencyMs: 5000, errorClass: "timeout", error: "silent" }
  if (event === "probe-other") return { outcome: "unknown", latencyMs: 5, errorClass: "unknown", error: "diagnostic" }
  return undefined
}
const concrete = (event: TestEvent): LaunchStallEvent => {
  if (event.startsWith("deadline")) return { kind: "initial-deadline", hasSource: event === "deadline-source" }
  if (event.startsWith("probe")) return { kind: "probe-finished", result: result(event) }
  return event === "grace" ? { kind: "grace-deadline" } : { kind: "cancel" }
}
const words = (commands: readonly LaunchStallCommand[]): string[] => commands.map((command) => {
  if (command.kind === "arm-grace") return `arm-grace:${command.ms}`
  if (command.kind === "stall") return `stall:${command.reason}`
  return "probe"
})
const realKey = (state: LaunchStallState): StateKey => state.phase
const modelKey = (state: ModelState): StateKey => ({ watch: "armed", check: "probing", mercy: "grace", said: "stalled", void: "cancelled" })[state.station] as StateKey
function modelStep(before: ModelState, event: TestEvent): { state: ModelState; output: string[] } {
  const none = { state: before, output: [] as string[] }
  if (before.station === "said" || before.station === "void") return none
  if (event === "cancel") return { state: { station: "void" }, output: [] }
  if (event === "deadline-empty" || event === "deadline-source") {
    if (before.station !== "watch") return none
    return event === "deadline-empty"
      ? { state: { station: "said" }, output: ["stall:host-unanswered"] }
      : { state: { station: "check" }, output: ["probe"] }
  }
  if (event.startsWith("probe")) {
    if (before.station !== "check") return none
    if (event === "probe-lost") return { state: { station: "said" }, output: ["stall:chain-lost"] }
    if (event === "probe-timeout") return { state: { station: "said" }, output: ["stall:host-unanswered"] }
    return { state: { station: "mercy" }, output: [`arm-grace:${LAUNCH_STALL_GRACE_MS}`] }
  }
  if (before.station !== "mercy") return none
  return { state: { station: "said" }, output: ["stall:read-unanswered"] }
}
const CASES: Array<{ real: LaunchStallState; model: ModelState }> = [
  { real: { phase: "armed" }, model: { station: "watch" } },
  { real: { phase: "probing" }, model: { station: "check" } },
  { real: { phase: "grace" }, model: { station: "mercy" } },
  { real: { phase: "stalled" }, model: { station: "said" } },
  { real: { phase: "cancelled" }, model: { station: "void" } },
]
export const launchStallTransitionTable = defineTransitionTable<StateKey, EventKey>()(
  {
    armed: {
      "deadline-empty": "transition", "deadline-source": "transition",
      "probe-lost": "no-op", "probe-timeout": "no-op", "probe-other": "no-op",
      grace: "no-op", cancel: "transition",
    },
    probing: {
      "deadline-empty": "no-op", "deadline-source": "no-op",
      "probe-lost": "transition", "probe-timeout": "transition", "probe-other": "transition",
      grace: "no-op", cancel: "transition",
    },
    grace: {
      "deadline-empty": "no-op", "deadline-source": "no-op",
      "probe-lost": "no-op", "probe-timeout": "no-op", "probe-other": "no-op",
      grace: "transition", cancel: "transition",
    },
    stalled: {
      "deadline-empty": "no-op", "deadline-source": "no-op",
      "probe-lost": "no-op", "probe-timeout": "no-op", "probe-other": "no-op",
      grace: "no-op", cancel: "no-op",
    },
    cancelled: {
      "deadline-empty": "no-op", "deadline-source": "no-op",
      "probe-lost": "no-op", "probe-timeout": "no-op", "probe-other": "no-op",
      grace: "no-op", cancel: "no-op",
    },
  },
)
export const launchStallWitnesses: NamedSequence<TestEvent, LaunchStallState, ModelState>[] = CASES.flatMap(({ real, model }) =>
  EVENTS.map((event) => ({ name: `${real.phase} × ${event}`, initial: { real, model }, events: [event] })),
)
export const launchStallRegressionCorpus: NamedSequence<TestEvent, LaunchStallState, ModelState>[] = [
  { name: "missing host answer stalls at the first bound", events: ["deadline-empty"] },
  { name: "healthy unknown and thrown probes share the grace path", events: ["deadline-source", "probe-other", "grace"] },
  { name: "cancel drops a late loss answer", events: ["deadline-source", "cancel", "probe-lost", "grace"] },
  { name: "duplicate and out-of-order timers cannot report twice", events: ["grace", "probe-other", "deadline-source", "deadline-source", "probe-lost", "probe-timeout", "cancel"] },
]
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
type Inv = NamedInvariant<LaunchStallState, ModelState, TestEvent, Observation, StateKey, EventKey>
const invariants: Inv[] = [
  { name: "only explicit host loss bypasses grace", specClause: "L2/L4", check: ({ previousReal, event, realObservation }) => {
    if (previousReal.phase === "probing" && event === "probe-other") assert(realObservation.commands[0] === `arm-grace:${LAUNCH_STALL_GRACE_MS}`, "diagnostic probe skipped grace")
  } },
  { name: "the machine reports at most one stall", specClause: "L5", check: ({ trace }) => {
    assert(trace.flatMap((entry) => entry.real.commands).filter((word) => word.startsWith("stall:")).length <= 1, "multiple stalls")
  } },
  { name: "cancel is silent and terminal", specClause: "L5", check: ({ previousReal, event, realObservation }) => {
    if (event === "cancel" || previousReal.phase === "cancelled") assert(realObservation.commands.length === 0, "cancel emitted work")
  } },
]
export const launchStallMachineDefinition: MachineDefinition<LaunchStallState, ModelState, TestEvent, LaunchStallCommand[], string[], Observation, StateKey, EventKey> = {
  name: "launch-stall",
  initialReal: startLaunchStall,
  initialModel: () => ({ station: "watch" }),
  realStep: (state, event) => { const next = launchStallStep(state, concrete(event)); return { state: next.state, output: next.commands } },
  modelStep,
  classifyRealStep: (before, next) => next.state === before && next.output.length === 0 ? "no-op" : "transition",
  observeReal: (next) => ({ state: realKey(next.state), commands: words(next.output) }),
  observeModel: (next) => ({ state: modelKey(next.state), commands: next.output }),
  realStateKey: realKey,
  modelStateKey: modelKey,
  eventKey: (event) => event,
  transitionTable: launchStallTransitionTable,
  witnesses: launchStallWitnesses,
  regressions: launchStallRegressionCorpus,
  invariants,
  sequenceArbitrary: fc.array(fc.constantFrom(...EVENTS), { minLength: 0, maxLength: 30 }),
  numRuns: 300,
}
