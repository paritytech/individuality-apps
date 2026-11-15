// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  startSignupRetry,
  stepSignupRetry,
  type RetryReason,
  type SignupEnd,
  type SignupRetryCommand,
  type SignupRetryEvent,
  type SignupRetryState,
} from "@individuality/sign-up"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

/**
 * This model specifies the extracted pure reducer. Player-visible doorway
 * policy (phase/timer callbacks and stop ordering around async work) remains
 * covered by the doorway regressions and old-vs-new differential tests.
 */
const EVENTS = [
  "window-open",
  "window-registered",
  "window-closed",
  "attempt-landed",
  "attempt-registered",
  "attempt-closed",
  "attempt-refused",
  "retry-bind",
  "retry-name",
  "retry-network",
  "retry-other",
  "wait-finished",
  "stop",
  "stale-window-open",
  "stale-attempt-landed",
  "stale-retry-network",
  "stale-wait-finished",
] as const
const ENDS = ["landed", "registered", "closed", "refused", "stopped"] as const

export type SignupRetryTestEvent = (typeof EVENTS)[number]
type ActiveStateKey = "checking-window" | "attempting" | "waiting"
type StateKey = ActiveStateKey | `finished:${SignupEnd}`

interface ModelSignupState {
  status: ActiveStateKey | "finished"
  token: number
  submits: number
  previousFailure?: RetryReason
  result?: SignupEnd
}
interface SignupRetryObservation {
  phase: SignupRetryState["phase"]
  generation: number
  attempts: number
  lastReason?: RetryReason
  end?: SignupEnd
  commands: string[]
}

const realState = (phase: SignupRetryState["phase"], attempts: number, end?: SignupEnd): SignupRetryState => ({
  phase,
  generation: 7,
  attempts,
  ...(phase === "waiting" ? { lastReason: "network" as const } : {}),
  ...(end === undefined ? {} : { end }),
})
const modelState = (status: ModelSignupState["status"], submits: number, result?: SignupEnd): ModelSignupState => ({
  status,
  token: 7,
  submits,
  ...(status === "waiting" ? { previousFailure: "network" as const } : {}),
  ...(result === undefined ? {} : { result }),
})
const stateCases: Array<{
  key: StateKey
  real: SignupRetryState
  model: ModelSignupState
}> = [
  {
    key: "checking-window",
    real: realState("checking-window", 4),
    model: modelState("checking-window", 4),
  },
  {
    key: "attempting",
    real: realState("attempting", 4),
    model: modelState("attempting", 4),
  },
  {
    key: "waiting",
    real: realState("waiting", 4),
    model: modelState("waiting", 4),
  },
  ...ENDS.map((end) => ({
    key: `finished:${end}` as const,
    real: realState("finished", 4, end),
    model: modelState("finished", 4, end),
  })),
]
const stateKey = (state: Pick<SignupRetryState, "phase" | "end">): StateKey => (state.phase === "finished" ? `finished:${state.end!}` : state.phase)

function concreteEvent(state: SignupRetryState, event: SignupRetryTestEvent): SignupRetryEvent {
  const current = state.generation
  const stale = current - 1
  switch (event) {
    case "window-open":
      return { kind: "window-result", generation: current, result: true }
    case "window-registered":
      return {
        kind: "window-result",
        generation: current,
        result: "registered",
      }
    case "window-closed":
      return { kind: "window-result", generation: current, result: false }
    case "attempt-landed":
      return {
        kind: "attempt-result",
        generation: current,
        result: { kind: "landed" },
      }
    case "attempt-registered":
      return {
        kind: "attempt-result",
        generation: current,
        result: { kind: "registered" },
      }
    case "attempt-closed":
      return {
        kind: "attempt-result",
        generation: current,
        result: { kind: "closed" },
      }
    case "attempt-refused":
      return {
        kind: "attempt-result",
        generation: current,
        result: { kind: "refused", reason: "NoInvites" },
      }
    case "retry-bind":
      return {
        kind: "attempt-result",
        generation: current,
        result: { kind: "retry", reason: "bind-pending" },
      }
    case "retry-name":
      return {
        kind: "attempt-result",
        generation: current,
        result: { kind: "retry", reason: "name-pending" },
      }
    case "retry-network":
      return {
        kind: "attempt-result",
        generation: current,
        result: { kind: "retry", reason: "network" },
      }
    case "retry-other":
      return {
        kind: "attempt-result",
        generation: current,
        result: { kind: "retry", reason: "other" },
      }
    case "wait-finished":
      return { kind: "wait-finished", generation: current }
    case "stop":
      return { kind: "stopped" }
    case "stale-window-open":
      return { kind: "window-result", generation: stale, result: true }
    case "stale-attempt-landed":
      return {
        kind: "attempt-result",
        generation: stale,
        result: { kind: "landed" },
      }
    case "stale-retry-network":
      return {
        kind: "attempt-result",
        generation: stale,
        result: { kind: "retry", reason: "network" },
      }
    case "stale-wait-finished":
      return { kind: "wait-finished", generation: stale }
  }
}

