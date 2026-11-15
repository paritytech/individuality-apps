// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE CHAT WORKER'S TELEMETRY: what the worker does, sent to Sentry straight
 * from the hidden WebView it runs in. No SDK: a POST of an
 * envelope with fetch, the same thing the SDK does, which a probe proved the
 * iOS host lets through (the product is a trusted one, so no permission
 * prompt). Everything is tagged surface "chat", the environment is the baked
 * product name, and the user is the player's account when known.
 *
 *  - FIRE AND FORGET. Nothing here throws and nothing is ever awaited on a
 *    player path. No DSN baked in (__SENTRY_DSN__ empty) makes every call a no-op.
 *  - TEST TRAFFIC TO ITS OWN PROJECT. A second DSN,
 *    __SENTRY_DSN_TEST__ (a test project), is used by a worker built
 *    for a worker served from loopback, or built as `local` when no host can
 *    be read (chatDsnFor); a worker served under any other host keeps the
 *    production DSN whatever the build says, so a hosted origin can never
 *    divert real players to the test project.
 *  - BOUNDED. At most MAX_QUEUED envelopes wait (the oldest is dropped), at most
 *    MAX_IN_FLIGHT are on the wire, each gives up after TIMEOUT_MS, and one
 *    failure fingerprint sends at most MAX_PER_FINGERPRINT times per run (a
 *    counter, MAX_PER_COUNTER, so ratios against chat.start stay right), so a loop
 *    cannot flood Sentry from a phone.
 *  - THE APP'S NAMES. A failure is "<kind>: <reason>" with fingerprint
 *    [kind, reason] and the failure.* tags of lib/telemetry/failures.ts; a
 *    journey is a transaction `journey.<name>` with journey.outcome,
 *    journey.sad, journey.sad_reason, journey.expected as tags; a counter is a
 *    trace_metric point named for the counter.
 *  - PRIVATE. Free text goes through maskSafe, which is copied from
 *    lib/journeys/mask-text.ts (the chat must not import lib/). Errors are
 *    sent as "Name: message", never as the object. Uncaught errors keep only
 *    their first stack frames, enough to name the worker path without sending
 *    an unbounded stack.
 */

import type { TurnPassOutcome } from "./host"

declare const __SENTRY_DSN__: string
declare const __SENTRY_DSN_TEST__: string
declare const __CHAT_RELEASE__: string
declare const __PRODUCT_DOTNS__: string

const MAX_QUEUED = 50
const MAX_IN_FLIGHT = 3
const TIMEOUT_MS = 10_000
const MAX_PER_FINGERPRINT = 5
const MAX_PER_COUNTER = 500
const MAX_TEXT = 300

export interface ParsedDsn {
  url: string
  key: string
  projectId: string
}

/** `https://<key>@<host>/<projectId>` to the envelope URL and the key. Null when unusable. */
export function parseDsn(dsn: string): ParsedDsn | null {
  const m = /^(https?):\/\/([^:@/]+)(?::[^@]*)?@([^/]+)\/(?:(.*)\/)?([^/]+)$/.exec(dsn.trim())
  if (!m) return null
  const [, scheme, key, host, prefix, projectId] = m
  const base = `${scheme}://${host}${prefix ? `/${prefix}` : ""}`
  return { url: `${base}/api/${projectId}/envelope/?sentry_key=${key}&sentry_version=7`, key: key!, projectId: projectId! }
}

/** Copied from lib/journeys/mask-text.ts: Sentry blanks a whole value that contains these words. */
const MASKED_WORDS = /auth|secret|credential|password/gi
export function maskSafe(text: string): string {
  return text.replace(MASKED_WORDS, (word) => `${word.slice(0, 2)}*${word.slice(3)}`)
}

/** An error as text a person can read in an issue: "Name: message", masked and capped. */
export function describeError(error: unknown): string {
  let text: string
  try {
    const e = error as { name?: unknown; message?: unknown } | null
    text = error instanceof Error ? `${e?.name ?? "Error"}: ${e?.message ?? ""}` : String(error)
  } catch {
    text = "unprintable error"
  }
  return maskSafe(text).slice(0, MAX_TEXT)
}

