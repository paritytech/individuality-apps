// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * JOURNEYS — the intervals we measure. A journey is a top-level span (op
 * `journey.<name>`); each step is a child span (op `<name>.<step>`), and a
 * step's duration is what dashboards aggregate. Every attribute is TEXT: the
 * Sentry JS SDK's custom attributes are stored string-typed, so only the
 * built-in `span.duration` aggregates as a number. Counts are spans too.
 *
 * `journey.sad` and `journey.expected` are "false" from the start, so their
 * ratios have a denominator. Every call on the handle is wrapped: it never
 * throws, and after `end()` it does nothing.
 */
import * as Sentry from "@sentry/react"
import type { Span } from "@sentry/react"
import { clockAttrs } from "./clock"

/** Journey and step names as one map (the spec's catalogue). `round.<n>` is
 *  one step per round of the game. */
export const JOURNEYS = {
  "app-open": {
    steps: ["host.connect", "host.identity", "chain.genesis", "permissions.check"],
    outcomes: ["ready", "gate", "no-source"],
  },
  "home-first-status": {
    steps: [],
    outcomes: ["shown", "restart-card", "stuck"],
  },
  permissions: {
    steps: ["camera", "network", "network.turn-receipt", "webrtc", "statements"],
    outcomes: ["granted", "refused"],
  },
  person: {
    steps: ["key.find", "proof", "bind.broadcast"],
    outcomes: ["bound", "already-bound", "failed"],
  },
  "game-signup": {
    steps: ["route", "tx.build", "tx.broadcast", "tx.landed"],
    outcomes: ["landed", "failed", "not-eligible", "unbound", "retrying", "closed"],
  },
  join: {
    steps: ["camera.acquire", "chain.read", "statements.first_page", "turn.proof", "turn.issue", "mesh.open", "peer.first", "peer.all", "rtc.peer", "rtc.ice_error", "rtc.negotiation_error", "rtc.codec_guard", "rtc.sps", "rtc.heal", "rtc.stall", "rtc.signal", "net.change", "app.hidden"],
    outcomes: ["full", "partial", "isolated", "late"],
  },
  game: {
    steps: ["round.1", "round.2", "report.submit", "report.landed", "rtc.stall", "rtc.reconnect", "rtc.path", "rtc.decoder_change", "rtc.encoder_change", "rtc.ice_error", "rtc.negotiation_error", "rtc.codec_guard", "rtc.sps", "rtc.heal", "rtc.signal", "net.change", "game.peer.away", "camera.recover", "app.hidden"],
    outcomes: ["completed", "abandoned", "isolated"],
  },
  payoff: {
    steps: ["attestations.ready", "draw.show", "chest.show", "app.hidden"],
    outcomes: ["shown", "stalled"],
  },
  /** the tap from the membership screen into Humanity; a journey of its own
   *  because the payoff has ended by the time the player can tap */
  humanity: {
    steps: ["open"],
    outcomes: ["requested"],
  },
  /** the player's username linked to their jollity account, in the background
   *  from app open, so the prize draw's wheel can name their tickets (#456;
   *  `name_link.trigger` background or register); a step per
   *  `linkName` stage (@individuality/name-link), so `sign` is the time the
   *  player took to confirm the root's signature */
  "name-link": {
    steps: ["lookup", "funds", "sign", "store", "note", "verify"],
    outcomes: ["linked", "already-linked", "unfunded", "not-signed", "unowned", "failed", "skipped"],
  },
} as const

export type JourneyName = keyof typeof JOURNEYS
export type OutcomeOf<N extends JourneyName> = (typeof JOURNEYS)[N]["outcomes"][number]
/** A journey's step names: its declared ones, plus one per game round. A typo
 *  is a compile error. */
export type StepOf<N extends JourneyName> = (typeof JOURNEYS)[N]["steps"][number] | `round.${number}`
export type Attrs = Record<string, string | number>

