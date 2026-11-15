// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from "fast-check"
import type { StoreStamp } from "@jollity/statement-core"
import {
  createMessageExpiryClock,
  messageExpiryClockStep,
  type MessageExpiryClockCommand,
  type MessageExpiryClockState,
} from "../store-clock"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence, type TransitionTable } from "./framework"

/** Extraction-parity definition for the page adapter. Its separately written
 * model primarily proves parity with the pre-existing statement-core policy;
 * named invariants retain the independently stated safety claims. */

type MarginKey = "absent" | "zero" | "min" | "raised" | "capped"
type PushKey = "zero" | "open" | "capped"
type StateKey = `absent|reported:${0 | 1}` | `${Exclude<MarginKey, "absent">}|push:${PushKey}|reported:${0 | 1}`
type Event =
  | { kind: "stamp" }
  | { kind: "stamp-device" }
  | { kind: "retry-fresh" }
  | { kind: "retry-stale" }
  | { kind: "accept-push" }
  | { kind: "accept-sibling" }
  | { kind: "accept-plain" }
  | { kind: "reject-learn" }
  | { kind: "reject-plain" }
  | { kind: "margin" }
type EventKey = Event["kind"]

interface KindState {
  marginMs: number
  failedPushMs: number
}

interface ModelState {
  kinds: Record<string, KindState>
  rejectedReported: boolean
}

interface Observation {
  state: ModelState
  commands: MessageExpiryClockCommand[]
}

const MIN_MARGIN = 60_000
const MAX_MARGIN = 600_000
const TTL_MS = 30_000
const BASE_MS = 1_000_000

const marginKey = (marginMs: number): Exclude<MarginKey, "absent"> =>
  marginMs === 0 ? "zero" : marginMs === MIN_MARGIN ? "min" : marginMs === MAX_MARGIN ? "capped" : "raised"

const pushKey = (failedPushMs: number): PushKey =>
  failedPushMs === 0 ? "zero" : failedPushMs === MAX_MARGIN ? "capped" : "open"

const stateKey = (state: MessageExpiryClockState | ModelState): StateKey => {
  const chain = state.kinds.chain
  if (!chain) return `absent|reported:${state.rejectedReported ? 1 : 0}`
  return `${marginKey(chain.marginMs)}|push:${pushKey(chain.failedPushMs)}|reported:${state.rejectedReported ? 1 : 0}`
}

const marginValue = (key: Exclude<MarginKey, "absent">): number =>
  key === "zero" ? 0 : key === "min" ? MIN_MARGIN : key === "raised" ? 120_000 : MAX_MARGIN

const pushValue = (key: PushKey): number => key === "zero" ? 0 : key === "open" ? 120_000 : MAX_MARGIN

const stateCases: { key: StateKey; margin: MarginKey; push: PushKey; reported: boolean }[] = [
  { key: "absent|reported:0", margin: "absent", push: "zero", reported: false },
  { key: "absent|reported:1", margin: "absent", push: "zero", reported: true },
]
for (const margin of ["zero", "min", "raised", "capped"] as const) {
  for (const push of ["zero", "open", "capped"] as const) {
    for (const reported of [false, true]) {
      stateCases.push({ key: `${margin}|push:${push}|reported:${reported ? 1 : 0}`, margin, push, reported })
    }
  }
}

const realState = (entry: (typeof stateCases)[number]): MessageExpiryClockState => ({
  kinds: entry.margin === "absent"
    ? {}
    : { chain: { marginMs: marginValue(entry.margin), failedPushMs: pushValue(entry.push) } },
  rejectedReported: entry.reported,
})

const modelState = (entry: (typeof stateCases)[number]): ModelState => ({
  kinds: Object.fromEntries(Object.entries(realState(entry).kinds).map(([kind, value]) => [kind, { ...value }])),
  rejectedReported: entry.reported,
})

const kindOf = (state: MessageExpiryClockState | ModelState, kind: string): KindState =>
  state.kinds[kind] ?? { marginMs: 0, failedPushMs: 0 }

