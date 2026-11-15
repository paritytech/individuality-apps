// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The "chain looks stuck" health machine, under the state-machine framework.
 *
 * The machine is the pipeline a probe result travels in the app: the doorway
 * (lib/game-source) promotes two bounded probe timeouts in a row to a loss
 * (reduceHostStuckEvidence), the card hook drops results older than the
 * latest applied (acceptChainHealthOrder), and the card (reduceChainHealthCard)
 * shows or clears the restart card. The reducers are pure; time arrives as an
 * event field (here: derived from the harness clock and the event's timing).
 *
 * Not in this machine: lib/chain-lost-streak.ts (async, host storage and
 * module-level state, a count and not a state machine) and the card hook's
 * round-lost gate (lib/use-chain-health-card.ts).
 *
 * The model below is written from the documented rules, not from the
 * implementation's branches:
 *  - two timeouts count only when consecutive and at most 30 s apart; any
 *    other result breaks the run (HOST_STUCK_TIMEOUT_WINDOW_MS). The doorway
 *    measures that interval on the monotonic clock, so a wall-clock step can
 *    neither join timeouts that were too far apart nor split adjacent ones.
 *  - a result with an order applies only if newer than the latest applied; one
 *    without an order always applies;
 *  - unknown failures are diagnostic only; a known loss raises the card; the
 *    first successful probe after it clears it; a silent host never downgrades
 *    the "connection lost" wording already on the card.
 *  - a loss raises the card whatever class the host gave it, and only the
 *    timeout of the probe bound counts toward a stuck host.
 *  - a return from the background discards what came before it: a lost card
 *    goes down without claiming the host answers, and a timeout from before
 *    never pairs with one after.
 */
import fc from "fast-check"
import {
  acceptChainHealthOrder,
  chainHealthCardAfterReturn,
  reduceChainHealthCard,
  reduceHostStuckEvidence,
  resetHostStuckEvidenceOnReturn,
  type ChainHealthCardState,
  type ChainHealthResult,
  type HostStuckEvidenceState,
} from "../chain-health"
import type { HostFailureClass } from "@individuality/people-chain"
import { defineTransitionTable, type MachineDefinition, type NamedInvariant, type NamedSequence } from "./framework"

const WINDOW_MS = 30_000

type Raw =
  | "healthy"
  | "lost-block"
  | "lost-dropped"
  | "lost-follow"
  | "lost-pinned"
  | "lost-interrupted"
  | "lost-declined"
  | "lost-network"
  | "lost-unknown"
  | "lost-timeout"
  | "timeout"
  | "unknown"
  | "unknown-interrupted"
  | "unknown-network"
  | "unknown-declined"
  | "declined"
type OrderMode = "fresh" | "none" | "same" | "older"
type Timing = "step" | "near" | "edge" | "far"

const SPECS = {
  healthy: { raw: "healthy", order: "fresh", timing: "step" },
  "healthy-unordered": { raw: "healthy", order: "none", timing: "step" },
  "stale-healthy": { raw: "healthy", order: "same", timing: "step" },
  "older-healthy": { raw: "healthy", order: "older", timing: "step" },
  "lost-block": { raw: "lost-block", order: "fresh", timing: "step" },
  "lost-dropped": { raw: "lost-dropped", order: "fresh", timing: "step" },
  "stale-lost": { raw: "lost-block", order: "same", timing: "step" },
  "turn-timeout-lost": { raw: "lost-timeout", order: "fresh", timing: "step" },
  "timeout-near": { raw: "timeout", order: "fresh", timing: "near" },
  "timeout-edge": { raw: "timeout", order: "fresh", timing: "edge" },
  "timeout-far": { raw: "timeout", order: "fresh", timing: "far" },
  // Named aliases keep the wall-discontinuity regressions readable. Only the
  // monotonic timing reaches the reducers.
  "timeout-clock-back": { raw: "timeout", order: "fresh", timing: "far" },
  "timeout-clock-forward": { raw: "timeout", order: "fresh", timing: "near" },
  "stale-timeout-near": { raw: "timeout", order: "same", timing: "near" },
  "unknown-other": { raw: "unknown", order: "fresh", timing: "step" },
  "unknown-interrupted": { raw: "unknown-interrupted", order: "fresh", timing: "step" },
  "unknown-network": { raw: "unknown-network", order: "fresh", timing: "step" },
  "unknown-declined": { raw: "unknown-declined", order: "fresh", timing: "step" },
  "lost-follow": { raw: "lost-follow", order: "fresh", timing: "step" },
  "lost-pinned": { raw: "lost-pinned", order: "fresh", timing: "step" },
  "lost-interrupted": { raw: "lost-interrupted", order: "fresh", timing: "step" },
  "lost-declined": { raw: "lost-declined", order: "fresh", timing: "step" },
  "lost-network": { raw: "lost-network", order: "fresh", timing: "step" },
  "lost-unknown": { raw: "lost-unknown", order: "fresh", timing: "step" },
  declined: { raw: "declined", order: "fresh", timing: "step" },
} as const satisfies Record<string, { raw: Raw; order: OrderMode; timing: Timing }>

/** Not a probe result: the page coming back from the background. */
const RETURNED = "returned"
type ProbeEvent = keyof typeof SPECS
export type ChainHealthTestEvent = ProbeEvent | typeof RETURNED
const EVENTS = [...(Object.keys(SPECS) as ProbeEvent[]), RETURNED] as ChainHealthTestEvent[]

type CardKind = "never-answered" | "answering" | "lost-loss" | "lost-silence"
type StateKey = `${CardKind}|armed:${0 | 1}`

/** The pipeline's state: the three real reducers' states plus harness fields. */
export interface RealPipeline {
  evidence: HostStuckEvidenceState
  latest: number
  card: ChainHealthCardState
  clockMs: number
}

interface ModelPipeline {
  kind: CardKind
  lastTimeoutAt: number | null
  latest: number
  clockMs: number
}

interface Observation {
  nowMs: number
  accepted: boolean
  promoted: boolean
  cardLost: boolean
  cardReason: string | null
  cardAnswering: boolean | null
  armedAt: number | null
  latest: number
}

const baseNow = (armedAt: number | null, clockMs: number): number => armedAt ?? clockMs
function timingNow(
  timing: Timing,
  armedAt: number | null,
  clockMs: number,
): number {
  const base = baseNow(armedAt, clockMs)
  switch (timing) {
    case "step":
      return clockMs + 1000
    case "near":
      return base + 10_000
    case "edge":
      return base + WINDOW_MS
    case "far":
      return base + WINDOW_MS + 1
  }
}
function orderFor(mode: OrderMode, latest: number): number | undefined {
  switch (mode) {
    case "fresh":
      return latest + 1
    case "none":
      return undefined
    case "same":
      return latest
    case "older":
      return latest - 1
  }
}

const lost = (errorClass: HostFailureClass, o: { order?: number }): ChainHealthResult => ({
  outcome: "host-chain-lost",
  latencyMs: 4,
  errorClass,
  error: "x",
  ...o,
})
const unknown = (errorClass: HostFailureClass, o: { order?: number }): ChainHealthResult => ({
  outcome: "unknown",
  latencyMs: 5,
  errorClass,
  error: "u",
  ...o,
})

function resultFor(raw: Raw, order: number | undefined): ChainHealthResult {
  const o = order === undefined ? {} : { order }
  switch (raw) {
    case "healthy":
      return { outcome: "healthy", latencyMs: 9, ...o }
    case "lost-block":
      return lost("cannot-get-current-block", o)
    case "lost-dropped":
      return lost("subscription-dropped", o)
    case "lost-follow":
      return lost("follow-unknown", o)
    case "lost-pinned":
      return lost("block-not-pinned", o)
    case "lost-interrupted":
      return lost("host-interrupted", o)
    case "lost-declined":
      return lost("declined", o)
    case "lost-network":
      return lost("network", o)
    case "lost-unknown":
      return lost("unknown", o)
    case "lost-timeout":
      return lost("timeout", o)
    case "timeout":
      return { outcome: "unknown", latencyMs: 5000, errorClass: "timeout", error: "t", ...o }
    case "unknown":
      return unknown("unknown", o)
    case "unknown-interrupted":
      return unknown("host-interrupted", o)
    case "unknown-network":
      return unknown("network", o)
    case "unknown-declined":
      return unknown("declined", o)
    case "declined":
      return { outcome: "declined", latencyMs: 0, error: "d", ...o }
  }
}

const cardKindOf = (card: ChainHealthCardState): CardKind =>
  card.lost ? (card.reason === "chain-lost" ? "lost-loss" : "lost-silence") : card.answering ? "answering" : "never-answered"

const stateKey = (kind: CardKind, armed: boolean): StateKey => `${kind}|armed:${armed ? 1 : 0}`

const KINDS: CardKind[] = ["never-answered", "answering", "lost-loss", "lost-silence"]
const CLOCK = 100_000
const cardFor = (kind: CardKind): ChainHealthCardState => {
  switch (kind) {
    case "never-answered":
      return { lost: false }
    case "answering":
      return { lost: false, answering: true }
    case "lost-loss":
      return { lost: true, reason: "chain-lost" }
    case "lost-silence":
      return { lost: true, reason: "host-unanswered" }
  }
}
const stateCases = KINDS.flatMap((kind) =>
  [false, true].map((armed) => ({
    key: stateKey(kind, armed),
    real: {
      evidence: { lastTimeoutAtMs: armed ? CLOCK : null },
      latest: 1,
      card: cardFor(kind),
      clockMs: CLOCK,
    } satisfies RealPipeline,
    model: {
      kind,
      lastTimeoutAt: armed ? CLOCK : null,
      latest: 1,
      clockMs: CLOCK,
    } satisfies ModelPipeline,
  })),
)

function realStep(state: RealPipeline, event: ChainHealthTestEvent) {
  if (event === RETURNED) {
    const nowMs = state.clockMs + 1000
    return {
      state: {
        evidence: resetHostStuckEvidenceOnReturn(state.evidence, nowMs),
        latest: state.latest,
        card: chainHealthCardAfterReturn(state.card),
        clockMs: nowMs,
      } satisfies RealPipeline,
      output: { nowMs, accepted: false, promoted: false },
    }
  }
  const spec = SPECS[event]
  const nowMs = timingNow(spec.timing, state.evidence.lastTimeoutAtMs, state.clockMs)
  const incoming = resultFor(spec.raw, orderFor(spec.order, state.latest))
  const promoted = reduceHostStuckEvidence(state.evidence, incoming, nowMs)
  const gate = acceptChainHealthOrder(state.latest, incoming.order)
  const card = gate.accepted ? reduceChainHealthCard(state.card, promoted.result) : state.card
  return {
    state: { evidence: promoted.state, latest: gate.latest, card, clockMs: nowMs } satisfies RealPipeline,
    output: { nowMs, accepted: gate.accepted, promoted: promoted.result !== incoming },
  }
}

const LOSSES: readonly Raw[] = [
  "lost-block",
  "lost-dropped",
  "lost-follow",
  "lost-pinned",
  "lost-interrupted",
  "lost-declined",
  "lost-network",
  "lost-unknown",
]

/** Independent executable model: phases and rules from the module's header. */
function modelStep(before: ModelPipeline, event: ChainHealthTestEvent) {
  if (event === RETURNED) {
    // the return forgets the run of timeouts and lowers a lost card; what the
    // host showed it can do (answering) stays
    const kind: CardKind = before.kind === "lost-loss" || before.kind === "lost-silence" ? "never-answered" : before.kind
    const nowMs = before.clockMs + 1000
    return {
      state: { kind, lastTimeoutAt: null, latest: before.latest, clockMs: nowMs },
      output: { nowMs, accepted: false, promoted: false },
    }
  }
  const spec = SPECS[event]
  const nowMs = timingNow(spec.timing, before.lastTimeoutAt, before.clockMs)
  const order = orderFor(spec.order, before.latest)

  // the run of timeouts: continues only on a timeout close enough to the last one
  const isTimeout = spec.raw === "timeout"
  const closeEnough = before.lastTimeoutAt !== null && nowMs - before.lastTimeoutAt <= WINDOW_MS
  const promoted = isTimeout && closeEnough
  const lastTimeoutAt = isTimeout ? nowMs : null

  // the order gate
  const accepted = order === undefined || order > before.latest
  const latest = order !== undefined && accepted ? order : before.latest

  // what the card learns from the (possibly promoted) result
  let kind = before.kind
  if (accepted) {
    const loss = LOSSES.includes(spec.raw)
    const silence = spec.raw === "lost-timeout" || promoted
    if (loss) kind = "lost-loss"
    else if (silence) kind = before.kind === "lost-loss" ? "lost-loss" : "lost-silence"
    else if (spec.raw === "healthy") kind = "answering"
  }
  return {
    state: { kind, lastTimeoutAt, latest, clockMs: nowMs },
    output: { nowMs, accepted, promoted },
  }
}

const observeReal = (r: ReturnType<typeof realStep>): Observation => ({
  ...r.output,
  cardLost: r.state.card.lost,
  cardReason: r.state.card.reason ?? null,
  cardAnswering: r.state.card.answering ?? null,
  armedAt: r.state.evidence.lastTimeoutAtMs,
  latest: r.state.latest,
})
const observeModel = (m: ReturnType<typeof modelStep>): Observation => {
  const card = cardFor(m.state.kind)
  return {
    ...m.output,
    cardLost: card.lost,
    cardReason: card.reason ?? null,
    cardAnswering: card.answering ?? null,
    armedAt: m.state.lastTimeoutAt,
    latest: m.state.latest,
  }
}

const quietly = (before: ModelPipeline, after: ModelPipeline, out: { accepted: boolean; promoted: boolean }) =>
  before.kind === after.kind && before.lastTimeoutAt === after.lastTimeoutAt && before.latest === after.latest && !out.accepted && !out.promoted

const modelOutcome = (before: ModelPipeline, event: ChainHealthTestEvent): "transition" | "no-op" => {
  const after = modelStep(before, event)
  return quietly(before, after.state, after.output) ? "no-op" : "transition"
}

export const chainHealthTransitionTable = defineTransitionTable<StateKey, ChainHealthTestEvent>()(
  Object.fromEntries(
    stateCases.map(({ key, model }) => [key, Object.fromEntries(EVENTS.map((event) => [event, modelOutcome(model, event)]))]),
  ) as Record<StateKey, Record<ChainHealthTestEvent, "transition" | "no-op">>,
)

export const chainHealthWitnesses: NamedSequence<ChainHealthTestEvent, RealPipeline, ModelPipeline>[] = stateCases.flatMap(
  ({ key, real, model }) => EVENTS.map((event) => ({ name: `${key} × ${event}`, initial: { real, model }, events: [event] })),
)

export const chainHealthRegressionCorpus: NamedSequence<ChainHealthTestEvent, RealPipeline, ModelPipeline>[] = [
  { name: "one timeout alone never raises the card", events: ["timeout-far", "unknown-other"] },
  { name: "two timeouts within the window raise the silent-host card", events: ["timeout-far", "timeout-near"] },
  { name: "the window edge (30 s) still counts", events: ["timeout-far", "timeout-edge"] },
  { name: "one millisecond past the window does not count", events: ["timeout-far", "timeout-far"] },
  { name: "a healthy probe between two timeouts breaks the run", events: ["timeout-far", "healthy", "timeout-near"] },
  { name: "an unknown failure between two timeouts breaks the run", events: ["timeout-far", "unknown-other", "timeout-near"] },
  { name: "a stale healthy result cannot clear a lost card", events: ["lost-block", "stale-healthy"] },
  { name: "an older healthy result cannot clear a lost card", events: ["lost-block", "older-healthy"] },
  { name: "a duplicate loss changes nothing", events: ["lost-block", "stale-lost"] },
  { name: "the first newer healthy probe clears the card", events: ["lost-dropped", "healthy"] },
  { name: "an unordered healthy result always applies", events: ["lost-block", "healthy-unordered"] },
  { name: "a silent host does not downgrade the connection-lost wording", events: ["lost-block", "turn-timeout-lost", "timeout-far", "timeout-near"] },
  { name: "a known loss replaces the silent-host wording", events: ["turn-timeout-lost", "lost-block"] },
  { name: "a stale timeout still feeds the evidence run but not the card", events: ["timeout-far", "stale-timeout-near"] },
  { name: "a backwards clock jump does not invent a loss from one timeout", events: ["timeout-far", "healthy", "timeout-clock-back"] },
  {
    name: "a backward wall-clock jump cannot join timeouts more than 30 s apart",
    events: ["timeout-far", "timeout-clock-back"],
  },
  {
    name: "a forward wall-clock jump cannot split adjacent timeouts",
    events: ["timeout-far", "timeout-clock-forward"],
  },
  { name: "declined probes say nothing about the chain", events: ["lost-block", "declined"] },
  { name: "a loss with no class it knows still raises the card", events: ["lost-unknown"] },
  { name: "a loss the host called a decline still raises the card", events: ["healthy", "lost-declined"] },
  { name: "a loss the host called a cut link still raises the card", events: ["lost-interrupted"] },
  { name: "a decline the probe left unknown says nothing about the chain", events: ["lost-block", "unknown-declined"] },
  { name: "a decline the probe left unknown breaks the run of timeouts", events: ["timeout-far", "unknown-declined", "timeout-near"] },
  { name: "a cut link breaks the run of timeouts", events: ["timeout-far", "unknown-interrupted", "timeout-near"] },
  { name: "a network failure never raises the card", events: ["unknown-network", "unknown-network"] },
  { name: "a return from the background lowers a connection-lost card", events: ["lost-dropped", "returned"] },
  { name: "a return from the background lowers a silent-host card", events: ["timeout-far", "timeout-near", "returned"] },
  { name: "a timeout before the background never pairs with one after it", events: ["timeout-far", "returned", "timeout-near"] },
  { name: "a return does not claim the host answers", events: ["returned", "timeout-far"] },
  { name: "fresh evidence after a return raises the card again", events: ["lost-dropped", "returned", "lost-dropped"] },
]

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}
const TIMEOUTS: readonly ChainHealthTestEvent[] = [
  "timeout-near",
  "timeout-edge",
  "timeout-far",
  "timeout-clock-back",
  "timeout-clock-forward",
  "stale-timeout-near",
]
const isTimeoutEvent = (event: ChainHealthTestEvent) => TIMEOUTS.includes(event)

