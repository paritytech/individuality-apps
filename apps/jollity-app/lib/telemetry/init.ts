// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * STARTING SENTRY — the only file that calls `Sentry.init`.
 *
 * lib/telemetry is the ONE importer of @sentry/react, as lib/host is for the
 * host SDK. This file owns the DSN, the release, the environment, the tags on
 * every event, the page context, and the retrying transport queue. Slow,
 * failed, rate-limited and timed-out sends never close telemetry: queue.ts
 * retries them with backoff and holds offline work until `online`. Metrics
 * use the same lane as events and are displaced first only at QUEUE_CAP.
 *
 * At most REPEAT_CAP events of one fingerprint (or one exception type and
 * message) per page session, since Dedupe is off.
 *
 * `traceLifecycle: "static"`: @sentry/react 11 streams v2 span items by
 * default; journeys are sent as transactions instead, so their attributes sit
 * in `contexts.trace.data`, where Sentry's trace queries read them.
 *
 * No scrubbing but one: anything shaped like a 12-word recovery phrase is
 * redacted from messages, exceptions, breadcrumbs (at the devLog sink), extras, tags and span
 * data (lib/debug/scrub.ts).
 *
 * GAME LOGS LEAVE AS LOG ITEMS: sendLogEnvelope is
 * the one confirmed log sender. It packs records into keepalive-sized
 * envelopes, pushes them through the same queue, and answers true only when
 * every envelope was accepted without a log-category limit. The queue's
 * barrier is per lane: "log" for log envelopes, "event" for everything else.
 */
import * as Sentry from "@sentry/react"
import type { BrowserOptions, Event } from "@sentry/react"
import { APP_VERSION, LOG_PRODUCT } from "../debug/flag"
import { scrubMnemonic } from "../debug/scrub"
import { SESSION_ID } from "../debug/session-id"
import { hostPortParked } from "../host/container"
import { collectDevice, connectionSnapshot, connectionTags, deviceContext, deviceTags, normaliseGpu, readGpu, watchConnection } from "./device"
import { detectHostKind, environmentFor, ingestHost, pageOrigin, pickDsn, type HostKind } from "./environment"
import { installBreadcrumbSink } from "./breadcrumbs"
import { interruptOpenJourneys, resetJourneysForTests } from "./journeys"
import { deliveryHealthObserver, flushDeliveryHealthWrites, resetDeliveryHealthForTests } from "./delivery-health"
import { createQueue, type DeliveryQueue, type QueueLanes, type RateLimitDeadlineStore, type RateLimitInfo, type SendAnswer } from "./queue"
import { devLog } from "../debug/log-store"
import { invalidateScopeTags, setScopeTags } from "./scope-tags"
import { whenIdle } from "./util"
import { MEDIA_CAP_TAG_KEYS, probeMediaCapabilities } from "./media-caps"
import { resetClockForTests } from "./clock"
import { isLogEnvelope, packEnvelopes, withAttributes, type LogRecord } from "./log-envelope"
import { hostTelemetryTags, readHostTelemetryContext } from "./host-context"

export type TransportFactory = NonNullable<BrowserOptions["transport"]>
export type Envelope = Parameters<ReturnType<TransportFactory>["send"]>[0]

export interface TelemetryConfig {
  dsn: string
  release: string
  product: string
  /** NEXT_PUBLIC_SENTRY_TAG: sent as the `test.tag` tag (and Log attribute)
   *  so scripted runs can be filtered out; "" sends none. It changes nothing
   *  else. */
  testTag: string
  hostname: string
  protocol: string
  userAgent: string
  inContainer: boolean
  maxTouchPoints: number
  viewport: string
  language: string
  sessionId: string
  /** tests: replaces the fetch transport */
  makeTransport?: TransportFactory
  /** tests: no default integrations */
  bare?: boolean
}

