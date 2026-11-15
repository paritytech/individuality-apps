// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The on-device debug log: what an export holds, and what survives a restart.
 *
 * ONE STORE. Every devLog entry (lib/debug/log-store.ts) lands in a capped
 * in-memory buffer (this session's log, sized for a whole game with room to
 * spare: real game logs run 250 to 600 lines), and the lines of the GAME WINDOW
 * (handover to payoff) are also written, in small batches off the hot path, to
 * the chunk ring of lib/debug/log-chunks.ts (lib/debug/host-persist.ts) over
 * lib/host/storage.ts: host storage in a container, localStorage in a plain
 * development browser. That ring is what survives a restart, and an export (the
 * debug sheet, the end-of-game log, the late one) adds the earlier sessions'
 * lines from it to this session's memory.
 *
 * There is no IndexedDB store: every host container (web, iOS and Android)
 * deletes `window.indexedDB` on purpose, so it could only ever have run in a
 * development browser.
 *
 * WHAT LEAVES THE DEVICE. With no Sentry DSN in the build, nothing leaves it
 * except what the player exports from the debug sheet (Download / Copy). With
 * a DSN, every devLog line also leaves as a Sentry breadcrumb on the events
 * sent (lib/telemetry/breadcrumbs.ts), and the lines of the game window leave
 * as game-log parts (lib/telemetry/game-log.ts, game-log-outbox.ts). Lines
 * name co-players by their account, and may carry this player's own local
 * network addresses; ICE candidates are logged without addresses
 * (lib/webrtc/candidate-log.ts). docs/telemetry.md lists what is sent.
 *
 * - one `sessionId` (uuid) per page load; the ring carries earlier sessions' game lines
 * - rotation: the memory buffer drops its oldest lines past MEMORY_CAP_*; the ring
 *   overwrites its oldest chunk
 * - scrub guard: any string that looks like a 12+-word mnemonic is redacted
 *   before it is persisted (defense in depth — nothing should log one)
 *
 * CLIENT ONLY: touches window, navigator. `initTelemetry()` must run
 * from a client bootstrap (components/debug/debug-boot.tsx), never during SSR.
 */
import { watchPageHidden } from "../page-lifecycle"
import { withTimeout } from "../with-timeout"
import { hostPortParked } from "../host/container"
import { describeError } from "../host/error-detail"
import { knownDisplayName } from "../host/identity"
import { tryReadStoredString, writeStoredString } from "../host/storage"
import { describePage } from "../telemetry/environment"
import { APP_VERSION, DEBUG_LOGS, LOG_PRODUCT } from "./flag"
import { createHostPersist } from "./host-persist"
import { gameIndexOf, logFilename } from "./log-export"
import { addDevLogSink, devLog, type LogLevel, type SinkEntry } from "./log-store"
import { SESSION_ID } from "./session-id"
import { readWorkerEvidence } from "./worker-evidence"
import { readSessionLink, retainSessionLink } from "./session-link"

// re-exported for this module's callers; the id lives in ./session-id so
// lib/telemetry can read it without importing this module, which imports it back
export { SESSION_ID }

export interface TelemetryEntry {
  /** ms epoch */
  ts: number
  sessionId: string
  /** Capture identity shared by chunk, full-export and recovery copies. */
  lineId?: string
  /** build stamp — in every entry so log lines stay attributable on their own */
  version: string
  level: LogLevel
  tag: string
  message: string
  /** payload, JSON-parsed back on export when possible */
  data?: unknown
}

/** Record shape in the buffer and the ring — data pre-serialized, size for the caps. */
export interface StoredEntry {
  ts: number
  sessionId: string
  lineId?: string
  version: string
  level: LogLevel
  tag: string
  message: string
  data?: string
  size: number
}

const MAX_DATA_CHARS = 4_096
/** the in-memory buffer's caps: this session's whole log */
export const MEMORY_CAP_ENTRIES = 5_000
export const MEMORY_CAP_BYTES = 2 * 1024 * 1024

// -- storage ------------------------------------------------------------

/** The game window's copy of the log, in host storage (localStorage in a dev browser). */
const hostPersist = createHostPersist<StoredEntry>({
  read: (key) => tryReadStoredString(key),
  write: (key, value) => writeStoredString(key, value),
})
/** this session's log */
const memoryEntries: StoredEntry[] = []
let memoryBytes = 0

