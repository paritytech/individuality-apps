// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  createSendAdaptationState,
  sendAdaptationStep,
  type SendAdaptationCommand,
  type SendAdaptationEvent,
  type SendAdaptationMachineState,
  type SendTransition,
} from "../webrtc/send-adaptation"
import type { SendWindowSummary, VideoRungApplyResult, VideoRungSenderResult } from "../webrtc/send-adaptation-classifier"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence, type TransitionTable } from "./framework"

/**
 * Independent upload-ladder model, derived from the module header and policy
 * comments rather than the controller's branches:
 *
 * S1 hidden, baseline-only and senderless windows grant no credit or pressure;
 * S2 the first eligible capacity sample may fit directly; later ordinary
 *    bandwidth pressure needs two windows, while severe/unknown capacity acts
 *    immediately, and the video floor is terminal;
 * S3 recovery needs four healthy windows and the hold, then probes one rung;
 * S4 a probe is good after two healthy windows; bandwidth failure returns to
 *    the last good rung and backs off 12→24→48→60 seconds;
 * S5 one request is pending at a time; stale/duplicate acknowledgements do
 *    nothing, partial maxBitrate application counts, and refusal rolls back;
 * S6 pending/missing-only application parks the request, but four eligible
 *    windows settle that rung so the ladder cannot freeze;
 * S7 regroup clears all accumulated credit without counting as probe failure;
 *    an unanswered down request stays pending across it (it still parks after
 *    four windows), an unanswered up probe rolls back to the last good rung;
 * S8 every move follows ordered rungs and video is never disabled.
 */

const ACTIONS = [
  "hidden", "senderless", "unknown", "healthy", "pressure-known", "pressure-unknown", "pressure-severe",
  "accept-held", "accept-pending", "accept-refused", "reject", "stale-accept", "stale-reject", "regroup",
] as const
type Action = (typeof ACTIONS)[number]
export interface SendAdaptationTestEvent { action: Action }
type StateKey =
  | "steady-fresh"
  | "steady-quiet"
  | "steady-credited"
  | "awaiting-down"
  | "awaiting-up"
  | "awaiting-pending-down"
  | "awaiting-pending-up"
  | "awaiting-parked-down"
  | "awaiting-parked-up"
  | "down-hold-quiet"
  | "down-hold-credited"
  | "probing"
type EventKey = Action
type Direction = "up" | "down"
interface ModelMove { direction: Direction; cause: "bandwidth" | "recovery"; from: number; to: number; probe: SendTransition["probe"] }
interface ModelState {
  stage: "steady" | "awaiting" | "down-hold" | "probing"
  tier: number
  goodTier: number
  first: boolean
  healthy: number
  pressure: number
  hold: 12_000 | 24_000 | 48_000 | 60_000
  request?: ModelMove
  transition?: ModelMove
  probeWindows: number
  parkedWindows: number
}
interface Observation {
  stage: ModelState["stage"]
  tier: number
  goodTier: number
  first: boolean
  healthy: number
  pressure: number
  hold: number
  request?: ModelMove
  transition?: ModelMove
  probeWindows: number
  parkedWindows: number
  commands: ModelMove[]
}

const initialModel = (): ModelState => ({
  stage: "steady", tier: 0, goodTier: 0, first: true, healthy: 0, pressure: 0,
  hold: 12_000, probeWindows: 0, parkedWindows: 0,
})
const backoff = (hold: ModelState["hold"]): ModelState["hold"] => hold === 12_000 ? 24_000 : hold === 24_000 ? 48_000 : 60_000
const isPressure = (action: Action): boolean => action.startsWith("pressure-")

/** S4: a settled down move becomes the good tier; a settled up move never
 * changes it. Spec clause, not a copy of the implementation's helper. */
const settledGoodTier = (state: ModelState, direction: Direction, to: number): number =>
  direction === "down" ? to : state.goodTier

const requestModel = (state: ModelState, to: number, cause: ModelMove["cause"], probe: ModelMove["probe"]): { state: ModelState; output: ModelMove[] } => {
  const move: ModelMove = { direction: to < state.tier ? "up" : "down", cause, from: state.tier, to, probe }
  return {
    state: { ...state, stage: "awaiting", healthy: 0, pressure: 0, request: move, transition: move, parkedWindows: 0 },
    output: [move],
  }
}