type Ctx = Parameters<NamedInvariant<RealPipeline, ModelPipeline, ChainHealthTestEvent, Observation, StateKey, ChainHealthTestEvent>["check"]>[0]

const invariants: NamedInvariant<RealPipeline, ModelPipeline, ChainHealthTestEvent, Observation, StateKey, ChainHealthTestEvent>[] = [
  {
    name: "no false stuck: a card goes up only on a known loss or two timeouts within the window",
    specClause: "HOST_STUCK_TIMEOUT_WINDOW_MS; reduceChainHealthCard",
    check: ({ previousReal, real, event, realObservation }: Ctx) => {
      if (previousReal.card.lost || !real.card.lost) return
      if (event === RETURNED) throw new Error("a return from the background raised the card")
      const knownLoss = LOSSES.includes(SPECS[event].raw) || event === "turn-timeout-lost"
      const twoTimeouts =
        isTimeoutEvent(event) &&
        previousReal.evidence.lastTimeoutAtMs !== null &&
        realObservation.nowMs - previousReal.evidence.lastTimeoutAtMs <= WINDOW_MS
      assert(knownLoss || twoTimeouts, `card raised by ${event} without a loss or two timeouts in the window`)
    },
  },
  {
    name: "no false stuck: a run broken by any other result never promotes a timeout",
    specClause: "reduceHostStuckEvidence: any other evidence breaks the run",
    check: ({ previousReal, event, realObservation }: Ctx) => {
      if (realObservation.promoted) {
        assert(isTimeoutEvent(event), "a non-timeout result was promoted")
        assert(previousReal.evidence.lastTimeoutAtMs !== null, "promoted without a previous timeout")
      }
      if (!isTimeoutEvent(event)) assert(realObservation.armedAt === null, "a non-timeout result left a timeout armed")
    },
  },
  {
    name: "no false stuck: while healthy probes keep arriving the card is down",
    specClause: "reduceChainHealthCard: first successful probe clears",
    check: ({ real, event, realObservation }: Ctx) => {
      if ((event === "healthy" || event === "healthy-unordered") && realObservation.accepted)
        assert(!real.card.lost && real.card.answering === true, "a fresh healthy probe left the card up")
    },
  },
  {
    name: "no false fine: two timeouts in a row within the window are reported at once",
    specClause: "HOST_STUCK_TIMEOUT_WINDOW_MS (30 s bound)",
    check: ({ previousReal, real, event, realObservation }: Ctx) => {
      if (!isTimeoutEvent(event) || previousReal.evidence.lastTimeoutAtMs === null) return
      const elapsed = realObservation.nowMs - previousReal.evidence.lastTimeoutAtMs
      if (elapsed > WINDOW_MS) return
      assert(realObservation.promoted, "second timeout within the window was not promoted")
      if (realObservation.accepted) assert(real.card.lost, "promoted timeout did not raise the card")
    },
  },
  {
    name: "no false fine: only a fresh healthy probe lowers a lost card",
    specClause: "acceptChainHealthResult; reduceChainHealthCard",
    check: ({ previousReal, real, event }: Ctx) => {
      if (previousReal.card.lost && !real.card.lost)
        assert(event === "healthy" || event === "healthy-unordered" || event === RETURNED, `${event} cleared a lost card`)
    },
  },
  {
    name: "stale results never touch the card and the latest order never moves back",
    specClause: "acceptChainHealthResult: an older async result must not undo newer state",
    check: ({ previousReal, real, event, realObservation }: Ctx) => {
      assert(real.latest >= previousReal.latest, "latest applied order went backwards")
      if (!realObservation.accepted && event !== RETURNED) assert(JSON.stringify(real.card) === JSON.stringify(previousReal.card), "a stale result changed the card")
    },
  },
  {
    name: "a silent host never downgrades the connection-lost wording",
    specClause: "reduceChainHealthCard: chain-lost reason is kept against timeouts",
    check: ({ previousReal, real, event }: Ctx) => {
      if (event === RETURNED) return
      if (previousReal.card.lost && previousReal.card.reason === "chain-lost" && real.card.lost && !LOSSES.includes(SPECS[event].raw))
        assert(real.card.reason === "chain-lost", "chain-lost wording downgraded")
    },
  },
  {
    name: "a return from the background forgets the restart evidence and claims nothing",
    specClause: "chainHealthCardAfterReturn; resetHostStuckEvidenceOnReturn",
    check: ({ previousReal, real, event }: Ctx) => {
      if (event !== RETURNED) return
      assert(!real.card.lost, "a lost card survived the return")
      assert(real.evidence.lastTimeoutAtMs === null, "a timeout from before the return stayed armed")
      assert(real.card.answering === (previousReal.card.lost ? undefined : previousReal.card.answering), "the return changed what the host has shown")
    },
  },
]

