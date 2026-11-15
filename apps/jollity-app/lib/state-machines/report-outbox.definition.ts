// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  emptyReportOutbox,
  reportOutbox,
  type OutboxClock,
  type OutboxCommand,
  type OutboxEvent,
  type OutboxInputs,
  type OutboxState,
} from "../report-outbox"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

const REPORT = [["Person", "NotPerson"]] as const
const PHASES = ["idle", "countdown", "beat", "submitting", "retry-wait", "handover", "confirmed", "missed", "error"] as const
const EVENTS = [
  "arm",
  "tap",
  "beat",
  "verdict-changed",
  "fire",
  "confirm",
  "late-confirm",
  "sent",
  "stale-sent",
  "refused",
  "chain-closed",
  "retry",
  "late-retry",
  "close",
  "handover-sent",
  "handover-missed",
  "handover-gone",
  "handover-pending",
  "unmount",
] as const

type Phase = (typeof PHASES)[number]
type FlagsKey = `locked:${0 | 1}|submitted:${0 | 1}|closed:${0 | 1}|rushed:${0 | 1}|pending:${0 | 1}`
// countdown alone carries the restart bit: a verdict change restarts an armed countdown, and repeating it changes nothing
type StateKey = `${Exclude<Phase, "countdown">}|${FlagsKey}` | `countdown|${FlagsKey}|restart:${0 | 1}`
export type ReportOutboxTestEvent = (typeof EVENTS)[number]

interface ModelOutboxState {
  phase: Phase
  generation: number
  attempts: number
  locked: boolean
  submitted: boolean
  chainClosed: boolean
  reportFrozen: boolean
  hardStopAt: number | null
  beatAt: number | null
  fireAt: number | null
  rushed: boolean
  rushPending: boolean
  handoverPauseMs: number
  /** a verdict change owns the countdown's deadline (set by verdict-changed, cleared by arm) */
  restartOwnsDeadline: boolean
}

interface OutboxObservation {
  state: ModelOutboxState
  commands: string[]
}

const inputs: OutboxInputs = {
  gameIndex: 7,
  reportEndsMs: 30_000,
  confirming: true,
  confirmReady: true,
  votesMissing: 0,
  hasSubmitPath: true,
}

const at = (monotonicMs: number, gameMs = monotonicMs): OutboxClock => ({
  monotonicMs,
  gameMs,
  latchMs: monotonicMs,
  chainAnchored: true,
})

interface ModelFlags {
  locked: boolean
  submitted: boolean
  chainClosed: boolean
  rushed: boolean
  rushPending: boolean
}

// the countdown a verdict change at 2_100 leaves: hardStopAt 2_100 + 7_000, beat 900 earlier
const RESTARTED = { hardStopAt: 9_100, beatAt: 8_200 } as const

function initialReal(phase: Phase, flags?: ModelFlags, restart = false): OutboxState {
  const state = emptyReportOutbox(inputs)
  const finish = (value: OutboxState): OutboxState =>
    flags === undefined ? value : { ...value, ...flags, filedBy: flags.rushed ? "tap" : value.filedBy }
  if (phase === "idle") return finish(state)
  if (phase === "countdown" && restart) {
    return finish({ ...state, phase, ...RESTARTED, fireAt: null, autoCount: 7, filedBy: "auto-confirm", restartOwnsDeadline: true, restartCapSlackMs: 0 })
  }
  if (phase === "countdown" || phase === "beat") {
    return finish({
      ...state,
      phase,
      hardStopAt: 7_000,
      beatAt: 6_100,
      fireAt: phase === "beat" ? 7_000 : null,
      autoCount: phase === "beat" ? 0 : 7,
      filedBy: "auto-confirm",
    })
  }
  if (phase === "submitting" || phase === "retry-wait") {
    return finish({
      ...state,
      phase,
      generation: 1,
      attempts: 1,
      locked: true,
      report: REPORT.map((round) => [...round]),
    })
  }
  if (phase === "handover") return finish({ ...state, phase })
  if (phase === "confirmed") return finish({ ...state, phase, generation: 1, attempts: 1, locked: true, submitted: true })
  if (phase === "missed") return finish({ ...state, phase })
  return finish({ ...state, phase: "error" })
}