/** every tag key the app sets — the masking test reads this */
export const TAG_KEYS = [
  "product",
  "host.kind",
  "session.id",
  "env.source",
  "test.tag",
  "game.index",
  "account",
  "signup.attempt",
  "signup.route",
  "release",
  "failure.kind",
  "build.stale",
  "build.check",
  "failure.reason",
  "journey.expected",
  "game_log.late",
  "game_log.stage",
  "game_log.checkpoint",
  "game_log.seq",
  "game_log.storage",
  "telemetry.health_late",
  "device.os",
  "device.os_version",
  "device.model",
  "device.gpu",
  "device.cores",
  "device.memory",
  "device.engine",
  "device.engine_version",
  "host.app",
  "host.app_version",
  "host.session_id",
  "host.native_app_version",
  "host.app_build",
  "host.app_variant",
  "host.source_commit",
  "truapi.host_version",
  "truapi.core_version",
  "truapi.codec_version",
  "truapi.schema_version",
  "previous.end",
  "previous.visibility",
  "previous.in_game",
  "previous.pagehide",
  "previous.pagehide_persisted",
  "previous.freeze",
  "previous.visibility_changed",
  "previous.screen",
  "previous.game",
  "previous.turn",
  "net.type",
  "net.effective",
  "lowpower",
  "lowpower.reason",
  "probe",
  ...MEDIA_CAP_TAG_KEYS,
  "rtc.sps_tap",
] as const

let started = false
let removeBreadcrumbs: (() => void) | null = null
let removeOnline: (() => void) | null = null
let removePagehide: (() => void) | null = null
let removeConnection: (() => void) | null = null
let cancelGpu: (() => void) | null = null
/** the GPU read waits this long where there is no requestIdleCallback (Safari) */
const GPU_READ_FALLBACK_MS = 3000
/** bumped by a reset, so a device profile that lands late is dropped */
let generation = 0
/** The barrier's lanes. */
export const EVENT_LANE = "event"
export const LOG_LANE = "log"
const ENVELOPE_LANES: QueueLanes<Envelope> = {
  names: [EVENT_LANE, LOG_LANE],
  of: (envelope) => (isLogEnvelope(envelope) ? LOG_LANE : EVENT_LANE),
}
const newQueue = (rateLimitStore?: RateLimitDeadlineStore) =>
  createQueue<Envelope>({ observer: deliveryHealthObserver, ...(rateLimitStore ? { rateLimitStore } : {}), lanes: ENVELOPE_LANES })
let queue: DeliveryQueue<Envelope> = newQueue()
/** deliveries somebody is waiting on, by event id */
const waiters = new Map<string, (settled: Promise<boolean>) => void>()
/** One promise per event id while its envelope is queued, sending or in the
 * uncertain-follow window. A repeated durable chunk attaches to this promise
 * instead of consuming another queue slot. */
const pendingEventIds = new Map<string, Promise<boolean>>()
/** One promise per log item key while any of its envelopes is unsettled. */
const pendingLogKeys = new Map<string, Promise<boolean>>()
/** Which item key an in-flight log envelope belongs to. */
const logEnvelopeKeys = new WeakMap<object, string>()
/** Keys Sentry refused for good with a 413. */
const rejectedLogKeys = new Set<string>()
/** Attributes every log record shares, derived from the started config. */
let logShared: Record<string, string | undefined> = {}

const safe = (work: () => void) => {
  try {
    work()
  } catch {
    /* telemetry never breaks the app */
  }
}

const DEFAULT_RATE_LIMIT_MS = 60_000
/** the event lane keeps the key every earlier release wrote */
const RATE_LIMIT_DEADLINE_KEY = "jollity.telemetry.rate-limit-until.v1"
const LOG_RATE_LIMIT_DEADLINE_KEY = "jollity.telemetry.rate-limit-until.log.v1"
const deadlineKey = (lane: string): string => (lane === LOG_LANE ? LOG_RATE_LIMIT_DEADLINE_KEY : RATE_LIMIT_DEADLINE_KEY)
/** The longest deadline written to (or trusted from) storage. The in-session
 *  barrier honors the server's full value, because the SDK's own in-memory
 *  limiter does too; only what outlives the page is capped, so a huge or
 *  hostile Retry-After cannot stall telemetry for hours across reloads. */
export const MAX_PERSISTED_RATE_LIMIT_MS = 60 * 60_000

const rateLimitStore: RateLimitDeadlineStore = {
  load: (lane) => {
    try {
      const value = Number(globalThis.localStorage?.getItem(deadlineKey(lane)))
      if (!Number.isFinite(value) || value <= 0) return 0
      const cap = Date.now() + MAX_PERSISTED_RATE_LIMIT_MS
      if (value <= cap) return value
      // re-checked on every open: rewrite it, so the next open reads a sane one
      globalThis.localStorage?.setItem(deadlineKey(lane), String(cap))
      return cap
    } catch {
      return 0
    }
  },
  save: (until, lane) => {
    try {
      globalThis.localStorage?.setItem(deadlineKey(lane), String(Math.min(until, Date.now() + MAX_PERSISTED_RATE_LIMIT_MS)))
    } catch {
      /* telemetry persistence never breaks the app */
    }
  },
}