/** Up to five error levels, including host causes, as one masked and bounded value. */
export function describeErrorChain(error: unknown): string {
  const levels: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null && !seen.has(current); depth++) {
    seen.add(current)
    levels.push(describeError(current))
    try {
      current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined
    } catch {
      current = undefined
    }
  }
  return maskSafe(levels.join(" <- ")).slice(0, MAX_TEXT)
}

type Level = "info" | "warning" | "error"
export type Tags = Record<string, string>

export interface TelemetryConfig {
  dsn?: string
  /** the test project's DSN (chatDsnFor picks between the two) */
  testDsn?: string
  product?: string
  /** the served host name, instead of reading location (tests) */
  served?: string
  release?: string
  /** a stand-in for the host's fetch, for tests */
  fetchImpl?: (url: string, init: { method: "POST"; body: string; signal?: unknown }) => Promise<unknown>
  maxPerFingerprint?: number
  maxPerCounter?: number
}

// The worker's lib has no DOM types; the runtime does.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

interface State {
  dsn: ParsedDsn | null
  product: string
  release: string | undefined
  fetchImpl: TelemetryConfig["fetchImpl"] | undefined
  maxPerFingerprint: number
  maxPerCounter: number
  userId: string | undefined
  username: string | undefined
  gameIndex: number | undefined
  hostName: string
  hostVersion: string
  queue: string[]
  inFlight: number
  sent: Map<string, number>
  served: string | undefined
}

const bakedDsn = () => (typeof __SENTRY_DSN__ === "string" ? __SENTRY_DSN__ : "")
const bakedTestDsn = () => (typeof __SENTRY_DSN_TEST__ === "string" ? __SENTRY_DSN_TEST__ : "")
const bakedProduct = () => (typeof __PRODUCT_DOTNS__ === "string" ? __PRODUCT_DOTNS__ : "")
const bakedRelease = () => (typeof __CHAT_RELEASE__ === "string" && __CHAT_RELEASE__ ? __CHAT_RELEASE__ : undefined)

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"])

/** The DSN this worker writes to: the test project's when it is a developer's
 *  copy (served from loopback, or, with no readable host, built as `local`) and
 *  a usable test DSN is baked; production's otherwise, so a build without the
 *  test DSN is unchanged. */
export function chatDsnFor(choice: { served: string | undefined; product: string; prod: string; test: string }): string {
  // The served host is authoritative when it is known: loopback is a developer's
  // copy, any other host (a real worker origin) keeps production whatever the
  // build says. The baked product decides only when no host can be read.
  const host = (choice.served ?? "").trim().toLowerCase()
  const product = choice.product.trim().toLowerCase()
  const isLocal = host ? LOCAL_HOSTS.has(host) : product === "" || product === "local"
  return isLocal && parseDsn(choice.test) ? choice.test : choice.prod
}

function servedHostname(): string | undefined {
  try {
    return (globalThis as Any).location?.hostname
  } catch {
    return undefined
  }
}

function fresh(): State {
  return {
    dsn: parseDsn(chatDsnFor({ served: servedHostname(), product: bakedProduct(), prod: bakedDsn(), test: bakedTestDsn() })),
    product: bakedProduct() || "local",
    release: bakedRelease(),
    fetchImpl: undefined,
    maxPerFingerprint: MAX_PER_FINGERPRINT,
    maxPerCounter: MAX_PER_COUNTER,
    userId: undefined,
    username: undefined,
    gameIndex: undefined,
    hostName: "unknown",
    hostVersion: "version pending",
    queue: [],
    inFlight: 0,
    sent: new Map(),
    served: undefined,
  }
}
let state = fresh()
let activitySequence = 0
let activities: { id: number; name: string }[] = []
let namedHostCalls = new WeakMap<object, string>()