/** Policy model expressed as tier movement, credits and one request token. */
function modelAction(before: ModelState, action: Action): { state: ModelState; output: ModelMove[] } {
  if (action === "regroup") {
    const request = before.request
    const awaiting = before.stage === "awaiting" && request !== undefined
    if (awaiting && request.direction === "down") {
      // The request and its parked-window count carry over untouched.
      return { state: { ...before, healthy: 0, pressure: 0, probeWindows: 0 }, output: [] }
    }
    return {
      state: {
        ...before,
        stage: "steady",
        tier: before.stage === "probing" || (awaiting && request.direction === "up") ? before.goodTier : before.tier,
        healthy: 0,
        pressure: 0,
        request: undefined,
        transition: undefined,
        probeWindows: 0,
        parkedWindows: 0,
      },
      output: [],
    }
  }
  if (action.includes("accept") || action.includes("reject")) {
    const matching = before.stage === "awaiting" && before.request !== undefined && !action.startsWith("stale-")
    if (!matching) return { state: before, output: [] }
    if (action === "accept-pending")
      return {
        state: {
          ...before,
          tier: before.request!.to,
          goodTier: settledGoodTier(before, before.request!.direction, before.request!.to),
          parkedWindows: 0,
        },
        output: [],
      }
    if (action === "accept-held") {
      const up = before.request!.direction === "up"
      return {
        state: {
          ...before,
          stage: up ? "probing" : "down-hold",
          tier: before.request!.to,
          goodTier: settledGoodTier(before, before.request!.direction, before.request!.to),
          healthy: 0,
          pressure: 0,
          request: undefined,
          probeWindows: 0,
          parkedWindows: 0,
        },
        output: [],
      }
    }
    const failedProbe = before.request!.direction === "up"
    return {
      state: {
        ...before,
        stage: "steady",
        tier: failedProbe ? before.goodTier : before.request!.from,
        goodTier: failedProbe ? before.goodTier : before.request!.from,
        healthy: 0,
        pressure: 0,
        hold: failedProbe ? backoff(before.hold) : before.hold,
        request: undefined,
        transition: undefined,
        probeWindows: 0,
        parkedWindows: 0,
      },
      output: [],
    }
  }
  if (action === "hidden" || action === "senderless") return { state: before, output: [] }
  if (before.stage === "awaiting") {
    const parkedWindows = before.parkedWindows + 1
    if (parkedWindows < 4) return { state: { ...before, parkedWindows }, output: [] }
    const up = before.request!.direction === "up"
    return {
      state: {
        ...before,
        stage: up ? "probing" : "down-hold",
        tier: before.request!.to,
        goodTier: settledGoodTier(before, before.request!.direction, before.request!.to),
        healthy: 0,
        pressure: 0,
        request: undefined,
        probeWindows: 0,
        parkedWindows: 0,
      },
      output: [],
    }
  }
  if (before.stage === "probing") {
    if (isPressure(action)) {
      const backed = { ...before, probeWindows: before.probeWindows + 1, hold: backoff(before.hold) }
      return requestModel(backed, backed.goodTier, "bandwidth", "failed")
    }
    if (action === "healthy") {
      const probeWindows = before.probeWindows + 1
      if (probeWindows >= 2)
        return { state: { ...before, stage: "steady", goodTier: before.tier, healthy: 0, pressure: 0, transition: undefined, probeWindows: 0 }, output: [] }
      return { state: { ...before, probeWindows }, output: [] }
    }
    return { state: before, output: [] }
  }

  let state = before
  if (state.first) {
    state = { ...state, first: false }
    if ((action === "pressure-known" || action === "pressure-severe") && state.tier < 4)
      return requestModel(state, 4, "bandwidth", "none")
  }
  if (isPressure(action)) {
    state = { ...state, healthy: 0, pressure: state.pressure + 1 }
    const target = action === "pressure-unknown" ? Math.min(4, state.tier + 1) : 4
    if (state.tier < target && (action !== "pressure-known" || state.pressure >= 2))
      return requestModel(state, target, "bandwidth", "none")
    return { state, output: [] }
  }
  state = { ...state, pressure: 0 }
  if (action !== "healthy") return { state: { ...state, healthy: 0 }, output: [] }
  state = { ...state, healthy: state.healthy + 1 }
  return state.healthy >= 4 && state.tier > 0
    ? requestModel(state, state.tier - 1, "recovery", "start")
    : { state, output: [] }
}

