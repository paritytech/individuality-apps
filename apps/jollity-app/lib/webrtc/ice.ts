// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Assembles the ICE servers the mesh connects through.
 *
 * It follows the TURN provisioning of the native Polkadot-app game clients
 * (now discontinued), so this product connects the way they did. The five
 * Google STUN servers and Cloudflare's are always present.
 * TURN credentials are fetched with a five second timeout and cached until
 * five seconds before they expire. A timeout or an error yields an empty list, which is STUN only
 * and never a blocked mesh.
 *
 * Credentials last 30 minutes, so ones fetched earlier on the permission
 * screen or by a warm-up are reused while they have 10 minutes or more left,
 * refreshed in the background below that, persisted in localStorage across
 * page reloads, and NEVER replaced by an empty list while they are still
 * valid. A failed refresh is not tried again for a minute. A mesh holds its
 * credentials for the whole game, so one opening with less than about 4
 * minutes left waits up to 8 s for the refresh instead.
 *
 * A fetch that reaches the issuer and fails with a timeout, a 5xx or a
 * refused stamp is tried up to three times with backoff, the proof built once
 * and reused for a retry of the fetch. A proof that timed out is asked for
 * once more, and any other proof/host failure is not retried: only an observed
 * network change, a restored host channel, or the app returning to the
 * foreground while a game runs on STUN only starts that leg again. With nothing cached
 * the mesh waits about 8 s at most, then starts on STUN only while the fetch
 * carries on and caches what it gets for later connections. `stampSeconds`
 * stamps the proof with the clock of the issuer. The issuer refuses a stamp
 * more than 60 s from that clock, so a phone 75 s fast would otherwise never
 * get a relay.
 *
 * The issuer is the device-uniqueness backend for this network, from the
 * protocol config. Its `/issue-with-proof` route answers the preflight and
 * takes a personhood proof. A device that cannot prove gets no TURN at all.
 *
 * It matters because STUN only connects peers on one LAN. Every cross-network
 * room in the logs reached ICE `checking` and then failed.
 */

import type { IceOutcome } from "@jollity/statement-core"
import { devLog } from "../debug/log-store"
import { turnProofBody, type TurnProofBody, type TurnProofCode, type TurnProofResult } from "../host/turn-proof"
import { describeError } from "../host/error-detail"
import { readStoredJSON, writeStoredJSON } from "../host/storage"
import { withTimeout } from "../with-timeout"
import { chainSeconds } from "../telemetry/clock"
import { recordDistribution } from "../telemetry/metrics"
import { hostRetryRecord } from "../telemetry"
import { watchForegroundReturn } from "../telemetry/foreground"
// the durations here (the cache's expiry, the cooldowns, the proof's age) on
// the step-free device clock: a phone clock stepped back 75 s kept expired
// TURN credentials "valid" (#331). The proof's stamp, which the ISSUER judges,
// rides the game clock (lib/chain-clock.ts, `skewBaseMs`).
import { deviceNowMs } from "../device-clock"
import { chainNowMs, readChainGapMs } from "../chain-clock"
import { isTurnCredentialTimeout, nextChainHealthOrder } from "../chain-health"
import {
  deviceUniquenessBackendUrl,
  isTurnCredentials,
  isTurnPass,
  productAccount,
  turnIssueCause,
  turnPassKey,
  type TurnCredentials,
  type TurnPass,
} from "@jollity/protocol"
import { chainVerdict, classifyHostFailure } from "@individuality/people-chain"
import { CONNECTION_STAGE_DURATION, HOST_FULL_CYCLE, ROUND_GAP } from "@jollity/game-chain/game"

/** Writes to the console and the debug sheet, so recovery is visible beside failure in either export. */
function iceLog(message: string, level: "info" | "warn" = "warn"): void {
  if (level === "warn") console.warn(message)
  else console.log(message)
  devLog("rtc", message, undefined, level)
}

/**
 * The same facts the lines above write as prose, kept as a VALUE so the health
 * ladder's TURN rung can read them. The prose stays — it is what someone
 * scrolling an exported log looks for — but a verdict cannot be built by
 * grepping our own log messages, which a copy edit would silently break.
 *
 * Null until the first acquisition attempt, which is exactly the ladder's
 * "not fetched yet" input. A cache hit does not overwrite it: the last real
 * attempt is still the truth about whether we hold a relay.
 */
let iceOutcome: IceOutcome | null = null
let durableCacheTimedOut = false

export function lastIceOutcome(): (IceOutcome & { durable_timed_out: boolean }) | null {
  return iceOutcome && {
    ...iceOutcome,
    issuerErrors: [...iceOutcome.issuerErrors],
    durable_timed_out: durableCacheTimedOut,
  }
}

/**
 * The two host-and-issuer legs as timed events, for the join journey
 * (lib/journeys/game-trace.ts). A cache hit is its own event, so no
 * zero-length step is ever recorded for credentials already in hand.
 */
export type IceEvent =
  | { kind: "proof" | "issue"; startedAt: number; endedAt: number; ok: boolean }
  | { kind: "cached" }

const iceListeners = new Set<(event: IceEvent) => void>()

export function observeIce(listener: (event: IceEvent) => void): () => void {
  iceListeners.add(listener)
  return () => {
    iceListeners.delete(listener)
  }
}

function emitIce(event: IceEvent): void {
  for (const listener of iceListeners) {
    try {
      listener(event)
    } catch {
      /* an observer must not break the relays */
    }
  }
}

const turnServerListeners = new Set<(servers: RTCIceServer[]) => void>()

/** Fresh relay credentials for a room that had to open on STUN only. */
export function observeTurnServers(
  listener: (servers: RTCIceServer[]) => void,
): () => void {
  turnServerListeners.add(listener)
  return () => {
    turnServerListeners.delete(listener)
  }
}

function emitTurnServers(turn: RTCIceServer[]): void {
  const servers = [STUN, ...turn]
  for (const listener of turnServerListeners) {
    try {
      listener(servers)
    } catch {
      /* an observer must not break the relays */
    }
  }
}