/** For tests and for a build that wants other settings: replaces the baked ones. */
export function configureTelemetry(config: TelemetryConfig): void {
  const product = config.product ?? bakedProduct()
  const served = config.served ?? servedHostname()
  const prod = config.dsn ?? bakedDsn()
  const test = config.testDsn ?? bakedTestDsn()
  state = {
    ...fresh(),
    dsn: parseDsn(chatDsnFor({ served, product, prod, test })),
    ...(config.product !== undefined ? { product: config.product } : {}),
    ...(config.served !== undefined ? { served: config.served } : {}),
    ...(config.release !== undefined ? { release: config.release } : {}),
    fetchImpl: config.fetchImpl,
    maxPerFingerprint: config.maxPerFingerprint ?? MAX_PER_FINGERPRINT,
    maxPerCounter: config.maxPerCounter ?? MAX_PER_COUNTER,
  }
}
export function resetTelemetry(): void {
  state = fresh()
  activitySequence = 0
  activities = []
  namedHostCalls = new WeakMap()
}
export function pendingSends(): { inFlight: number; queued: number } {
  return { inFlight: state.inFlight, queued: state.queue.length }
}

/** The player's account address, once the worker knows it. */
export function setChatUser(address: string | null | undefined): void {
  state.userId = address || undefined
}
/** The player's username, once the worker knows it: sent as user.username beside the id. */
export function setChatUsername(name: string | null | undefined): void {
  state.username = name?.trim() || undefined
}
/** The game the chat is about now, for the game.index tag. */
export function setChatGame(index: number | null | undefined): void {
  state.gameIndex = index === null || index === undefined ? undefined : index
}

/** The native app around the worker, read from truApi system.info(). */
export function setChatHost(info: { name: string; version: string } | null, failed = false): void {
  state.hostName = info?.name || "unknown"
  state.hostVersion = failed ? "version read failed" : info?.version || "host sent no version"
}

/** Whether a host rejection says it could not decode the message frame. */
export function isMalformedFrameError(error: unknown): boolean {
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 6) return false
    if (typeof value === "string") return /malformed[ ._-]*frame/i.test(value)
    if (typeof value !== "object" || value === null || seen.has(value)) return false
    seen.add(value)
    const record = value as Record<string, unknown>
    return ["name", "message", "tag", "type", "reason", "cause", "error", "value"].some((key) => visit(record[key], depth + 1))
  }
  return visit(error, 0)
}

/**
 * Marks concurrent worker work. The most recently started live activity is
 * what an otherwise context-free rejection names.
 */
export function beginChatActivity(name: string): () => void {
  const activity = { id: ++activitySequence, name }
  activities.push(activity)
  return () => {
    activities = activities.filter(({ id }) => id !== activity.id)
  }
}

function currentActivity(): string {
  return activities.at(-1)?.name ?? "idle"
}

/** Attach the doorway call site without replacing the original Error or stack. */
export function nameHostCallError(error: unknown, call: string): unknown {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    namedHostCalls.set(error as object, call)
    return error
  }
  const wrapped = new Error(String(error))
  namedHostCalls.set(wrapped, call)
  return wrapped
}

function namedHostCall(error: unknown): string | undefined {
  return (typeof error === "object" && error !== null) || typeof error === "function"
    ? namedHostCalls.get(error as object)
    : undefined
}