const moveOf = (transition: SendTransition | undefined): ModelMove | undefined => transition === undefined ? undefined : ({
  direction: transition.direction,
  cause: transition.cause,
  from: transition.from,
  to: transition.to,
  probe: transition.probe,
})
const stageOfReal = (state: SendAdaptationMachineState): ModelState["stage"] =>
  state.value.mode === "awaiting-apply" ? "awaiting" : state.value.mode === "probing-up" ? "probing" : state.value.mode

const searchId = (state: ModelState): string => [
  state.stage,
  `t${state.tier}`,
  `g${state.stage === "probing" || state.request?.direction === "up" ? state.goodTier : state.tier}`,
  state.first ? "fresh" : "seen",
  state.healthy > 0 ? `h${Math.min(4, state.healthy)}` : state.pressure > 0 ? `p${Math.min(2, state.pressure)}` : "credit0",
  `q${state.request ? `${state.request.direction}-${state.request.to}` : "none"}`,
  `w${state.stage === "probing" ? Math.min(2, state.probeWindows) : 0}`,
  `k${state.stage === "awaiting" ? Math.min(4, state.parkedWindows) : 0}`,
].join("|")

const modelOfReal = (state: SendAdaptationMachineState): ModelState => ({
  stage: stageOfReal(state),
  tier: state.value.rung,
  goodTier: state.value.lastGoodRung,
  first: state.firstWindow,
  healthy: state.value.healthyWindows,
  pressure: state.value.pressureWindows,
  hold: state.value.recoveryHoldMs,
  request: moveOf(state.requested),
  transition: moveOf(state.value.transition),
  probeWindows: state.probeWindows,
  parkedWindows: state.parkedWindows,
})
const stateKey = (state: ModelState): StateKey => {
  if (state.stage === "steady") {
    if (state.first) return "steady-fresh"
    return state.healthy > 0 || state.pressure > 0 ? "steady-credited" : "steady-quiet"
  }
  if (state.stage === "awaiting") {
    if (state.parkedWindows > 0)
      return state.request?.direction === "down" ? "awaiting-parked-down" : "awaiting-parked-up"
    if (state.tier === state.request?.to)
      return state.request?.direction === "down" ? "awaiting-pending-down" : "awaiting-pending-up"
    return state.request?.direction === "down" ? "awaiting-down" : "awaiting-up"
  }
  if (state.stage === "down-hold")
    return state.healthy > 0 || state.pressure > 0 ? "down-hold-credited" : "down-hold-quiet"
  return "probing"
}
const stateKeyReal = (state: SendAdaptationMachineState): StateKey => stateKey(modelOfReal(state))

const makeSummary = (state: SendAdaptationMachineState, action: Action): SendWindowSummary => ({
  atMs: state.lastAppliedAt + (action === "healthy" ? 60_000 : 3_000),
  durationMs: 3_000,
  hidden: action === "hidden",
  baselineOnly: false,
  effects: { windowMs: 3_000 },
  activeSenders: action === "senderless" ? 0 : 5,
  validSenders: action === "senderless" ? 0 : 5,
  targetBitrateCoverage: 0,
  targetNearCapShare: 0,
  bandwidthLowTargetShare: 0,
  bandwidthShare: 0,
  cpuShare: 0,
  noneShare: 0,
  stalledShare: 0,
  encoderImplementations: [],
  route: "direct",
  pressure: isPressure(action) ? "bandwidth" : action === "healthy" ? "healthy" : "unknown",
  severe: action === "pressure-severe",
  ...((action === "pressure-known" || action === "pressure-severe") ? { availableKbps: 60 } : {}),
})
const makeApply = (state: SendAdaptationMachineState, action: Action): VideoRungApplyResult => {
  const stale = action.startsWith("stale-")
  const requested = stale ? (state.requested?.to ?? 4) + 10 : state.requested?.to ?? 999
  const status: VideoRungSenderResult["status"] = action === "accept-pending" ? "pending" : action === "accept-refused" || action.includes("reject") ? "refused" : "applied"
  return {
    requested,
    uniform: status === "applied",
    senders: [{
      id: "sender-a",
      status,
      appliedFields: status === "applied" ? ["maxBitrate"] : [],
      refusedFields: status === "refused" ? ["maxBitrate"] : [],
    }],
  }
}
const realEvent = (state: SendAdaptationMachineState, action: Action): SendAdaptationEvent => {
  if (action === "regroup") return { kind: "regroup" }
  if (action.includes("accept")) return { kind: "accepted", result: makeApply(state, action), atMs: state.lastAppliedAt + 3_000 }
  if (action.includes("reject")) return { kind: "rejected", result: makeApply(state, action), atMs: state.lastAppliedAt + 3_000 }
  return { kind: "observe", summary: makeSummary(state, action) }
}
const realStep = (state: SendAdaptationMachineState, event: SendAdaptationTestEvent) => {
  const result = sendAdaptationStep(state, realEvent(state, event.action))
  return { state: result.state, output: result.commands }
}

