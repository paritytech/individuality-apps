// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  readRetryStep,
  startReadRetry,
  type ReadRetryCommand,
  type ReadRetryEvent,
  type ReadRetryState,
} from "../read-retry"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

/** Independent model from read-retry.ts's header:
 * R1 one read runs at a time; R2 every failure consumes the next configured
 * delay; R3 the last failure is surfaced; R4 abort wins before another read;
 * R5 success, exhaustion and abort are terminal and late events are ignored. */
type EventKey = "start" | "answer" | "fail" | "wait" | "abort"
type StateKey = "idle" | "reading-more" | "reading-last" | "waiting" | "done"
type TestEvent = EventKey
interface ModelState { mode: "dormant" | "in-flight" | "pause" | "settled"; ordinal: number; retriesLeft: number }
interface Observation { state: StateKey; commands: string[] }

const EVENTS: TestEvent[] = ["start", "answer", "fail", "wait", "abort"]
const error = new Error("read failed")
const concrete = (event: TestEvent): ReadRetryEvent<string> => {
  if (event === "answer") return { kind: "answered", value: "answer" }
  if (event === "fail") return { kind: "failed", error }
  if (event === "wait") return { kind: "waited" }
  if (event === "abort") return { kind: "aborted", reason: new Error("left") }
  return { kind: "start" }
}
const words = (commands: readonly ReadRetryCommand<string>[]): string[] => commands.map((command) => {
  if (command.kind === "read") return `read:${command.attempt}`
  if (command.kind === "retry") return `retry:${command.retry}:${command.delayMs}`
  return command.kind
})
const realKey = (state: ReadRetryState): StateKey => {
  if (state.phase === "idle") return "idle"
  if (state.phase === "waiting") return "waiting"
  if (state.phase === "done") return "done"
  return state.delaysMs[state.attempt - 1] === undefined ? "reading-last" : "reading-more"
}
const modelKey = (state: ModelState): StateKey => {
  if (state.mode === "dormant") return "idle"
  if (state.mode === "pause") return "waiting"
  if (state.mode === "settled") return "done"
  return state.retriesLeft > 0 ? "reading-more" : "reading-last"
}
function modelStep(before: ModelState, event: TestEvent): { state: ModelState; output: string[] } {
  const none = { state: before, output: [] as string[] }
  if (before.mode === "settled") return none
  if (event === "abort") return { state: { ...before, mode: "settled" }, output: ["reject"] }
  if (event === "start") {
    if (before.mode !== "dormant") return none
    return { state: { ...before, mode: "in-flight", ordinal: 1 }, output: ["read:1"] }
  }
  if (event === "answer") {
    if (before.mode !== "in-flight") return none
    return { state: { ...before, mode: "settled" }, output: ["resolve"] }
  }
  if (event === "fail") {
    if (before.mode !== "in-flight") return none
    if (before.retriesLeft === 0) return { state: { ...before, mode: "settled" }, output: ["reject"] }
    return { state: { ...before, mode: "pause", retriesLeft: before.retriesLeft - 1 }, output: [`retry:${before.ordinal}:10`] }
  }
  if (before.mode !== "pause") return none
  const ordinal = before.ordinal + 1
  return { state: { ...before, mode: "in-flight", ordinal }, output: [`read:${ordinal}`] }
}