const HOST_REQUEST_ID = /\bhost\s*:\s*(\d+)\b/i
const WIRE_METHOD = /\bwire(?:\s+(?:method|call))?\s*[:#]?\s*([1345])\b/i

export interface RejectionDetails {
  tags: Tags
  context: Record<string, string>
}

/** The diagnostic fields a worker-level rejection can recover without SDK support. */
export function rejectionDetails(reason: unknown): RejectionDetails {
  const described = describeError(reason)
  let errorClass: string = typeof reason
  let stack: string | undefined
  if (reason instanceof Error) {
    errorClass = reason.name || reason.constructor?.name || "Error"
    const frames = typeof reason.stack === "string" ? reason.stack.split("\n").slice(0, 4).join("\n") : ""
    if (frames) stack = frames
  }
  const requestId = HOST_REQUEST_ID.exec(described)?.[1]
  const wireMethod = WIRE_METHOD.exec(described)?.[1]
  const call = namedHostCall(reason)
  return {
    tags: {
      "error.class": errorClass,
      "worker.activity": currentActivity(),
      ...(requestId ? { "host.request_id": requestId } : {}),
      ...(wireMethod ? { "host.wire_method": wireMethod } : {}),
      ...(call ? { "host.call": call } : {}),
    },
    context: {
      error: described,
      ...(stack ? { stack } : {}),
      ...(call ? { host_call: call } : {}),
    },
  }
}

const hex = (length: number) => {
  let id = ""
  for (let i = 0; i < length; i++) id += Math.floor(Math.random() * 16).toString(16)
  return id
}

/**
 * The environment is the SERVED name, not the baked one: a build can be served
 * under another name than it was built for (a staging name, say), and
 * lib/telemetry/environment.ts in the app applies the same rules, which this
 * copies for a worker origin like polkadot://worker.<name>.<tld>.
 * A LOOPBACK HOST IS A DEVELOPER'S COPY, not the baked product: the same rule
 * the app applies (so a build opened from localhost does not land in the
 * production numbers), and the same set chatDsnFor calls local, so a worker
 * run on a developer's machine files under `local` like the app does.
 * Without a name we can read, the baked product stands.
 */
export function environmentFor(hostname: string | undefined, baked: string): string {
  let name = (hostname ?? "").toLowerCase()
  if (LOCAL_HOSTS.has(name)) return "local"
  if (name.startsWith("worker.")) name = name.slice(7)
  if (name.startsWith("app.")) name = name.slice(4)
  if (name.endsWith(".li")) name = name.slice(0, -3)
  for (const suffix of DOTNS_SUFFIXES) if (name.endsWith(`.app${suffix}`)) name = name.slice(0, -(suffix.length + 4)) + suffix
  return DOTNS_SUFFIXES.some((suffix) => name.endsWith(suffix) && name.length > suffix.length) ? name : baked
}
const DOTNS_SUFFIXES = [".paseo", ".testnet", ".dot"] as const

function environment(): string {
  if (state.served !== undefined) return environmentFor(state.served, state.product)
  try {
    return environmentFor((globalThis as Any).location?.hostname, state.product)
  } catch {
    return state.product
  }
}

function commonTags(extra: Tags | undefined): Tags {
  return {
    surface: "chat",
    product: state.product,
    "host.app": state.hostName,
    "host.app_version": state.hostVersion,
    ...(state.gameIndex !== undefined ? { "game.index": String(state.gameIndex) } : {}),
    ...extra,
  }
}

function base(timestampMs: number) {
  return {
    event_id: hex(32),
    timestamp: timestampMs / 1000,
    platform: "javascript",
    environment: environment(),
    ...(state.release ? { release: state.release } : {}),
    sdk: { name: "jollity.chat-worker", version: "1" },
    ...(state.userId || state.username ? { user: { ...(state.userId ? { id: state.userId } : {}), ...(state.username ? { username: state.username } : {}) } } : {}),
  }
}

function envelope(eventId: string, timestampMs: number, type: "event" | "transaction", payload: object): string {
  return [
    JSON.stringify({ event_id: eventId, sent_at: new Date(timestampMs).toISOString() }),
    JSON.stringify({ type }),
    JSON.stringify(payload),
  ].join("\n")
}

type StringAttribute = { value: string; type: "string" }

function itemAttributes(tags: Tags): Record<string, StringAttribute> {
  const values: Tags = {
    ...commonTags(tags),
    "sentry.environment": environment(),
    ...(state.release ? { "sentry.release": state.release } : {}),
    "sentry.sdk.name": "jollity.chat-worker",
    "sentry.sdk.version": "1",
    ...(state.userId ? { "user.id": state.userId } : {}),
    ...(state.username ? { "user.name": state.username } : {}),
  }
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, type: "string" as const }]))
}

/** One hand-built Sentry counter envelope for the QuickJS worker. */
function metricEnvelope(name: string, value: number, tags: Tags): string {
  const now = Date.now()
  return [
    JSON.stringify({ sent_at: new Date(now).toISOString() }),
    JSON.stringify({ type: "trace_metric", item_count: 1, content_type: "application/vnd.sentry.items.trace-metric+json" }),
    JSON.stringify({
      version: 2,
      items: [{
        timestamp: now / 1000,
        trace_id: hex(32),
        name,
        type: "counter",
        unit: "none",
        value,
        attributes: itemAttributes(tags),
      }],
    }),
  ].join("\n")
}

