// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * TEST HELPER: a recording fake of the telemetry doorway, for the tests of
 * the modules that call it (game-source, permission-pass, camera, the game
 * trace). It keeps the real rules that matter to a caller: a step or a
 * journey does nothing once ended, and `journey.expected` follows
 * `isExpected`. Imported by tests only.
 */
import { connectionAttrs } from "./device"
import { isExpected, markExpected } from "./failure-policy"
import type { FailureDetails, FailureKind } from "./failures"
import type { GameLogRequest } from "./game-log"
import type { Attrs, EndOptions, Journey, JourneyName, JourneyOptions, OutcomeOf, Step, StepOptions } from "./journeys"
import type { HealCohortEvent, LinkFailure } from "../webrtc/heal-cohort"
import type { HealEpisodeEvent } from "../webrtc/heal"
import type { CameraRestoreEvent } from "./camera-restore"
import type { HostRetry } from "./index"

export interface RecordedStep {
  name: string
  attrs: Attrs
  startedAt?: number
  ended: boolean
  endAttrs?: Attrs
  endedAt?: number
}
export interface RecordedJourney {
  name: JourneyName
  attrs: Attrs
  options: JourneyOptions
  steps: RecordedStep[]
  sad: string[]
  outcome?: string
  endAttrs?: Attrs
  ended: boolean
  handle: Journey
}
export interface RecordedFailure {
  kind: FailureKind
  details: FailureDetails
  journey?: JourneyName
  expected: boolean
}
export type GameLogRequestLike = GameLogRequest

export interface RecordedMetric {
  type: "distribution" | "gauge" | "count"
  name: string
  value: number
  unit?: string
  attrs: Record<string, string>
}

export interface RecordedSignupBroadcast {
  account: string
  gameIndex: number | null
  attempt: number
  route: string
}

export interface RecordedAwayPeriod {
  event: {
    reason: string
    return: string
    lastAttempt: string
    attempts: number
    offerer: string
    offererRole?: string
    ms: number
  }
  attrs: Record<string, string>
}

export interface RecordedHealEpisode {
  event: HealEpisodeEvent
  attrs: Record<string, string>
}

export const recorded = {
  metrics: [] as RecordedMetric[],
  /** flushMetrics() calls */
  metricFlushes: 0,
  journeys: [] as RecordedJourney[],
  failures: [] as RecordedFailure[],
  player: [] as Array<[string | null | undefined, string | null | undefined]>,
  gameIndex: [] as Array<number | null>,
  signupBroadcasts: [] as RecordedSignupBroadcast[],
  previousSessionEnds: [] as Array<{ classification: string }>,
  gameLogs: [] as GameLogRequestLike[],
  noVideoChoiceLogs: [] as Array<{ choice: "default-notperson" | "flipped-person"; everFlipped: boolean }>,
  healCohorts: [] as HealCohortEvent[],
  linkFailures: [] as Array<{ event: LinkFailure; attrs: Record<string, string> }>,
  awayPeriods: [] as RecordedAwayPeriod[],
  healEpisodes: [] as RecordedHealEpisode[],
  cameraRestores: [] as CameraRestoreEvent[],
  reminderAsks: [] as Array<{ outcome: string; error?: string }>,
  hostRetries: [] as HostRetry[],
}

export function resetRecorded(): void {
  recorded.metrics.length = 0
  recorded.metricFlushes = 0
  recorded.journeys.length = 0
  recorded.failures.length = 0
  recorded.player.length = 0
  recorded.gameIndex.length = 0
  recorded.signupBroadcasts.length = 0
  recorded.previousSessionEnds.length = 0
  recorded.gameLogs.length = 0
  recorded.noVideoChoiceLogs.length = 0
  recorded.healCohorts.length = 0
  recorded.linkFailures.length = 0
  recorded.awayPeriods.length = 0
  recorded.healEpisodes.length = 0
  recorded.cameraRestores.length = 0
  recorded.reminderAsks.length = 0
  recorded.hostRetries.length = 0
}

export function journeysNamed(name: JourneyName): RecordedJourney[] {
  return recorded.journeys.filter((journey) => journey.name === name)
}

const noopStep: Step = { ended: true, set() {}, end() {} }

function fakeJourney<N extends JourneyName>(name: N, attrs: Attrs = {}, options: JourneyOptions = {}): Journey<N> {
  const index = recorded.journeys.length
  const record = { name, attrs: { ...attrs }, options, steps: [], sad: [], ended: false } as unknown as RecordedJourney
  const handle: Journey<N> = {
    name,
    get ended() {
      return record.ended
    },
    trace: { traceId: `trace-${index}`, spanId: `span-${index}` },
    step(stepName: string, stepAttrs: Attrs = {}, stepOptions: StepOptions = {}): Step {
      if (record.ended) return noopStep
      const step: RecordedStep = { name: stepName, attrs: { ...stepAttrs }, startedAt: stepOptions.startedAt, ended: false }
      record.steps.push(step)
      return {
        get ended() {
          return step.ended
        },
        set(more: Attrs) {
          if (!step.ended) Object.assign(step.attrs, more)
        },
        end(more?: Attrs, endOptions: EndOptions = {}) {
          if (step.ended) return
          step.ended = true
          step.endAttrs = more ?? {}
          step.endedAt = endOptions.endedAt
        },
      }
    },
    set(more: Attrs) {
      if (!record.ended) Object.assign(record.attrs, more)
    },
    markSad(reason: string) {
      if (!record.ended) record.sad.push(reason)
    },
    end(outcome: OutcomeOf<N>, more?: Attrs) {
      if (record.ended) return
      for (const step of record.steps) if (!step.ended) Object.assign(step, { ended: true, endAttrs: { "step.outcome": "cut" } })
      record.ended = true
      record.outcome = outcome
      record.endAttrs = more ?? {}
    },
  }
  record.handle = handle as unknown as Journey
  recorded.journeys.push(record)
  return handle
}

