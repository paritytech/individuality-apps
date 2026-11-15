// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import {
  payoff,
  startPayoff,
  type PayoffActiveKind,
  type PayoffCommand,
  type PayoffEvent,
  type PayoffInput,
  type PayoffOutcome,
  type PayoffRoute,
  type PayoffState,
} from "../payoff-machine"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

const ACTIVE_STATE_KEYS = [
  "draw-waiting|draw:0|stalled:0",
  "draw-waiting|draw:0|stalled:1",
  "draw-showing|draw:1|stalled:0",
  "draw-showing|draw:1|stalled:1",
  "chest-reading|draw:0|stalled:0",
  "chest-reading|draw:0|stalled:1",
  "chest-reading|draw:1|stalled:0",
  "chest-reading|draw:1|stalled:1",
  "chest-showing|draw:0|stalled:0",
  "chest-showing|draw:0|stalled:1",
  "chest-showing|draw:1|stalled:0",
  "chest-showing|draw:1|stalled:1",
] as const

type ActiveStateKey = (typeof ACTIVE_STATE_KEYS)[number]
type PayoffStateKey = ActiveStateKey | "ended"
type PayoffInputType = PayoffEvent["type"]
type PayoffEventKey = `${PayoffInputType}|current` | `${PayoffInputType}|stale`
export const payoffTagModes = [
  "current",
  "stale-game-older",
  "stale-game-newer",
  "stale-epoch-older",
  "stale-epoch-newer",
] as const
type TagMode = (typeof payoffTagModes)[number]

export interface PayoffTestEvent {
  input: PayoffInput
  tag: TagMode
}

interface ModelActivePayoff {
  kind: PayoffActiveKind
  gameIndex: number
  epoch: number
  route: PayoffRoute
  stalled: boolean
  drawFactSent: boolean
}

interface ModelEndedPayoff {
  kind: "ended"
  gameIndex: number
  epoch: number
  route: PayoffRoute
  outcome: PayoffOutcome
}

type ModelPayoffState = ModelActivePayoff | ModelEndedPayoff

interface PayoffObservation {
  state: {
    kind: PayoffActiveKind | "ended"
    gameIndex: number
    epoch: number
    route: PayoffRoute
    stalled: boolean | null
    drawFactSent: boolean | null
    outcome: PayoffOutcome | null
  }
  commands: string[]
}

const INPUTS = [
  { type: "draw-result" },
  { type: "draw-none" },
  { type: "draw-bypass" },
  { type: "draw-continue" },
  { type: "draw-idle" },
  { type: "draw-error" },
  { type: "draw-offered" },
  { type: "chest-opened" },
  { type: "chest-result" },
  { type: "chest-error" },
  { type: "chest-reread-due" },
  { type: "chest-continue" },
  { type: "chest-skip" },
  { type: "payoff-stalled", stage: "chest.load" },
  { type: "next-game" },
  { type: "return-after-long-absence" },
  { type: "app-gone" },
  { type: "hidden", at: 100 },
  { type: "visible", at: 200 },
] as const satisfies readonly PayoffInput[]

const inputByType = Object.fromEntries(INPUTS.map((input) => [input.type, input])) as Record<PayoffInputType, PayoffInput>

const current = (type: PayoffInputType): PayoffTestEvent => ({ input: inputByType[type], tag: "current" })

function tagged(state: Pick<PayoffState, "gameIndex" | "epoch">, event: PayoffTestEvent): PayoffEvent {
  const tag =
    event.tag === "current"
      ? { gameIndex: state.gameIndex, epoch: state.epoch }
      : event.tag === "stale-game-older"
        ? { gameIndex: state.gameIndex - 1, epoch: state.epoch }
        : event.tag === "stale-game-newer"
          ? { gameIndex: state.gameIndex + 1, epoch: state.epoch }
          : event.tag === "stale-epoch-older"
            ? { gameIndex: state.gameIndex, epoch: state.epoch - 1 }
            : { gameIndex: state.gameIndex, epoch: state.epoch + 1 }
  return { ...event.input, ...tag } as PayoffEvent
}

