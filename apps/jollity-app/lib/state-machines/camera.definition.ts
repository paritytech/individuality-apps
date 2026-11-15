// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  cameraRecoveryStep,
  startCameraRecovery,
  type CameraRecoveryCommand,
  type CameraRecoveryEvent,
  type CameraRecoveryState,
} from "../camera"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

/** Independent recovery model from camera.ts's header:
 * K1 hidden/unheld work never opens a camera; K2 retry waits are bounded;
 * K3 only the current timer may recover; K4 live resets only retry backoff;
 * K5 three quick still-muted reopens offer one tap; K6 tapping schedules no
 * recovery; K7 one end command closes each offered episode. */
type BaseKey = "ready" | "scheduled" | "deferred" | "deferred-scheduled"
type TapPhase = CameraRecoveryState["tap"]
type StateKey = BaseKey | `${BaseKey}:${Exclude<TapPhase, "none">}`
type EventKey =
  | "recover" | "recover-hidden" | "recover-hidden-unheld" | "open-hidden-unheld" | "recover-unheld"
  | "busy" | "other" | "override" | "retry-hidden" | "retry-unheld"
  | "fire" | "fire-hidden" | "fire-unheld" | "stale-fire" | "shown" | "shown-unavailable"
  | "clear" | "live" | "stop"
  | "still-muted-quick" | "still-muted-slow" | "unmuted" | "frame" | "hidden"
  | "tap" | "tap-frames" | "tap-muted" | "tap-error"
type TestEvent = EventKey
interface ModelState { failures: number; behind: boolean; alarm: number | undefined; mutedStreak: number; tap: TapPhase }
interface Observation { state: StateKey; failures: number; mutedStreak: number; tap: TapPhase; commands: string[] }

const EVENTS: TestEvent[] = [
  "recover", "recover-hidden", "recover-hidden-unheld", "open-hidden-unheld", "recover-unheld",
  "busy", "other", "override", "retry-hidden", "retry-unheld", "fire", "fire-hidden", "fire-unheld", "stale-fire",
  "shown", "shown-unavailable", "clear", "live", "stop",
  "still-muted-quick", "still-muted-slow", "unmuted", "frame", "hidden", "tap", "tap-frames", "tap-muted", "tap-error",
]
const TAPS: TapPhase[] = ["none", "offered", "tapping", "spent"]

const realBase = (state: CameraRecoveryState): BaseKey => state.deferred
  ? state.scheduledAttempt === null ? "deferred" : "deferred-scheduled"
  : state.scheduledAttempt === null ? "ready" : "scheduled"
const modelBase = (state: ModelState): BaseKey => state.behind
  ? state.alarm === undefined ? "deferred" : "deferred-scheduled"
  : state.alarm === undefined ? "ready" : "scheduled"
const phaseKey = (base: BaseKey, tap: TapPhase): StateKey => tap === "none" ? base : `${base}:${tap}`
const realKey = (state: CameraRecoveryState): StateKey => phaseKey(realBase(state), state.tap)
const modelKey = (state: ModelState): StateKey => phaseKey(modelBase(state), state.tap)

const concrete = (state: CameraRecoveryState, event: TestEvent): CameraRecoveryEvent => {
  if (event === "recover") return { kind: "recover", held: true, hidden: false, reason: "ended", trigger: "force" }
  if (event === "recover-hidden") return { kind: "recover", held: true, hidden: true, reason: "ended", trigger: "force" }
  if (event === "recover-hidden-unheld") return { kind: "recover", held: false, hidden: true, reason: "ended", trigger: "force" }
  if (event === "open-hidden-unheld") return { kind: "recover", held: false, hidden: true, reason: "open requested", trigger: "warm-up", deferWithoutHolder: true }
  if (event === "recover-unheld") return { kind: "recover", held: false, hidden: false, reason: "ended", trigger: "force" }
  if (event === "busy") return { kind: "retry", held: true, hidden: false, reason: "busy", trigger: "warm-up" }
  if (event === "other") return { kind: "retry", held: true, hidden: false, reason: "unknown", trigger: "warm-up" }
  if (event === "override") return { kind: "retry", held: true, hidden: false, reason: "denied", waitOverride: 500, trigger: "return" }
  if (event === "retry-hidden") return { kind: "retry", held: true, hidden: true, reason: "unknown", trigger: "warm-up" }
  if (event === "retry-unheld") return { kind: "retry", held: false, hidden: false, reason: "unknown", trigger: "warm-up" }
  if (event === "fire" || event === "fire-hidden" || event === "fire-unheld") return {
    kind: "retry-fired", attempt: state.scheduledAttempt ?? state.retries,
    held: event !== "fire-unheld", hidden: event === "fire-hidden",
  }
  if (event === "stale-fire") return { kind: "retry-fired", attempt: (state.scheduledAttempt ?? state.retries) + 99, held: true, hidden: false }
  if (event === "shown" || event === "shown-unavailable") return { kind: "shown", held: true, hidden: false, unavailable: event === "shown-unavailable" }
  return { kind: event }
}