export interface StepOptions {
  /** wall-clock ms; default now */
  startedAt?: number
}
export interface EndOptions {
  /** wall-clock ms; default now */
  endedAt?: number
}

export interface Step {
  readonly ended: boolean
  set(attrs: Attrs): void
  end(attrs?: Attrs, options?: EndOptions): void
}

export interface JourneyOptions {
  /** wall-clock ms; default now */
  startedAt?: number
  /** run in this journey's trace (one trace per game) */
  sameTraceAs?: Journey | null
  /** the caller ends this journey itself when the page goes away (game-trace's
   *  join, game and payoff, which add their closing facts first): the generic
   *  interrupt of #279 leaves it alone */
  ownsLifecycle?: boolean
}

/** The durable, deliberately small part of a reached step. The last-session
 *  record keeps these so a page the OS kills can reconstruct the journey on
 *  the next boot. Attributes remain in Sentry's ordinary live span; storage
 *  only needs one chronology entry per step name and the steps reached. */
export interface OpenJourneyStepRecord {
  name: string
  startedAt: number
  endedAt?: number
}

/** A live journey's recovery record. `traceHeader` identifies the root that
 *  was lost. `parentTraceHeader`, when present, is the root's original parent:
 *  reconstruction continues from that parent so the replacement root occupies
 *  the lost root's place rather than becoming its child. */
export interface OpenJourneyRecord {
  name: JourneyName
  startedAt: number
  traceHeader: string
  parentTraceHeader?: string
  gameIndex?: string
  lastStep: string
  sadReason?: string
  steps: OpenJourneyStepRecord[]
}

export interface Journey<N extends JourneyName = JourneyName> {
  readonly name: N
  readonly ended: boolean
  /** the trace this journey runs in; null for a no-op journey */
  readonly trace: { traceId: string; spanId: string } | null
  step(name: StepOf<N>, attrs?: Attrs, options?: StepOptions): Step
  set(attrs: Attrs): void
  markSad(reason: string): void
  end(outcome: OutcomeOf<N>, attrs?: Attrs, options?: EndOptions): void
}

/** Span times from the wall clock, in ms. The SDK's own default is the
 *  performance clock, which stops while a phone's page is frozen. */
const wall = (given?: number) => given ?? Date.now()

const safe = (work: () => void) => {
  try {
    work()
  } catch {
    /* never throws */
  }
}

const NOOP_STEP: Step = { ended: true, set() {}, end() {} }

export function noopJourney<N extends JourneyName>(name: N): Journey<N> {
  return { name, ended: true, trace: null, step: () => NOOP_STEP, set() {}, markSad() {}, end() {} }
}

/** the root span behind each live journey, for `sameTraceAs` */
const roots = new WeakMap<object, Span>()

function rootSpan(name: JourneyName, attrs: Attrs, options: JourneyOptions): { span: Span; parentTraceHeader?: string } {
  const start = () =>
    Sentry.withActiveSpan(null, () =>
      Sentry.startInactiveSpan({
        name: `journey.${name}`,
        op: `journey.${name}`,
        attributes: attrs,
        startTime: wall(options.startedAt),
      }),
    )
  const parent = options.sameTraceAs ? roots.get(options.sameTraceAs) : undefined
  if (parent) {
    const parentTraceHeader = Sentry.spanToTraceHeader(parent)
    return { span: Sentry.continueTrace({ sentryTrace: parentTraceHeader, baggage: undefined }, start), parentTraceHeader }
  }
  return { span: Sentry.startNewTrace(start) }
}

function recoveredRootSpan(record: OpenJourneyRecord, attrs: Attrs): Span {
  const start = () =>
    Sentry.withActiveSpan(null, () =>
      Sentry.startInactiveSpan({
        name: `journey.${record.name}`,
        op: `journey.${record.name}`,
        attributes: attrs,
        startTime: record.startedAt,
      }),
    )
  if (record.parentTraceHeader)
    return Sentry.continueTrace({ sentryTrace: record.parentTraceHeader, baggage: undefined }, start)
  const [traceId, , sampled] = record.traceHeader.split("-")
  return Sentry.withScope((scope) => {
    scope.setPropagationContext({ traceId, sampleRand: 0, sampled: sampled === "1" })
    return start()
  })
}