/** The one way a line enters the log: memory, and the ring's queue (which takes
 *  it only inside a game window). Neither waits on storage. */
function write(entry: StoredEntry): void {
  memoryEntries.push(entry)
  memoryBytes += entry.size
  hostPersist.enqueue(entry)
  capMemory()
}

/** trim below the caps by this slack, so a trim is one splice per ~500 lines
 *  and not one per line once the buffer is full */
const TRIM_SLACK_ENTRIES = 500
const TRIM_SLACK_BYTES = 256 * 1024

/** Drops the oldest in-memory lines once either cap plus its slack is passed,
 *  down to the cap itself. */
function capMemory(): void {
  if (memoryEntries.length <= MEMORY_CAP_ENTRIES + TRIM_SLACK_ENTRIES && memoryBytes <= MEMORY_CAP_BYTES + TRIM_SLACK_BYTES) return
  let drop = 0
  while (
    memoryEntries.length - drop > MEMORY_CAP_ENTRIES ||
    (memoryBytes > MEMORY_CAP_BYTES && drop < memoryEntries.length - 1)
  ) {
    memoryBytes -= memoryEntries[drop].size
    drop += 1
  }
  if (drop > 0) memoryEntries.splice(0, drop)
}

// -- write-through sink ---------------------------------------------------

function onDevLog(entry: SinkEntry): void {
  retainSessionLink(entry)
  const message = entry.message
  let data = entry.dataText()
  if (data !== undefined && data.length > MAX_DATA_CHARS) data = `${data.slice(0, MAX_DATA_CHARS)}…[truncated]`
  const stored: StoredEntry = {
    ts: entry.time,
    sessionId: SESSION_ID,
    lineId: `${SESSION_ID}:${entry.id}`,
    version: APP_VERSION,
    level: entry.level,
    tag: entry.tag,
    message,
    size: message.length + (data?.length ?? 0) + 96,
  }
  if (data !== undefined) stored.data = data
  // the game's first handover marker (lib/journeys/game-trace.ts noteGame) opens
  // the window the host-storage copy covers, the handover line included
  const handover = entry.tag === "telemetry" ? HANDOVER_MARKER.exec(message) : null
  if (handover) {
    persistingGame = Number(handover[1])
    hostPersist.activate()
  }
  write(stored)
}

const HANDOVER_MARKER = /^game (\d+) handover$/
/** the game of the newest handover marker this page saw, set synchronously at
 *  the marker, ahead of lib/telemetry/game-log.ts's async handover-list write */
let persistingGame: number | null = null

/** Every remembered game's log got a transport 2xx: stop queueing until the
 *  next handover. The stored lines STAY: a 2xx is not proof Sentry kept the
 *  event, and a rejoin or a human export still reads
 *  them. Game-aware: a delayed 2xx for game N that lands after game N+1's
 *  handover (whose list write may still be pending) must not stop N+1, so it
 *  stops only when the newest handover this page saw is among `sent`. */
export function stopPersistingLog(sent: readonly number[]): void {
  if (persistingGame !== null && !sent.includes(persistingGame)) return
  hostPersist.deactivate()
}

/** The next game's handover (lib/telemetry/game-log.ts): let go of the stored
 *  lines older than `before`. Never rejects. */
export function releasePersistedLogBefore(before: number): Promise<void> {
  return hostPersist.release(before)
}

// -- init ----------------------------------------------------------------

let knownAddress: string | null = null

/** Called by the doorway once the player address is known (game-source.ts), so
 *  an export is attributable to an account without logging it on every line. */
export function setTelemetryAddress(address: string | null): void {
  knownAddress = address
}

let initialized = false