function normalizeCommands(commands: readonly PayoffCommand[]): string[] {
  return commands.map((command) => {
    switch (command.kind) {
      case "telemetry":
        return command.fact === "payoffStalled" ? `telemetry:${command.fact}:${command.stage}` : `telemetry:${command.fact}`
      case "replace-route":
        return `replace-route:${command.route}`
      case "end-payoff":
        return `end-payoff:${command.outcome}:${command.cause}:${command.sendGameLog ? "log" : "no-log"}`
      default:
        return command.kind
    }
  })
}

function observe(state: PayoffState | ModelPayoffState, commands: string[]): PayoffObservation {
  return {
    state: {
      kind: state.kind,
      gameIndex: state.gameIndex,
      epoch: state.epoch,
      route: state.route,
      stalled: state.kind === "ended" ? null : state.stalled,
      drawFactSent: state.kind === "ended" ? null : state.drawFactSent,
      outcome: state.kind === "ended" ? state.outcome : null,
    },
    commands,
  }
}

const modelStart = (): ModelPayoffState => ({
  kind: "draw-waiting",
  gameIndex: 5,
  epoch: 0,
  route: "/prize-draw",
  stalled: false,
  drawFactSent: false,
})

/** the chest is left: the payoff ends, its log goes, and so does the player */
const modelHandOff = (state: ModelActivePayoff): { state: ModelPayoffState; output: string[] } => {
  const outcome: PayoffOutcome = state.stalled ? "stalled" : "shown"
  return {
    state: { kind: "ended", gameIndex: state.gameIndex, epoch: state.epoch, route: state.route, outcome },
    output: [`end-payoff:${outcome}:handed-off:log`, "hand-off"],
  }
}

const modelActive = (state: ModelActivePayoff, kind: PayoffActiveKind, route: PayoffRoute = state.route): ModelActivePayoff => ({
  ...state,
  kind,
  route,
})

/** Independent executable model of the step-0 contract. It imports no reducer code. */
function modelPayoff(state: ModelPayoffState, testEvent: PayoffTestEvent): { state: ModelPayoffState; output: string[] } {
  const event = tagged(state, testEvent)
  const noChange = (): { state: ModelPayoffState; output: string[] } => ({ state, output: [] })
  if (event.type === "return-after-long-absence" || event.type === "hidden" || event.type === "visible") return noChange()
  if (state.kind === "ended" || event.gameIndex !== state.gameIndex || event.epoch !== state.epoch) return noChange()

  switch (event.type) {
    case "draw-result":
      if (state.drawFactSent) return noChange()
      if (state.kind !== "draw-waiting") return { state: { ...state, drawFactSent: true }, output: ["telemetry:drawShown"] }
      return {
        state: { ...modelActive(state, "draw-showing"), drawFactSent: true },
        output: ["telemetry:drawShown"],
      }
    case "draw-error":
      return noChange()
    // the idle is armed by the way on being offered, only while the draw shows
    case "draw-offered":
      return state.kind === "draw-showing" ? { state, output: ["arm-draw-idle"] } : noChange()
    case "draw-none":
      if (state.drawFactSent) return noChange()
      if (state.kind !== "draw-waiting") return { state: { ...state, drawFactSent: true }, output: ["telemetry:drawShown"] }
      return {
        state: { ...modelActive(state, "chest-reading", "/chest"), drawFactSent: true },
        output: ["telemetry:drawShown", "cancel-draw-idle", "load-chest", "replace-route:/chest"],
      }
    case "draw-continue":
    case "draw-idle":
      if (state.kind !== "draw-showing") return noChange()
      return {
        state: modelActive(state, "chest-reading", "/chest"),
        output: [
          ...(event.type === "draw-continue" ? ["mark-draw-seen"] : []),
          "cancel-draw-idle",
          "load-chest",
          "replace-route:/chest",
        ],
      }
    case "draw-bypass":
      return state.kind === "draw-waiting"
        ? { state: modelActive(state, "chest-reading", "/chest"), output: ["load-chest", "replace-route:/chest"] }
        : noChange()
    case "payoff-stalled":
      return state.stalled
        ? noChange()
        : { state: { ...state, stalled: true }, output: [`telemetry:payoffStalled:${event.stage}`] }
    case "chest-opened":
      return state.kind === "chest-reading" ? { state, output: ["telemetry:chestOpened"] } : noChange()
    case "chest-result":
      return state.kind === "chest-reading"
        ? { state: modelActive(state, "chest-showing"), output: ["telemetry:chestShown"] }
        : noChange()
    case "chest-error":
      return noChange()
    case "chest-reread-due":
      return state.kind === "chest-reading"
        ? { state: { ...state, epoch: state.epoch + 1 }, output: ["load-chest"] }
        : noChange()
    case "chest-continue":
      return state.kind === "chest-showing" ? modelHandOff(state) : noChange()
    case "chest-skip":
      return state.kind === "chest-reading" ? modelHandOff(state) : noChange()
    case "next-game":
      return {
        state: { kind: "ended", gameIndex: state.gameIndex, epoch: state.epoch, route: state.route, outcome: "stalled" },
        output: ["end-payoff:stalled:next-game:no-log"],
      }
    case "app-gone":
      return {
        state: { kind: "ended", gameIndex: state.gameIndex, epoch: state.epoch, route: state.route, outcome: "stalled" },
        output: ["end-payoff:stalled:app-gone:no-log"],
      }
  }
}