const retryPush = (state: MessageExpiryClockState | ModelState, kind: string): number => {
  const current = kindOf(state, kind)
  return Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, 2 * current.marginMs, 2 * current.failedPushMs))
}

const stamp = (overrides: Partial<StoreStamp> = {}): StoreStamp => ({
  ms: BASE_MS,
  base: BASE_MS,
  kind: "chain",
  from: 0,
  retry: false,
  learn: false,
  ...overrides,
})

const inputFor = (state: MessageExpiryClockState | ModelState, event: Event) => {
  const current = kindOf(state, "chain")
  const pushed = retryPush(state, "chain")
  switch (event.kind) {
    case "stamp":
      return { type: "stamp" as const, base: { ms: BASE_MS, kind: "chain" } }
    case "stamp-device":
      return { type: "stamp" as const, base: { ms: BASE_MS + 500, kind: "device" } }
    case "retry-fresh":
      return {
        type: "retry" as const,
        base: { ms: BASE_MS + 100, kind: "chain" },
        first: stamp({ from: current.marginMs, ms: BASE_MS + current.marginMs }),
        ttlS: TTL_MS / 1_000,
      }
    case "retry-stale":
      return {
        type: "retry" as const,
        base: { ms: BASE_MS + TTL_MS / 2 + 1, kind: "chain" },
        first: stamp({ from: current.marginMs, ms: BASE_MS + current.marginMs }),
        ttlS: TTL_MS / 1_000,
      }
    case "accept-push":
      return { type: "accepted" as const, stamp: stamp({ ms: BASE_MS + pushed, from: current.marginMs, retry: true, learn: true }) }
    case "accept-sibling":
      return { type: "accepted" as const, stamp: stamp({ ms: BASE_MS + MIN_MARGIN, from: 0, retry: true, learn: true }) }
    case "accept-plain":
      return { type: "accepted" as const, stamp: stamp({ ms: BASE_MS + current.marginMs, from: current.marginMs }) }
    case "reject-learn":
      return { type: "rejected" as const, stamp: stamp({ ms: BASE_MS + pushed, from: current.marginMs, retry: true, learn: true }), reason: "alreadyExpired" }
    case "reject-plain":
      return { type: "rejected" as const, stamp: stamp({ ms: BASE_MS + current.marginMs, from: current.marginMs }), reason: "alreadyExpired" }
    case "margin":
      return { type: "margin" as const, base: { ms: BASE_MS, kind: "chain" } }
  }
}

/** Separately written extraction-parity model of docs/time-and-clocks.md Rule 2. */
function modelStep(before: ModelState, event: Event): { state: ModelState; output: MessageExpiryClockCommand[] } {
  const state: ModelState = {
    kinds: Object.fromEntries(Object.entries(before.kinds).map(([kind, value]) => [kind, { ...value }])),
    rejectedReported: before.rejectedReported,
  }
  const output: MessageExpiryClockCommand[] = []
  const of = (kind: string): KindState => (state.kinds[kind] ??= { marginMs: 0, failedPushMs: 0 })
  const input = inputFor(before, event)

  if (input.type === "stamp") {
    const current = of(input.base.kind)
    output.push({
      type: "stamp",
      stamp: { ms: input.base.ms + current.marginMs, base: input.base.ms, kind: input.base.kind, from: current.marginMs, retry: false, learn: false },
    })
  } else if (input.type === "retry") {
    const current = of(input.base.kind)
    const stale = input.base.kind === input.first.kind && input.base.ms - input.first.base > (input.ttlS * 1_000) / 2
    const pushMs = stale
      ? current.marginMs
      : Math.min(MAX_MARGIN, Math.max(MIN_MARGIN, 2 * input.first.from, 2 * current.failedPushMs))
    output.push({
      type: "stamp",
      stamp: { ms: input.base.ms + pushMs, base: input.base.ms, kind: input.base.kind, from: input.first.from, retry: true, learn: !stale },
    })
  } else if (input.type === "accepted") {
    if (input.stamp.learn) {
      const current = of(input.stamp.kind)
      const learned = input.stamp.ms - input.stamp.base
      const next = current.marginMs <= input.stamp.from ? learned : Math.min(current.marginMs, learned)
      if (next !== current.marginMs) {
        const previousMs = current.marginMs
        current.marginMs = next
        current.failedPushMs = 0
        state.rejectedReported = false
        output.push({ type: "event", event: { kind: "learned", marginMs: next, previousMs, base: input.stamp.kind } })
      }
    }
  } else if (input.type === "rejected") {
    const current = of(input.stamp.kind)
    const pushMs = input.stamp.ms - input.stamp.base
    if (input.stamp.learn) current.failedPushMs = Math.max(current.failedPushMs, pushMs)
    if (!state.rejectedReported) {
      state.rejectedReported = true
      output.push({ type: "event", event: { kind: "rejected", reason: input.reason, marginMs: current.marginMs, pushMs, base: input.stamp.kind } })
    }
  } else {
    output.push({ type: "margin", marginMs: of(input.base.kind).marginMs })
  }
  return { state, output }
}