/**
 * WHAT HAPPENED TO THE RELAY CREDENTIALS, once per fetchIceServers call (a
 * mesh open, a warm-up or a retry, whoever shares the fetch and whether it
 * came from the cache), as a VALUE for the game trace (lib/journeys/turn-outcome.ts): whether
 * credentials were received and parsed by this client and, on a failure, the stage, the HTTP status and the
 * server's own reason, so a round played with no relay names why. Nothing here
 * changes what is fetched, retried or cached (that is #225); it only says what
 * happened.
 *
 * `stage` is where it stopped: `proof-chain` (the host lost its chain
 * subscription while building the proof), `proof` (any other host proof
 * failure), `issue` (the issuer refused, timed out or answered badly) or
 * `config` (no issuer for this network). `ttlLeftS` is the seconds the
 * credentials still have, on a fresh issue or a cache hit. `reason` is the
 * server's text, RAW: cleaning it for an attribute is the trace's job.
 *
 * A refusal's body is read AFTER the mesh has its STUN-only list, so the
 * outcome of a refusal is emitted when that read settles, a moment later.
 */
export type TurnSource =
  | "mesh"
  | "warmup"
  | "cache-hit"
  | "network-change"
  | "host-reconnect"
  | "foreground-return"
export type TurnOutcome =
  | { received: "true" | "cached"; ttlLeftS: number; source?: TurnSource }
  | { received: "false"; stage: "proof-chain" | "proof" | "issue" | "config"; status?: number; reason: string; cause?: TurnCause; source?: TurnSource }

function sourced(outcome: TurnOutcome, source: TurnSource): TurnOutcome {
  if (outcome.received === "cached") return { ...outcome, source: "cache-hit" }
  if (source === "mesh") return outcome
  return { ...outcome, source }
}

/**
 * WHY it failed, finer than the stage, one value per thing that needs a
 * different fix: the issuer's refusals by status (400 split on whether the
 * body names the timestamp window, 403 the proof not verifying or an unknown
 * ring, 404 no such route on this issuer, 429 the redemption limit, 503 no
 * ring roots yet), a timeout of the proof or the issuer as the stage says,
 * the `TurnProofCode` of the step at which the host could not give a proof,
 * `proof-failed` for a throw while reading the product account or the stamp
 * before the host is called, and any other server or network failure.
 */
export type TurnCause =
  | TurnProofCode
  | "timestamp-window"
  | "bad-request"
  | "no-route"
  | "proof-rejected"
  | "redemption-limit"
  | "no-ring-roots"
  | "timeout"
  | "proof-failed"
  | "server-error"

const outcomeListeners = new Set<(outcome: TurnOutcome) => void>()
const chainHealthOutcomeListeners = new Set<(outcome: TurnOutcome) => void>()
let latestOutcome: TurnOutcome | null = null
let latestOutcomeAtMs = -Infinity
let latestChainHealthOutcome: TurnOutcome | null = null
let latestChainHealthOutcomeAtMs = -Infinity
const outcomeHealthOrders = new WeakMap<object, number>()
export const TURN_OUTCOME_REPLAY_MAX_MS = 60_000

/** The order of the actual proof build behind this outcome. A synthetic
 * first-start timeout has no proof order, but #726 still treats it as direct
 * stuck-host evidence; cache hits intentionally have neither. */
export function turnOutcomeChainHealthOrder(outcome: TurnOutcome): number | undefined {
  return outcomeHealthOrders.get(outcome)
}

/** The last completed acquisition outcome, including one produced on the
 * permissions screen before the waiting-room page mounted. */
export function lastTurnOutcome(maxAgeMs = Infinity): TurnOutcome | null {
  return deviceNowMs() - latestOutcomeAtMs <= maxAgeMs ? latestOutcome : null
}

export function observeTurnOutcome(listener: (outcome: TurnOutcome) => void): () => void {
  outcomeListeners.add(listener)
  return () => {
    outcomeListeners.delete(listener)
  }
}

/** The latest TURN evidence relevant to the restart card. Unlike the
 * per-mesh outcome, this may be a proof-chain refusal that completed after a
 * mesh had already opened on STUN. */
export function lastTurnChainHealthOutcome(maxAgeMs = Infinity): TurnOutcome | null {
  return deviceNowMs() - latestChainHealthOutcomeAtMs <= maxAgeMs
    ? latestChainHealthOutcome
    : null
}

export function observeTurnChainHealthOutcome(
  listener: (outcome: TurnOutcome) => void,
): () => void {
  chainHealthOutcomeListeners.add(listener)
  return () => {
    chainHealthOutcomeListeners.delete(listener)
  }
}

function emitChainHealthOutcome(outcome: TurnOutcome, healthOrder?: number): void {
  if (healthOrder !== undefined) outcomeHealthOrders.set(outcome, healthOrder)
  latestChainHealthOutcome = outcome
  latestChainHealthOutcomeAtMs = deviceNowMs()
  for (const listener of chainHealthOutcomeListeners) {
    try {
      listener(outcome)
    } catch {
      /* an observer must not break the relays */
    }
  }
}

function isChainHealthEvidence(outcome: TurnOutcome, healthOrder?: number): boolean {
  if (isTurnCredentialTimeout(outcome)) return true
  if (healthOrder === undefined) return false
  return (
    outcome.received === "true" ||
    (outcome.received === "false" &&
      (outcome.stage === "proof-chain" || outcome.stage === "issue"))
  )
}

function emitOutcome(outcome: TurnOutcome, healthOrder?: number): void {
  if (isChainHealthEvidence(outcome, healthOrder))
    emitChainHealthOutcome(outcome, healthOrder)
  latestOutcome = outcome
  latestOutcomeAtMs = deviceNowMs()
  if (outcome.source)
    void import("../telemetry").then(({ turnReceiptSpan }) => turnReceiptSpan(outcome)).catch(() => {})
  for (const listener of outcomeListeners) {
    try {
      listener(outcome)
    } catch {
      /* an observer must not break the relays */
    }
  }
}