type TransportResponse = { statusCode?: number; headers?: Record<string, string | null> }

/** x-sentry-rate-limits, parsed exactly as @sentry/core's updateRateLimits
 *  does: an unparseable delay is sixty seconds, and no categories means all. */
function sentryLimits(response: TransportResponse | undefined): Array<{ ms: number; categories: string[]; scope: string; reason: string }> | null {
  const header = response?.headers?.["x-sentry-rate-limits"]
  if (!header) return null
  return header.trim().split(",").map((limit) => {
    const [retryAfter = "", categories = "", scope = "", reason = ""] = limit.split(":", 5)
    const seconds = parseInt(retryAfter, 10)
    return { ms: (Number.isNaN(seconds) ? 60 : seconds) * 1000, categories: categories ? categories.split(";") : [], scope, reason }
  })
}

const MAX_RAW_HEADER = 200
const seenRateLimits = new Set<string>()

/** What the server said about a limited send. Never throws: a malformed
 *  header only yields entries with empty scope and reason. */
function rateLimitInfo(kind: RateLimitInfo["kind"], response: TransportResponse | undefined): RateLimitInfo {
  const raw = response?.headers?.["x-sentry-rate-limits"]
  const entries = (sentryLimits(response) ?? []).map(({ categories, scope, reason }) => ({ categories, scope, reason }))
  return { kind, ...(raw ? { header: raw.trim().slice(0, MAX_RAW_HEADER) } : {}), entries }
}

/** One warn line per distinct scope/reason/categories seen in a session. */
function logFirstRateLimit(info: RateLimitInfo): void {
  for (const entry of info.entries) {
    const key = `${entry.scope}:${entry.reason}:${entry.categories.join(";")}`
    if (seenRateLimits.has(key)) continue
    seenRateLimits.add(key)
    devLog("telemetry", `Sentry rate limit (${info.kind}): ${key}`, { header: info.header }, "warn")
  }
}

function rateLimitDelay(response: TransportResponse | undefined): number {
  const longest = Math.max(0, ...(sentryLimits(response) ?? []).map((limit) => limit.ms))
  // A zero delay would retry back to back and burn the retry budget at once.
  if (longest > 0) return longest
  const retry = response?.headers?.["retry-after"]
  if (retry !== undefined && retry !== null) {
    const seconds = Number(retry)
    if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : DEFAULT_RATE_LIMIT_MS
    const date = Date.parse(retry)
    if (Number.isFinite(date)) {
      const delay = date - Date.now()
      return delay > 0 ? delay : DEFAULT_RATE_LIMIT_MS
    }
  }
  return DEFAULT_RATE_LIMIT_MS
}

const hasRateLimitHeader = (response: TransportResponse | undefined): boolean =>
  response?.headers?.["x-sentry-rate-limits"] != null || response?.headers?.["retry-after"] != null

/** Relay limits attachments by bytes (attachment) and by count (attachment_item). */
const ATTACHMENT_CATEGORIES = new Set(["attachment", "attachment_item"])
/** Relay limits logs by count (log_item) and by bytes (log_byte). */
const LOG_CATEGORIES = new Set(["log_item", "log_byte"])
/** Relay accepts an envelope and drops the items of a limited category, then
 *  names the limit on the 2xx. For an envelope that carried an attachment or
 *  log items, that 2xx is the loss path. */
const categoryDropped = (response: TransportResponse | undefined, categories: ReadonlySet<string>): boolean =>
  (sentryLimits(response) ?? []).some((limit) =>
    limit.ms > 0 && (limit.categories.length === 0 || limit.categories.some((category) => categories.has(category))))

/** Each header entry keeps its own duration. A category-less entry holds both
 * lanes; log categories hold the log lane; every other category holds the
 * event lane. A bare Retry-After also holds both lanes. */
function limitLanes(response: TransportResponse | undefined): Map<string, number> {
  const limits = sentryLimits(response)
  const lanes = new Map<string, number>()
  const hold = (lane: string, delayMs: number) => {
    lanes.set(lane, Math.max(lanes.get(lane) ?? 0, delayMs))
  }
  if (limits) {
    for (const limit of limits) {
      if (limit.categories.length === 0) {
        hold(EVENT_LANE, limit.ms)
        hold(LOG_LANE, limit.ms)
        continue
      }
      for (const category of limit.categories) {
        hold(LOG_CATEGORIES.has(category) ? LOG_LANE : EVENT_LANE, limit.ms)
      }
    }
  } else if (response?.headers?.["retry-after"] != null) {
    const delayMs = rateLimitDelay(response)
    hold(EVENT_LANE, delayMs)
    hold(LOG_LANE, delayMs)
  }
  return lanes
}

