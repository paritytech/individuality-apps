// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  REPORT_STATUS_POLL_MS,
  reportAttemptStep,
  startReportAttempt,
  type ReportAttemptCommand,
  type ReportAttemptEvent,
  type ReportAttemptOutcome,
  type ReportAttemptState,
} from "../report-retry"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

/**
 * Reference model for one report attempt (lib/report-retry.ts), written from
 * the module's documented rules, not from its branches:
 *
 *  R1 an attempt over a closed window files nothing and reads nothing;
 *  R2 it re-reads the status BEFORE submitting; a landed report ("sent") or a
 *     chain that left Reporting ends the attempt with no submit;
 *  R3 otherwise it submits exactly once and keeps the watch alive until
 *     report_ends: elapsed time is never a failure while the window is open;
 *  R4 beside the watch the status is polled every REPORT_STATUS_POLL_MS; a
 *     poll that finds sent or closed ends the attempt, an open or failed read
 *     only schedules the next poll (#596);
 *  R5 NoReporting from the pallet means the chain closed the window, not retry;
 *     any other submit error is surfaced ("failed") for the caller to retry;
 *  R6 only the clock reaching report_ends gives up ("closed");
 *  R7 whenever the attempt ends with the submission still pending, the watch
 *     is dropped (abort); a settled submission has nothing to abort;
 *  R8 one attempt settles once; late events are ignored.
 */

type ModelOutcome = "none" | "sent" | "closed" | "chain-closed:pre-submit" | "chain-closed:watch" | "chain-closed:NoReporting" | "failed"
interface ModelState {
  stage: "new" | "reading" | "watching" | "over"
  settled: boolean
  outcome: ModelOutcome
}
const EVENTS = [
  "start-live",
  "start-closed",
  "status-sent",
  "status-closed",
  "status-open",
  "status-open-late",
  "status-unread",
  "submit-ok",
  "submit-window-closed",
  "submit-failed",
  "poll-sent",
  "poll-closed",
  "poll-open",
  "poll-unread",
  "deadline",
] as const
export type ReportRetryTestEvent = (typeof EVENTS)[number]
type StateKey = `${ModelState["stage"]}|submit-settled:${0 | 1}|${ModelOutcome}`

interface Observation {
  phase: string
  submitSettled: boolean
  outcome: ModelOutcome
  commands: string[]
}

const ENDS = 115
const NOW = 100
const outcomeWord = (outcome: ReportAttemptOutcome | null): ModelOutcome =>
  outcome === null
    ? "none"
    : typeof outcome === "string"
      ? outcome
      : (`chain-closed:${outcome.at}` as ModelOutcome)

const stateKey = (state: { stage: string; settled: boolean; outcome: ModelOutcome }): StateKey =>
  `${state.stage as ModelState["stage"]}|submit-settled:${state.settled ? 1 : 0}|${state.outcome}`

const STATES: ModelState[] = [
  { stage: "new", settled: false, outcome: "none" },
  { stage: "reading", settled: false, outcome: "none" },
  { stage: "watching", settled: false, outcome: "none" },
  { stage: "over", settled: false, outcome: "sent" },
  { stage: "over", settled: true, outcome: "sent" },
  { stage: "over", settled: false, outcome: "closed" },
  { stage: "over", settled: false, outcome: "chain-closed:pre-submit" },
  { stage: "over", settled: false, outcome: "chain-closed:watch" },
  { stage: "over", settled: true, outcome: "chain-closed:NoReporting" },
  { stage: "over", settled: true, outcome: "failed" },
]

const PHASE: Record<ModelState["stage"], ReportAttemptState["phase"]> = {
  new: "idle",
  reading: "reading",
  watching: "watching",
  over: "done",
}
const realOutcome = (word: ModelOutcome): ReportAttemptOutcome | null => {
  if (word === "none") return null
  if (word.startsWith("chain-closed:")) return { kind: "chain-closed", at: word.slice(13) as "pre-submit" | "watch" | "NoReporting" }
  return word as "sent" | "closed" | "failed"
}
const realOf = (state: ModelState): ReportAttemptState => ({
  phase: PHASE[state.stage],
  submitSettled: state.settled,
  outcome: realOutcome(state.outcome),
})