const eventValues: Record<EventKey, Event> = {
  stamp: { kind: "stamp" },
  "stamp-device": { kind: "stamp-device" },
  "retry-fresh": { kind: "retry-fresh" },
  "retry-stale": { kind: "retry-stale" },
  "accept-push": { kind: "accept-push" },
  "accept-sibling": { kind: "accept-sibling" },
  "accept-plain": { kind: "accept-plain" },
  "reject-learn": { kind: "reject-learn" },
  "reject-plain": { kind: "reject-plain" },
  margin: { kind: "margin" },
}

const transitionFor = (entry: (typeof stateCases)[number], event: EventKey): "transition" | "no-op" => {
  if (["stamp", "stamp-device", "retry-fresh", "retry-stale", "margin"].includes(event)) return "transition"
  if (event === "accept-plain") return "no-op"
  if (event === "accept-push") return entry.margin === "capped" ? "no-op" : "transition"
  if (event === "accept-sibling") return entry.margin === "min" ? "no-op" : "transition"
  if (event === "reject-learn") return entry.push === "capped" && entry.reported ? "no-op" : "transition"
  return entry.margin === "absent" || !entry.reported ? "transition" : "no-op"
}

export const messageExpiryTransitionTable = defineTransitionTable<StateKey, EventKey>()(
  Object.fromEntries(stateCases.map((entry) => [entry.key, Object.fromEntries(
    (Object.keys(eventValues) as EventKey[]).map((event) => [event, transitionFor(entry, event)]),
  )])) as TransitionTable<StateKey, EventKey>,
)

export const messageExpiryWitnesses: NamedSequence<Event, MessageExpiryClockState, ModelState>[] = stateCases.flatMap((entry) =>
  (Object.keys(eventValues) as EventKey[]).map((event) => ({
    name: `${entry.key} ${event}`,
    initial: { real: realState(entry), model: modelState(entry) },
    events: [eventValues[event]],
  })),
)

const entryFor = (margin: MarginKey, push: PushKey, reported = false) => {
  const entry = stateCases.find((candidate) => candidate.margin === margin && candidate.push === push && candidate.reported === reported)
  if (!entry) throw new Error(`missing state case ${margin}/${push}/${reported}`)
  return entry
}

export const messageExpiryRegressions: NamedSequence<Event, MessageExpiryClockState, ModelState>[] = [
  { name: "fresh refusal retries once at the minimum margin", events: [{ kind: "retry-fresh" }] },
  { name: "stale refusal restamps without learning", events: [{ kind: "retry-stale" }] },
  { name: "two rejected learning stamps double the next retry push", events: [{ kind: "reject-learn" }, { kind: "reject-learn" }, { kind: "retry-fresh" }] },
  {
    name: "a sibling acceptance keeps the smaller accepted margin",
    initial: { real: realState(entryFor("raised", "zero")), model: modelState(entryFor("raised", "zero")) },
    events: [{ kind: "accept-sibling" }],
  },
  { name: "device and chain margins stay independent", events: [{ kind: "stamp-device" }, { kind: "accept-push" }, { kind: "stamp-device" }, { kind: "stamp" }] },
]