type EnvelopeKind = "attachment" | "log" | "plain"

/** Keep retryAfterMs aligned with this envelope while laneDelays gives the
 * queue every independently timed deadline from the same response. */
function answerLimit(response: TransportResponse | undefined, kind: EnvelopeKind, limits: ReadonlyMap<string, number>) {
  const lane = kind === "log" ? LOG_LANE : EVENT_LANE
  const laneDelays = limits.size > 0 ? { laneDelays: Object.fromEntries(limits) } : {}
  const own = limits.get(lane)
  if (own !== undefined) return { retryAfterMs: own, lanes: [lane], ...laneDelays }
  const longest = [...limits].sort((left, right) => right[1] - left[1])[0]
  return longest
    ? { retryAfterMs: longest[1], lanes: [longest[0]], ...laneDelays }
    : { retryAfterMs: rateLimitDelay(response) }
}

function answered(response: TransportResponse | undefined, kind: EnvelopeKind, limits = limitLanes(response)): SendAnswer {
  // No status is the SDK's own local rate-limit drop. Its default limiter is
  // 60 seconds, so retrying on the ordinary 1–15 s cadence would exhaust the
  // item without making another network request. It dropped this envelope
  // for its own category, so only this envelope's lane waits.
  const code = response?.statusCode
  if (code === undefined) {
    return {
      failed: "429",
      retryAfterMs: rateLimitDelay(response),
      locallyRateLimited: true,
      rateLimit: rateLimitInfo("local_drop", response),
      lanes: [kind === "log" ? LOG_LANE : EVENT_LANE],
    }
  }
  if (code >= 200 && code < 300) {
    // Sentry kept the event but dropped the attachment. Resending this
    // envelope repeats an accepted event id, which Sentry may discard as a
    // duplicate, so settle it undelivered now: the outbox (or the late
    // upload) keeps the evidence and sends it again under a fresh id.
    if ((kind === "attachment" && categoryDropped(response, ATTACHMENT_CATEGORIES)) ||
      (kind === "log" && categoryDropped(response, LOG_CATEGORIES))) {
      return {
        failed: "429",
        ...answerLimit(response, kind, limits),
        statusCode: code,
        final: true,
        rateLimit: rateLimitInfo("limited_2xx", response),
      }
    }
    // Sentry can establish a per-category limit on a successful response.
    // Advance our stricter global barrier before another envelope reaches the
    // SDK, otherwise it may strip an attachment and return 200 for the event
    // alone, causing durable game-log evidence to be deleted as delivered.
    return hasRateLimitHeader(response)
      ? {
          delivered: true,
          ...answerLimit(response, kind, limits),
          ...(response?.headers?.["x-sentry-rate-limits"] ? { rateLimit: rateLimitInfo("limited_2xx", response) } : {}),
        }
      : true
  }
  if (code === 429) {
    return {
      failed: "429",
      ...answerLimit(response, kind, limits),
      statusCode: code,
      rateLimit: rateLimitInfo("server_429", response),
    }
  }
  // Resending the same oversized log envelope cannot succeed.
  if (code === 413 && kind === "log") return { failed: "4xx", statusCode: code, final: true }
  // The SDK honors Retry-After on any status, so the barrier does too; the
  // failure keeps its real class for delivery health.
  const failed = code >= 500 ? "5xx" : "4xx"
  return hasRateLimitHeader(response)
    ? { failed, ...answerLimit(response, kind, limits), statusCode: code }
    : { failed, statusCode: code }
}

/** only an explicit false: a runtime without navigator.onLine is online */
const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false

/** Offline sends wait for this; one listener for the page session. */
function listenForOnline(): (() => void) | null {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return null
  const page = window
  const resume = () => queue.resume()
  page.addEventListener("online", resume)
  return () => page.removeEventListener("online", resume)
}