export function initTelemetry(): void {
  if (initialized || !DEBUG_LOGS || typeof window === "undefined") return
  initialized = true
  addDevLogSink(onDevLog)

  // a page sent to the background may be killed there: write the batch now
  watchPageHidden(() => void hostPersist.flushNow())

  window.addEventListener("error", (event) => {
    devLog(
      "window",
      `uncaught error: ${event.message}`,
      event.error instanceof Error ? event.error.stack : `${event.filename}:${event.lineno}`,
      "error",
    )
  })
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason
    devLog(
      "window",
      `unhandled rejection: ${reason instanceof Error ? reason.message : describeError(reason)}`,
      reason instanceof Error ? reason.stack : undefined,
      "error",
    )
  })

  // app/environment snapshot, once per session
  devLog("session", `session ${SESSION_ID.slice(0, 8)} start`, {
    version: APP_VERSION,
    product: LOG_PRODUCT,
    ua: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    lang: navigator.language,
    ...describePage({
      hostname: location.hostname,
      protocol: location.protocol,
      userAgent: navigator.userAgent,
      inContainer: hostPortParked(),
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
    }),
  })
}

// -- stats / export / clear ------------------------------------------------

export interface TelemetryStats {
  count: number
  approxBytes: number
}

export function getTelemetryStats(): TelemetryStats {
  return { count: memoryEntries.length, approxBytes: memoryBytes }
}

/** How long an export waits for the ring's read before it takes what this
 *  session holds in memory: Web Share and the clipboard want the tap's gesture. */
const READ_WAIT_MS = 3_000

/** The earlier sessions' lines from the ring (null when it could not be read
 *  or was slow: this session's memory then stands alone), already range-filtered. */
function readEarlier(since?: number, until?: number): Promise<StoredEntry[] | null> {
  return withTimeout(hostPersist.readEarlier(since, until, SESSION_ID), READ_WAIT_MS).catch((error: unknown) => {
    devLog("telemetry", "earlier sessions could not be read for the export", { detail: describeError(error) }, "warn")
    return null
  })
}

function toExportEntry(stored: Omit<StoredEntry, "size">): TelemetryEntry {
  const entry: TelemetryEntry = {
    ts: stored.ts,
    sessionId: stored.sessionId,
    ...(stored.lineId ? { lineId: stored.lineId } : {}),
    version: stored.version ?? "unknown",
    level: stored.level,
    tag: stored.tag,
    message: stored.message,
  }
  if (stored.data !== undefined) {
    try {
      entry.data = JSON.parse(stored.data) as unknown
    } catch {
      entry.data = stored.data
    }
  }
  return entry
}

// Web Share and the clipboard only work shortly after the tap, so a host that
// is slow to answer must not hold the export past that.
const NAME_LOOKUP_TIMEOUT_MS = 1_000

function exportUsername(): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), NAME_LOOKUP_TIMEOUT_MS))
  return Promise.race([knownDisplayName().catch(() => null), timeout])
}

/** Build the export payload (all sessions, or those entries at or after
 *  `since`) as a JSON string. The manual export takes everything; the
 *  end-of-game log (lib/telemetry/game-log.ts) takes the game's own. */
export async function buildLogsExport(
  range: { since?: number; until?: number } = {},
  extra: Record<string, unknown> = {},
): Promise<{ json: string; count: number; filename: string }> {
  const { since, until } = range
  // Worker permission and booking happen before handover, so their own bounded
  // evidence is deliberately not filtered to this app-log window.
  const [earlier, username, worker] = await Promise.all([
    readEarlier(since, until),
    exportUsername(),
    withTimeout(readWorkerEvidence(), READ_WAIT_MS).catch((error: unknown) => {
      devLog("telemetry", "worker evidence could not be read for the export", { detail: describeError(error) }, "warn")
      return null
    }),
  ])
  // the ring is range-filtered by its read; the memory buffer is filtered here
  const inRange = (entry: StoredEntry) => (since === undefined || entry.ts >= since) && (until === undefined || entry.ts < until)
  const stored = [...(earlier ?? []), ...memoryEntries.filter(inRange)]
  const entries = stored.map(toExportEntry)
  // A startup link can precede `since` or have fallen out of the memory cap.
  // Keep only that bounded identity outside the game window, not pre-game logs.
  const sessionLinks = entries.filter((entry) => entry.tag === "replay" && entry.message === "session.link")
  const link = readSessionLink()
  if (link && entries.some((entry) => entry.sessionId === link.sessionId)
    && (until === undefined || link.ts < until) && !sessionLinks.some((entry) => entry.lineId === link.lineId)) {
    sessionLinks.push(toExportEntry(link))
  }
  const exportedAt = new Date()
  const gameIndex = gameIndexOf(entries)
  const meta = {
    app: "jollity",
    version: APP_VERSION,
    product: LOG_PRODUCT,
    ua: navigator.userAgent,
    exportedAt: exportedAt.toISOString(),
    sessionId: SESSION_ID,
    address: knownAddress,
    username,
    gameIndex,
    entryCount: entries.length,
    // what one real-device run needs to tell a store that lost the earlier
    // sessions from a window that skipped them
    store: earlier ? "ring+memory" : "memory",
    sessionCount: new Set(entries.map((entry) => entry.sessionId)).size,
    sessionLinks,
  }
  return {
    json: JSON.stringify({ meta, entries, worker, ...extra }, null, 1),
    count: entries.length,
    filename: logFilename({ exportedAt, gameIndex, username, address: knownAddress, version: APP_VERSION }),
  }
}