function concreteEvent(event: ReportRetryTestEvent): ReportAttemptEvent {
  switch (event) {
    case "start-live":
      return { kind: "start", nowS: NOW, reportEnds: ENDS }
    case "start-closed":
      return { kind: "start", nowS: ENDS, reportEnds: ENDS }
    case "status-sent":
      return { kind: "status", read: "sent", nowS: NOW, reportEnds: ENDS }
    case "status-closed":
      return { kind: "status", read: "closed", nowS: NOW, reportEnds: ENDS }
    case "status-open":
      return { kind: "status", read: "open", nowS: NOW, reportEnds: ENDS }
    case "status-open-late":
      return { kind: "status", read: "open", nowS: ENDS, reportEnds: ENDS }
    case "status-unread":
      return { kind: "status", read: "unread", nowS: NOW, reportEnds: ENDS }
    case "submit-ok":
      return { kind: "submit-settled", result: "ok" }
    case "submit-window-closed":
      return { kind: "submit-settled", result: "window-closed" }
    case "submit-failed":
      return { kind: "submit-settled", result: "failed" }
    case "poll-sent":
      return { kind: "poll", read: "sent" }
    case "poll-closed":
      return { kind: "poll", read: "closed" }
    case "poll-open":
      return { kind: "poll", read: "open" }
    case "poll-unread":
      return { kind: "poll", read: "unread" }
    case "deadline":
      return { kind: "deadline" }
  }
}

const words = (commands: readonly ReportAttemptCommand[]): string[] =>
  commands.map((command) => {
    switch (command.kind) {
      case "arm-deadline":
        return `arm-deadline:${command.ms}`
      case "read-status":
        return `read-status:${command.purpose}`
      case "schedule-poll":
        return `schedule-poll:${command.ms}`
      case "abort":
        return `abort:${command.reason}`
      case "settle":
        return `settle:${outcomeWord(command.outcome)}`
      default:
        return command.kind
    }
  })

/** Independent model: an ordered rule list per event, with the priority
 *  sent > closed > open spelled out once. */
function modelStep(before: ModelState, event: ReportRetryTestEvent): { state: ModelState; output: string[] } {
  const over = (outcome: ModelOutcome, settled: boolean, abort: "window" | "ended" | null): { state: ModelState; output: string[] } => ({
    state: { stage: "over", settled, outcome },
    output: [...(abort === null ? [] : [`abort:${abort}`]), `settle:${outcome}`],
  })
  const none = { state: before, output: [] as string[] }
  const read = event.split("-")[1]
  if (event === "start-live" || event === "start-closed") {
    if (before.stage !== "new") return none
    if (event === "start-closed") return over("closed", false, null)
    return { state: { ...before, stage: "reading" }, output: [`arm-deadline:${(ENDS - NOW) * 1000}`, "read-status:first"] }
  }
  if (event.startsWith("status-")) {
    if (before.stage !== "reading") return none
    if (read === "sent") return over("sent", false, "ended")
    if (read === "closed") return over("chain-closed:pre-submit", false, "ended")
    if (event === "status-open-late") return over("closed", false, "ended")
    return { state: { ...before, stage: "watching" }, output: ["submit", `schedule-poll:${REPORT_STATUS_POLL_MS}`] }
  }
  if (event.startsWith("submit-")) {
    if (before.stage !== "watching") return none
    if (event === "submit-ok") return over("sent", true, null)
    if (event === "submit-window-closed") return over("chain-closed:NoReporting", true, null)
    return over("failed", true, null)
  }
  if (event.startsWith("poll-")) {
    if (before.stage !== "watching") return none
    if (read === "sent") return over("sent", false, "ended")
    if (read === "closed") return over("chain-closed:watch", false, "ended")
    return { state: before, output: [`schedule-poll:${REPORT_STATUS_POLL_MS}`] }
  }
  // deadline
  if (before.stage === "reading" || before.stage === "watching") return over("closed", false, "window")
  return none
}