const single = fc.constantFrom<ChainHealthTestEvent>(...EVENTS)
/** bursts keep timeouts adjacent so the window logic is exercised, and
 *  duplicated/stale/clock-jump events appear among them */
const burst = fc.constantFrom<readonly ChainHealthTestEvent[]>(
  ["timeout-far", "timeout-near"],
  ["timeout-far", "timeout-edge"],
  ["timeout-far", "timeout-far"],
  ["timeout-far", "timeout-clock-back"],
  ["timeout-far", "timeout-clock-forward"],
  ["timeout-far", "stale-timeout-near", "timeout-near"],
  ["lost-block", "stale-lost", "stale-healthy"],
  ["timeout-far", "returned", "timeout-near"],
)
const sequenceArbitrary = fc
  .array(fc.oneof({ weight: 3, arbitrary: single.map((e) => [e] as readonly ChainHealthTestEvent[]) }, { weight: 1, arbitrary: burst }), {
    minLength: 0,
    maxLength: 40,
    size: "max",
  })
  .map((chunks) => chunks.flat())

export const chainHealthMachineDefinition: MachineDefinition<
  RealPipeline,
  ModelPipeline,
  ChainHealthTestEvent,
  ReturnType<typeof realStep>["output"],
  ReturnType<typeof modelStep>["output"],
  Observation,
  StateKey,
  ChainHealthTestEvent