const compile = (actions: readonly Action[]): SendAdaptationTestEvent[] => actions.map((action) => ({ action }))

interface Case { state: ModelState; prefix: SendAdaptationTestEvent[] }
const visited = new Set<string>()
const discovered = new Map<`${StateKey}::${EventKey}`, NamedSequence<SendAdaptationTestEvent, SendAdaptationMachineState, ModelState>>()
const queue: Case[] = [{ state: initialModel(), prefix: [] }]
while (queue.length > 0) {
  const current = queue.shift()!
  const currentId = searchId(current.state)
  if (visited.has(currentId)) continue
  visited.add(currentId)
  if (visited.size > 2_000) throw new Error("send-adaptation abstract state space did not close")
  for (const action of ACTIONS) {
    const event = { action } satisfies SendAdaptationTestEvent
    const eventKey = action
    const pair = `${stateKey(current.state)}::${eventKey}` as const
    if (!discovered.has(pair)) discovered.set(pair, { name: pair, events: [...current.prefix, event] })
    const next = modelAction(current.state, action).state
    if (!visited.has(searchId(next))) queue.push({ state: next, prefix: [...current.prefix, event] })
  }
}

/** Contract outcomes transcribed from S1-S8 above. The model discovers
 * witnesses for these cells, but never writes or changes the table. */
const awaitingRow = (regroup: "transition" | "no-op"): TransitionTable<StateKey, EventKey>[StateKey] => ({
  hidden: "no-op", senderless: "no-op", unknown: "transition", healthy: "transition",
  "pressure-known": "transition", "pressure-unknown": "transition", "pressure-severe": "transition",
  "accept-held": "transition", "accept-pending": "transition", "accept-refused": "transition", reject: "transition",
  "stale-accept": "no-op", "stale-reject": "no-op", regroup,
})
export const sendAdaptationTransitionTable = defineTransitionTable<StateKey, EventKey>()({
  "steady-fresh": {
    hidden: "no-op", senderless: "no-op", unknown: "transition", healthy: "transition",
    "pressure-known": "transition", "pressure-unknown": "transition", "pressure-severe": "transition",
    "accept-held": "no-op", "accept-pending": "no-op", "accept-refused": "no-op", reject: "no-op",
    "stale-accept": "no-op", "stale-reject": "no-op", regroup: "no-op",
  },
  "steady-quiet": {
    hidden: "no-op", senderless: "no-op", unknown: "no-op", healthy: "transition",
    "pressure-known": "transition", "pressure-unknown": "transition", "pressure-severe": "transition",
    "accept-held": "no-op", "accept-pending": "no-op", "accept-refused": "no-op", reject: "no-op",
    "stale-accept": "no-op", "stale-reject": "no-op", regroup: "no-op",
  },
  "steady-credited": {
    hidden: "no-op", senderless: "no-op", unknown: "transition", healthy: "transition",
    "pressure-known": "transition", "pressure-unknown": "transition", "pressure-severe": "transition",
    "accept-held": "no-op", "accept-pending": "no-op", "accept-refused": "no-op", reject: "no-op",
    "stale-accept": "no-op", "stale-reject": "no-op", regroup: "transition",
  },
  "awaiting-down": awaitingRow("no-op"),
  "awaiting-up": awaitingRow("transition"),
  "awaiting-pending-down": awaitingRow("no-op"),
  "awaiting-pending-up": awaitingRow("transition"),
  "awaiting-parked-down": awaitingRow("no-op"),
  "awaiting-parked-up": awaitingRow("transition"),
  "down-hold-quiet": {
    hidden: "no-op", senderless: "no-op", unknown: "no-op", healthy: "transition",
    "pressure-known": "transition", "pressure-unknown": "transition", "pressure-severe": "transition",
    "accept-held": "no-op", "accept-pending": "no-op", "accept-refused": "no-op", reject: "no-op",
    "stale-accept": "no-op", "stale-reject": "no-op", regroup: "transition",
  },
  "down-hold-credited": {
    hidden: "no-op", senderless: "no-op", unknown: "transition", healthy: "transition",
    "pressure-known": "transition", "pressure-unknown": "transition", "pressure-severe": "transition",
    "accept-held": "no-op", "accept-pending": "no-op", "accept-refused": "no-op", reject: "no-op",
    "stale-accept": "no-op", "stale-reject": "no-op", regroup: "transition",
  },
  probing: {
    hidden: "no-op", senderless: "no-op", unknown: "no-op", healthy: "transition",
    "pressure-known": "transition", "pressure-unknown": "transition", "pressure-severe": "transition",
    "accept-held": "no-op", "accept-pending": "no-op", "accept-refused": "no-op", reject: "no-op",
    "stale-accept": "no-op", "stale-reject": "no-op", regroup: "transition",
  },
})
export const sendAdaptationWitnesses = [...discovered.values()]