const modelOutcomeKind = (before: ModelState, event: ReportRetryTestEvent): "transition" | "no-op" => {
  const after = modelStep(before, event)
  return JSON.stringify(after.state) === JSON.stringify(before) && after.output.length === 0 ? "no-op" : "transition"
}

export const reportRetryTransitionTable = defineTransitionTable<StateKey, ReportRetryTestEvent>()(
  Object.fromEntries(
    STATES.map((state) => [stateKey(state), Object.fromEntries(EVENTS.map((event) => [event, modelOutcomeKind(state, event)]))]),
  ) as Record<StateKey, Record<ReportRetryTestEvent, "transition" | "no-op">>,
)

export const reportRetryWitnesses: NamedSequence<ReportRetryTestEvent, ReportAttemptState, ModelState>[] = STATES.flatMap((state) =>
  EVENTS.map((event) => ({
    name: `${stateKey(state)} × ${event}`,
    initial: { real: realOf(state), model: state },
    events: [event],
  })),
)

export const reportRetryRegressionCorpus: NamedSequence<ReportRetryTestEvent, ReportAttemptState, ModelState>[] = [
  { name: "re-reads before submitting, submits once", events: ["start-live", "status-open", "submit-ok"] },
  { name: "late sent read files nothing", events: ["start-live", "status-sent", "submit-ok"] },
  { name: "closed window files nothing", events: ["start-closed", "status-open", "deadline"] },
  { name: "hanging submit ends only at report_ends", events: ["start-live", "status-open", "poll-open", "poll-unread", "poll-open", "deadline"] },
  { name: "hanging read ends only at report_ends", events: ["start-live", "deadline", "status-open"] },
  { name: "#596 poll sees the chain close early", events: ["start-live", "status-open", "poll-open", "poll-closed", "submit-ok"] },
  { name: "#596 poll sees the report landed", events: ["start-live", "status-open", "poll-sent", "submit-failed"] },
  { name: "NoReporting is a closure, not a retry", events: ["start-live", "status-unread", "submit-window-closed", "poll-open"] },
  { name: "other submit errors are surfaced", events: ["start-live", "status-open", "submit-failed", "deadline"] },
  { name: "open read at report_ends does not submit", events: ["start-live", "status-open-late", "status-open"] },
  { name: "stale and duplicate events after the end are ignored", events: ["start-live", "status-sent", "status-open", "poll-closed", "deadline", "start-live"] },
]

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}
type Inv = NamedInvariant<ReportAttemptState, ModelState, ReportRetryTestEvent, Observation, StateKey, ReportRetryTestEvent>