const retryReason = (event: SignupRetryTestEvent): RetryReason | undefined => {
  if (event === "retry-bind") return "bind-pending"
  if (event === "retry-name") return "name-pending"
  if (event === "retry-network" || event === "stale-retry-network") return "network"
  if (event === "retry-other") return "other"
  return undefined
}
const terminalResult = (event: SignupRetryTestEvent): SignupEnd | undefined => {
  if (event === "attempt-landed" || event === "stale-attempt-landed") return "landed"
  if (event === "attempt-registered") return "registered"
  if (event === "attempt-closed") return "closed"
  if (event === "attempt-refused") return "refused"
  return undefined
}
const staleEvent = (event: SignupRetryTestEvent): boolean => event.startsWith("stale-")
/** Specification formula, deliberately independent of the reducer's lookup table. */
const referenceBackoff = (attempt: number): number => Math.min(15_000, 2_000 * 2 ** Math.min(3, Math.max(0, attempt - 1)))

/**
 * Independent model reconstructed from the header: check the window before
 * every submit, retry every non-terminal failure, and never leave an end state.
 */
function modelStep(before: ModelSignupState, event: SignupRetryTestEvent): { state: ModelSignupState; output: string[] } {
  if (before.status === "finished") return { state: before, output: [] }
  if (event === "stop") {
    const state = {
      ...before,
      status: "finished" as const,
      token: before.token + 1,
      result: "stopped" as const,
    }
    return { state, output: [`finish:stopped:${state.submits}`] }
  }
  if (staleEvent(event)) return { state: before, output: [] }
  if (before.status === "checking-window") {
    if (event === "window-registered") {
      const state = {
        ...before,
        status: "finished" as const,
        token: before.token + 1,
        result: "registered" as const,
      }
      return { state, output: [`finish:registered:${state.submits}`] }
    }
    if (event === "window-closed") {
      const state = {
        ...before,
        status: "finished" as const,
        token: before.token + 1,
        result: "closed" as const,
      }
      return { state, output: [`finish:closed:${state.submits}`] }
    }
    if (event === "window-open") {
      const state = {
        ...before,
        status: "attempting" as const,
        token: before.token + 1,
        submits: before.submits + 1,
      }
      return { state, output: [`attempt:${state.token}:${state.submits}`] }
    }
    return { state: before, output: [] }
  }
  if (before.status === "attempting") {
    const result = terminalResult(event)
    if (result !== undefined) {
      const state = {
        ...before,
        status: "finished" as const,
        token: before.token + 1,
        result,
      }
      return { state, output: [`finish:${result}:${state.submits}`] }
    }
    const reason = retryReason(event)
    if (reason !== undefined) {
      const state = {
        ...before,
        status: "waiting" as const,
        token: before.token + 1,
        previousFailure: reason,
      }
      return {
        state,
        output: [`wait:${state.token}:${state.submits}:${reason}:${referenceBackoff(state.submits)}`],
      }
    }
    return { state: before, output: [] }
  }
  if (event === "wait-finished") {
    const state = {
      ...before,
      status: "checking-window" as const,
      token: before.token + 1,
    }
    return { state, output: [`check-window:${state.token}`] }
  }
  return { state: before, output: [] }
}