/** The outcome of a journey the page went away on. It is reserved: no journey
 *  declares it, the page-lifecycle hook (#279) sets it, and a report reads it
 *  as "the phone froze or was killed here" next to the step it was in. */
const INTERRUPTED_OUTCOME = "interrupted"
export type InterruptCause = "pagehide"

/** every journey that has not ended; each entry ends its journey as interrupted */
const openJourneys = new Set<(cause: InterruptCause) => void>()
const openJourneyRecords = new Map<object, OpenJourneyRecord>()
let openJourneyListener: (() => void) | null = null
const pendingContinuations: Array<{ root: Span; previousSessionId: string; gameIndex: string }> = []

const TRACE_HEADER = /^[0-9a-f]{32}-[0-9a-f]{16}-[01]$/i

export function isOpenJourneyRecord(value: unknown): value is OpenJourneyRecord {
  const record = value as Partial<OpenJourneyRecord> | null
  return (
    !!record &&
    typeof record === "object" &&
    typeof record.name === "string" &&
    record.name in JOURNEYS &&
    typeof record.startedAt === "number" &&
    Number.isFinite(record.startedAt) &&
    typeof record.traceHeader === "string" &&
    TRACE_HEADER.test(record.traceHeader) &&
    (record.parentTraceHeader === undefined || (typeof record.parentTraceHeader === "string" && TRACE_HEADER.test(record.parentTraceHeader))) &&
    (record.gameIndex === undefined || typeof record.gameIndex === "string") &&
    typeof record.lastStep === "string" &&
    (record.sadReason === undefined || typeof record.sadReason === "string") &&
    Array.isArray(record.steps) &&
    record.steps.every(
      (step) =>
        !!step &&
        typeof step === "object" &&
        typeof step.name === "string" &&
        typeof step.startedAt === "number" &&
        Number.isFinite(step.startedAt) &&
        (step.endedAt === undefined || (typeof step.endedAt === "number" && Number.isFinite(step.endedAt))),
    )
  )
}

export function openJourneyRecoveryRecords(): OpenJourneyRecord[] {
  return [...openJourneyRecords.values()].map((record) => ({
    ...record,
    steps: record.steps.map((step) => ({ ...step })),
  }))
}

/** One listener is enough: the last-session record is the sole durable owner. */
export function setOpenJourneyListener(listener: (() => void) | null): void {
  openJourneyListener = listener
}

function openJourneysChanged(): void {
  safe(() => openJourneyListener?.())
}

function linkRecoveredRoots(root: Span, gameIndex: string): void {
  if (pendingContinuations.length === 0) return
  const matches = pendingContinuations.filter((pending) => pending.gameIndex === gameIndex)
  // A known current game is authoritative: roots for any other game are not a
  // continuation of this visit and must not leak into a later join.
  pendingContinuations.length = 0
  if (matches.length === 0) return
  root.addLinks(
    matches.map(({ root: previous }) => ({
      context: previous.spanContext(),
      attributes: { "sentry.link.type": "previous_trace" },
    })),
  )
  root.setAttributes({
    "journey.resumed": "true",
    "journey.resumed_from_session": [...new Set(matches.map((match) => match.previousSessionId))].join(","),
  })
}

function linkCurrentJoin(): void {
  for (const [journey, record] of openJourneyRecords) {
    if (record.name !== "join" || !record.gameIndex) continue
    const root = roots.get(journey)
    if (root) linkRecoveredRoots(root, record.gameIndex)
    return
  }
}

/** End every still-open journey as interrupted, so its root span is sent while
 *  the page can still send it. A journey ends once: one that ended normally is
 *  not here, and one ended here is not sent again. */