/** Sentry flushes on visibility-hidden, but page replacement is also exposed
 * directly as pagehide. Its fetch transport already uses keepalive for small
 * envelopes; this hands pending event preparation to the retrying path.
 *
 * The root span of a journey is sent only when it ends, so a phone that
 *  freezes or is killed first loses the whole journey (#279). On pagehide (a
 *  bfcache-persisted one is a pause, not the end) every open journey that has
 *  no owner of its own is ended as interrupted, then everything is flushed
 *  once, after the roots are ended so their envelopes are queued. The fetch
 *  transport's keepalive carries bodies up to about 60 KB; a bigger root may
 *  not leave.
 *
 *  Pagehide only, no timer on hidden: a hidden timer cannot tell a lock that
 *  resumes from a page that is gone (iOS runs an overdue timer on resume
 *  before the visible event, Android keeps timers running), and a wrong guess
 *  marks journeys that succeeded as interrupted. game-trace owns the hidden
 *  grace for join, game and payoff. */
function listenForPagehide(): (() => void) | null {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return null
  const page = window
  const onPagehide = (event: PageTransitionEvent) => {
    if (!event.persisted) interruptOpenJourneys("pagehide")
    queue.flushNow()
    flushDeliveryHealthWrites()
    void Sentry.flush().catch(() => false)
  }
  page.addEventListener("pagehide", onPagehide)
  return () => page.removeEventListener("pagehide", onPagehide)
}

/** The SDK's fetch transport, sent through the PAGE's window.fetch. By default
 *  it lifts a native fetch from a hidden iframe on iOS, which would step round
 *  the host's network rule. */
const pageFetchTransport: TransportFactory = (options) =>
  Sentry.makeFetchTransport(options, (...args) => window.fetch(...args))

/** Only `trace_metric` items: queue pressure displaces these before events. */
export function metricOnly(envelope: Envelope): boolean {
  const items = envelope[1] as unknown as ReadonlyArray<readonly [{ type?: unknown }, unknown]>
  return items.length > 0 && items.every(([header]) => header?.type === "trace_metric")
}

const envelopeHasAttachment = (envelope: Envelope): boolean =>
  (envelope[1] as unknown as ReadonlyArray<readonly [{ type?: unknown }, unknown]>)
    .some(([header]) => header?.type === "attachment")

const envelopeKind = (envelope: Envelope): EnvelopeKind =>
  isLogEnvelope(envelope) ? "log" : envelopeHasAttachment(envelope) ? "attachment" : "plain"

function retryingTransport(inner: TransportFactory): TransportFactory {
  return (options) => {
    const real = inner(options)
    // Guard the wrapper boundary per lane. Sentry's transport filters
    // rate-limited envelope items before sending, so an event+attachment can
    // otherwise become an event-only 200, and its limiter does not protect
    // log_byte. The queue's persisted lane deadline is authoritative.
    queue.setSender(async (envelope) => {
      try {
        const at = Date.now()
        const kind = envelopeKind(envelope)
        const lane = kind === "log" ? LOG_LANE : EVENT_LANE
        const limitedUntil = queue.deadlineOf(lane)
        if (kind !== "plain" && limitedUntil > at) {
          return {
            failed: "429",
            retryAfterMs: limitedUntil - at,
            locallyRateLimited: true,
            rateLimit: { kind: "local_drop", entries: [] },
            lanes: [lane],
          }
        }
        const response = await real.send(envelope)
        const limits = limitLanes(response)
        const answer = answered(response, kind, limits)
        if (answer !== true && answer !== "offline" && answer.rateLimit) logFirstRateLimit(answer.rateLimit)
        const id = envelope[0].event_id
        if (answer !== true && answer !== "offline" && "final" in answer && answer.final) {
          if (kind === "attachment" && typeof id === "string") attachmentDroppedIds.add(id)
          const key = logEnvelopeKeys.get(envelope)
          if (kind === "log" && answer.statusCode === 413 && key !== undefined) {
            rejectedLogKeys.add(key)
            devLog("telemetry", "Sentry refused a game-log envelope as too large; the item is dropped", { key }, "warn")
          }
        }
        return answer
      } catch {
        // offline is not the host: hold it for the window's `online`
        if (isOffline()) return "offline"
        return { failed: "fetch" }
      }
    })
    return {
      send(envelope) {
        const id = envelope[0].event_id
        if (typeof id === "string") {
          const pending = pendingEventIds.get(id)
          if (pending) {
            const waiter = waiters.get(id)
            if (waiter) {
              waiters.delete(id)
              waiter(pending)
            }
            return pending.then(() => ({}))
          }
        }
        const settled = queue.push(envelope, metricOnly(envelope))
        if (typeof id === "string") {
          pendingEventIds.set(id, settled)
          void settled.finally(() => pendingEventIds.delete(id))
          const waiter = waiters.get(id)
          if (waiter) {
            waiters.delete(id)
            waiter(settled)
          }
        }
        return settled.then(() => ({}))
      },
      flush: async (timeout) => queue.size() === 0 && (await real.flush(timeout)),
    }
  }
}