const LOG_LEVEL = { info: "info", warning: "warn", error: "error" } as const
const LOG_SEVERITY = { info: 9, warning: 13, error: 17 } as const

/** One hand-built Sentry Log envelope for detail that must stay drillable. */
function logEnvelope(message: string, level: Level, tags: Tags, detail: string): string {
  const now = Date.now()
  return [
    JSON.stringify({ sent_at: new Date(now).toISOString() }),
    JSON.stringify({ type: "log", item_count: 1, content_type: "application/vnd.sentry.items.log+json" }),
    JSON.stringify({
      version: 2,
      items: [{
        timestamp: now / 1000,
        trace_id: hex(32),
        level: LOG_LEVEL[level],
        // Callers cap each detail value before serialising it. Keep the JSON
        // framing intact so a capped value remains machine-readable in Logs.
        body: `${message}\t${maskSafe(detail)}`,
        severity_number: LOG_SEVERITY[level],
        attributes: itemAttributes(tags),
      }],
    }),
  ].join("\n")
}

async function post(body: string): Promise<void> {
  const dsn = state.dsn
  if (!dsn) return
  const g = globalThis as Any
  const impl = state.fetchImpl ?? (typeof g.fetch === "function" ? (url: string, init: Any) => g.fetch(url, init) : undefined)
  if (!impl) return
  let timer: ReturnType<typeof setTimeout> | undefined
  // A send that times out is cancelled, so a hanging Sentry cannot pile up requests.
  const controller = typeof g.AbortController === "function" ? new g.AbortController() : null
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      try {
        controller?.abort()
      } catch {
        /* nothing to cancel */
      }
      resolve()
    }, TIMEOUT_MS)
  })
  try {
    await Promise.race([
      Promise.resolve(impl(dsn.url, { method: "POST", body, ...(controller ? { signal: controller.signal } : {}) })).then(() => undefined),
      late,
    ])
  } finally {
    clearTimeout(timer)
  }
}

function pump(): void {
  while (state.inFlight < MAX_IN_FLIGHT && state.queue.length > 0) {
    const body = state.queue.shift()!
    state.inFlight++
    const owner = state
    const done = () => {
      owner.inFlight--
      if (owner === state) pump()
    }
    try {
      post(body).then(done, done)
    } catch {
      done()
    }
  }
}

function enqueue(body: string): void {
  state.queue.push(body)
  while (state.queue.length > MAX_QUEUED) state.queue.shift()
  pump()
}

/** Whether this fingerprint may still send in this run. */
function allowed(fingerprint: string[], cap = state.maxPerFingerprint): boolean {
  const key = fingerprint.join("\u0000")
  const n = state.sent.get(key) ?? 0
  if (n >= cap) return false
  state.sent.set(key, n + 1)
  return true
}

export interface ChatEventOptions {
  level?: Level
  tags?: Tags
  contexts?: Record<string, Record<string, unknown>>
  fingerprint?: string[]
  /** the most this fingerprint may send per run; default MAX_PER_FINGERPRINT */
  cap?: number
}

/** One event. Never throws, never awaited. */
export function chatEvent(message: string, options: ChatEventOptions = {}): void {
  try {
    if (!state.dsn) return
    const fingerprint = options.fingerprint ?? [message]
    if (!allowed(fingerprint, options.cap)) return
    const now = Date.now()
    const event = {
      ...base(now),
      level: options.level ?? "info",
      message,
      fingerprint,
      tags: commonTags(options.tags),
      ...(options.contexts ? { contexts: options.contexts } : {}),
    }
    enqueue(envelope(event.event_id, now, "event", event))
  } catch {
    /* telemetry never disturbs the worker */
  }
}