function initialModel(phase: Phase, flags?: ModelFlags, restart = false): ModelOutboxState {
  const state: ModelOutboxState = {
    phase,
    generation: phase === "submitting" || phase === "retry-wait" || phase === "confirmed" ? 1 : 0,
    attempts: phase === "submitting" || phase === "retry-wait" || phase === "confirmed" ? 1 : 0,
    locked: phase === "submitting" || phase === "retry-wait" || phase === "confirmed",
    submitted: phase === "confirmed",
    chainClosed: false,
    reportFrozen: phase === "submitting" || phase === "retry-wait",
    hardStopAt: phase === "countdown" || phase === "beat" ? 7_000 : null,
    beatAt: phase === "countdown" || phase === "beat" ? 6_100 : null,
    fireAt: phase === "beat" ? 7_000 : null,
    rushed: false,
    rushPending: false,
    handoverPauseMs: 2_500,
    restartOwnsDeadline: false,
  }
  const restarted = phase === "countdown" && restart ? { ...state, ...RESTARTED, restartOwnsDeadline: true } : state
  return flags === undefined ? restarted : { ...restarted, ...flags }
}

const stateKey = (
  state: Pick<ModelOutboxState, "phase" | "locked" | "submitted" | "chainClosed" | "rushed" | "rushPending" | "restartOwnsDeadline">,
): StateKey => {
  const flags: FlagsKey = `locked:${state.locked ? 1 : 0}|submitted:${state.submitted ? 1 : 0}|closed:${state.chainClosed ? 1 : 0}|rushed:${state.rushed ? 1 : 0}|pending:${state.rushPending ? 1 : 0}`
  return state.phase === "countdown" ? `countdown|${flags}|restart:${state.restartOwnsDeadline ? 1 : 0}` : `${state.phase}|${flags}`
}

const stateCases = PHASES.flatMap((phase) =>
  [false, true].flatMap((locked) =>
    [false, true].flatMap((submitted) =>
      [false, true].flatMap((chainClosed) =>
        [false, true].flatMap((rushed) =>
          [false, true].flatMap((rushPending) =>
            (phase === "countdown" ? [false, true] : [false]).map((restart) => {
              const flags = { locked, submitted, chainClosed, rushed, rushPending }
              return {
                key: stateKey({ phase, ...flags, restartOwnsDeadline: restart }),
                real: initialReal(phase, flags, restart),
                model: initialModel(phase, flags, restart),
                restart,
              }
            }),
          ),
        ),
      ),
    ),
  ),
)

function concreteEvent(state: OutboxState, event: ReportOutboxTestEvent): OutboxEvent {
  switch (event) {
    case "arm":
      return { kind: "sync", inputs, clock: at(0) }
    case "tap": {
      const tapAt = state.fireAt === null ? 2_000 : 2_400
      return { kind: "rush-confirm", clock: at(tapAt) }
    }
    case "beat":
      return {
        kind: "tick",
        clock: at(state.rushPending ? (state.fireAt === null ? 2_000 : 2_400) : (state.beatAt ?? 6_100)),
      }
    case "verdict-changed":
      return { kind: "verdict-changed", clock: at(2_100), capSlackMs: 0 }
    case "fire": {
      const fireAt = state.fireAt ?? state.hardStopAt ?? 7_000
      return { kind: "tick", clock: at(fireAt) }
    }
    case "confirm":
      return { kind: "confirm", clock: at(1_000), report: REPORT.map((round) => [...round]), filedBy: "tap" }
    case "late-confirm":
      return { kind: "confirm", clock: at(31_000), report: REPORT.map((round) => [...round]), filedBy: "tap" }
    case "sent":
      return { kind: "attempt-result", generation: state.generation, clock: at(1_100), result: "sent" }
    case "stale-sent":
      return { kind: "attempt-result", generation: state.generation + 1, clock: at(1_100), result: "sent" }
    case "refused":
      return { kind: "attempt-result", generation: state.generation, clock: at(1_100), result: "refused" }
    case "chain-closed":
      return { kind: "attempt-result", generation: state.generation, clock: at(1_100), result: "chain-closed" }
    case "retry":
      return { kind: "retry-fired", generation: state.generation, clock: at(3_000) }
    case "late-retry":
      return { kind: "retry-fired", generation: state.generation, clock: at(31_000) }
    case "close":
      return { kind: "sync", inputs, clock: at(31_000) }
    case "handover-sent":
      return { kind: "handover-result", result: "sent" }
    case "handover-missed":
      return { kind: "handover-result", result: "missed" }
    case "handover-gone":
      return { kind: "handover-result", result: "gone" }
    case "handover-pending":
      return { kind: "handover-result", result: "pending" }
    case "unmount":
      return { kind: "unmounted" }
  }
}