/** A credential fetch that stopped, and where. The message is what the log and
 *  the health ladder read; `reason` is the server's text, still being read.
 *  `cause` and `retryable` are decided where it is thrown, where the facts are. */
class TurnError extends Error {
  constructor(
    readonly stage: "proof-chain" | "proof" | "issue",
    message: string,
    readonly cause: TurnCause,
    readonly retryable: boolean,
    readonly status?: number,
    readonly reason?: Promise<string | undefined>,
    public healthOrder?: number,
  ) {
    super(message)
    this.healthOrder = healthOrder
  }
}

/** Classify a failure of `bounded` or the host. The issuer path may retry a
 * timeout. On the proof path, issueWithProof asks once more after a timeout;
 * any other proof failure waits for a network change, a restored host channel
 * or a foreground return (see the header). */
function failed(stage: "proof" | "issue", err: unknown): TurnError {
  const message = err instanceof Error ? err.message : String(err)
  const timeout = /no answer in/.test(message)
  return new TurnError(stage, message, timeout ? "timeout" : stage === "proof" ? "proof-failed" : "server-error", timeout || stage === "issue", undefined, Promise.resolve(err instanceof TurnError ? err.message : describeError(err)))
}

/** The error for an issuer answer that was not credentials; a 400 is read first, to tell the stamp's from any other. */
async function refused(res: Response): Promise<TurnError> {
  const { status } = res
  const reason = refusalReason(res)
  const cause = turnIssueCause(status, status === 400 ? await reason : undefined)
  const retryable = cause === "no-ring-roots" || cause === "server-error"
  return new TurnError("issue", `turn/issue-with-proof ${status}`, cause, retryable, status, reason)
}

const NO_REASON = "no reason given"
/** a refusal's body is only ever a short reason: read little, wait little */
const REASON_READ_MS = 1_000
const REASON_MAX_CHARS = 1_000

/** The server's reason for a refusal, raw: the `error` of a JSON body, else the
 *  text. Never throws and never waits long. */
async function refusalReason(res: Response): Promise<string | undefined> {
  try {
    const text = (await withTimeout(res.text(), REASON_READ_MS))?.slice(0, REASON_MAX_CHARS)
    if (!text) return undefined
    try {
      const error = (JSON.parse(text) as { error?: unknown } | null)?.error
      if (typeof error === "string") return error
    } catch {
      /* not JSON: the text is the reason */
    }
    return text
  } catch {
    return undefined
  }
}

/**
 * The STUN list the native game clients used, plus Cloudflare's free STUN on
 * 3478: a network that drops Google's port 19302 still lets the phone learn
 * its public IPv4 address (a phone that got only an IPv6 one has been seen
 * reaching no IPv4-only peer).
 */
const STUN: RTCIceServer = {
  urls: [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun2.l.google.com:19302",
    "stun:stun3.l.google.com:19302",
    "stun:stun4.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
  ],
}
/** A 5 s fetch timeout, and credentials dropped 5 s before they expire. */
const FETCH_TIMEOUT_MS = 5_000
const EXPIRY_BUFFER_S = 5
/** A credential lives 30 minutes, and the warm-ups 10 and 3 minutes before the
 *  game (use-turn-warmup.ts) keep this much in hand for the mesh. */
const REFRESH_BELOW_S = 600
/** The game a mesh must outlive: its rounds and its group cap, as the chain's
 * game record sets them (#1348). The session names it (`setTurnGameShape`)
 * once it has read the game; until then two rounds of six seats stand in. */
export interface TurnGameShape {
  rounds: number
  maxGroupSize: number
}
const UNREAD_GAME: TurnGameShape = { rounds: 2, maxGroupSize: 6 }
let gameShape: TurnGameShape = UNREAD_GAME
/** Covers the 8 s wait and a mesh that opens a few seconds after the
 *  connection stage starts, 64 s before the game (CONNECTION_STAGE_DURATION). */
const MESH_OPEN_MARGIN_S = 30
/** The credential life a mesh needs to open on: the whole game, and the margin. */
export function meshOpenMinS(shape: TurnGameShape = gameShape): number {
  return (
    CONNECTION_STAGE_DURATION +
    shape.rounds * shape.maxGroupSize * HOST_FULL_CYCLE +
    Math.max(0, shape.rounds - 1) * ROUND_GAP +
    MESH_OPEN_MARGIN_S
  )
}
/** Names the game the mesh's credentials must outlive. A shape with no
 * rounds or no seats is not a game: the stand-in holds. */
export function setTurnGameShape(shape: TurnGameShape | undefined): void {
  gameShape = shape && shape.rounds > 0 && shape.maxGroupSize > 0 ? { rounds: shape.rounds, maxGroupSize: shape.maxGroupSize } : UNREAD_GAME
}
/** tries per issuer, and the wait before the second and the third (jittered) */
const MAX_TRIES = 3
const BACKOFF_MS = [1_000, 2_000]
/** no new try starts after this long */
const RETRY_BUDGET_MS = 15_000
/** a proof built longer ago than this is built again, whatever the retry */
const PROOF_MAX_AGE_MS = 30_000
/** no new background refresh this soon after a failed one */
const REFRESH_COOLDOWN_MS = 60_000
/** at most one retry per this long when the app returns to the foreground: a
 *  player switching apps back and forth would otherwise cost an issuer
 *  request and a proof each time */
const FOREGROUND_RETRY_MIN_MS = 60_000
/** with nothing cached, the mesh waits this long for credentials before starting on STUN only */
const FIRST_START_MS = 8_000
/** A durable pass is the fast rejoin path, but a stuck host store must leave
 * enough of FIRST_START_MS for the established proof/fallback path. */
const DURABLE_CACHE_WAIT_MS = 1_500

/**
 * Resolved on use, not at import.
 *
 * `deviceUniquenessBackendUrl()` throws when the build did not name a network,
 * and at module scope that turns a missing env var into an import-time crash
 * for every consumer of this file.
 */
const issuers = () => [deviceUniquenessBackendUrl()].filter(Boolean)