const invariants: Inv[] = [
  {
    name: "a report is never abandoned while the report window is open",
    specClause: "R3/R6 closed only when the clock reached report_ends",
    check: ({ previousReal, real, event }) => {
      if (real.outcome === "closed" && previousReal.outcome !== "closed")
        assert(["start-closed", "status-open-late", "deadline"].includes(event), `gave up on ${event} with the window open`)
    },
  },
  {
    name: "unread or open status never ends an attempt",
    specClause: "R3/R4 elapsed time and a failed read are not failures",
    check: ({ event, realObservation, previousReal, real }) => {
      if (["poll-open", "poll-unread", "status-open", "status-unread"].includes(event) && previousReal.phase !== "done") {
        assert(real.phase !== "done", `${event} ended the attempt`)
        assert(!realObservation.commands.some((command) => command.startsWith("settle")), `${event} settled`)
      }
    },
  },
  {
    name: "at most one submit, and never after a sent/closed answer or the end",
    specClause: "R2/R3 single submission after a fresh status read",
    check: ({ trace }) => {
      const submits = trace.filter((entry) => entry.real.commands.includes("submit"))
      assert(submits.length <= 1, "more than one submit")
      submits.forEach((entry) => assert(["status-open", "status-unread"].includes(entry.eventKey), `submit on ${entry.eventKey}`))
    },
  },
  {
    name: "poll cadence and deadline are bounded by the module's constants and the window",
    specClause: "R4 REPORT_STATUS_POLL_MS; R3 deadline = report_ends - now",
    check: ({ realObservation }) => {
      realObservation.commands.forEach((command) => {
        if (command.startsWith("schedule-poll:")) assert(command === `schedule-poll:${REPORT_STATUS_POLL_MS}`, `poll cadence ${command}`)
        if (command.startsWith("arm-deadline:")) {
          const ms = Number(command.slice(13))
          assert(ms >= 1 && ms <= (ENDS - NOW) * 1000, `deadline ${ms}ms outside the remaining window`)
        }
      })
    },
  },
  {
    name: "an attempt settles exactly once, with its outcome, and done is terminal",
    specClause: "R8",
    check: ({ trace, previousReal, real, realObservation }) => {
      const settles = trace.flatMap((entry) => entry.real.commands).filter((command) => command.startsWith("settle:"))
      assert(settles.length <= 1, "settled twice")
      assert((real.phase === "done") === (settles.length === 1) || previousReal.phase === "done", "done without settle")
      if (previousReal.phase === "done") {
        assert(JSON.stringify(real) === JSON.stringify(previousReal) && realObservation.commands.length === 0, "terminal state moved")
      }
    },
  },
  {
    name: "the watch is dropped exactly when the submission is still pending",
    specClause: "R7",
    check: ({ previousReal, real, realObservation }) => {
      const ending = (previousReal.phase === "reading" || previousReal.phase === "watching") && real.phase === "done"
      const aborted = realObservation.commands.some((command) => command.startsWith("abort:"))
      if (ending) assert(aborted === !real.submitSettled, "abort does not match submit-settled")
      else assert(!aborted, "abort outside an ending")
    },
  },
  {
    name: "a submission outcome comes only from a watching attempt",
    specClause: "R3/R5",
    check: ({ previousReal, real }) => {
      if (real.submitSettled && !previousReal.submitSettled) assert(previousReal.phase === "watching", "submit settled without a submit")
    },
  },
]

const eventArbitrary = fc.constantFrom<ReportRetryTestEvent>(...EVENTS)
// start-biased so most sequences get past "new"; the rest are out-of-order,
// stale or duplicate events
const sequenceArbitrary = fc
  .tuple(fc.array(eventArbitrary, { minLength: 0, maxLength: 24, size: "max" }), fc.boolean())
  .map(([events, startFirst]) => (startFirst ? (["start-live", ...events] as ReportRetryTestEvent[]) : events))

export const reportRetryMachineDefinition: MachineDefinition<
  ReportAttemptState,
  ModelState,
  ReportRetryTestEvent,
  ReportAttemptCommand[],
  string[],
  Observation,
  StateKey,
  ReportRetryTestEvent
> = {
  name: "report-retry",
  initialReal: startReportAttempt,
  initialModel: () => STATES[0],
  initialArbitrary: fc.constantFrom(...STATES).map((model) => ({ real: realOf(model), model })),
  realStep: (state, event) => {
    const result = reportAttemptStep(state, concreteEvent(event))
    return { state: result.state, output: result.commands }
  },
  modelStep,
  classifyRealStep: (previous, result) =>
    JSON.stringify(previous) === JSON.stringify(result.state) && result.output.length === 0 ? "no-op" : "transition",
  observeReal: ({ state, output }) => ({
    phase: state.phase,
    submitSettled: state.submitSettled,
    outcome: outcomeWord(state.outcome),
    commands: words(output),
  }),
  observeModel: ({ state, output }) => ({
    phase: PHASE[state.stage],
    submitSettled: state.settled,
    outcome: state.outcome,
    commands: output,
  }),
  realStateKey: (state) =>
    stateKey({
      stage: ({ idle: "new", reading: "reading", watching: "watching", done: "over" } as const)[state.phase],
      settled: state.submitSettled,
      outcome: outcomeWord(state.outcome),
    }),
  modelStateKey: stateKey,
  eventKey: (event) => event,
  transitionTable: reportRetryTransitionTable,
  witnesses: reportRetryWitnesses,
  regressions: reportRetryRegressionCorpus,
  invariants,
  sequenceArbitrary,
  numRuns: 300,
}