function normalizeCommands(commands: readonly OutboxCommand[]): string[] {
  return commands.map((command) => {
    switch (command.kind) {
      case "confirm":
        return `confirm:${command.filedBy}`
      case "submit":
        return `submit:${command.generation}:${command.attempt}`
      case "schedule-retry":
        return `schedule-retry:${command.delayMs}:${command.generation}`
      case "poll-handover":
        return `poll-handover:${command.delayMs}`
      case "navigate-chest":
        return `navigate-chest:${command.missed ? "missed" : "gone"}`
      default:
        return command.kind
    }
  })
}

function observeReal(state: OutboxState, commands: readonly OutboxCommand[]): OutboxObservation {
  return {
    state: {
      phase: state.phase as Phase,
      generation: state.generation,
      attempts: state.attempts,
      locked: state.locked,
      submitted: state.submitted,
      chainClosed: state.chainClosed,
      reportFrozen: state.report !== null,
      hardStopAt: state.hardStopAt,
      beatAt: state.beatAt,
      fireAt: state.fireAt,
      rushed: state.rushed,
      rushPending: state.rushPending,
      handoverPauseMs: state.handoverPauseMs,
      restartOwnsDeadline: state.restartOwnsDeadline,
    },
    commands: normalizeCommands(commands),
  }
}

/** Independent executable model of the report-outbox transactional core. */
function modelStep(before: ModelOutboxState, event: ReportOutboxTestEvent): { state: ModelOutboxState; output: string[] } {
  const state = { ...before }
  const output: string[] = []
  if ((state.phase === "confirmed" || state.phase === "missed") && event !== "unmount") return { state, output }
  if (state.chainClosed && event !== "unmount") return { state, output }

  switch (event) {
    case "arm":
      if (state.phase === "idle" && !state.locked && !state.submitted) {
        state.phase = "countdown"
        state.hardStopAt = 7_000
        state.beatAt = 6_100
        state.fireAt = null
        state.rushed = false
        state.rushPending = false
        state.restartOwnsDeadline = false
      }
      break
    case "tap":
      if (!state.locked && !state.submitted) state.rushPending = true
      break
    case "beat":
      if ((state.phase === "countdown" || state.phase === "beat") && state.rushPending) {
        state.rushPending = false
        state.rushed = true
        state.phase = "beat"
        state.beatAt = state.fireAt === null ? 2_000 : 2_400
        state.fireAt ??= 2_900
        output.push("rush-consumed")
      } else if (state.phase === "countdown") {
        state.phase = "beat"
        state.fireAt ??= state.hardStopAt
      }
      break
    case "verdict-changed":
      if (!state.rushed && !state.locked && !state.submitted) {
        state.phase = "countdown"
        state.hardStopAt = 9_100
        state.beatAt = 8_200
        state.fireAt = null
        state.restartOwnsDeadline = true
      }
      break
    case "fire":
      if (state.phase === "countdown" || state.phase === "beat") {
        if (state.rushPending) {
          state.rushPending = false
          state.rushed = true
          state.beatAt = state.fireAt ?? state.hardStopAt
          output.push("rush-consumed")
        }
        state.fireAt ??= state.hardStopAt
        state.phase = "idle"
        output.push(`confirm:${state.rushed ? "tap" : "auto-confirm"}`)
      }
      break
    case "confirm":
      if (!state.chainClosed && !state.locked && !state.submitted) {
        state.phase = "submitting"
        state.generation++
        state.attempts = 1
        state.locked = true
        state.reportFrozen = true
        output.push(`submit:${state.generation}:1`)
      }
      break
    case "late-confirm":
    case "stale-sent":
      break
    case "sent":
      if (!state.chainClosed && state.phase === "submitting") {
        state.phase = "confirmed"
        state.submitted = true
        output.push("finish-report", "clear-votes")
      }
      break
    case "chain-closed":
      if (!state.chainClosed && state.phase === "submitting") {
        state.phase = "error"
        state.chainClosed = true
        output.push("terminal-failure")
      }
      break
    case "refused":
      if (!state.chainClosed && state.phase === "submitting") {
        state.phase = "retry-wait"
        output.push(`schedule-retry:1500:${state.generation}`)
      }
      break
    case "late-retry":
      if (!state.chainClosed && state.phase === "retry-wait" && state.reportFrozen) {
        state.phase = "error"
        output.push("terminal-failure")
      }
      break
    case "retry":
      if (!state.chainClosed && state.phase === "retry-wait" && state.reportFrozen) {
        state.phase = "submitting"
        state.attempts++
        output.push(`submit:${state.generation}:${state.attempts}`)
      }
      break
    case "close":
      if (!state.submitted && !state.locked && state.phase !== "handover") {
        state.phase = "handover"
        output.push("poll-handover:0")
      }
      break
    case "handover-sent":
      if (state.phase === "handover") {
        state.phase = "confirmed"
        state.submitted = true
        output.push("finish-report", "clear-votes")
      }
      break
    case "handover-missed":
      if (state.phase === "handover") {
        state.phase = "missed"
        output.push("navigate-chest:missed")
      }
      break
    case "handover-gone":
      if (state.phase === "handover") {
        state.phase = "missed"
        output.push("navigate-chest:gone")
      }
      break
    case "handover-pending":
      if (state.phase === "handover") {
        output.push(`poll-handover:${state.handoverPauseMs}`)
        state.handoverPauseMs = Math.min(state.handoverPauseMs * 2, 10_000)
      }
      break
    case "unmount":
      state.generation++
      state.locked = true
      break
  }
  return { state, output }
}