/** A numeric observation carried by a transaction, where Sentry indexes measurements. */
export function chatMeasure(name: string, value: number, tags: Tags = {}, unit = "millisecond"): void {
  try {
    if (!state.dsn || !Number.isFinite(value) || !allowed([name], state.maxPerCounter)) return
    const now = Date.now()
    const durationMs = unit === "millisecond" ? Math.max(0, value) : 0
    const traceId = hex(32)
    const spanId = hex(16)
    const event = {
      ...base(now),
      type: "transaction",
      transaction: name,
      start_timestamp: (now - durationMs) / 1000,
      tags: commonTags({ ...tags, "chat.measure": name }),
      contexts: { trace: { trace_id: traceId, span_id: spanId, op: name, status: "ok" } },
      spans: [],
      measurements: { [name]: { value, unit } },
    }
    enqueue(envelope(event.event_id, now, "transaction", event))
  } catch {
    /* telemetry never disturbs the worker */
  }
}

export interface ChatCountOptions {
  /** more detail as text (an error, a reason), masked and capped */
  detail?: Record<string, string>
  /** splits the fingerprint (and so the per-run rate limit) by one more word, e.g. the card face */
  key?: string
  /** send this count once per run (a canary, not a rate) */
  once?: boolean
}

/** A counter metric; detail gets a sibling Log record for drill-down. */
export function chatCount(name: string, tags: Tags = {}, options: ChatCountOptions = {}): void {
  try {
    if (!state.dsn) return
    const fingerprint = options.key ? [name, options.key] : [name]
    // A rate is only a rate if it keeps counting, so counters get a far higher cap than failures.
    if (!allowed(fingerprint, options.once ? 1 : state.maxPerCounter)) return
    enqueue(metricEnvelope(name, 1, tags))
    if (options.detail) enqueue(logEnvelope(name, "info", tags, JSON.stringify(maskedRecord(options.detail))))
  } catch {
    /* telemetry never disturbs the worker */
  }
}

function maskedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, maskSafe(v).slice(0, MAX_TEXT)]))
}

/** The failures the player's answer makes expected, as lib/telemetry/failures.ts isExpected. */
export function isExpected(kind: string, reason: string): boolean {
  if (kind === "draw-skipped") return true // the sign-up itself went out
  if (kind === "claim-failed") return reason === "cancelled"
  if (kind === "permission-refused") return ["denied", "blocked", "busy", "no-camera", "timeout"].includes(reason.slice(reason.lastIndexOf(".") + 1))
  if (kind === "camera-unavailable") return reason === "denied"
  if (kind === "name-link-failed") return reason === "not-signed" || reason === "unowned" // the player declined to sign, or the chain says nobody owns the name
  return kind === "signup-failed" && (reason === "signing-refused" || reason === "not-eligible")
}

const NEVER_ACTIONABLE = new Set(["draw-skipped", "mesh-isolated", "peer-failed", "attestations-late", "clock-drift", "unclean-exit"])
const NON_ACTIONABLE_REASONS: Readonly<Record<string, readonly string[]>> = {
  "camera-unavailable": ["denied", "timeout"],
}
const ACTIONABLE_TURN_REASONS = new Set(["bad-request", "proof-failed"])
type TurnPassReason = Extract<TurnPassOutcome, { cause: unknown }>["cause"] | "write-failed" | "threw"
const ACTIONABLE_TURN_PASS_REASONS = new Set<TurnPassReason>([
  "grant-missing",
  "proof-refused",
  "no-ring-key",
  "key-list-failed",
  "proof-threw",
  "bad-request",
  "proof-rejected",
  "no-route",
  "write-failed",
  "threw",
])

/** Worker-local data copy of lib/telemetry/failures.ts; QuickJS imports no app modules. */
export function isActionable(kind: string, reason: string): boolean {
  if (kind === "signup-failed" || kind === "permission-refused") return !isExpected(kind, reason)
  if (kind === "turn-unavailable") return ACTIONABLE_TURN_REASONS.has(reason)
  if (kind === "chat-turn-pass-failed") return ACTIONABLE_TURN_PASS_REASONS.has(reason as TurnPassReason)
  if (NEVER_ACTIONABLE.has(kind)) return false
  return !(NON_ACTIONABLE_REASONS[kind]?.includes(reason) ?? false)
}

