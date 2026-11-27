// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  FULL_VIDEO_RUNG,
  VIDEO_RUNGS,
  fitRung,
  rungAbove,
  rungBelow,
  type SendRungIndex,
  type SendWindowSummary,
  type VideoRung,
  type VideoRungApplyResult,
} from "./send-adaptation-classifier"

/** Four 3s windows without any sender confirming the requested rung. A sender
 * that only ever reports pending/missing never settles the request, so the
 * parked rung is treated as applied instead of freezing the ladder forever. */
const PARKED_APPLY_WINDOWS = 4

export interface SendTransition {
  id: string
  atMs: number
  direction: "down" | "up"
  cause: "bandwidth" | "recovery"
  from: SendRungIndex
  to: SendRungIndex
  probe: "none" | "start" | "success" | "failed"
  before: SendWindowSummary
}

export interface SendAdaptationState {
  rung: SendRungIndex
  mode: "steady" | "awaiting-apply" | "down-hold" | "probing-up"
  healthyWindows: number
  pressureWindows: number
  recoveryHoldMs: 12_000 | 24_000 | 48_000 | 60_000
  lastGoodRung: SendRungIndex
  transition?: SendTransition
}

export interface SendAdaptationControllerOptions {
  nowMs?: number
  rungs?: readonly VideoRung[]
  headroomRatio?: number
  /** Test pin: start here and never recover above it (pressure may still lower it). */
  ceiling?: SendRungIndex
}

export interface SendAdaptationMachineState {
  value: SendAdaptationState
  firstWindow: boolean
  lastAppliedAt: number
  transitionSequence: number
  requested?: SendTransition
  probeWindows: number
  parkedWindows: number
  policy: {
    rungs: readonly VideoRung[]
    headroomRatio: number
    ceiling?: SendRungIndex
  }
}

export type SendAdaptationEvent =
  | { kind: "observe"; summary: SendWindowSummary }
  | { kind: "accepted"; result: VideoRungApplyResult; atMs: number }
  | { kind: "rejected"; result: VideoRungApplyResult; atMs: number }
  | { kind: "regroup" }

export type SendAdaptationCommand = { kind: "apply-rung"; transition: SendTransition }

export function createSendAdaptationState({
  nowMs = 0,
  rungs = VIDEO_RUNGS,
  headroomRatio = 0.75,
  ceiling,
}: SendAdaptationControllerOptions = {}): SendAdaptationMachineState {
  const full = rungs.find((rung) => rung.index === ceiling) ?? rungs.find((rung) => rung.name === FULL_VIDEO_RUNG.name) ?? rungs[0]
  return {
    value: {
      rung: full.index,
      mode: "steady",
      healthyWindows: 0,
      pressureWindows: 0,
      recoveryHoldMs: 12_000,
      lastGoodRung: full.index,
    },
    firstWindow: true,
    lastAppliedAt: nowMs,
    transitionSequence: 0,
    probeWindows: 0,
    parkedWindows: 0,
    policy: { rungs, headroomRatio, ceiling },
  }
}

function sendAdaptationAcceptsResult(state: SendAdaptationMachineState, result: VideoRungApplyResult): boolean {
  return state.value.mode === "awaiting-apply" && state.requested?.to === result.requested
}

const position = (state: SendAdaptationMachineState, index: SendRungIndex): number => {
  const found = state.policy.rungs.findIndex((rung) => rung.index === index)
  return found < 0 ? state.policy.rungs.length : found
}

/** S4/S5: a down move the host has taken becomes the last good rung, even
 * while only pending; an up move never changes it. One rule for the pending
 * accept, the held accept and the parked settle. */
const settledGoodRung = (
  previous: SendAdaptationMachineState,
  direction: SendTransition["direction"],
  to: SendRungIndex,
): SendRungIndex => (direction === "down" ? to : previous.value.lastGoodRung)

const request = (
  previous: SendAdaptationMachineState,
  to: SendRungIndex,
  cause: SendTransition["cause"],
  before: SendWindowSummary,
  probe: SendTransition["probe"],
): { state: SendAdaptationMachineState; commands: SendAdaptationCommand[] } => {
  const from = previous.value.rung
  const transitionSequence = previous.transitionSequence + 1
  const transition: SendTransition = {
    id: `${before.atMs}-${transitionSequence}`,
    atMs: before.atMs,
    direction: position(previous, to) < position(previous, from) ? "up" : "down",
    cause,
    from,
    to,
    probe,
    before,
  }
  return {
    state: {
      ...previous,
      transitionSequence,
      requested: transition,
      parkedWindows: 0,
      value: { ...previous.value, mode: "awaiting-apply", healthyWindows: 0, pressureWindows: 0, transition },
    },
    commands: [{ kind: "apply-rung", transition }],
  }
}