const NO_OP_INPUT_ROW: Record<PayoffInputType, "no-op"> = {
  "draw-result": "no-op",
  "draw-none": "no-op",
  "draw-bypass": "no-op",
  "draw-continue": "no-op",
  "draw-idle": "no-op",
  "draw-error": "no-op",
  "draw-offered": "no-op",
  "chest-opened": "no-op",
  "chest-result": "no-op",
  "chest-error": "no-op",
  "chest-reread-due": "no-op",
  "chest-continue": "no-op",
  "chest-skip": "no-op",
  "payoff-stalled": "no-op",
  "next-game": "no-op",
  "return-after-long-absence": "no-op",
  "app-gone": "no-op",
  hidden: "no-op",
  visible: "no-op",
}

const row = (transitions: readonly PayoffInputType[]) =>
  Object.fromEntries(
    Object.entries(NO_OP_INPUT_ROW).flatMap(([event, value]) => [
      [`${event}|current`, transitions.includes(event as PayoffInputType) ? "transition" : value],
      [`${event}|stale`, "no-op"],
    ]),
  ) as Record<PayoffEventKey, "transition" | "no-op">

function transitionsForState(stateKey: ActiveStateKey): readonly PayoffInputType[] {
  const [kind, drawPart, stalledPart] = stateKey.split("|") as [PayoffActiveKind, `draw:${0 | 1}`, `stalled:${0 | 1}`]
  const drawFactSent = drawPart === "draw:1"
  const stalled = stalledPart === "stalled:1"
  const transitions: PayoffInputType[] = ["next-game", "app-gone"]
  if (!drawFactSent) transitions.push("draw-result", "draw-none")
  if (!stalled) transitions.push("payoff-stalled")
  if (kind === "draw-waiting") transitions.push("draw-bypass")
  if (kind === "draw-showing") transitions.push("draw-offered", "draw-continue", "draw-idle")
  if (kind === "chest-reading") transitions.push("chest-opened", "chest-result", "chest-reread-due", "chest-skip")
  if (kind === "chest-showing") transitions.push("chest-continue")
  return transitions
}

export const payoffTransitionTable = defineTransitionTable<PayoffStateKey, PayoffEventKey>()(
  Object.fromEntries([
    ...ACTIVE_STATE_KEYS.map((stateKey) => [stateKey, row(transitionsForState(stateKey))] as const),
    ["ended", row([])] as const,
  ]) as Record<PayoffStateKey, Record<PayoffEventKey, "transition" | "no-op">>,
)

const routeForKind = (kind: PayoffActiveKind): PayoffRoute => (kind.startsWith("draw-") ? "/prize-draw" : "/chest")

function initialForStateKey(stateKey: PayoffStateKey): { real: PayoffState; model: ModelPayoffState } {
  if (stateKey === "ended") {
    return {
      real: startPayoff(5, "/chest", { ended: "shown" }),
      model: { kind: "ended", gameIndex: 5, epoch: 0, route: "/chest", outcome: "shown" },
    }
  }
  const [kind, drawPart, stalledPart] = stateKey.split("|") as [PayoffActiveKind, `draw:${0 | 1}`, `stalled:${0 | 1}`]
  const state = {
    kind,
    gameIndex: 5,
    epoch: 0,
    route: routeForKind(kind),
    drawFactSent: drawPart === "draw:1",
    stalled: stalledPart === "stalled:1",
  }
  return { real: state, model: state }
}