/** A deliberate failure, with the app's title "<kind>: <reason>" and tags. */
export function chatFailure(kind: string, reason: string, context: Record<string, string> = {}, tags: Tags = {}): void {
  const expected = isExpected(kind, reason)
  const fixed = { "failure.kind": kind, "failure.reason": reason, "journey.expected": expected ? "true" : "false" }
  if (!isActionable(kind, reason)) {
    try {
      if (!state.dsn || !allowed([kind, reason])) return
      enqueue(metricEnvelope("failure", 1, { ...tags, ...fixed }))
      const masked = maskedRecord(context)
      enqueue(logEnvelope(`${kind}: ${reason}`, expected ? "info" : "warning", { ...tags, ...masked, ...fixed }, JSON.stringify(masked)))
    } catch {
      /* telemetry never disturbs the worker */
    }
    return
  }
  chatEvent(`${kind}: ${reason}`, {
    level: expected ? "warning" : "error",
    fingerprint: [kind, reason],
    tags: { ...tags, ...fixed },
    contexts: { failure: maskedRecord(context) },
  })
}

export interface ChatJourney {
  set(attrs: Tags): void
  markSad(reason: string): void
  /** Sends the journey, once. Later calls do nothing. */
  end(outcome: string, attrs?: Tags): void
}

const MAX_JOURNEYS = 20
/** Numbers go out as numbers in the trace data (tags stay text, as Sentry wants). */
const NUMERIC_DATA = new Set(["journey.duration_ms", "signup.tap_to_broadcast_ms", "signup.draws_entered", "signup.attempt", "signup.draw.scheduled", "signup.draw.waited_ms", "signup.draw.retries", "name_link.sign_ms"])
const traceData = (tags: Tags): Record<string, string | number> =>
  Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, NUMERIC_DATA.has(k) && Number.isFinite(Number(v)) ? Number(v) : v]))

/** A journey, sent as the transaction `journey.<name>` when it ends. */
export function chatJourney(name: string, attrs: Tags = {}): ChatJourney {
  const startedAt = Date.now()
  let tags: Tags = { ...attrs, "journey.sad": "false", "journey.expected": "false" }
  let ended = false
  return {
    set(more) {
      if (!ended) tags = { ...tags, ...more }
    },
    markSad(reason) {
      if (!ended) tags = { ...tags, "journey.sad": "true", "journey.sad_reason": reason }
    },
    end(outcome, more = {}) {
      if (ended) return
      ended = true
      try {
        if (!state.dsn || !allowed([`journey.${name}`], MAX_JOURNEYS)) return
        const now = Date.now()
        const all = commonTags({ ...tags, ...more, "journey.outcome": outcome, "journey.duration_ms": String(now - startedAt) })
        const traceId = hex(32)
        const spanId = hex(16)
        const event = {
          ...base(now),
          type: "transaction",
          transaction: `journey.${name}`,
          start_timestamp: startedAt / 1000,
          tags: all,
          contexts: { trace: { trace_id: traceId, span_id: spanId, op: `journey.${name}`, status: "ok", data: traceData(all) } },
          spans: [],
        }
        enqueue(envelope(event.event_id, now, "transaction", event))
      } catch {
        /* never throws */
      }
    },
  }
}

const installedErrorTargets = new WeakSet<object>()

function reportUnhandled(reason: unknown, fallback: "error" | "rejection"): void {
  const details = rejectionDetails(reason)
  chatFailure("chat-uncaught", fallback, details.context, details.tags)
}

/** Installs non-blocking worker-level error reporting once for a WebView global. */
export function installGlobalErrorTelemetry(target: Any = globalThis as Any): void {
  try {
    if (!target || (typeof target !== "object" && typeof target !== "function") || installedErrorTargets.has(target)) return
    if (typeof target.addEventListener !== "function") return
    installedErrorTargets.add(target)
    target.addEventListener("error", (event: Any) => {
      reportUnhandled(event?.error ?? event?.message ?? event, "error")
    })
    target.addEventListener("unhandledrejection", (event: Any) => {
      reportUnhandled(event?.reason ?? event, "rejection")
    })
  } catch {
    /* telemetry never disturbs the worker */
  }
}