const words = (commands: readonly CameraRecoveryCommand[]): string[] => commands.map((command) => {
  if (command.kind === "recover") return `recover:${command.reason}:${command.trigger}`
  if (command.kind === "schedule") return `schedule:${command.reason}:${command.attempt}:${command.waitMs}:${command.trigger}`
  if (command.kind === "episode-end") return `episode-end:${command.reason}`
  return command.kind
})

function modelStep(before: ModelState, event: TestEvent): { state: ModelState; output: string[] } {
  const none = { state: before, output: [] as string[] }
  if (event === "stop") return {
    state: { failures: 0, behind: false, alarm: undefined, mutedStreak: 0, tap: "none" },
    output: before.tap === "offered" || before.tap === "tapping" ? ["episode-end:game_end"] : [],
  }
  if (event === "live") return { state: { ...before, failures: 0 }, output: [] }
  if (event === "clear") return { state: { ...before, behind: false, alarm: undefined }, output: [] }
  if (event === "still-muted-quick" || event === "still-muted-slow") {
    if (before.tap === "tapping") return none
    const mutedStreak = event === "still-muted-quick" ? before.mutedStreak + 1 : 1
    if (before.tap === "none" && mutedStreak >= 3)
      return { state: { ...before, mutedStreak, tap: "offered" }, output: ["offer-tap", "recover:still muted:force"] }
    return { state: { ...before, mutedStreak }, output: ["recover:still muted:force"] }
  }
  if (event === "tap") return before.tap === "offered" ? { state: { ...before, tap: "tapping" }, output: [] } : none
  if (event === "tap-frames" || event === "tap-muted" || event === "tap-error") {
    if (before.tap !== "tapping") return none
    const reason = event === "tap-frames" ? "frames" : event === "tap-muted" ? "still_muted" : "error"
    return { state: { ...before, mutedStreak: 0, tap: event === "tap-frames" ? "none" : "spent" }, output: [`episode-end:${reason}`] }
  }
  if (event === "unmuted" || event === "frame" || event === "hidden") {
    if (before.tap === "tapping" && event !== "hidden") return none
    const output = before.tap === "offered" || before.tap === "tapping"
      ? [`episode-end:${event === "hidden" ? "hidden" : "recovered"}`]
      : []
    return { state: { ...before, mutedStreak: 0, tap: "none" }, output }
  }
  if (event === "recover-unheld" || event === "recover-hidden-unheld" || event === "retry-unheld") return none
  if (event === "recover-hidden" || event === "open-hidden-unheld" || event === "retry-hidden")
    return { state: { ...before, behind: true }, output: [] }
  if (event === "recover") return { state: before, output: ["recover:ended:force"] }
  if (event === "busy" || event === "other" || event === "override") {
    const attempt = before.failures + 1
    const ordinary = [2000, 4000, 8000, 10000][Math.min(before.failures, 3)]!
    const wait = event === "busy" ? 2000 : event === "override" ? 500 : ordinary
    const reason = event === "busy" ? "busy" : event === "override" ? "denied" : "unknown"
    const trigger = event === "override" ? "return" : "warm-up"
    return { state: { ...before, failures: attempt, alarm: attempt }, output: [`schedule:${reason}:${attempt}:${wait}:${trigger}`] }
  }
  if (event === "fire" || event === "fire-hidden" || event === "fire-unheld") {
    if (before.alarm === undefined) return none
    if (event === "fire-unheld") return { state: { ...before, alarm: undefined }, output: [] }
    if (event === "fire-hidden") return { state: { ...before, behind: true, alarm: undefined }, output: [] }
    return { state: { ...before, alarm: undefined }, output: [`recover:retry ${before.failures}:retry`] }
  }
  if (event === "stale-fire") return none
  if (!before.behind && event !== "shown-unavailable") return none
  return { state: { ...before, behind: false }, output: ["recover:back in front:return"] }
}

const baseCases: Array<{ real: Pick<CameraRecoveryState, "retries" | "deferred" | "scheduledAttempt">; model: Pick<ModelState, "failures" | "behind" | "alarm"> }> = [
  { real: { retries: 0, deferred: false, scheduledAttempt: null }, model: { failures: 0, behind: false, alarm: undefined } },
  { real: { retries: 1, deferred: false, scheduledAttempt: 1 }, model: { failures: 1, behind: false, alarm: 1 } },
  { real: { retries: 1, deferred: true, scheduledAttempt: null }, model: { failures: 1, behind: true, alarm: undefined } },
  { real: { retries: 1, deferred: true, scheduledAttempt: 1 }, model: { failures: 1, behind: true, alarm: 1 } },
]
const streakFor = (tap: TapPhase) => tap === "offered" || tap === "tapping" ? 3 : 0
const CASES: Array<{ real: CameraRecoveryState; model: ModelState }> = baseCases.flatMap(({ real, model }) =>
  TAPS.map((tap) => ({ real: { ...real, tap, mutedStreak: streakFor(tap) }, model: { ...model, tap, mutedStreak: streakFor(tap) } })),
)