export const payoffWitnesses: NamedSequence<PayoffTestEvent, PayoffState, ModelPayoffState>[] = Object.entries(
  payoffTransitionTable,
).flatMap(([state, events]) =>
  (Object.keys(events) as PayoffEventKey[]).map((event) => ({
    name: `${state} × ${event}`,
    initial: initialForStateKey(state as PayoffStateKey),
    events: [
      event.endsWith("|current")
        ? current(event.slice(0, -"|current".length) as PayoffInputType)
        : { input: inputByType[event.slice(0, -"|stale".length) as PayoffInputType], tag: "stale-game-older" },
    ],
  })),
)

export const payoffInitialCases = [
  { name: "prize draw", ...initialForStateKey("draw-waiting|draw:0|stalled:0") },
  {
    name: "chest reload",
    real: startPayoff(5, "/chest", { epoch: 2 }),
    model: { kind: "chest-reading", gameIndex: 5, epoch: 2, route: "/chest", stalled: false, drawFactSent: false },
  },
  {
    name: "ended reload",
    real: startPayoff(5, "/chest", { ended: "shown", epoch: 2 }),
    model: { kind: "ended", gameIndex: 5, epoch: 2, route: "/chest", outcome: "shown" },
  },
] as const satisfies readonly { name: string; real: PayoffState; model: ModelPayoffState }[]

export const payoffRegressionCorpus: NamedSequence<PayoffTestEvent, PayoffState, ModelPayoffState>[] = [
  {
    name: "normal draw-chest-humanity journey",
    events: ["draw-result", "draw-continue", "chest-result", "chest-continue"].map((type) => current(type as PayoffInputType)),
  },
  {
    name: "idle draw advance",
    events: ["draw-result", "draw-offered", "draw-idle", "chest-result", "chest-continue"].map((type) => current(type as PayoffInputType)),
  },
  {
    name: "stale and duplicate async answers are inert",
    events: [
      current("draw-none"),
      current("chest-reread-due"),
      { input: inputByType["chest-result"], tag: "stale-game-older" },
      { input: inputByType["chest-result"], tag: "stale-game-newer" },
      { input: inputByType["chest-result"], tag: "stale-epoch-older" },
      { input: inputByType["chest-result"], tag: "stale-epoch-newer" },
      current("chest-result"),
      current("chest-result"),
    ],
  },
  {
    name: "stalled payoff keeps stalled outcome and sends the log at the hand-off",
    events: ["draw-none", "payoff-stalled", "chest-result", "chest-continue"].map((type) => current(type as PayoffInputType)),
  },
  {
    name: "a slow chest hands off without the chest",
    events: ["draw-none", "payoff-stalled", "chest-skip", "chest-result", "chest-continue"].map((type) => current(type as PayoffInputType)),
  },
  {
    name: "reload on chest",
    initial: payoffInitialCases[1],
    events: [current("chest-result")],
  },
  {
    name: "reload after payoff already ended",
    initial: payoffInitialCases[2],
    events: [current("next-game"), current("draw-result")],
  },
  {
    name: "saved chest epoch rejects old read and accepts current read",
    initial: payoffInitialCases[1],
    events: [{ input: inputByType["chest-result"], tag: "stale-epoch-older" }, current("chest-result")],
  },
]