interface Cached {
  turn: RTCIceServer[]
  expiresAt: number
}
let cached: Cached | null = null
let activeCacheKey: string | null = null
let browserCacheHydrated = false
type DurableCacheResult = "hit" | "miss" | "error"
let durableCacheHydration: Promise<DurableCacheResult> | null = null
let durableCacheStartedAt = 0
let durableCacheWaitFinished = false
const durableCacheMeasuredKeys = new Set<string>()
const NO_DURABLE_CACHE_KEY = "none"
// A non-secret, page-local history bit per bound cache key. Structurally valid
// persisted credentials prove that an issue happened even when they are too
// old to reuse and are removed from storage.
const previouslyIssuedKeys = new Set<string>()

const credentialHistoryKey = (key = activeCacheKey) => key ?? NO_DURABLE_CACHE_KEY

const cacheKey = (account: Uint8Array) => turnPassKey(productAccount(), account, issuers())

function adoptStoredCredentials(stored: unknown): boolean {
  if (!isTurnPass(stored)) return false
  previouslyIssuedKeys.add(credentialHistoryKey())
  const ttlMs = stored.expiresAtWallMs - Date.now()
  if (ttlMs <= EXPIRY_BUFFER_S * 1000) return false
  const expiresAt = deviceNowMs() + ttlMs
  if (!valid(cached) || expiresAt > cached.expiresAt)
    cached = { turn: stored.turn, expiresAt }
  return true
}

function hydrateBrowserCache(): void {
  const key = activeCacheKey
  if (!key || browserCacheHydrated) return
  browserCacheHydrated = true
  try {
    const raw = localStorage.getItem(key)
    const stored: unknown = raw ? JSON.parse(raw) : null
    if (!adoptStoredCredentials(stored) && raw) localStorage.removeItem(key)
  } catch {
    // Storage is an optimization. A blocked, absent or malformed store falls
    // through to the credential fetch and never blocks the room.
  }
}

/** Host storage survives the WebView replacement that follows a dropped host
 * channel. Keep one read in flight: if the bounded caller stops waiting, the
 * eventual value still warms this page for a later link. */
function hydrateDurableCache(): Promise<DurableCacheResult> {
  const key = activeCacheKey
  if (!key) return Promise.resolve("miss")
  if (!durableCacheHydration) durableCacheStartedAt = deviceNowMs()
  durableCacheHydration ??= readStoredJSON(key)
    .then((stored) => {
      const adopted = activeCacheKey === key && adoptStoredCredentials(stored)
      // A pass that lands after the room opened on STUN only has no fetch to
      // ride: the one lateIceServers call has already gone, so the room would
      // never hear about it and its links would stay on STUN for the page.
      // Tell the open rooms what this read brought, the same way a fresh
      // issue does.
      if (adopted && valid(cached)) emitTurnServers(cached.turn)
      return adopted ? "hit" : "miss"
    })
    .catch(() => "error")
  return durableCacheHydration
}

async function waitForDurableCache(): Promise<void> {
  const key = activeCacheKey
  if (!key) {
    if (!durableCacheMeasuredKeys.has(NO_DURABLE_CACHE_KEY)) {
      durableCacheMeasuredKeys.add(NO_DURABLE_CACHE_KEY)
      recordDistribution("turn.durable_wait_ms", 0, "millisecond", {
        "turn.durable_result": "none",
      })
    }
    return
  }
  if (durableCacheWaitFinished) return
  const shouldRecord = !durableCacheMeasuredKeys.has(key)
  if (shouldRecord) durableCacheMeasuredKeys.add(key)
  const waitStartedAt = deviceNowMs()
  const hydration = hydrateDurableCache()
  const leftMs = Math.max(
    0,
    DURABLE_CACHE_WAIT_MS - (deviceNowMs() - durableCacheStartedAt),
  )
  const result = await withTimeout(hydration, leftMs)
  if (activeCacheKey === key) {
    durableCacheWaitFinished = true
    durableCacheTimedOut = result === null
  }
  if (shouldRecord)
    recordDistribution(
      "turn.durable_wait_ms",
      Math.max(0, deviceNowMs() - waitStartedAt),
      "millisecond",
      { "turn.durable_result": result ?? "timeout" },
    )
}

function persistCache(entry: TurnPass, key = activeCacheKey): void {
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(entry))
  } catch {
    // Private browsing and a full store must not turn a relay into a failure.
  }
  // The host copy survives a host-driven WebView replacement. The browser
  // copy above remains for standalone use and backward compatibility.
  void writeStoredJSON(key, entry).catch(() => undefined)
}

/** Binds persisted TURN credentials to the playing product account. The game
 * source already owns that identity; the ICE layer receives only its public
 * account bytes and never asks the host for another identity or proof. */
export function setTurnPlayerAccount(account: Uint8Array | undefined): void {
  if (!account) return
  const key = cacheKey(account)
  if (activeCacheKey === key) return
  if (activeCacheKey !== null) {
    cached = null
    // A shared request belongs to the account that started it. It may still
    // finish for that caller, but a newly selected player must start its own
    // proof instead of receiving the former player's returned secret.
    inflight = null
    outlived = null
    refreshBlockedUntil = 0
  }
  activeCacheKey = key
  browserCacheHydrated = false
  durableCacheHydration = null
  durableCacheStartedAt = 0
  durableCacheWaitFinished = false
  durableCacheTimedOut = false
  hydrateBrowserCache()
  void hydrateDurableCache()
  if (valid(cached))
    persistCache({
      turn: cached.turn,
      expiresAtWallMs: Date.now() + (cached.expiresAt - deviceNowMs()),
    })
}
/** the issuer's clock minus the phone's, from the Date header of its last answer (ms) */
let serverSkewMs: number | null = null
/** no background refresh starts before this: a failed one is not repeated at every mesh open */
let refreshBlockedUntil = 0

const valid = (entry: Cached | null): entry is Cached => entry !== null && deviceNowMs() < entry.expiresAt
/** Reads the mutable cache after an await without TypeScript carrying a stale
 * pre-await narrowing across the host-storage promise. */