export const sendAdaptationRegressions: NamedSequence<SendAdaptationTestEvent, SendAdaptationMachineState, ModelState>[] = [
  { name: "first capacity window fits directly", events: compile(["pressure-known", "accept-held"]) },
  { name: "ordinary later pressure needs two windows", events: compile(["unknown", "pressure-known", "pressure-known", "accept-held"]) },
  { name: "unknown capacity descends one ordered rung immediately", events: compile(["unknown", "pressure-unknown", "accept-held"]) },
  { name: "four healthy windows start one-rung recovery probe", events: compile(["pressure-known", "accept-held", "healthy", "healthy", "healthy", "healthy"]) },
  { name: "two healthy probe windows commit recovery", events: compile(["pressure-known", "accept-held", "healthy", "healthy", "healthy", "healthy", "accept-held", "healthy", "healthy"]) },
  { name: "probe pressure restores last good and backs off", events: compile(["pressure-known", "accept-held", "healthy", "healthy", "healthy", "healthy", "accept-held", "pressure-known", "accept-held"]) },
  { name: "pending request settles after four windows", events: compile(["pressure-known", "accept-pending", "unknown", "unknown", "unknown", "unknown"]) },
  { name: "regroup clears probe credit without backoff", events: compile(["pressure-known", "accept-held", "healthy", "healthy", "healthy", "healthy", "accept-held", "healthy", "regroup"]) },
  { name: "pending down move survives regroup and failed recovery probe", events: compile(["pressure-known", "accept-pending", "regroup", "healthy", "healthy", "healthy", "healthy", "accept-held", "pressure-known"]) },
  { name: "unanswered down request keeps awaiting across regroup and settles the late accept", events: compile(["pressure-known", "regroup", "accept-held"]) },
  { name: "unconfirmed up probe rolls back to the last good rung on regroup", events: compile(["pressure-known", "accept-held", "healthy", "healthy", "healthy", "healthy", "accept-pending", "regroup"]) },
  { name: "rejected pending down move restores the prior last good rung", events: compile(["pressure-unknown", "accept-held", "pressure-unknown", "accept-held", "pressure-severe", "accept-pending", "reject", "healthy", "healthy", "healthy", "healthy", "accept-held", "pressure-known"]) },
  { name: "settled parked probe leaves steady regroup inert", events: compile(["pressure-known", "accept-held", "healthy", "healthy", "healthy", "healthy", "unknown", "accept-held", "healthy", "healthy", "regroup"]) },
  { name: "stale duplicate and out-of-order results are inert", events: compile(["stale-accept", "reject", "pressure-known", "stale-reject", "accept-held", "accept-held", "reject"]) },
]