export function interruptOpenJourneys(cause: InterruptCause): number {
  let count = 0
  for (const interrupt of [...openJourneys]) {
    count += 1
    safe(() => interrupt(cause))
  }
  return count
}

export function resetJourneysForTests(): void {
  openJourneys.clear()
  openJourneyRecords.clear()
  pendingContinuations.length = 0
  openJourneyListener = null
}

/** Recreate roots that an unclean exit could not send. Their child spans are
 *  the steps durably observed by the previous page. Once the next join learns
 *  that it is for the same game, it links to the reconstructed roots and is
 *  marked `journey.resumed`. A different game discards the pending links. */
export function recoverInterruptedJourneys(records: readonly OpenJourneyRecord[], previousSessionId: string, lastSeenAt: number): number {
  let recovered = 0
  for (const record of records) {
    if (!isOpenJourneyRecord(record)) continue
    safe(() => {
      const endedAt = Math.max(record.startedAt, lastSeenAt)
      const attrs: Attrs = {
        "journey.sad": record.sadReason ? "true" : "false",
        "journey.expected": "false",
        ...(record.sadReason ? { "journey.sad_reason": record.sadReason } : {}),
        "wall.time.start": String(record.startedAt),
        "wall.time.end": String(endedAt),
        "journey.outcome": INTERRUPTED_OUTCOME,
        "journey.interrupted_by": "unclean-exit",
        "journey.interrupted_step": record.lastStep,
        "journey.interrupted_after_ms": String(Math.max(0, endedAt - record.startedAt)),
        "journey.recovered": "true",
        "journey.previous_session_id": previousSessionId,
        ...(record.gameIndex ? { "game.index": record.gameIndex } : {}),
      }
      // Scope/user/build tags describe the recovery boot. The explicit
      // previous-session id above is the authority for the lost page.
      const root = recoveredRootSpan(record, attrs)
      for (const saved of record.steps) {
        const startedAt = Math.min(endedAt, Math.max(record.startedAt, saved.startedAt))
        const step = Sentry.startInactiveSpan({
          name: saved.name,
          op: `${record.name}.${saved.name}`,
          parentSpan: root,
          attributes: { "journey.recovered": "true", ...(saved.endedAt === undefined ? { "step.outcome": "cut" } : {}) },
          startTime: startedAt,
        })
        step.end(Math.min(endedAt, Math.max(startedAt, saved.endedAt ?? endedAt)))
      }
      root.end(endedAt)
      if (record.gameIndex) pendingContinuations.push({ root, previousSessionId, gameIndex: record.gameIndex })
      recovered += 1
    })
  }
  // Session recovery is asynchronous and the current join can learn its game
  // first. Link it now as well as handling the usual recovery-before-join path.
  linkCurrentJoin()
  return recovered
}