const currentCache = (): Cached | null => cached

/** a response's Date header as ms, if the bridge passes headers through and it parses */
function serverMsOf(res: Response): number | undefined {
  const parsed = Date.parse(res.headers?.get?.("date") ?? "")
  return Number.isNaN(parsed) ? undefined : parsed
}

/** What stampSecondsOf reads, each a function so it is read only when used. */
export interface StampReadings {
  serverSkewMs: number | null
  skewBaseMs: () => number
  gapMs: () => number | null
  deviceNowMs: () => number
  chainSeconds: () => number | null
}

/**
 * The second a proof is stamped with. The issuer judges it against its own
 * wall clock, so in order: that clock as learned from the Date header of any
 * of its answers (a 400 included, so the next stamp is already right), then
 * the chain's time, the device clock minus the chain gap the game source
 * measured (the game clock does not carry it, #1375; without it a phone 75 s
 * fast with no readable Date header is refused every proof, #1397), then
 * the game clock, then the raw phone clock. A dev node's lag on the chain
 * costs at most one restamp. `noGap` skips the gap after the issuer refused a
 * stamp taken from it (issueWithProof).
 */
export function stampSecondsOf(readings: StampReadings, noGap: boolean): { seconds: number; fromGap: boolean } {
  if (readings.serverSkewMs !== null)
    return { seconds: Math.floor((readings.skewBaseMs() + readings.serverSkewMs) / 1000), fromGap: false }
  const gapMs = noGap ? null : readings.gapMs()
  if (gapMs !== null) return { seconds: Math.floor((readings.deviceNowMs() - gapMs) / 1000), fromGap: true }
  return { seconds: readings.chainSeconds() ?? Math.floor(readings.deviceNowMs() / 1000), fromGap: false }
}

function stampSeconds(noGap = false): { seconds: number; fromGap: boolean } {
  return stampSecondsOf({ serverSkewMs, skewBaseMs, gapMs: readChainGapMs, deviceNowMs, chainSeconds }, noGap)
}

/** the clock the issuer's skew is measured on: the chain's once the doorway
 *  has one (it re-syncs when the device clock loses time in a freeze, #331),
 *  else the step-free device clock */