const observeModel = (state: ModelState, commands: ModelMove[]): Observation => ({ ...state, commands })
const observeReal = (state: SendAdaptationMachineState, commands: SendAdaptationCommand[]): Observation => ({
  ...modelOfReal(state),
  commands: commands.map(({ transition }) => moveOf(transition)!),
})
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
const invariants: NamedInvariant<SendAdaptationMachineState, ModelState, SendAdaptationTestEvent, Observation, StateKey, EventKey>[] = [
  {
    name: "ineligible windows are completely inert",
    specClause: "S1 hidden/baseline/senderless windows grant no evidence",
    check: ({ previousReal, real, event, realObservation }) => {
      if (event.action === "hidden" || event.action === "senderless") assert(real === previousReal && realObservation.commands.length === 0, `${event.action} changed state`)
    },
  },
  {
    name: "the ladder stays on an eligible video rung",
    specClause: "S2/S8 video floor and ordered-rung movement",
    check: ({ real }) => assert(real.value.rung >= 0 && real.value.rung <= 4, `tier ${real.value.rung}`),
  },
  {
    name: "upward requests spend four healthy credits and downward requests need bandwidth pressure",
    specClause: "S2/S3",
    check: ({ previousReal, event, realObservation }) => realObservation.commands.forEach((move) => {
      if (move.direction === "up") assert(event.action === "healthy" && previousReal.value.healthyWindows >= 3, `up on ${event.action}`)
      else assert(isPressure(event.action), `down on ${event.action}`)
    }),
  },
  {
    name: "only one matching request can settle and stale results do nothing",
    specClause: "S5",
    check: ({ previousReal, real, event, realObservation }) => {
      if (event.action.startsWith("stale-") || ((event.action.includes("accept") || event.action === "reject") && previousReal.requested === undefined))
        assert(real === previousReal && realObservation.commands.length === 0, `${event.action} settled without its request`)
      if (real.value.mode === "awaiting-apply") assert(real.requested !== undefined, "awaiting without request")
    },
  },
  {
    name: "recovery backoff is bounded to the policy ladder",
    specClause: "S4 12→24→48→60 second probe backoff",
    check: ({ real }) => assert([12_000, 24_000, 48_000, 60_000].includes(real.value.recoveryHoldMs), `hold ${real.value.recoveryHoldMs}`),
  },
  {
    name: "the fourth parked window releases awaiting-apply",
    specClause: "S6 PARKED_APPLY_WINDOWS",
    check: ({ previousReal, real, event }) => {
      if (!event.action.includes("accept") && !event.action.includes("reject") && event.action !== "hidden" && event.action !== "senderless" && event.action !== "regroup" && previousReal.value.mode === "awaiting-apply" && previousReal.parkedWindows === 3)
        assert(real.value.mode !== "awaiting-apply", "request remained parked")
    },
  },
]

export const sendAdaptationMachineDefinition: MachineDefinition<
  SendAdaptationMachineState, ModelState, SendAdaptationTestEvent, SendAdaptationCommand[], ModelMove[], Observation, StateKey, EventKey
> = {
  name: "send-adaptation",
  initialReal: createSendAdaptationState,
  initialModel,
  realStep,
  modelStep: (state, event) => modelAction(state, event.action),
  classifyRealStep: (previous, result) => JSON.stringify(previous) === JSON.stringify(result.state) && result.output.length === 0 ? "no-op" : "transition",
  observeReal: ({ state, output }) => observeReal(state, output),
  observeModel: ({ state, output }) => observeModel(state, output),
  realStateKey: stateKeyReal,
  modelStateKey: stateKey,
  eventKey: (event) => event.action,
  transitionTable: sendAdaptationTransitionTable,
  witnesses: sendAdaptationWitnesses,
  regressions: sendAdaptationRegressions,
  invariants,
  sequenceArbitrary: fc.array(fc.constantFrom(...ACTIONS), { minLength: 0, maxLength: 100 }).map((actions) => compile(actions)),
  numRuns: 300,
}