export function createJourney<N extends JourneyName>(name: N, attrs: Attrs = {}, options: JourneyOptions = {}): Journey<N> {
  const began = wall(options.startedAt)
  const created = rootSpan(
    name,
    {
      ...attrs,
      "journey.sad": "false",
      "journey.expected": "false",
      ...clockAttrs("start", name, began),
    },
    options,
  )
  const root = created.span
  const context = root.spanContext()
  const open = new Set<Step>()
  let ended = false
  let lastStep = "none"
  const record: OpenJourneyRecord = {
    name,
    startedAt: began,
    traceHeader: Sentry.spanToTraceHeader(root),
    parentTraceHeader: created.parentTraceHeader,
    ...(attrs["game.index"] === undefined ? {} : { gameIndex: String(attrs["game.index"]) }),
    lastStep,
    steps: [],
  }
  const savedSteps = new Map<string, { record: OpenJourneyStepRecord; open: number }>()
  const openStepOrder: Array<{ name: string; step: Step }> = []
  let lastReachedStep = "none"

  const linkRecoveredGame = (gameIndex: string) => {
    if (name === "join") linkRecoveredRoots(root, gameIndex)
  }
  if (record.gameIndex) linkRecoveredGame(record.gameIndex)

  const journey: Journey<N> & { __withActiveSpan<T>(work: () => T): T } = {
    name,
    get ended() {
      return ended
    },
    trace: { traceId: context.traceId, spanId: context.spanId },
    __withActiveSpan(work) {
      return Sentry.withActiveSpan(root, work)
    },
    step(stepName, stepAttrs = {}, stepOptions = {}) {
      if (ended) return NOOP_STEP
      let child: Span
      try {
        child = Sentry.startInactiveSpan({
          name: stepName,
          op: `${name}.${stepName}`,
          parentSpan: root,
          attributes: stepAttrs,
          startTime: wall(stepOptions.startedAt),
        })
      } catch {
        return NOOP_STEP
      }
      const startedAt = wall(stepOptions.startedAt)
      lastReachedStep = stepName
      lastStep = stepName
      record.lastStep = stepName
      const saved = savedSteps.get(stepName) ?? { record: { name: stepName, startedAt }, open: 0 }
      if (!savedSteps.has(stepName)) {
        savedSteps.set(stepName, saved)
        record.steps.push(saved.record)
      }
      saved.open += 1
      delete saved.record.endedAt
      let stepEnded = false
      const step: Step = {
        get ended() {
          return stepEnded
        },
        set(more) {
          if (!stepEnded) safe(() => child.setAttributes(more))
        },
        end(more, endOptions = {}) {
          if (stepEnded) return
          stepEnded = true
          open.delete(step)
          const orderIndex = openStepOrder.findIndex((entry) => entry.step === step)
          if (orderIndex >= 0) openStepOrder.splice(orderIndex, 1)
          saved.open -= 1
          if (saved.open === 0) saved.record.endedAt = wall(endOptions.endedAt)
          lastStep = openStepOrder.at(-1)?.name ?? lastReachedStep
          record.lastStep = lastStep
          openJourneysChanged()
          safe(() => {
            if (more) child.setAttributes(more)
            child.end(wall(endOptions.endedAt))
          })
        },
      }
      open.add(step)
      openStepOrder.push({ name: stepName, step })
      openJourneysChanged()
      return step
    },
    set(more) {
      if (!ended)
        safe(() => {
          if (more["game.index"] !== undefined) {
            record.gameIndex = String(more["game.index"])
            linkRecoveredGame(record.gameIndex)
            openJourneysChanged()
          }
          root.setAttributes(more)
        })
    },
    markSad(reason) {
      if (!ended)
        safe(() => {
          record.sadReason = reason
          root.setAttributes({ "journey.sad": "true", "journey.sad_reason": reason })
          openJourneysChanged()
        })
    },
    end(outcome, more, endOptions) {
      finish(outcome, more, endOptions)
    },
  }
  const finish = (outcome: string, more?: Attrs, endOptions: EndOptions = {}) => {
      if (ended) return
      openJourneys.delete(interrupt)
      for (const step of [...open]) step.end({ "step.outcome": "cut" }, endOptions)
      ended = true
      openJourneyRecords.delete(journey)
      openJourneysChanged()
      safe(() => {
        root.setAttributes({ ...(more ?? {}), ...clockAttrs("end", name, wall(endOptions.endedAt)), "journey.outcome": outcome })
        root.end(wall(endOptions.endedAt))
      })
  }
  const interrupt = (cause: InterruptCause) =>
    // not sad: a plain app close is not a failure, and an earlier sad reason
    // (app-hidden, a TURN reason) stays as it was
    finish(INTERRUPTED_OUTCOME, {
      "journey.interrupted_by": cause,
      "journey.interrupted_step": lastStep,
      "journey.interrupted_after_ms": String(Math.max(0, Date.now() - began)),
    })
  if (!options.ownsLifecycle) openJourneys.add(interrupt)
  roots.set(journey, root)
  openJourneyRecords.set(journey, record)
  openJourneysChanged()
  return journey
}