/** Event ids Sentry accepted while dropping their attachment (a proven 2xx
 *  partial acceptance). Recorded before the delivery settles false. */
const attachmentDroppedIds = new Set<string>()

/** True once (it is consumed): Sentry kept this event id without its
 *  attachment, so the owner must resend under a NEW id. A repeat of an
 *  accepted id may be discarded as a duplicate. */
export function takeAttachmentDropped(eventId: string): boolean {
  return attachmentDroppedIds.delete(eventId)
}

/** Hand a game-log item to Sentry Logs. True only once every envelope was
 * accepted without a log-category limit. A repeated unsettled key attaches
 * to the first promise and pushes nothing. Never throws. */
export function sendLogEnvelope(key: string, records: readonly LogRecord[]): Promise<boolean> {
  try {
    if (!started) return Promise.resolve(false)
    const pending = pendingLogKeys.get(key)
    if (pending) return pending
    if (records.length === 0) return Promise.resolve(true)
    const sdk = Sentry.getClient()?.getSdkMetadata()?.sdk
    const envelopes = packEnvelopes(
      records.map((record) => withAttributes(record, logShared)),
      sdk?.name && sdk.version ? { name: sdk.name, version: sdk.version } : undefined,
    )
    const settled = Promise.all(envelopes.map((envelope) => {
      logEnvelopeKeys.set(envelope, key)
      return queue.push(envelope as unknown as Envelope)
    })).then((answers) => answers.every(Boolean))
    pendingLogKeys.set(key, settled)
    void settled.finally(() => {
      if (pendingLogKeys.get(key) === settled) pendingLogKeys.delete(key)
    })
    return settled
  } catch {
    return Promise.resolve(false)
  }
}

/** True once: Sentry refused this item's envelope permanently with a 413. */
export function takeLogRejected(key: string): boolean {
  return rejectedLogKeys.delete(key)
}

/** Wait for the envelope of the event captured with `{ event_id: eventId }`.
 *  Call it BEFORE the capture. True only if the real transport took it. */
export function expectDelivery(eventId: string, timeoutMs: number): Promise<boolean> {
  const arrival = new Promise<boolean>((resolve) => {
    waiters.set(eventId, (settled) => {
      void settled.then(resolve)
    })
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  return Promise.race([arrival, deadline]).finally(() => {
    clearTimeout(timer)
    waiters.delete(eventId)
  })
}

/** Strings of a record, and of the records one level down. */
function scrubRecord(record: Record<string, unknown> | undefined, depth = 1): void {
  if (!record) return
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") record[key] = scrubMnemonic(value)
    else if (depth > 0 && value && typeof value === "object" && !Array.isArray(value)) {
      scrubRecord(value as Record<string, unknown>, depth - 1)
    }
  }
}

/** The mnemonic guard over every text field an event or transaction carries.
 *  Breadcrumbs are not walked: the devLog sink hands them over already scrubbed. */
function scrubEvent<E extends Event>(event: E): E {
  if (event.message) event.message = scrubMnemonic(event.message)
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubMnemonic(exception.value)
  }
  scrubRecord(event.extra)
  scrubRecord(event.tags as Record<string, unknown> | undefined)
  for (const context of Object.values(event.contexts ?? {})) {
    scrubRecord(context as Record<string, unknown> | undefined)
  }
  for (const span of event.spans ?? []) scrubRecord(span.data as Record<string, unknown> | undefined)
  return event
}

/** Events of one kind a page session sends: Dedupe is off (two peers failing
 *  the same way are two events), so without a cap an error that fires every
 *  block would be one event per occurrence, each a host-network request. */
const REPEAT_CAP = 5
const repeats = new Map<string, number>()

/** What makes two events "the same": the fingerprint we set, else the first
 *  exception's type and message (the SDK's own captures), else the message.
 *  Info events (the game logs) are never capped. */
function repeatKey(event: Event): string | null {
  if (event.level === "info" || event.level === "log" || event.level === "debug") return null
  if (event.fingerprint?.length) return `f:${event.fingerprint.join("\u0000")}`
  const exception = event.exception?.values?.[0]
  if (exception) return `e:${exception.type ?? ""}\u0000${exception.value ?? ""}`
  return event.message ? `m:${event.message}` : null
}