const normalizeCommands = (commands: readonly SignupRetryCommand[]): string[] =>
  commands.map((command) => {
    switch (command.kind) {
      case "check-window":
        return `check-window:${command.generation}`
      case "attempt":
        return `attempt:${command.generation}:${command.attempt}`
      case "wait":
        return `wait:${command.generation}:${command.attempt}:${command.reason}:${command.waitMs}`
      case "finish":
        return `finish:${command.end}:${command.attempts}`
    }
  })
function observeReal(state: SignupRetryState, commands: readonly SignupRetryCommand[]): SignupRetryObservation {
  return {
    phase: state.phase,
    generation: state.generation,
    attempts: state.attempts,
    ...(state.lastReason === undefined ? {} : { lastReason: state.lastReason }),
    ...(state.end === undefined ? {} : { end: state.end }),
    commands: normalizeCommands(commands),
  }
}
function observeModel(state: ModelSignupState, output: readonly string[]): SignupRetryObservation {
  return {
    phase: state.status,
    generation: state.token,
    attempts: state.submits,
    ...(state.previousFailure === undefined ? {} : { lastReason: state.previousFailure }),
    ...(state.result === undefined ? {} : { end: state.result }),
    commands: [...output],
  }
}
const modelOutcome = (before: ModelSignupState, event: SignupRetryTestEvent): "transition" | "no-op" =>
  JSON.stringify(before) === JSON.stringify(modelStep(before, event).state) ? "no-op" : "transition"

export const signupRetryTransitionTable = defineTransitionTable<StateKey, SignupRetryTestEvent>()(
  Object.fromEntries(stateCases.map(({ key, model }) => [key, Object.fromEntries(EVENTS.map((event) => [event, modelOutcome(model, event)]))])) as Record<
    StateKey,
    Record<SignupRetryTestEvent, "transition" | "no-op">
  >,
)
export const signupRetryWitnesses: NamedSequence<SignupRetryTestEvent, SignupRetryState, ModelSignupState>[] = stateCases.flatMap(({ key, real, model }) =>
  EVENTS.map((event) => ({
    name: `${key} × ${event}`,
    initial: { real, model },
    events: [event],
  })),
)
export const signupRetryRegressionCorpus: NamedSequence<SignupRetryTestEvent>[] = [
  {
    name: "retry rechecks the window before another submit",
    events: ["window-open", "retry-other", "wait-finished", "window-open"],
  },
  {
    name: "closed registration stops all later retries",
    events: ["window-open", "retry-network", "wait-finished", "window-closed", "window-open", "retry-other"],
  },
  {
    name: "registered wins when the window closed behind the player",
    events: ["window-open", "retry-other", "wait-finished", "window-registered"],
  },
  {
    name: "duplicate and stale completions cannot duplicate a submit",
    events: ["window-open", "window-open", "stale-window-open", "retry-network", "stale-retry-network", "retry-network", "wait-finished"],
  },
  {
    name: "late attempt success cannot replace a closed result",
    events: ["window-closed", "stale-attempt-landed", "attempt-landed"],
  },
  {
    name: "player stop is terminal from every active stage",
    events: ["window-open", "retry-bind", "stop", "wait-finished", "window-open"],
  },
]

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}
const invariants: NamedInvariant<SignupRetryState, ModelSignupState, SignupRetryTestEvent, SignupRetryObservation, StateKey, SignupRetryTestEvent>[] = [
  {
    name: "retry delay stays within the documented backoff bounds",
    specClause: "header: retry on 2, 4, 8 seconds, then every 15 seconds",
    check: ({ previousReal, realObservation }) => {
      const wait = realObservation.commands.find((command) => command.startsWith("wait:"))
      if (wait === undefined) return
      const delay = Number(wait.split(":").at(-1))
      assert(delay === referenceBackoff(previousReal.attempts), "retry delay did not follow the bounded schedule")
      assert(delay >= 2_000 && delay <= 15_000, "retry delay escaped its bounds")
    },
  },
  {
    name: "one open-window decision emits at most one sign-up submit",
    specClause: "header: check the window, then make one numbered attempt",
    check: ({ previousReal, event, real, realObservation }) => {
      const submit = realObservation.commands.filter((command) => command.startsWith("attempt:"))
      assert(submit.length <= 1, "one event emitted duplicate sign-up submits")
      if (submit.length === 1) {
        assert(previousReal.phase === "checking-window" && event === "window-open", "submit lacked an open window")
        assert(real.attempts === previousReal.attempts + 1, "submit number did not advance exactly once")
      }
    },
  },
  {
    name: "a closed registration window stops retries",
    specClause: "header: registration closed is terminal because no retry can change it",
    check: ({ previousReal, real, realObservation }) => {
      if (previousReal.end !== "closed" && real.end !== "closed") return
      assert(real.phase === "finished" && real.end === "closed", "closed registration reopened")
      assert(!realObservation.commands.some((command) => command.startsWith("attempt:") || command.startsWith("wait:")), "closed registration scheduled work")
    },
  },
  {
    name: "every terminal outcome is irreversible",
    specClause: "header: only landed, registered, closed, refused, or stopped end the loop",
    check: ({ previousReal, real, realObservation }) => {
      if (previousReal.phase !== "finished") return
      assert(real === previousReal, "terminal state changed")
      assert(realObservation.commands.length === 0, "terminal state emitted a command")
    },
  },
  {
    name: "attempt numbers never regress or skip",
    specClause: "header: retries are numbered and continue until a terminal condition",
    check: ({ previousReal, real }) =>
      assert(real.attempts === previousReal.attempts || real.attempts === previousReal.attempts + 1, "attempt counter regressed or skipped"),
  },
  {
    name: "stale and out-of-order completions have no effect",
    specClause: "house rule: side-effect completions apply only to their current state and generation",
    check: ({ previousReal, event, real, realObservation }) => {
      const family =
        event.startsWith("window-") || event === "stale-window-open"
          ? "checking-window"
          : event.startsWith("attempt-") || event.startsWith("retry-") || event === "stale-attempt-landed" || event === "stale-retry-network"
            ? "attempting"
            : event === "wait-finished" || event === "stale-wait-finished"
              ? "waiting"
              : undefined
      if (!staleEvent(event) && (family === undefined || previousReal.phase === family)) return
      assert(real === previousReal, "stale or out-of-order completion changed state")
      assert(realObservation.commands.length === 0, "stale or out-of-order completion emitted a command")
    },
  },
]