function modelObservation(state: ModelOutboxState, output: string[]): OutboxObservation {
  return { state, commands: output }
}

const modelOutcome = (before: ModelOutboxState, event: ReportOutboxTestEvent): "transition" | "no-op" => {
  const after = modelStep(before, event)
  return JSON.stringify(before) === JSON.stringify(after.state) && after.output.length === 0 ? "no-op" : "transition"
}

export const reportOutboxTransitionTable = defineTransitionTable<StateKey, ReportOutboxTestEvent>()(
  Object.fromEntries(
    stateCases.map(({ key, model }) => [key, Object.fromEntries(EVENTS.map((event) => [event, modelOutcome(model, event)]))]),
  ) as Record<StateKey, Record<ReportOutboxTestEvent, "transition" | "no-op">>,
)

export const reportOutboxWitnesses: NamedSequence<ReportOutboxTestEvent, OutboxState, ModelOutboxState>[] = stateCases.flatMap(
  ({ key, real, model }) => EVENTS.map((event) => ({ name: `${key} × ${event}`, initial: { real, model }, events: [event] })),
)

export const reportOutboxRegressionCorpus: NamedSequence<ReportOutboxTestEvent, OutboxState, ModelOutboxState>[] = [
  { name: "first rush beat owns fireAt", events: ["arm", "tap", "beat", "tap", "beat", "fire"] },
  { name: "verdict change cannot restart a rushed beat", events: ["arm", "tap", "beat", "verdict-changed", "fire"] },
  { name: "double confirm freezes one report", events: ["confirm", "confirm", "sent"] },
  { name: "retry preserves the logical report", events: ["confirm", "refused", "retry", "sent"] },
  { name: "late confirm cannot submit", events: ["late-confirm"] },
  { name: "late retry cannot submit", events: ["confirm", "refused", "late-retry"] },
  { name: "stale attempt result is ignored", events: ["confirm", "unmount", "stale-sent"] },
  { name: "chain closure is terminal", events: ["confirm", "chain-closed", "retry", "sent"] },
  { name: "missed handover is terminal", events: ["close", "handover-missed", "confirm", "handover-sent"] },
  { name: "confirmed submission is terminal", events: ["confirm", "sent", "confirm", "handover-sent"] },
]

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const invariants: NamedInvariant<OutboxState, ModelOutboxState, ReportOutboxTestEvent, OutboxObservation, StateKey, ReportOutboxTestEvent>[] = [
  {
    name: "generation never moves backwards or skips",
    specClause: "a stale generation cannot act",
    check: ({ previousReal, real }) =>
      assert(real.generation === previousReal.generation || real.generation === previousReal.generation + 1, "generation skipped or regressed"),
  },
  {
    name: "report window closure never emits submit",
    specClause: "a closed report window submits nothing",
    check: ({ event, realObservation }) => {
      if (event === "late-confirm" || event === "late-retry")
        assert(!realObservation.commands.some((command) => command.startsWith("submit:")), "closed report window emitted submit")
    },
  },
  {
    name: "stale attempt results cannot finish",
    specClause: "a stale generation cannot act",
    check: ({ event, realObservation }) => {
      if (event === "stale-sent")
        assert(!realObservation.commands.includes("finish-report"), "stale generation finished the report")
    },
  },
  {
    name: "each generation emits at most one first attempt",
    specClause: "one logical submission per report",
    check: ({ trace }) => {
      const firstAttempts = trace.flatMap((entry) => entry.real.commands).filter((command) => /^submit:\d+:1$/.test(command))
      assert(new Set(firstAttempts).size === firstAttempts.length, "generation emitted its first submit more than once")
    },
  },
  {
    name: "chain closure prevents later submit or finish",
    specClause: "chain closure is terminal",
    check: ({ trace }) => {
      const closedIndex = trace.findIndex((entry) => entry.real.state.chainClosed)
      if (closedIndex < 0) return
      const later = trace.slice(closedIndex + 1).flatMap((entry) => entry.real.commands)
      assert(!later.some((command) => command.startsWith("submit:") || command === "finish-report"), "chain-closed history emitted submit or finish")
    },
  },
  {
    name: "the first beat owns fireAt",
    specClause: "the auto-confirm beat keeps its first fireAt",
    check: ({ previousReal, real }) => {
      if (
        previousReal.rushed &&
        previousReal.fireAt !== null &&
        (previousReal.phase === "countdown" || previousReal.phase === "beat") &&
        (real.phase === "countdown" || real.phase === "beat")
      )
        assert(real.fireAt === previousReal.fireAt, "fireAt was overwritten")
    },
  },
  {
    name: "confirmed and missed states are terminal",
    specClause: "confirmed and missed are terminal",
    check: ({ previousReal, real, event, realObservation }) => {
      if ((previousReal.phase === "confirmed" || previousReal.phase === "missed") && event !== "unmount") {
        assert(JSON.stringify(real) === JSON.stringify(previousReal), "terminal state changed")
        assert(realObservation.commands.length === 0, "terminal state emitted a command")
      }
    },
  },
  {
    name: "terminal histories never submit or finish again",
    specClause: "no submit or finish after missed or confirmed",
    check: ({ trace }) => {
      const terminalIndex = trace.findIndex((entry) => entry.real.state.phase === "confirmed" || entry.real.state.phase === "missed")
      if (terminalIndex < 0) return
      const later = trace.slice(terminalIndex + 1).flatMap((entry) => entry.real.commands)
      assert(!later.some((command) => command.startsWith("submit:") || command === "finish-report"), "terminal history emitted submit or finish")
    },
  },
]