function underRepeatCap(event: Event): boolean {
  const key = repeatKey(event)
  if (key === null) return true
  const seen = repeats.get(key) ?? 0
  if (seen >= REPEAT_CAP) return false
  repeats.set(key, seen + 1)
  return true
}

const RESOURCE_SPAN_OPS = ["resource.script", "resource.css", "resource.img", "resource.link", "resource.other"]

export function sentryOptions(config: TelemetryConfig): BrowserOptions {
  const { environment } = environmentFor(config)
  const base: BrowserOptions = {
    dsn: config.dsn,
    release: config.release,
    environment,
    tracesSampleRate: 1,
    traceLifecycle: "static",
    // SDK client reports are redundant with telemetry.health and would add
    // more pressure to the same transport.
    sendClientReports: false,
    maxBreadcrumbs: 100,
    transport: retryingTransport(config.makeTransport ?? pageFetchTransport),
    beforeSend: (event) => {
      if (!underRepeatCap(event)) return null
      // withScope().clearBreadcrumbs() cannot remove breadcrumbs inherited
      // from Sentry 11's isolation scope. Game-log envelopes (chunks and full
      // parts) must stay below the keepalive budget, so strip them at the
      // final event boundary too (the outbox's scope processor is the first).
      if (event.message === "game-log-chunk" || event.message === "game-log") event.breadcrumbs = []
      return scrubEvent(event)
    },
    beforeSendTransaction: (event) => scrubEvent(event),
  }
  if (config.bare) return { ...base, defaultIntegrations: false, integrations: [] }
  return {
    ...base,
    integrations: (defaults) => [
      // Dedupe would drop the second of two identical failures (two peers
      // failing the same way); Console would double the devLog breadcrumbs
      // with the rtc console lines; the default Breadcrumbs integration is
      // replaced by one with the browser's own dom/fetch/xhr/history crumbs off.
      // Breadcrumbs are devLog lines only (lib/telemetry/breadcrumbs.ts).
      // (@sentry/react 11 ships console breadcrumbs as their own default
      // integration, so dropping it is enough.)
      ...defaults.filter((integration) => !["Dedupe", "Console", "Breadcrumbs"].includes(integration.name)),
      Sentry.breadcrumbsIntegration({ dom: false, fetch: false, history: false, xhr: false }),
      // the page load only: journeys are started by hand, and resource, long
      // task and long animation frame spans would be noise inside them
      Sentry.browserTracingIntegration({
        instrumentNavigation: false,
        enableLongTask: false,
        enableLongAnimationFrame: false,
        // INP spans go out as standalone envelopes, one per slow tap, each a
        // transport request of its own
        enableInp: false,
        ignoreResourceSpans: RESOURCE_SPAN_OPS,
      }),
    ],
  }
}

export function startTelemetryWith(config: TelemetryConfig): boolean {
  if (started) return true
  if (!config.dsn || ingestHost(config.dsn) === null) return false
  queue = newQueue(rateLimitStore)
  Sentry.init(sentryOptions(config))
  started = true
  logShared = {
    "sentry.release": config.release,
    "sentry.environment": environmentFor(config).environment,
    ...(config.testTag ? { "test.tag": config.testTag } : {}),
  }
  removeBreadcrumbs = installBreadcrumbSink()
  safe(() => {
    removeOnline = listenForOnline()
    removePagehide = listenForPagehide()
  })
  const { source } = environmentFor(config)
  const hostTelemetry = readHostTelemetryContext()
  safe(() =>
    setScopeTags({
      product: config.product,
      "host.kind": detectHostKind(config),
      "session.id": config.sessionId,
      "env.source": source,
      ...(config.testTag ? { "test.tag": config.testTag } : {}),
      ...hostTelemetryTags(hostTelemetry),
    }),
  )
  safe(() =>
    Sentry.setContext("page", {
      user_agent: config.userAgent,
      origin: pageOrigin(config),
      viewport: config.viewport,
      language: config.language,
    }),
  )
  if (hostTelemetry) safe(() => Sentry.setContext("native_host", { ...hostTelemetry }))
  safe(() => {
    setScopeTags(connectionTags(connectionSnapshot()))
    removeConnection = watchConnection((snapshot) => safe(() => setScopeTags(connectionTags(snapshot))))
  })
  // The device is read in the background: no send waits for it, and an event
  // captured before it lands simply lacks the device tags.
  const startedIn = generation
  void collectDevice({ userAgent: config.userAgent })
    .then((profile) => {
      if (startedIn !== generation) return
      safe(() => {
        setScopeTags(deviceTags(profile))
        Sentry.setContext("device_profile", { ...profile })
        Sentry.setContext("device", deviceContext(profile))
      })
    })
    .catch(() => {})
  // The GPU costs a WebGL context: read it once the page is idle, not while
  // the app boots.
  cancelGpu = whenIdle(() => {
    cancelGpu = null
    if (startedIn !== generation) return
    // what the device says it can encode and decode for WebRTC (#627), once a session
    void probeMediaCapabilities()
      .then(({ tags, context }) => {
        if (startedIn !== generation) return
        safe(() => {
          setScopeTags(tags)
          Sentry.setContext("media_caps", context)
        })
      })
      .catch(() => {})
    const renderer = readGpu()
    const family = normaliseGpu(renderer)
    if (!family) return
    safe(() => {
      setScopeTags({ "device.gpu": family })
      Sentry.setContext("device_gpu", { renderer, family })
    })
  }, GPU_READ_FALLBACK_MS)
  return true
}