const eventArbitrary = fc.constantFrom<SignupRetryTestEvent>(...EVENTS)
const started = startSignupRetry()
const initialModel: ModelSignupState = {
  status: "checking-window",
  token: 1,
  submits: 0,
}
export const signupRetryMachineDefinition: MachineDefinition<
  SignupRetryState,
  ModelSignupState,
  SignupRetryTestEvent,
  SignupRetryCommand[],
  string[],
  SignupRetryObservation,
  StateKey,
  SignupRetryTestEvent
> = {
  name: "signup-retry",
  initialReal: () => started.state,
  initialModel: () => initialModel,
  initialArbitrary: fc.constantFrom(...stateCases.map(({ real, model }) => ({ real, model }))),
  realStep: (state, event) => {
    const result = stepSignupRetry(state, concreteEvent(state, event))
    return { state: result.state, output: result.commands }
  },
  modelStep,
  classifyRealStep: (previous, result) => (previous === result.state ? "no-op" : "transition"),
  observeReal: ({ state, output }) => observeReal(state, output),
  observeModel: ({ state, output }) => observeModel(state, output),
  realStateKey: stateKey,
  modelStateKey: (state) => (state.status === "finished" ? `finished:${state.result!}` : state.status),
  eventKey: (event) => event,
  transitionTable: signupRetryTransitionTable,
  witnesses: signupRetryWitnesses,
  regressions: signupRetryRegressionCorpus,
  invariants,
  sequenceArbitrary: fc.array(eventArbitrary, {
    minLength: 0,
    maxLength: 80,
    size: "max",
  }),
  numRuns: 300,
}