export function fakeTelemetryModule() {
  return {
    startTelemetry: () => {},
    telemetryLive: () => true,
    startJourney: fakeJourney,
    recoverInterruptedJourneys: () => 0,
    reportFailure: (kind: FailureKind, details: FailureDetails, journey?: Journey) => {
      const expected = isExpected(kind, details)
      markExpected(journey, expected)
      recorded.failures.push({ kind, details, journey: journey?.name, expected })
    },
    setPlayer: (address: string | null | undefined, name?: string | null) => {
      recorded.player.push([address, name])
    },
    setGameIndex: (gameIndex: number | null) => recorded.gameIndex.push(gameIndex),
    signupBroadcast: (account: string, attempt: number, route: string, signupGameIndex: number | null) => {
      recorded.signupBroadcasts.push({ account, gameIndex: signupGameIndex, attempt, route })
    },
    previousSessionEnd: (data: { classification: string }) => recorded.previousSessionEnds.push({ ...data }),
    pageResourceSample: () => {},
    cameraTrail: () => {},
    cameraNoFrames: () => {},
    chainHealthRecord: () => {},
    storageSlowRecord: () => {},
    hostRetryRecord: (data: HostRetry) => recorded.hostRetries.push(data),
    pageLifecycleRecord: () => {},
    reminderAskRecord: (outcome: string, error?: string) => recorded.reminderAsks.push({ outcome, ...(error ? { error } : {}) }),
    recordDistribution: (name: string, value: number, unit: string, attrs: Record<string, string>) => {
      recorded.metrics.push({ type: "distribution", name, value, unit, attrs: { ...attrs } })
    },
    recordGauge: (name: string, value: number, unit: string, attrs: Record<string, string>) => {
      recorded.metrics.push({ type: "gauge", name, value, unit, attrs: { ...attrs } })
    },
    recordCount: (name: string, value: number, attrs: Record<string, string>) => {
      recorded.metrics.push({ type: "count", name, value, attrs: { ...attrs } })
    },
    connectionAttrs, // the real one: pure over navigator.connection
    flushMetrics: () => {
      recorded.metricFlushes += 1
    },
    sendGameLog: async (request: GameLogRequestLike) => {
      recorded.gameLogs.push(request)
      return true
    },
    reportNoVideoChoice: (choice: "default-notperson" | "flipped-person", everFlipped: boolean) => {
      recorded.noVideoChoiceLogs.push({ choice, everFlipped })
    },
    // field by field: the event game-trace hands over still carries its RtcEvent `kind`
    reportHealCohort: (event: HealCohortEvent) => recorded.healCohorts.push({
      size: event.size,
      windowMs: event.windowMs,
      relayProtocol: event.relayProtocol,
      turnEndpointHost: event.turnEndpointHost,
      failKind: event.failKind,
      quietMs: [...event.quietMs],
      recoveryMs: [...event.recoveryMs],
      unrecovered: event.unrecovered,
      ...(event.pageHidden !== undefined ? { pageHidden: event.pageHidden } : {}),
      ...(event.sinceNetChangeMs !== undefined ? { sinceNetChangeMs: event.sinceNetChangeMs } : {}),
    }),
    reportLinkFailed: (event: LinkFailure, attrs: Record<string, string>) => {
      // what the real report reads: the failure facts, never the RtcEvent's own `kind`
      const facts = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "kind")) as unknown as LinkFailure
      recorded.linkFailures.push({ event: facts, attrs: { ...attrs } })
    },
    reportAwayPeriod: (event: RecordedAwayPeriod["event"], attrs: Record<string, string>) => {
      recorded.awayPeriods.push({ event: { ...event }, attrs: { ...attrs } })
    },
    reportHealEpisode: (event: HealEpisodeEvent, attrs: Record<string, string>) => {
      recorded.healEpisodes.push({ event: { ...event }, attrs: { ...attrs } })
    },
    reportCameraRestore: (event: CameraRestoreEvent) => recorded.cameraRestores.push({ ...event }),
  }
}

/** the substrings Sentry's scrubbing may blank (lib/journeys/mask-text.ts) — no literal of ours may contain one */
export const MASKED = ["auth", "secret", "credential", "password"] as const

export function isMaskSafe(text: string): boolean {
  const lower = text.toLowerCase()
  return !MASKED.some((word) => lower.includes(word))
}