const routeOrder: PayoffRoute[] = ["/prize-draw", "/chest"]
const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const payoffInvariants: NamedInvariant<PayoffState, ModelPayoffState, PayoffTestEvent, PayoffObservation, PayoffStateKey, PayoffEventKey>[] = [
  {
    name: "game identity is stable",
    specClause: "one payoff journey per game",
    check: ({ previousReal, real }) => assert(real.gameIndex === previousReal.gameIndex, "gameIndex changed"),
  },
  {
    name: "read epochs never go backwards",
    specClause: "async results are tagged with their read epoch",
    check: ({ previousReal, real }) => assert(real.epoch >= previousReal.epoch, "epoch moved backwards"),
  },
  {
    name: "routes only move forward",
    specClause: "the payoff routes only move forward",
    check: ({ previousReal, real }) => assert(routeOrder.indexOf(real.route) >= routeOrder.indexOf(previousReal.route), "route moved backwards"),
  },
  {
    name: "terminal state absorbs later input",
    specClause: "one ended per payoff journey",
    check: ({ previousReal, real, realObservation }) => {
      if (previousReal.kind === "ended") {
        assert(JSON.stringify(real) === JSON.stringify(previousReal), "ended state changed")
        assert(realObservation.commands.length === 0, "ended state emitted a command")
      }
    },
  },
  {
    name: "stale async results are inert",
    specClause: "global lifecycle invariant: reject stale generations",
    check: ({ previousReal, real, event, realObservation }) => {
      if (event.tag !== "current") {
        assert(JSON.stringify(real) === JSON.stringify(previousReal), "stale event changed state")
        assert(realObservation.commands.length === 0, "stale event emitted a command")
      }
    },
  },
  {
    name: "page lifecycle observations are inert",
    specClause: "a return after a long absence keeps the current payoff screen",
    check: ({ previousReal, real, event, realObservation }) => {
      if (["hidden", "visible", "return-after-long-absence"].includes(event.input.type)) {
        assert(JSON.stringify(real) === JSON.stringify(previousReal), "lifecycle input changed state")
        assert(realObservation.commands.length === 0, "lifecycle input emitted a command")
      }
    },
  },
  {
    name: "facts and journey end are emitted at most once",
    specClause: "facts exactly once; one ended per journey",
    check: ({ trace }) => {
      const commands = trace.flatMap((entry) => entry.real.commands)
      for (const prefix of ["telemetry:drawShown", "telemetry:payoffStalled", "end-payoff:", "hand-off"]) {
        const count = commands.filter((command) => command.startsWith(prefix)).length
        assert(count <= 1, `${prefix} emitted ${count} times`)
      }
    },
  },
]

const inputArbitrary = fc.oneof(...INPUTS.map((input) => fc.constant(input as PayoffInput)))
const eventArbitrary: fc.Arbitrary<PayoffTestEvent> = fc.record({
  input: inputArbitrary,
  tag: fc.constantFrom<TagMode>("current", "current", "current", ...payoffTagModes.slice(1)),
})

export const payoffMachineDefinition: MachineDefinition<
  PayoffState,
  ModelPayoffState,
  PayoffTestEvent,
  PayoffCommand[],
  string[],
  PayoffObservation,
  PayoffStateKey,
  PayoffEventKey
> = {
  name: "payoff",
  initialReal: () => startPayoff(5, "/prize-draw"),
  initialModel: modelStart,
  initialArbitrary: fc.constantFrom(...payoffInitialCases.map(({ real, model }) => ({ real, model }))),
  realStep: (state, event) => {
    const result = payoff(state, tagged(state, event))
    return { state: result.state, output: result.commands }
  },
  modelStep: modelPayoff,
  classifyRealStep: (previous, result) =>
    JSON.stringify(previous) === JSON.stringify(result.state) && result.output.length === 0 ? "no-op" : "transition",
  observeReal: ({ state, output }) => observe(state, normalizeCommands(output)),
  observeModel: ({ state, output }) => observe(state, output),
  realStateKey: (state) =>
    state.kind === "ended" ? "ended" : `${state.kind}|draw:${state.drawFactSent ? 1 : 0}|stalled:${state.stalled ? 1 : 0}` as PayoffStateKey,
  modelStateKey: (state) =>
    state.kind === "ended" ? "ended" : `${state.kind}|draw:${state.drawFactSent ? 1 : 0}|stalled:${state.stalled ? 1 : 0}` as PayoffStateKey,
  eventKey: (event) => `${event.input.type}|${event.tag === "current" ? "current" : "stale"}`,
  transitionTable: payoffTransitionTable,
  witnesses: payoffWitnesses,
  regressions: payoffRegressionCorpus,
  invariants: payoffInvariants,
  sequenceArbitrary: fc.array(eventArbitrary, { minLength: 0, maxLength: 60, size: "max" }),
  numRuns: 300,
}