> = {
  name: "chain-health",
  initialReal: () => ({
    evidence: { lastTimeoutAtMs: null },
    latest: 0,
    card: { lost: false },
    clockMs: CLOCK,
  }),
  initialModel: () => ({
    kind: "never-answered",
    lastTimeoutAt: null,
    latest: 0,
    clockMs: CLOCK,
  }),
  initialArbitrary: fc.constantFrom(...stateCases.map(({ real, model }) => ({ real, model }))),
  realStep,
  modelStep,
  classifyRealStep: (previous, result) =>
    cardKindOf(previous.card) === cardKindOf(result.state.card) &&
    previous.evidence.lastTimeoutAtMs === result.state.evidence.lastTimeoutAtMs &&
    previous.latest === result.state.latest &&
    !result.output.accepted &&
    !result.output.promoted
      ? "no-op"
      : "transition",
  observeReal,
  observeModel,
  realStateKey: (state) => stateKey(cardKindOf(state.card), state.evidence.lastTimeoutAtMs !== null),
  modelStateKey: (state) => stateKey(state.kind, state.lastTimeoutAt !== null),
  eventKey: (event) => event,
  transitionTable: chainHealthTransitionTable,
  witnesses: chainHealthWitnesses,
  regressions: chainHealthRegressionCorpus,
  invariants,
  sequenceArbitrary,
  numRuns: 300,
}
