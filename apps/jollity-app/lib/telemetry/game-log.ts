// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE END-OF-GAME LOG. This device's log from the handover on, in the shape of
 * the manual export, split into independently acknowledged parts in the game's
 * trace and retained by the durable outbox until every part lands. By default
 * the parts go as Sentry Log records (game-log-outbox.ts); with
 * NEXT_PUBLIC_TELEMETRY_LOGS=0 they go as `game-log` events with a JSON
 * attachment. It goes twice on a clean game, as two independent copies. The
 * first leaves the moment the report lands (stage "report"): a page can freeze
 * right after that (seen on an iOS webview) and never reach the card, and the
 * whole log would be lost with it. The second leaves when journey.payoff ends
 * (stage "payoff"), fuller. Each stage is its own in-flight slot: neither waits
 * on the other, so a stuck report send cannot eat the payoff's deadline. A
 * reader keeps the fullest copy per player.
 *
 * THE BONUS-COPY RULE: the report copy settles nothing. It does not mark the
 * game sent, does not prune the delivery-health record and never clears the
 * persisted log, so a reload mid-game still finds its pre-reload lines and the
 * payoff or late copy is the full log. Only those two settle the game
 * (mark it sent, and stop queueing the persisted log once every game has gone
 * out).
 *
 * THE RING IS KEPT UNTIL THE NEXT GAME: a transport 2xx is not proof Sentry
 * stored the event (a phone whose payoff log never arrived has been seen with
 * an empty ring, wiped by that 2xx). A delivery therefore never deletes the
 * persisted lines. The next game's FIRST handover releases the lines older
 * than the earliest game still owed (that game, or an older one never marked
 * sent, which its late upload still needs); a rejoin of the same game
 * releases nothing. Between those, the ring's own fixed size bounds it. The
 * sent list still suppresses a resend: a kept ring is for a rejoin and a
 * human export, never an automatic upload.
 *
 * Every event carries `game_log.stage`: "report" and "payoff" as above, "late"
 * for the next-open upload below.
 *
 * A late upload is skipped while ANY send of its game is in flight.
 *
 * A game that did not end cleanly (abandoned, isolated, the app closed) is
 * sent on the next open instead, tagged `game_log.late`. The local store
 * remembers which games went out, and only a delivery the transport
 * confirmed counts: an envelope still queued for retry or offline is not sent.
 *
 * A game starts at its FIRST handover. A restart mid-game logs the handover
 * again at the rejoin, and the entries of the first session are still stored
 * (the chunk ring in host storage, or localStorage in a dev browser,
 * lib/debug/host-persist.ts, which buildLogsExport reads for the window), so
 * the earliest `at` per game wins, both in the stored list and in the
 * export's start. A failed read of the list skips the write: it must never
 * be mistaken for an empty list and overwritten.
 */
import { addDevLogSink, devLog } from "../debug/log-store"
import { buildLogsExport, releasePersistedLogBefore, stopPersistingLog } from "../debug/telemetry"
import { withTimeout } from "../with-timeout"
import { describeError } from "../host/error-detail"
import { readStoredString, tryReadStoredString, writeStoredString } from "../host/storage"
import { closeDeliveryHealthGameIfOpen, markDeliveryHealthLogSent } from "./delivery-health"
import { deliveryHealthFields, settledGameLogHealth } from "./health-event"
import {
  checkpointGameLog,
  drainGameLogOutbox,
  enqueueFullGameLog,
  gameLogManifest,
  hasPendingFullGameLog,
  setFullGameLogDeliveredHandler,
} from "./game-log-outbox"

export interface GameLogRequest {
  gameIndex: number
  /** wall ms of the handover: entries before it are not this game's. The
   *  game's earliest stored handover wins when it is older (a restart). */
  since: number
  /** wall ms, exclusive: the next game's handover, for a late upload of an
   *  older game, so the log does not run on into the following game */
  until?: number
  /** which send this is, tagged `game_log.stage` (and `game_log.late` for
   *  "late"). Set by the caller for "report" and "payoff", by this module for
   *  "late". Each stage of a game is its own in-flight slot. */
  stage: "report" | "payoff" | "late"
  trace: { traceId: string; spanId: string } | null
}

/** how long a caller waits for the answer; the delivery itself is followed
 *  much longer, so a late one still marks the game sent */
const DELIVERY_TIMEOUT_MS = 60_000
/** a handover this old is a game that is over */
export const LATE_AFTER_MS = 15 * 60_000
/** the late upload waits this long after start so persisted state is ready */
export const LATE_UPLOAD_DELAY_MS = 15_000

const SENT_KEY = "jollity.telemetry.game-logs-sent"
const HANDOVER_KEY = "jollity.telemetry.last-handover"
const SENT_KEEP = 20
/** handovers remembered: the games a device could still owe a late upload */
const HANDOVER_KEEP = 5

/** the sends captured and not yet settled this session, as `game:stage`: the
 *  same send twice would park another copy. Report and payoff are independent
 *  slots; a late upload or flush of the game waits out both (gameInFlight). */