/** How the export left the browser, for the caller's confirmation note. */
export type SaveOutcome = "shared" | "downloaded" | "failed"

/**
 * Save ALL persisted entries (all sessions) as a JSON file.
 *
 * On a touch device (the phone in the host WebView) the ACTUAL FILE goes to the
 * native share sheet via the Web Share API — the only path that yields a
 * populated sheet (save to Files/iCloud, or send to a messenger). The classic
 * `<a download>` blob-anchor is a trap there: WKWebView hands the blob URL to
 * an empty QuickLook preview the user cannot back out of.
 *
 * On desktop (no coarse pointer) the anchor download is what's wanted — a file
 * straight to Downloads — so that is the path taken. `copyLogs` stays the
 * always-works fallback for a host that exposes neither.
 */
export async function downloadLogs(): Promise<SaveOutcome> {
  const { json, count, filename } = await buildLogsExport()

  // Touch device → the native share sheet with the real file. Gated on a coarse
  // pointer so desktop keeps its plain download.
  const file = new File([json], filename, { type: "application/json" })
  const touch =
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 ||
      (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches))
  if (touch && typeof navigator.share === "function" && navigator.canShare?.({ files: [file] })) {
    try {
      // files ONLY — no title/text. Some targets (Signal) take a title as the
      // message body and drop the file; with just the file they attach it, and
      // "Save to Files"/iCloud still gets the real file.
      await navigator.share({ files: [file] })
      devLog("telemetry", `shared ${count} log entries`)
      return "shared"
    } catch (err) {
      // AbortError = the user dismissed the sheet; that is a completed share,
      // not a failure — do NOT fall back to the trapping anchor.
      if (err instanceof DOMException && err.name === "AbortError") return "shared"
      /* share unavailable/denied — fall through to the anchor download */
    }
  }

  // Desktop (and hosts without Web Share): the classic blob-anchor download.
  try {
    const blob = new Blob([json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    devLog("telemetry", `downloaded ${count} log entries`)
    return "downloaded"
  } catch {
    devLog("telemetry", "download blocked — use Copy", undefined, "warn")
    return "failed"
  }
}

/**
 * Copy the full log export to the clipboard — the host-sandbox-safe path. Tries
 * the async Clipboard API, then the `execCommand` textarea fallback (which works
 * under a user gesture where the Clipboard API is policy-blocked). Returns
 * `{ ok, text }`; on `ok: false` the caller should reveal `text` in a selectable
 * field so the user can copy manually.
 */
export async function copyLogs(): Promise<{ ok: boolean; text: string }> {
  const { json, count } = await buildLogsExport()
  try {
    await navigator.clipboard.writeText(json)
    devLog("telemetry", `copied ${count} log entries to clipboard`)
    return { ok: true, text: json }
  } catch {
    /* Clipboard API blocked (common in the host iframe) — fall through */
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = json
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0"
    document.body.append(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand("copy")
    ta.remove()
    if (ok) {
      devLog("telemetry", `copied ${count} log entries (execCommand)`)
      return { ok: true, text: json }
    }
  } catch {
    /* execCommand unavailable — fall through to manual reveal */
  }
  devLog("telemetry", "clipboard blocked — logs returned for manual copy", undefined, "warn")
  return { ok: false, text: json }
}

/** Wipe the log: this session's memory and the ring (the caller confirms first). */
export function clearTelemetry(): Promise<void> {
  memoryEntries.length = 0
  memoryBytes = 0
  return hostPersist.clear().catch(() => {})
}