type Cell = "transition" | "no-op"
type OldEvent = Exclude<EventKey, "still-muted-quick" | "still-muted-slow" | "unmuted" | "frame" | "hidden" | "tap" | "tap-frames" | "tap-muted" | "tap-error">
const baseRows: Record<BaseKey, Record<OldEvent, Cell>> = {
  ready: {
    recover: "transition", "recover-hidden": "transition", "recover-hidden-unheld": "no-op", "open-hidden-unheld": "transition", "recover-unheld": "no-op",
    busy: "transition", other: "transition", override: "transition", "retry-hidden": "transition", "retry-unheld": "no-op",
    fire: "no-op", "fire-hidden": "no-op", "fire-unheld": "no-op", "stale-fire": "no-op", shown: "no-op", "shown-unavailable": "transition",
    clear: "transition", live: "transition", stop: "transition",
  },
  scheduled: {
    recover: "transition", "recover-hidden": "transition", "recover-hidden-unheld": "no-op", "open-hidden-unheld": "transition", "recover-unheld": "no-op",
    busy: "transition", other: "transition", override: "transition", "retry-hidden": "transition", "retry-unheld": "no-op",
    fire: "transition", "fire-hidden": "transition", "fire-unheld": "transition", "stale-fire": "no-op", shown: "no-op", "shown-unavailable": "transition",
    clear: "transition", live: "transition", stop: "transition",
  },
  deferred: {
    recover: "transition", "recover-hidden": "transition", "recover-hidden-unheld": "no-op", "open-hidden-unheld": "transition", "recover-unheld": "no-op",
    busy: "transition", other: "transition", override: "transition", "retry-hidden": "transition", "retry-unheld": "no-op",
    fire: "no-op", "fire-hidden": "no-op", "fire-unheld": "no-op", "stale-fire": "no-op", shown: "transition", "shown-unavailable": "transition",
    clear: "transition", live: "transition", stop: "transition",
  },
  "deferred-scheduled": {
    recover: "transition", "recover-hidden": "transition", "recover-hidden-unheld": "no-op", "open-hidden-unheld": "transition", "recover-unheld": "no-op",
    busy: "transition", other: "transition", override: "transition", "retry-hidden": "transition", "retry-unheld": "no-op",
    fire: "transition", "fire-hidden": "transition", "fire-unheld": "transition", "stale-fire": "no-op", shown: "transition", "shown-unavailable": "transition",
    clear: "transition", live: "transition", stop: "transition",
  },
}
const phaseRow = (base: BaseKey, tap: TapPhase): Record<EventKey, Cell> => ({
  ...baseRows[base],
  "still-muted-quick": tap === "tapping" ? "no-op" : "transition",
  "still-muted-slow": tap === "tapping" ? "no-op" : "transition",
  unmuted: tap === "tapping" ? "no-op" : "transition",
  frame: tap === "tapping" ? "no-op" : "transition",
  hidden: "transition",
  tap: tap === "offered" ? "transition" : "no-op",
  "tap-frames": tap === "tapping" ? "transition" : "no-op",
  "tap-muted": tap === "tapping" ? "transition" : "no-op",
  "tap-error": tap === "tapping" ? "transition" : "no-op",
})
const table = Object.fromEntries((Object.keys(baseRows) as BaseKey[]).flatMap((base) =>
  TAPS.map((tap) => [phaseKey(base, tap), phaseRow(base, tap)]),
)) as Record<StateKey, Record<EventKey, Cell>>
export const cameraTransitionTable = defineTransitionTable<StateKey, EventKey>()(table)