const inFlight = new Set<string>()
const slot = (request: GameLogRequest): string => `${request.gameIndex}:${request.stage}`
const gameInFlight = (gameIndex: number): boolean => [...inFlight].some((key) => key.startsWith(`${gameIndex}:`))
const fullLogInFlight = (gameIndex: number): boolean => inFlight.has(`${gameIndex}:late`) || inFlight.has(`${gameIndex}:flush`)

/** Host storage in a container (it survives a webview cache clear), the page's
 *  localStorage anywhere else (lib/chest-picks.ts keeps its key the same way
 *  in host storage alone). Null when neither holds the key. */
async function readStored(key: string): Promise<unknown> {
  const raw = await readStoredString(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

async function writeStored(key: string, value: unknown): Promise<void> {
  await writeStoredString(key, JSON.stringify(value))
}

export async function readSentGames(): Promise<number[]> {
  const raw = await readStored(SENT_KEY)
  return Array.isArray(raw) ? raw.filter((value): value is number => typeof value === "number") : []
}

let sentWrites: Promise<void> = Promise.resolve()

export function markGameLogSent(gameIndex: number): Promise<void> {
  const write = sentWrites.then(async () => {
    const next = [...(await readSentGames()).filter((index) => index !== gameIndex), gameIndex].slice(-SENT_KEEP)
    await writeStored(SENT_KEY, next)
    // once every remembered game has gone out, stop queueing post-game lines
    // into the ring (lib/debug/host-persist.ts); what it holds stays until the
    // next game's handover releases it, because a 2xx is not proof of storage
    const handovers = await readHandovers()
    if (handovers.every((handover) => next.includes(handover.gameIndex))) stopPersistingLog(next)
  })
  sentWrites = write.catch(() => {})
  return write
}

setFullGameLogDeliveredHandler(({ gameIndex, stage }) => {
  // The report copy is a bonus: it settles nothing, so payoff/late/flush still
  // persists and sends the fullest document even when report arrived first.
  if (stage === "report") return
  return markGameLogSent(gameIndex)
    .then(() => markDeliveryHealthLogSent(gameIndex))
    .catch(() => {})
})

export interface Handover {
  gameIndex: number
  /** wall ms */
  at: number
  /** wall ms derived from the chain's report_ends and clock offset */
  endsAt?: number
}

const HANDOVER = /^game (\d+) handover$/

/** Folds a handover in: one entry per game, keeping its earliest `at`; the
 *  list holds the HANDOVER_KEEP most recently first-seen games, oldest first. */
function withHandover(list: Handover[], next: Handover): Handover[] {
  const known = list.find((handover) => handover.gameIndex === next.gameIndex)
  if (!known) return [...list, next].slice(-HANDOVER_KEEP)
  const endsAt = next.endsAt ?? known.endsAt
  const merged: Handover = {
    gameIndex: known.gameIndex,
    at: Math.min(known.at, next.at),
    ...(endsAt === undefined ? {} : { endsAt }),
  }
  if (merged.at === known.at && merged.endsAt === known.endsAt) return list
  return list.map((handover) => (handover === known ? merged : handover))
}

/** Writes are chained: each is a read-modify-write on one key, and the sink
 *  fires per devLog line, so two lines close together must not interleave. */
let handoverWrites: Promise<void> = Promise.resolve()

/** The devLog sink that remembers the handover markers (lib/journeys/
 *  game-trace.ts `noteGame`) under their own small key, so the late upload
 *  does not have to read the whole stored log to find them. */
export function installHandoverSink(): () => void {
  return addDevLogSink((entry) => {
    if (entry.tag !== "telemetry") return
    const match = HANDOVER.exec(entry.message)
    if (!match) return
    const at = (entry.data as { at?: unknown } | undefined)?.at
    const endsAt = (entry.data as { endsAt?: unknown } | undefined)?.endsAt
    const handover: Handover = {
      gameIndex: Number(match[1]),
      at: typeof at === "number" ? at : entry.time,
      ...(typeof endsAt === "number" ? { endsAt } : {}),
    }
    handoverWrites = handoverWrites
      .then(async () => {
        const list = await readHandoversChecked()
        if (!list) return
        const next = withHandover(list, handover)
        if (next !== list) await writeStored(HANDOVER_KEY, next)
        // a NEW game (not a rejoin) releases the ring's older lines, up to the
        // earliest game still owed a log
        if (list.some((known) => known.gameIndex === handover.gameIndex)) return
        // neither the sent list's read nor the release may hold back the next
        // marker: an unanswered read keeps every game as owed (keeps more)
        const sent = (await withTimeout(readSentGames(), 3_000)) ?? []
        const owed = next.filter((known) => known.gameIndex !== handover.gameIndex && !sent.includes(known.gameIndex))
        void releasePersistedLogBefore(Math.min(handover.at, entry.time, ...owed.map((known) => known.at)))
      })
      .catch((error: unknown) => {
        devLog("gamelog", "handover marker could not be stored", { detail: describeError(error) }, "warn")
      })
  })
}

function asHandover(raw: unknown): Handover | null {
  const value = raw as Partial<Handover> | null
  return typeof value?.gameIndex === "number" && typeof value.at === "number"
    ? { gameIndex: value.gameIndex, at: value.at, ...(typeof value.endsAt === "number" ? { endsAt: value.endsAt } : {}) }
    : null
}

/** The remembered handovers, oldest game first. A device updated mid-way holds
 *  the old single-object value, which reads as a one-entry list. */
export async function readHandovers(): Promise<Handover[]> {
  return (await readHandoversChecked()) ?? []
}

/** Null when the read failed, so a writer can tell it from an empty list. */
async function readHandoversChecked(): Promise<Handover[] | null> {
  const read = await tryReadStoredString(HANDOVER_KEY)
  if (!read.ok) return null
  let raw: unknown = null
  try {
    raw = read.value === null ? null : (JSON.parse(read.value) as unknown)
  } catch {
    /* an unparseable value reads as empty, as readStored does */
  }
  const items = Array.isArray(raw) ? raw : [raw]
  return items.flatMap((item) => asHandover(item) ?? [])
}

export async function readLastHandover(): Promise<Handover | null> {
  return (await readHandovers()).at(-1) ?? null
}

export async function uploadGameLog(request: GameLogRequest, deadlineMs = DELIVERY_TIMEOUT_MS): Promise<boolean> {
  const key = slot(request)
  const taken = request.stage === "late" ? gameInFlight(request.gameIndex) : inFlight.has(key) || fullLogInFlight(request.gameIndex)
  if (taken) return false
  if (hasPendingFullGameLog(request.gameIndex)) {
    void drainGameLogOutbox(true)
    return false
  }
  inFlight.add(key)
  // Capture first. None of the host-backed metadata reads below may stand
  // between a devLog line and its durable, host-independent chunk.
  checkpointGameLog(request.stage, Date.now(), request.gameIndex)
  try {
    return (await withTimeout(send(request), deadlineMs)) ?? false
  } finally {
    // The delivery follower may continue and settle bookkeeping after the
    // caller's deadline, but a hung preparation can never own the slot forever.
    inFlight.delete(key)
  }
}

async function send(request: GameLogRequest): Promise<boolean> {
  return (async () => {
    const [handovers, health] = await Promise.all([
      withTimeout(readHandovers(), 3_000).then((value) => value ?? []),
      withTimeout(settledGameLogHealth(request.gameIndex), 3_000).then((value) => value ?? null),
    ])
    const known = handovers.find((handover) => handover.gameIndex === request.gameIndex)
    const since = known ? Math.min(request.since, known.at) : request.since
    const { json, filename } = await buildLogsExport(
      { since, ...(request.until === undefined ? {} : { until: request.until }) },
      {
        ...(health ? { telemetryHealth: { ...deliveryHealthFields(health.game), session: deliveryHealthFields(health.session) } } : {}),
        gameLogManifest: gameLogManifest(request.gameIndex),
      },
    )
    return enqueueFullGameLog({
      gameIndex: request.gameIndex,
      stage: request.stage,
      trace: request.trace,
      filename,
      json,
    })
  })()
    .catch((error: unknown) => {
      devLog("gamelog", `game ${request.gameIndex} log delivery bookkeeping failed`, { detail: describeError(error) }, "warn")
      return false
    })
}

/** Close durable health only for games old enough to be over. A rejoin before
 * kickoff stays active and accumulates into the same eventual summary. */
const handoverEnded = (handover: Handover, now: number): boolean =>
  handover.endsAt === undefined ? now - handover.at >= LATE_AFTER_MS : now >= handover.endsAt

export async function closeExpiredDeliveryHealth(now = Date.now()): Promise<void> {
  for (const handover of await readHandovers()) {
    // The handover list deliberately outlives a successful upload. Delivery
    // health may already have sent or pruned its record, so close only a live
    // unsent record instead of inferring health state from game-log delivery.
    if (handoverEnded(handover, now)) await closeDeliveryHealthGameIfOpen(handover.gameIndex)
  }
}

/** Every remembered game whose log never went out and which is over, oldest
 *  first and one at a time. An older game's log stops at the next game's
 *  handover. True when at least one went out. */
export async function uploadLateGameLog(now = Date.now()): Promise<boolean> {
  const handovers = await readHandovers()
  const sent = await readSentGames()
  let any = false
  for (const [position, handover] of handovers.entries()) {
    if (gameInFlight(handover.gameIndex)) continue
    if (sent.includes(handover.gameIndex)) continue
    if (hasPendingFullGameLog(handover.gameIndex)) {
      void drainGameLogOutbox(true)
      continue
    }
    if (!handoverEnded(handover, now)) continue
    const until = handovers[position + 1]?.at
    // a restart can make the next game's earliest handover older than this
    // one's; an empty window is not worth a send
    if (until !== undefined && until <= handover.at) continue
    if (await uploadGameLog({ gameIndex: handover.gameIndex, since: handover.at, ...(until === undefined ? {} : { until }), stage: "late", trace: null })) any = true
  }
  return any
}