export function telemetryStarted(): boolean {
  return started
}

/** Settles after every envelope already handed to the retry queue has either
 * delivered or exhausted its retry limit. Offline work waits for `online`. */
export function waitForTelemetryIdle(): Promise<void> {
  return queue.whenIdle()
}

export function setHostKind(kind: HostKind): void {
  safe(() => setScopeTags({ "host.kind": kind }))
}

/** The build's config, or null: no DSN for this page, or no browser.
 *
 *  TWO DSNs CAN BE BAKED: production's (NEXT_PUBLIC_SENTRY_DSN) and a test
 *  project's (NEXT_PUBLIC_SENTRY_DSN_TEST). pickDsn chooses per page from the
 *  served origin alone: a copy served from a developer's machine (environment
 *  `local`) writes to the test project, every hosted origin to production.
 *  The test tag is deliberately not an input: a stale tag in a deploy must
 *  never divert real players. */
export function configFromEnvironment(): TelemetryConfig | null {
  const prod = process.env.NEXT_PUBLIC_SENTRY_DSN ?? ""
  const test = process.env.NEXT_PUBLIC_SENTRY_DSN_TEST ?? ""
  if (typeof window === "undefined") return null
  const config: TelemetryConfig = {
    dsn: prod,
    release: `jollity@${APP_VERSION}`,
    product: LOG_PRODUCT,
    testTag: process.env.NEXT_PUBLIC_SENTRY_TAG ?? "",
    hostname: location.hostname,
    protocol: location.protocol,
    userAgent: navigator.userAgent,
    inContainer: hostPortParked(),
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    language: navigator.language,
    sessionId: SESSION_ID,
  }
  if (!prod && !test) return null
  config.dsn = pickDsn({ prod, test, environment: environmentFor(config).environment })
  return ingestHost(config.dsn) === null ? null : config
}

export async function resetTelemetryForTests(): Promise<void> {
  removeBreadcrumbs?.()
  removeBreadcrumbs = null
  removeOnline?.()
  removeOnline = null
  removePagehide?.()
  removePagehide = null
  resetJourneysForTests()
  removeConnection?.()
  removeConnection = null
  cancelGpu?.()
  cancelGpu = null
  generation++
  await Sentry.close(0).catch(() => false)
  Sentry.getCurrentScope().setClient(undefined)
  // @sentry/react 11's Scope has no clear(): undo, one by one, what
  // startTelemetryWith and the doorway put on the isolation scope (where the
  // Sentry.set* helpers write). Undefined tags are dropped when serialized.
  const scope = Sentry.getIsolationScope()
  scope.setUser(null)
  scope.setContext("page", null)
  scope.setContext("device_profile", null)
  scope.setContext("device", null)
  scope.setContext("device_gpu", null)
  scope.setContext("native_host", null)
  scope.clearBreadcrumbs()
  for (const key of TAG_KEYS) scope.setTag(key, undefined)
  invalidateScopeTags()
  started = false
  queue = newQueue()
  resetDeliveryHealthForTests()
  waiters.clear()
  pendingEventIds.clear()
  pendingLogKeys.clear()
  rejectedLogKeys.clear()
  logShared = {}
  attachmentDroppedIds.clear()
  seenRateLimits.clear()
  repeats.clear()
  try {
    globalThis.localStorage?.removeItem(RATE_LIMIT_DEADLINE_KEY)
    globalThis.localStorage?.removeItem(LOG_RATE_LIMIT_DEADLINE_KEY)
  } catch {
    /* test reset stays best-effort in storage-less environments */
  }
  resetClockForTests()
}