export const cameraWitnesses: NamedSequence<TestEvent, CameraRecoveryState, ModelState>[] = CASES.flatMap(({ real, model }) =>
  EVENTS.map((event) => ({ name: `${realKey(real)} × ${event}`, initial: { real, model }, events: [event] })),
)
export const cameraRegressionCorpus: NamedSequence<TestEvent, CameraRecoveryState, ModelState>[] = [
  { name: "busy remains steady while ordinary failures climb and cap", events: ["busy", "fire", "busy", "fire", "other", "fire", "other", "fire", "other", "fire", "other"] },
  { name: "hidden retry is deferred without consuming backoff", events: ["retry-hidden", "shown", "other"] },
  { name: "return denial uses one short override supplied by the host", events: ["recover-hidden", "shown", "override", "fire"] },
  { name: "hidden holder-less open survives until a holder arrives before return", events: ["open-hidden-unheld", "shown"] },
  { name: "duplicate stale and out-of-order timer events cannot recover", events: ["fire", "stale-fire", "other", "stale-fire", "fire", "fire", "shown"] },
  { name: "retry fire rechecks current holder before opening", events: ["other", "fire-unheld"] },
  { name: "retry fire defers when the page became hidden", events: ["other", "fire-hidden", "shown"] },
  { name: "live resets backoff without discarding deferred recovery", events: ["retry-hidden", "live", "shown"] },
  { name: "live resets backoff without cancelling a scheduled retry", events: ["other", "live", "fire"] },
  { name: "host camera muting: fresh tracks keep muting, offer after three, tap gets frames", events: ["still-muted-quick", "live", "still-muted-quick", "live", "still-muted-quick", "tap", "live", "tap-frames"] },
  { name: "host camera muting: a tap that mutes again shows the restart notice, no second offer", events: ["still-muted-quick", "live", "still-muted-quick", "live", "still-muted-quick", "tap", "still-muted-quick", "tap-muted", "still-muted-quick", "still-muted-quick", "still-muted-quick"] },
]

const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
type Inv = NamedInvariant<CameraRecoveryState, ModelState, TestEvent, Observation, StateKey, EventKey>
const invariants: Inv[] = [
  { name: "hidden and unheld requests never schedule a timer", specClause: "K1", check: ({ event, realObservation }) => {
    if (["recover-hidden", "recover-hidden-unheld", "open-hidden-unheld", "retry-hidden", "recover-unheld", "retry-unheld"].includes(event))
      assert(!realObservation.commands.some((word) => word.startsWith("schedule:")), `timer scheduled on ${event}`)
  } },
  { name: "backoff is bounded and busy stays at two seconds", specClause: "K2", check: ({ realObservation }) => {
    realObservation.commands.filter((word) => word.startsWith("schedule:")).forEach((word) => {
      const [, reason, , wait] = word.split(":")
      assert(Number(wait) <= 10_000, `unbounded ${word}`)
      if (reason === "busy") assert(wait === "2000", `busy cadence ${word}`)
    })
  } },
  { name: "offer only at streak three and once per episode", specClause: "K5", check: ({ real, realObservation }) => {
    if (realObservation.commands.includes("offer-tap")) assert(real.mutedStreak >= 3 && real.tap === "offered", "early or unowned offer")
  } },
  { name: "tapping ignores still-muted and emits no schedule", specClause: "K6", check: ({ event, previousReal, realObservation }) => {
    if (previousReal.tap === "tapping" && event.startsWith("still-muted")) assert(realObservation.commands.length === 0, "tapping recovered")
    if (event === "tap") assert(!realObservation.commands.some((word) => word.startsWith("schedule:")), "tap scheduled")
  } },
  { name: "live never resets the muted streak", specClause: "K5", check: ({ event, real, previousReal }) => {
    if (event === "live") assert(real.mutedStreak === previousReal.mutedStreak && real.tap === previousReal.tap, "live reset tap episode")
  } },
  { name: "stop ends an offer as game_end", specClause: "K7", check: ({ event, previousReal, realObservation }) => {
    if (event === "stop" && (previousReal.tap === "offered" || previousReal.tap === "tapping"))
      assert(realObservation.commands.filter((word) => word === "episode-end:game_end").length === 1, "stop lost episode")
  } },
]

export const cameraMachineDefinition: MachineDefinition<CameraRecoveryState, ModelState, TestEvent, CameraRecoveryCommand[], string[], Observation, StateKey, EventKey> = {
  name: "camera-recovery",
  initialReal: startCameraRecovery,
  initialModel: () => ({ failures: 0, behind: false, alarm: undefined, mutedStreak: 0, tap: "none" }),
  realStep: (state, event) => { const next = cameraRecoveryStep(state, concrete(state, event)); return { state: next.state, output: next.commands } },
  modelStep,
  classifyRealStep: (before, next) => next.state === before && next.output.length === 0 ? "no-op" : "transition",
  observeReal: (next) => ({ state: realKey(next.state), failures: next.state.retries, mutedStreak: next.state.mutedStreak, tap: next.state.tap, commands: words(next.output) }),
  observeModel: (next) => ({ state: modelKey(next.state), failures: next.state.failures, mutedStreak: next.state.mutedStreak, tap: next.state.tap, commands: next.output }),
  realStateKey: realKey,
  modelStateKey: modelKey,
  eventKey: (event) => event,
  transitionTable: cameraTransitionTable,
  witnesses: cameraWitnesses,
  regressions: cameraRegressionCorpus,
  invariants,
  sequenceArbitrary: fc.array(fc.constantFrom(...EVENTS), { minLength: 0, maxLength: 50 }),
  numRuns: 300,
}