function skewBaseMs(): number {
  return chainNowMs() ?? deviceNowMs()
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
interface TurnResult {
  turn: RTCIceServer[]
  /** a refusal's outcome waits on its body: see TurnOutcome */
  outcome: TurnOutcome | Promise<TurnOutcome>
  /** order of the proof build that led to this result */
  healthOrder?: number
}
let inflight: Promise<TurnResult> | null = null
/** the fetch the first start stopped waiting for (FIRST_START_MS): a mesh that
 *  opened on STUN only takes its result when it lands (lateIceServers) */
interface OutlivedAcquisition {
  fetched: Promise<TurnResult>
  followup: Promise<void>
}
let outlived: OutlivedAcquisition | null = null

/**
 * Rejects when `work` outlives the fetch budget.
 *
 * Inside the host WebView `fetch` is the bridge and it ignores `signal`, so a
 * bridge that has gone away never settles and an unbounded await leaves the
 * mesh waiting for a promise that can never resolve. Every path that reaches
 * the host has to carry its own clock.
 */
function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: no answer in ${FETCH_TIMEOUT_MS}ms`)),
      FETCH_TIMEOUT_MS,
    )
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

/** The bound, exposed for its test: the mesh cannot wait on an unbounded call. */
export const boundedForTests = bounded

interface Proven {
  body: TurnProofBody
  at: number
  healthOrder: number
  /** stamped from the chain gap */
  fromGap: boolean
}

/** The proof, or a TurnError; null body cannot happen here: no proof is an error too. */
async function prove(noGap = false): Promise<Proven> {
  // The proof costs three host calls before any fetch, and a host that has
  // stopped answering makes every one of them hang.
  const proofAt = deviceNowMs()
  const stamp = stampSeconds(noGap)
  let result: TurnProofResult | null = null
  try {
    result = await bounded(turnProofBody(productAccount(), stamp.seconds), "turn/proof")
  } catch (err) {
    throw failed("proof", err)
  } finally {
    emitIce({ kind: "proof", startedAt: proofAt, endedAt: deviceNowMs(), ok: result !== null && "body" in result })
  }
  if (!("body" in result)) {
    // the reason rides the failure: "no proof" alone hid the host's own refusal
    const reason = `no proof: ${result.reason}`
    const stage = chainVerdict(classifyHostFailure(result.reason)) === "lost" ? "proof-chain" : "proof"
    throw new TurnError(
      stage,
      reason,
      result.code,
      false,
      undefined,
      Promise.resolve(reason),
      nextChainHealthOrder(),
    )
  }
  return { body: result.body, at: proofAt, healthOrder: nextChainHealthOrder(), fromGap: stamp.fromGap }
}

/** One post of a proof to the issuer. Whatever the answer, its Date header teaches the issuer's clock. */
async function post(base: string, body: TurnProofBody): Promise<TurnCredentials> {
  const issueAt = deviceNowMs()
  let issued = false
  try {
    const res = await bounded(
      fetch(`${base}/api/v1/turn/issue-with-proof`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      }),
      "turn/issue-with-proof",
    )
    const serverMs = serverMsOf(res)
    if (serverMs !== undefined) serverSkewMs = serverMs - skewBaseMs()
    // the body is read off this path (a 400's briefly, to tell the stamp's): the mesh must not wait on telemetry
    if (res.status !== 201 && res.status !== 200) throw await refused(res)
    const data: unknown = await bounded(res.json(), "turn/issue-with-proof")
    if (!isTurnCredentials(data)) throw new Error("turn/issue-with-proof: unexpected response shape")
    issued = true
    return data
  } catch (err) {
    // a timeout, a dead bridge or a body that is not credentials: no HTTP status to name
    throw err instanceof TurnError ? err : failed("issue", err)
  } finally {
    emitIce({ kind: "issue", startedAt: issueAt, endedAt: deviceNowMs(), ok: issued })
  }
}

/**
 * Redeems a proof with the retries that make a flaky moment survivable: up to
 * three tries with backoff for what a retry can fix (a timeout, a 5xx, and a
 * stamp the issuer refused, whose 400 has just taught us its clock so the next
 * stamp is right). A refusal no retry can change (403, 429, another 400) is
 * final. The proof is built once and reused by retries of the fetch, and built
 * again after a stamp refusal or once it is 30 s old. A proof the host did not
 * give in time is asked for once more. A host that just started is often slow
 * for one call, and a late joiner has no warm-up to absorb it.
 */
async function issueWithProof(
  base: string,
): Promise<{ credentials: TurnCredentials; healthOrder: number }> {
  const startedAt = deviceNowMs()
  let proven: Proven | undefined
  let issuerTries = 0
  let proofRetried = false
  /** a stamp from the chain gap was refused with no Date header to learn from: back to the game clock */
  let noGap = false
  for (;;) {
    try {
      if (!proven || deviceNowMs() - proven.at > PROOF_MAX_AGE_MS) proven = await prove(noGap)
      return { credentials: await post(base, proven.body), healthOrder: proven.healthOrder }
    } catch (err) {
      if (!(err instanceof TurnError)) throw err
      if (proven && err.healthOrder === undefined) err.healthOrder = proven.healthOrder
      if (err.cause === "timestamp-window") {
        if (proven?.fromGap && serverSkewMs === null) noGap = true
        proven = undefined
      }
      // A proof failure is the host, not the network. Repeating it against a
      // stuck app only burns the game clock, so beyond the one retry of a
      // timeout that leg waits for an observed network change.
      if (err.stage !== "issue") {
        if (err.stage !== "proof" || err.cause !== "timeout" || proofRetried) throw err
        proofRetried = true
        iceLog(`[jollity-rtc] TURN: the proof timed out (${err.message}), asking the host once more`)
        await sleep(BACKOFF_MS[0] * (0.75 + Math.random() * 0.5))
        continue
      }
      issuerTries++
      const retryable = err.retryable || err.cause === "timestamp-window"
      const wait = BACKOFF_MS[issuerTries - 1]
      if (!retryable || issuerTries >= MAX_TRIES || deviceNowMs() - startedAt + wait > RETRY_BUDGET_MS) throw err
      iceLog(`[jollity-rtc] TURN: try ${issuerTries} failed (${err.message}), trying again`)
      await sleep(wait * (0.75 + Math.random() * 0.5))
    }
  }
}

/** Asks the issuers for credentials. A failure leaves what is cached alone. */
function acquire(
  bases: string[],
  share = true,
  lifecycleReady: Promise<void> = Promise.resolve(),
): Promise<TurnResult> {
  if (share && inflight) return inflight
  const requestCacheKey = activeCacheKey
  const historyKey = credentialHistoryKey(requestCacheKey)
  const requestedAtWallMs = Date.now()
  const request: Promise<TurnResult> = (async (): Promise<TurnResult> => {
    // Kept per attempt so the outcome can distinguish redundant issuers
    // without retaining their URLs.
    const issuerErrors: string[] = []
    let failure: TurnError | undefined
    for (const [issuerIndex, base] of bases.entries()) {
        try {
          const { credentials: data, healthOrder } = await issueWithProof(base)
          const issuedAtWallMs = Date.now()
          const issuedAtDeviceMs = deviceNowMs()
          const expiresAtWallMs = issuedAtWallMs + Math.max(0, data.ttl) * 1000
          const cacheExpiresAtWallMs = issuedAtWallMs + Math.max(0, data.ttl - EXPIRY_BUFFER_S) * 1000
          // The credential request and durable-cache read intentionally run in
          // parallel. Do not call this issue "initial" until the bounded read
          // has had its chance to reveal an earlier (even expired) issue.
          await lifecycleReady.catch(() => undefined)
          const lifecycle = previouslyIssuedKeys.has(historyKey) ? "renewal" : "initial"
          previouslyIssuedKeys.add(historyKey)
          const turn = data.servers.map((url) => ({
            urls: url,
            username: data.username,
            credential: data.password,
          }))
          if (requestCacheKey === activeCacheKey) {
            cached = { turn, expiresAt: issuedAtDeviceMs + Math.max(0, data.ttl - EXPIRY_BUFFER_S) * 1000 }
            persistCache({
              turn,
              expiresAtWallMs: cacheExpiresAtWallMs,
            } satisfies TurnPass, requestCacheKey)
            emitTurnServers(turn)
          }
          iceOutcome = { turnReceived: true, issuerErrors, at: deviceNowMs() }
          // Only the failures were ever recorded, so a working fetch left the
          // sheet silent and the question of whether credentials arrived could
          // only be answered by the absence of a warning.
          const completedAtWallMs = Date.now()
          iceLog(`[jollity-rtc] TURN: client response received and parsed lifecycle=${lifecycle} request_started_at_ms=${requestedAtWallMs} received_at_ms=${issuedAtWallMs} completed_at_ms=${completedAtWallMs} expires_at_ms=${expiresAtWallMs} cache_expires_at_ms=${cacheExpiresAtWallMs} ttl_s=${data.ttl} turn_servers=${turn.length}`, "info")
          return {
            turn,
            outcome: { received: "true", ttlLeftS: data.ttl },
            healthOrder,
          }
        } catch (err) {
          failure = err instanceof TurnError ? err : failed("issue", err)
          // a TurnError keeps its classification in `cause`, which describeError
          // would follow and append as " <- server-error"
          const text = err instanceof TurnError ? err.message : describeError(err)
          const issuer = `issuer ${issuerIndex + 1}`
          issuerErrors.push(`${issuer}: ${text}`)
          iceLog(`[jollity-rtc] TURN: ${issuer} failed — ${text}`)
        }
      }
      // a refresh that failed while the old credentials are still good changes nothing
      const kept = valid(cached)
      if (kept) refreshBlockedUntil = deviceNowMs() + REFRESH_COOLDOWN_MS
      else iceOutcome = { turnReceived: false, issuerErrors, at: deviceNowMs() }
      iceLog(kept ? "[jollity-rtc] TURN: refresh failed, keeping the credentials in hand" : "[jollity-rtc] TURN: failed to fetch credentials, using empty list")
      const { stage, status, reason, cause } = failure!
      const outcome = Promise.resolve(reason).then((text): TurnOutcome => ({ received: "false", stage, ...(status !== undefined ? { status } : {}), reason: text ?? NO_REASON, cause }))
    return {
      turn: [],
      outcome,
      healthOrder: failure?.healthOrder,
    }
  })()
  if (!share) return request
  const shared = request.finally(() => {
    if (inflight === shared) inflight = null
  })
  inflight = shared
  return shared
}

const completedOutcomeObservers = new WeakSet<Promise<TurnResult>>()

/** Own the result after the mesh's eight-second wait expires. A late success
 * still warms the cache and can be installed by lateIceServers; a late host
 * failure remains chain-health evidence, but starts no retry loop. */
function observeCompletedOutcome(fetched: Promise<TurnResult>, source: TurnSource): void {
  if (completedOutcomeObservers.has(fetched)) return
  completedOutcomeObservers.add(fetched)
  void fetched
    .then(async (result) => emitOutcome(sourced(await Promise.resolve(result.outcome), source), result.healthOrder))
    .catch(() => {})
}

function followOutlived(
  fetched: Promise<TurnResult>,
  emitCompletedOutcome = false,
  source: TurnSource = "mesh",
): void {
  if (emitCompletedOutcome) observeCompletedOutcome(fetched, source)
  if (outlived?.fetched === fetched) {
    return
  }
  const acquisition: OutlivedAcquisition = {
    fetched,
    followup: Promise.resolve(),
  }
  outlived = acquisition
  acquisition.followup = fetched
    .then(async (result) => {
      const outcome = sourced(await Promise.resolve(result.outcome), source)
      // The ordinary first start already recorded its STUN-only opening. A
      // late chain loss still reaches the restart-card channel without
      // becoming a second per-mesh TURN outcome. A network-change acquisition
      // is itself a fresh health attempt, so it records the completed outcome.
      if (
        !emitCompletedOutcome &&
        !completedOutcomeObservers.has(fetched) &&
        isChainHealthEvidence(outcome, result.healthOrder)
      )
        emitChainHealthOutcome(outcome, result.healthOrder)
    })
    .catch(() => {})
    .finally(() => {
      if (outlived === acquisition) outlived = null
    })
}

/** Returns the TURN entries alone, cached (see the header). */
async function turnCredentials(source: TurnSource): Promise<TurnResult> {
  const startedAt = deviceNowMs()
  hydrateBrowserCache()
  const durableReady = waitForDurableCache()
  const bases = issuers()
  if (bases.length === 0) {
    iceOutcome = { turnReceived: false, issuerErrors: ["no TURN issuer configured"], at: deviceNowMs() }
    return { turn: [], outcome: { received: "false", stage: "config", reason: "no TURN issuer configured" } }
  }
  const leftS = (entry: Cached) =>
    (entry.expiresAt - deviceNowMs()) / 1000 + EXPIRY_BUFFER_S
  const firstStartLeftMs = () =>
    Math.max(0, FIRST_START_MS - (deviceNowMs() - startedAt))
  const stunOnly = (fetched: Promise<TurnResult>): TurnResult => {
    followOutlived(fetched, source !== "mesh", source)
    iceLog("[jollity-rtc] TURN: still fetching, starting on STUN only")
    return { turn: [], outcome: { received: "false", stage: "issue", reason: "no credentials after 8 s, started on STUN only", cause: "timeout" } }
  }
  if (valid(cached)) {
    const inHand = cached
    // the buffer is the five seconds the cache lets go early: the credentials still have them
    const ttlLeftS = () => leftS(inHand)
    const held = (): TurnResult => {
      emitIce({ kind: "cached" })
      return { turn: inHand.turn, outcome: { received: "cached", ttlLeftS: Math.round(ttlLeftS()) } }
    }
    // The cooldown wins on purpose: a renewal that just failed is not tried
    // again for the mesh within the minute.
    if (ttlLeftS() >= REFRESH_BELOW_S || deviceNowMs() < refreshBlockedUntil) return held()
    if (!inflight) logTurnRerun(source)
    const renewal = acquire(bases, true, durableReady)
    // An open link never takes new credentials, so a mesh opening on ones
    // that would die mid-game waits for the renewal.
    if (source !== "mesh" || ttlLeftS() >= meshOpenMinS()) return held()
    const renewed = await withTimeout(renewal, firstStartLeftMs())
    if (renewed && renewed.turn.length > 0) return renewed
    if (!valid(inHand)) return renewed ?? stunOnly(renewal)
    if (!renewed) followOutlived(renewal)
    else
      void Promise.resolve(renewed.outcome).then((outcome) => {
        if (isChainHealthEvidence(outcome, renewed.healthOrder)) emitChainHealthOutcome(outcome, renewed.healthOrder)
      })
    return held()
  }
  // Nothing in hand: wait for the fetch, but not longer than the first start can
  // afford. Past that the mesh goes STUN only and the fetch carries on, caching
  // what it gets for the connections after this one.
  if (!inflight) logTurnRerun(source)
  const fetched = acquire(bases, true, durableReady)
  // Storage and proof run together. If a retained pass wins this short race,
  // use it; otherwise the proof has already spent the same time making
  // progress, rather than starting 1.5 s late.
  await durableReady
  const restored = currentCache()
  if (valid(restored)) {
    followOutlived(fetched, source !== "mesh", source)
    emitIce({ kind: "cached" })
    return {
      turn: restored.turn,
      outcome: {
        received: "cached",
        ttlLeftS: Math.round(leftS(restored)),
      },
    }
  }
  const result = await withTimeout(fetched, firstStartLeftMs())
  return result ?? stunOnly(fetched)
}

const ABORTED = Symbol("aborted")

function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return work
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    const abort = () => resolve(ABORTED)
    signal.addEventListener("abort", abort, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/**
 * For a mesh that opened on STUN only: the ICE servers the fetch it stopped
 * waiting for brought, once it lands (no new fetch, and no second TURN outcome
 * for the trace), or what is cached; null when neither holds a relay. The mesh
 * hands them to its connections (Mesh.setIceServers).
 */
export async function lateIceServers(signal?: AbortSignal): Promise<RTCIceServer[] | null> {
  const pending = outlived?.followup
  if (pending && (await withAbort(pending, signal)) === ABORTED) return null
  return valid(cached) ? [STUN, ...cached.turn] : null
}

/** A network transition gets the only follow-up credential attempt. Links
 * rebuild immediately with valid cached credentials or STUN while their
 * replacement is fetched off the critical path. Every real attempt emits its
 * outcome for the health ladder and trace. */
export async function retryIceServers(signal?: AbortSignal): Promise<RTCIceServer[]> {
  if (signal?.aborted) return [STUN]
  hydrateBrowserCache()
  const durableReady = waitForDurableCache()
  const held = valid(cached) ? [STUN, ...cached.turn] : null
  if (held) return held
  const bases = issuers()
  if (bases.length === 0) return held ?? [STUN]
  // With no valid relay left, a new network is a new chance for the host too.
  // Join an existing request instead of replacing it: its host-health result
  // must still reach the restart card.
  const joined = inflight
  const fetched = acquire(bases, true, durableReady)
  await durableReady
  if (valid(cached)) return [STUN, ...cached.turn]
  // A still-awaited owner will publish this shared attempt once. If the owner
  // already timed out, promote its retained result to the network-change
  // observer so the eventual success/failure is not lost.
  if (joined === fetched && outlived?.fetched !== fetched) return [STUN]
  followOutlived(fetched, true, "network-change")
  return held ?? [STUN]
}

/**
 * A restored host bridge is a fresh chance to build the personhood proof.
 * Start it immediately so a mesh opening on the same edge joins `inflight`
 * and spends only the existing first-start budget before choosing STUN-only.
 */
export function retryIceServersAfterHostReconnect(
  signal?: AbortSignal,
): Promise<RTCIceServer[]> {
  return fetchIceServers(signal, "host-reconnect")
}

function logTurnRerun(source: TurnSource): void {
  if (source !== "host-reconnect" && source !== "foreground-return") return
  hostRetryRecord({ operation: "turn.ice-servers", attempt: source === "foreground-return" ? 1 : 2, reason: "turn", waitedMs: 0, error: source })
}

let foregroundRetryInstalled = false
let lastForegroundRetryAt = -Infinity
let stopForegroundRetry: (() => void) | null = null
// bumped by the test reset: a retry waiting on a fetch must not start another after it
let foregroundRetryGeneration = 0

/** For tests: drop the foreground listener and any retry still waiting, so one test's cannot fetch in the next. */
export function resetForegroundRetryForTests(): void {
  stopForegroundRetry?.()
  stopForegroundRetry = null
  foregroundRetryInstalled = false
  lastForegroundRetryAt = -Infinity
  foregroundRetryGeneration++
}

/**
 * Fetch TURN again when the app returns to the foreground while an open mesh
 * holds a STUN-only list. A resume can interrupt the host call that builds the
 * proof without any channel status change, and a proof failure is otherwise
 * never retried, so the phone would stay STUN only for the whole game.
 *
 * Only a STUN-only open mesh has a TURN observer registered (it removes it on
 * adoption), so that is the gate: before a game the warm-up and the mesh-open
 * fetch already cover it, and a relayed mesh needs nothing.
 *
 * The resume event can arrive before the host has rejected the interrupted
 * call. The retry would then join that doomed shared fetch and get its failure,
 * so it waits for it to settle and starts a fresh acquisition. A failed fetch
 * with nothing cached sets no cooldown (only a failed renewal of valid
 * credentials does), so the earlier failure never holds the retry back.
 */
export function retryIceServersOnForegroundReturn(): void {
  if (foregroundRetryInstalled) return
  foregroundRetryInstalled = true
  const stunOnlyMeshOpen = () => turnServerListeners.size > 0 && !valid(cached)
  stopForegroundRetry = watchForegroundReturn((value) => {
    if (value.awayMs === null || !stunOnlyMeshOpen()) return
    const generation = foregroundRetryGeneration
    void (async () => {
      if (inflight) await inflight.catch(() => undefined)
      // the wait may have been long, or the fetch may have landed
      if (generation !== foregroundRetryGeneration || !stunOnlyMeshOpen()) return
      // a player flicking between apps must not turn into a fetch each time
      if (deviceNowMs() - lastForegroundRetryAt < FOREGROUND_RETRY_MIN_MS) return
      lastForegroundRetryAt = deviceNowMs()
      await fetchIceServers(undefined, "foreground-return")
    })().catch((error) =>
      devLog("rtc", "TURN retry after foreground return failed", { detail: describeError(error) }, "warn"),
    )
  })
}

/** what goes into RTCConfiguration.iceServers: STUN + whatever TURN we got */
export async function fetchIceServers(signal?: AbortSignal, source: TurnSource = "mesh"): Promise<RTCIceServer[]> {
  if (signal?.aborted) return [STUN]
  const { turn, outcome, healthOrder } = await turnCredentials(source)
  // once per call (a mesh open, a warm-up or a retry), shared fetches and cache hits included
  void Promise.resolve(outcome).then((resolved) => emitOutcome(sourced(resolved, source), healthOrder))
  if (turn.length === 0) iceLog("[jollity-rtc] ICE: STUN-only — cross-network peers will not connect")
  else devLog("rtc", `[jollity-rtc] ICE: relayed — ${turn.length} TURN servers configured`)
  return [STUN, ...turn]
}

/** Pre-game acquisition for every registered player, including returning
 * players that never revisit the permission screen. */
export async function warmIceServers(signal?: AbortSignal): Promise<void> {
  await fetchIceServers(signal, "warmup")
}