const CASES: Array<{ real: ReadRetryState; model: ModelState }> = [
  { real: startReadRetry([10]), model: { mode: "dormant", ordinal: 0, retriesLeft: 1 } },
  { real: { phase: "reading", attempt: 1, delaysMs: [10] }, model: { mode: "in-flight", ordinal: 1, retriesLeft: 1 } },
  { real: { phase: "reading", attempt: 2, delaysMs: [10] }, model: { mode: "in-flight", ordinal: 2, retriesLeft: 0 } },
  { real: { phase: "waiting", attempt: 1, delaysMs: [10] }, model: { mode: "pause", ordinal: 1, retriesLeft: 0 } },
  { real: { phase: "done", attempt: 2, delaysMs: [10] }, model: { mode: "settled", ordinal: 2, retriesLeft: 0 } },
]
export const readRetryTransitionTable = defineTransitionTable<StateKey, EventKey>()(
  {
    idle: { start: "transition", answer: "no-op", fail: "no-op", wait: "no-op", abort: "transition" },
    "reading-more": { start: "no-op", answer: "transition", fail: "transition", wait: "no-op", abort: "transition" },
    "reading-last": { start: "no-op", answer: "transition", fail: "transition", wait: "no-op", abort: "transition" },
    waiting: { start: "no-op", answer: "no-op", fail: "no-op", wait: "transition", abort: "transition" },
    done: { start: "no-op", answer: "no-op", fail: "no-op", wait: "no-op", abort: "no-op" },
  },
)
export const readRetryWitnesses: NamedSequence<TestEvent, ReadRetryState, ModelState>[] = CASES.flatMap(({ real, model }) =>
  EVENTS.map((event) => ({ name: `${modelKey(model)} × ${event}`, initial: { real, model }, events: [event] })),
)
export const readRetryRegressionCorpus: NamedSequence<TestEvent, ReadRetryState, ModelState>[] = [
  { name: "failure waits then starts exactly one replacement", events: ["start", "fail", "wait", "answer"] },
  { name: "exhaustion surfaces the last failure", events: ["start", "fail", "wait", "fail"] },
  { name: "stale duplicate and out-of-order answers cannot revive a terminal attempt", events: ["answer", "start", "answer", "answer", "fail", "wait", "abort"] },
  { name: "abort during the retry wait prevents the next read", events: ["start", "fail", "abort", "wait"] },
]
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
type Inv = NamedInvariant<ReadRetryState, ModelState, TestEvent, Observation, StateKey, EventKey>
const invariants: Inv[] = [
  { name: "only a wait completion starts a replacement read", specClause: "R1/R2", check: ({ event, realObservation, trace }) => {
    if (realObservation.commands.some((word) => word.startsWith("read:"))) assert(event === "start" || event === "wait", `read on ${event}`)
    const reads = trace.flatMap((entry) => entry.real.commands.filter((word) => word.startsWith("read:")))
    assert(new Set(reads).size === reads.length, "duplicate attempt")
  } },
  { name: "a failure either schedules one configured retry or rejects", specClause: "R2/R3", check: ({ event, realObservation }) => {
    if (event === "fail") assert(realObservation.commands.length <= 1, "failure emitted multiple decisions")
  } },
  { name: "terminal attempts never emit another command", specClause: "R5", check: ({ previousReal, realObservation }) => {
    if (previousReal.phase === "done") assert(realObservation.commands.length === 0, "terminal attempt emitted a command")
  } },
]
export const readRetryMachineDefinition: MachineDefinition<ReadRetryState, ModelState, TestEvent, ReadRetryCommand<string>[], string[], Observation, StateKey, EventKey> = {
  name: "read-retry",
  initialReal: () => startReadRetry([10]),
  initialModel: () => ({ mode: "dormant", ordinal: 0, retriesLeft: 1 }),
  realStep: (state, event) => { const result = readRetryStep(state, concrete(event)); return { state: result.state, output: result.commands } },
  modelStep,
  classifyRealStep: (before, result) => result.state === before && result.output.length === 0 ? "no-op" : "transition",
  observeReal: (result) => ({ state: realKey(result.state), commands: words(result.output) }),
  observeModel: (result) => ({ state: modelKey(result.state), commands: result.output }),
  realStateKey: realKey,
  modelStateKey: modelKey,
  eventKey: (event) => event,
  transitionTable: readRetryTransitionTable,
  witnesses: readRetryWitnesses,
  regressions: readRetryRegressionCorpus,
  invariants,
  sequenceArbitrary: fc.array(fc.constantFrom(...EVENTS), { minLength: 0, maxLength: 30 }),
  numRuns: 300,
}