const invariants: NamedInvariant<MessageExpiryClockState, ModelState, Event, Observation, StateKey, EventKey>[] = [
  {
    name: "learned margins stay finite and bounded",
    specClause: "docs/time-and-clocks.md Rule 2: bounded acceptance margin",
    check: ({ real }) => {
      for (const current of Object.values(real.kinds)) {
        if (!Number.isFinite(current.marginMs) || current.marginMs < 0 || current.marginMs > MAX_MARGIN)
          throw new Error(`invalid margin ${current.marginMs}`)
      }
    },
  },
  {
    name: "a stale retry never teaches a margin",
    specClause: "docs/time-and-clocks.md Rule 2: stale rejection says nothing about node time",
    check: ({ event, realObservation }) => {
      if (event.kind !== "retry-stale") return
      const command = realObservation.commands.find((candidate) => candidate.type === "stamp")
      if (!command || command.stamp.learn || !command.stamp.retry) throw new Error("stale retry learned")
    },
  },
  {
    name: "a fresh retry is pushed within the safety bounds",
    specClause: "docs/time-and-clocks.md Rule 2: one bounded re-stamp",
    check: ({ event, realObservation }) => {
      if (event.kind !== "retry-fresh") return
      const command = realObservation.commands.find((candidate) => candidate.type === "stamp")
      if (!command || !command.stamp.learn || !command.stamp.retry) throw new Error("fresh retry did not learn")
      const push = command.stamp.ms - command.stamp.base
      if (push < MIN_MARGIN || push > MAX_MARGIN) throw new Error(`retry push ${push}`)
    },
  },
  {
    name: "rejection telemetry is told once until learning moves the margin",
    specClause: "packages/jollity-statement-core store-clock rejected-event contract",
    check: ({ previousReal, event, realObservation }) => {
      if (!event.kind.startsWith("reject")) return
      const told = realObservation.commands.filter((command) => command.type === "event" && command.event.kind === "rejected")
      if (told.length > (previousReal.rejectedReported ? 0 : 1)) throw new Error("duplicate rejection event")
    },
  },
]

const observe = (state: MessageExpiryClockState | ModelState, commands: MessageExpiryClockCommand[]): Observation => ({
  state: {
    kinds: Object.fromEntries(Object.entries(state.kinds).sort(([left], [right]) => left.localeCompare(right)).map(([kind, value]) => [kind, { ...value }])),
    rejectedReported: state.rejectedReported,
  },
  commands,
})

export const messageExpiryMachineDefinition: MachineDefinition<
  MessageExpiryClockState,
  ModelState,
  Event,
  MessageExpiryClockCommand[],
  MessageExpiryClockCommand[],
  Observation,
  StateKey,
  EventKey
> = {
  name: "message-expiry-clock",
  initialReal: createMessageExpiryClock,
  initialModel: () => ({ kinds: {}, rejectedReported: false }),
  realStep: (state, event) => {
    const result = messageExpiryClockStep(state, inputFor(state, event))
    return { state: result.state, output: result.commands }
  },
  modelStep,
  classifyRealStep: (previous, result) =>
    JSON.stringify(previous) === JSON.stringify(result.state) && result.output.length === 0 ? "no-op" : "transition",
  observeReal: ({ state, output }) => observe(state, output),
  observeModel: ({ state, output }) => observe(state, output),
  realStateKey: stateKey,
  modelStateKey: stateKey,
  eventKey: (event) => event.kind,
  transitionTable: messageExpiryTransitionTable,
  witnesses: messageExpiryWitnesses,
  regressions: messageExpiryRegressions,
  invariants,
  sequenceArbitrary: fc.array(fc.constantFrom<Event>(
    eventValues.stamp,
    eventValues["stamp-device"],
    eventValues["retry-fresh"],
    eventValues["retry-stale"],
    eventValues["accept-push"],
    eventValues["accept-sibling"],
    eventValues["accept-plain"],
    eventValues["reject-learn"],
    eventValues["reject-plain"],
    eventValues.margin,
  ), { minLength: 0, maxLength: 50 }),
  numRuns: 300,
}