const rejectRequest = (previous: SendAdaptationMachineState): SendAdaptationMachineState => {
  const requested = previous.requested!
  const wasProbe = requested.direction === "up"
  return {
    ...previous,
    value: {
      ...previous.value,
      rung: wasProbe ? previous.value.lastGoodRung : requested.from,
      lastGoodRung: wasProbe ? previous.value.lastGoodRung : requested.from,
      mode: "steady",
      healthyWindows: 0,
      pressureWindows: 0,
      transition: undefined,
      recoveryHoldMs: wasProbe ? nextBackoff(previous.value.recoveryHoldMs) : previous.value.recoveryHoldMs,
    },
    requested: undefined,
    probeWindows: 0,
    parkedWindows: 0,
  }
}

/** Pure upload-ladder policy. Window samples and apply acknowledgements are
 * events; the only command asks the host to apply a requested rung. */
export function sendAdaptationStep(
  previous: SendAdaptationMachineState,
  event: SendAdaptationEvent,
): { state: SendAdaptationMachineState; commands: SendAdaptationCommand[] } {
  const unchanged = { state: previous, commands: [] as SendAdaptationCommand[] }
  if (event.kind === "regroup") {
    // S7: a regroup clears accumulated credit without counting as a probe
    // failure. An unanswered down request stays pending — its parked-window
    // count carries over, so the request still settles after four windows and
    // the ladder cannot freeze; an unanswered up request is an unconfirmed
    // probe and rolls back to the last good rung (S4).
    const requested = previous.requested
    const keepDownRequest = previous.value.mode === "awaiting-apply" && requested !== undefined && requested.direction === "down"
    const rollbackUpRequest = previous.value.mode === "awaiting-apply" && requested !== undefined && requested.direction === "up"
    return {
      state: {
        ...previous,
        value: {
          ...previous.value,
          mode: keepDownRequest ? "awaiting-apply" : "steady",
          rung: rollbackUpRequest ? previous.value.lastGoodRung : keepDownRequest ? previous.value.rung : previous.value.mode === "probing-up" ? previous.value.lastGoodRung : previous.value.rung,
          healthyWindows: 0,
          pressureWindows: 0,
          transition: keepDownRequest ? previous.value.transition : undefined,
        },
        requested: keepDownRequest ? requested : undefined,
        probeWindows: 0,
        parkedWindows: keepDownRequest ? previous.parkedWindows : 0,
      },
      commands: [],
    }
  }
  if (event.kind === "rejected") {
    if (!sendAdaptationAcceptsResult(previous, event.result) || !previous.requested) return unchanged
    return { state: rejectRequest(previous), commands: [] }
  }
  if (event.kind === "accepted") {
    if (!sendAdaptationAcceptsResult(previous, event.result) || !previous.requested) return unchanged
    const allPending = event.result.senders.length > 0 && event.result.senders.every((sender) => sender.status === "pending" || sender.status === "missing")
    if (allPending) {
      return {
        state: {
          ...previous,
          value: {
            ...previous.value,
            rung: event.result.requested,
            mode: "awaiting-apply",
            lastGoodRung: settledGoodRung(previous, previous.requested.direction, event.result.requested),
          },
          // F3: a pending-only accept still happened at atMs, so the recovery
          // hold after the request parks is measured from here, not from an
          // older apply.
          lastAppliedAt: event.atMs,
          parkedWindows: 0,
        },
        commands: [],
      }
    }
    if (!event.result.senders.some((sender) => sender.appliedFields.includes("maxBitrate"))) {
      return { state: rejectRequest(previous), commands: [] }
    }
    const probing = previous.requested.direction === "up"
    return {
      state: {
        ...previous,
        value: {
          ...previous.value,
          rung: event.result.requested,
          mode: probing ? "probing-up" : "down-hold",
          healthyWindows: 0,
          pressureWindows: 0,
          lastGoodRung: settledGoodRung(previous, previous.requested.direction, event.result.requested),
          transition: previous.requested,
        },
        lastAppliedAt: event.atMs,
        probeWindows: 0,
        parkedWindows: 0,
        requested: undefined,
      },
      commands: [],
    }
  }

  const summary = event.summary
  if (summary.hidden || summary.baselineOnly || summary.validSenders === 0) return unchanged
  if (previous.value.mode === "awaiting-apply") {
    const requested = previous.requested!
    const parkedWindows = previous.parkedWindows + 1
    if (parkedWindows < PARKED_APPLY_WINDOWS) return { state: { ...previous, parkedWindows }, commands: [] }
    const probing = requested.direction === "up"
    return {
      state: {
        ...previous,
        value: {
          ...previous.value,
          rung: requested.to,
          mode: probing ? "probing-up" : "down-hold",
          healthyWindows: 0,
          pressureWindows: 0,
          lastGoodRung: settledGoodRung(previous, requested.direction, requested.to),
          transition: requested,
        },
        lastAppliedAt: summary.atMs,
        probeWindows: 0,
        parkedWindows: 0,
        requested: undefined,
      },
      commands: [],
    }
  }
  if (previous.value.mode === "probing-up") {
    if (summary.pressure === "bandwidth") {
      const withProbe = { ...previous, probeWindows: previous.probeWindows + 1 }
      const backedOff = { ...withProbe, value: { ...withProbe.value, recoveryHoldMs: nextBackoff(withProbe.value.recoveryHoldMs) } }
      return request(backedOff, backedOff.value.lastGoodRung, "bandwidth", summary, "failed")
    }
    if (summary.pressure === "healthy") {
      const probeWindows = previous.probeWindows + 1
      if (probeWindows >= 2) {
        return {
          state: {
            ...previous,
            value: {
              ...previous.value,
              mode: "steady",
              lastGoodRung: previous.value.rung,
              healthyWindows: 0,
              pressureWindows: 0,
              transition: undefined,
            },
            probeWindows: 0,
          },
          commands: [],
        }
      }
      return { state: { ...previous, probeWindows }, commands: [] }
    }
    return unchanged
  }

  let state = previous
  if (state.firstWindow) {
    state = { ...state, firstWindow: false }
    if (summary.availableKbps !== undefined) {
      const target = fitRung(summary.availableKbps, 1, state.policy.headroomRatio, state.policy.rungs)
      if (position(state, target) > position(state, state.value.rung)) return request(state, target, "bandwidth", summary, "none")
    }
  }
  if (summary.pressure === "bandwidth") {
    state = { ...state, value: { ...state.value, healthyWindows: 0, pressureWindows: state.value.pressureWindows + 1 } }
    const target =
      summary.availableKbps === undefined
        ? rungBelow(state.value.rung, state.policy.rungs)?.index
        : fitRung(summary.availableKbps, 1, state.policy.headroomRatio, state.policy.rungs)
    const shouldMove = summary.severe || summary.availableKbps === undefined || state.value.pressureWindows >= 2
    if (shouldMove && target !== undefined && position(state, target) > position(state, state.value.rung))
      return request(state, target, "bandwidth", summary, "none")
    return { state, commands: [] }
  }
  state = { ...state, value: { ...state.value, pressureWindows: 0 } }
  if (summary.pressure !== "healthy") {
    return { state: { ...state, value: { ...state.value, healthyWindows: 0 } }, commands: [] }
  }
  state = { ...state, value: { ...state.value, healthyWindows: state.value.healthyWindows + 1 } }
  if (state.value.healthyWindows < 4 || summary.atMs - state.lastAppliedAt < state.value.recoveryHoldMs) return { state, commands: [] }
  const above = rungAbove(state.value.rung, state.policy.rungs)
  if (above && state.policy.ceiling !== undefined && position(state, above.index) < position(state, state.policy.ceiling)) return { state, commands: [] }
  return above ? request(state, above.index, "recovery", summary, "start") : { state, commands: [] }
}