const eventArbitrary = fc.constantFrom<ReportOutboxTestEvent>(...EVENTS)
// the restarted countdowns are witnessed above and reached by verdict-changed; the property run starts from the rest
const initialCases = stateCases.filter(({ restart }) => !restart).map(({ real, model }) => ({ real, model }))

export const reportOutboxMachineDefinition: MachineDefinition<
  OutboxState,
  ModelOutboxState,
  ReportOutboxTestEvent,
  OutboxCommand[],
  string[],
  OutboxObservation,
  StateKey,
  ReportOutboxTestEvent
> = {
  name: "report-outbox",
  initialReal: () => initialReal("idle"),
  initialModel: () => initialModel("idle"),
  initialArbitrary: fc.constantFrom(...initialCases),
  realStep: (state, event) => {
    const result = reportOutbox(state, concreteEvent(state, event))
    return { state: result.state, output: result.commands }
  },
  modelStep,
  classifyRealStep: (previous, result) =>
    JSON.stringify(previous) === JSON.stringify(result.state) && result.output.length === 0 ? "no-op" : "transition",
  observeReal: ({ state, output }) => observeReal(state, output),
  observeModel: ({ state, output }) => modelObservation(state, output),
  realStateKey: (state) => stateKey({
    phase: state.phase as Phase,
    locked: state.locked,
    submitted: state.submitted,
    chainClosed: state.chainClosed,
    rushed: state.rushed,
    rushPending: state.rushPending,
    restartOwnsDeadline: state.restartOwnsDeadline,
  }),
  modelStateKey: stateKey,
  eventKey: (event) => event,
  transitionTable: reportOutboxTransitionTable,
  witnesses: reportOutboxWitnesses,
  regressions: reportOutboxRegressionCorpus,
  invariants,
  sequenceArbitrary: fc.array(eventArbitrary, { minLength: 0, maxLength: 60, size: "max" }),
  numRuns: 300,
}