/** The policy state machine. CPU observations are intentionally ignored: this
 * controller adapts only to demonstrated upload pressure and never turns
 * video off. */
export class SendAdaptationController {
  private machine: SendAdaptationMachineState

  constructor(options: SendAdaptationControllerOptions = {}) {
    this.machine = createSendAdaptationState(options)
  }

  state(): Readonly<SendAdaptationState> {
    return this.machine.value
  }

  acceptsResult(result: VideoRungApplyResult): boolean {
    return sendAdaptationAcceptsResult(this.machine, result)
  }

  observe(summary: SendWindowSummary): SendTransition | null {
    const result = sendAdaptationStep(this.machine, { kind: "observe", summary })
    this.machine = result.state
    return result.commands[0]?.transition ?? null
  }

  accepted(result: VideoRungApplyResult, atMs: number): void {
    this.machine = sendAdaptationStep(this.machine, { kind: "accepted", result, atMs }).state
  }

  rejected(result: VideoRungApplyResult, atMs: number): void {
    this.machine = sendAdaptationStep(this.machine, { kind: "rejected", result, atMs }).state
  }

  /** A peer regroup invalidates accumulated credit, but is not a failed probe. */
  regroup(): void {
    this.machine = sendAdaptationStep(this.machine, { kind: "regroup" }).state
  }
}

function nextBackoff(current: SendAdaptationState["recoveryHoldMs"]): SendAdaptationState["recoveryHoldMs"] {
  if (current === 12_000) return 24_000
  if (current === 24_000) return 48_000
  return 60_000
}
