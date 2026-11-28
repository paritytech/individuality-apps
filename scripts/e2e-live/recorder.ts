// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The Playwright side of the recording (the pure side is record.ts): per bot,
// a tile timeline every 250 ms (tiles-N.jsonl), screenshots on each stage
// change and every 2 s, and the app's devLog read back through the page's
// own export (window.__jollityHarness).
//
// It only WATCHES. It never clicks and never changes what the bot does; the
// tap loop in journey.pw.ts reads the page through the same `readPage` and
// calls `tapped()` so a tick can say which tile the bot pressed and what the
// click did.
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BrowserContext, Page } from "@playwright/test"
import { RING_SLOTS } from "../../apps/jollity-app/lib/debug/log-chunks"
import { FLUSH_INTERVAL_MS } from "../../apps/jollity-app/lib/debug/host-persist"
import { RoundTracker, parseExport, parseRotY, parseRotateY, readStage, shotName, voteTrail, type LogLine, type TileRow, type VoteTrail } from "./record"
import type { DevlogEvidence } from "./guards"
import type { AdaptiveUploadResult, TelemetryGroundTruth } from "./result"

export const TICK_MS = 250
export const SHOT_EVERY_MS = 2000
/** screenshots per bot: the 2 s ones stop here, stage-change ones get headroom */
export const SHOT_CAP = 200
const STAGE_SHOT_HEADROOM = 100
/** Leaves headroom beneath the strict 2 s authoritative-evidence ceiling for
 * the next DOM snapshot. Critical-phase deferral is the primary guarantee;
 * the native timeout bounds the Playwright caller and has a browser recovery
 * probe, but does not claim universal renderer-task cancellation. */
export const SHOT_OPERATION_TIMEOUT_MS = 1000

export interface TelemetryStorageState {
  origins?: { origin?: string; localStorage?: { name: string; value: string }[] }[]
}

export const GAME_LOG_TAIL_SETTLE_MS = 300
export const RELAUNCH_STORAGE_RESERVE_MS = 2_000
const RELAUNCH_FALLBACK_RESERVE_MS = 300

const timed = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Give preparatory page evidence only its share of the retirement budget, so
 * a slow dev-log export cannot consume the browser-storage snapshot reserve. */
export async function captureWithReservedRelaunchBudget<T>(options: {
  budgetMs: number
  reserveMs?: number
  prepare(budgetMs: number): Promise<void>
  capture(budgetMs: number, preparationTimedOut: boolean): Promise<T>
}): Promise<{ preparationError?: Error; snapshot: T }> {
  const started = Date.now()
  const totalMs = Math.max(1, options.budgetMs)
  const reserveMs = Math.min(totalMs, Math.max(1, options.reserveMs ?? RELAUNCH_STORAGE_RESERVE_MS))
  const preparationMs = Math.max(0, totalMs - reserveMs)
  let preparationError: Error | undefined
  let preparationTimedOut = false
  if (preparationMs === 0) preparationError = new Error("pre-relaunch page evidence skipped: storage snapshot owns the remaining budget")
  else {
    try {
      await timed(options.prepare(preparationMs), preparationMs, "pre-relaunch page evidence")
    } catch (error) {
      preparationError = error instanceof Error ? error : new Error(String(error))
      preparationTimedOut = /timed out/.test(preparationError.message)
    }
  }
  const remainingMs = Math.max(1, totalMs - (Date.now() - started))
  // The capture owns its deadline. An outer Promise.race could return while a
  // timed-out capture still owns Debugger.pause, racing Page.crash and hanging
  // the profile. It must resume before this promise resolves.
  const snapshot = await options.capture(remainingMs, preparationTimedOut)
  return { ...(preparationError ? { preparationError } : {}), snapshot }
}

export interface RelaunchStorageCapture {
  checkpointed: boolean
  storage: Awaited<ReturnType<BrowserContext["storageState"]>>
  checkpointError?: string
  pendingTailLines?: number
  newestTailLineAgeMs?: number | null
}

/** A failed durability proof is fatal only when production's 250 ms debounce
 * plus its 50 ms observation margin has already elapsed. */
export function staleUndurableTailError(capture: Pick<RelaunchStorageCapture, "checkpointed" | "pendingTailLines" | "newestTailLineAgeMs">): string | undefined {
  if (capture.checkpointed || !capture.pendingTailLines || capture.newestTailLineAgeMs === null || capture.newestTailLineAgeMs === undefined) return undefined
  if (capture.newestTailLineAgeMs < GAME_LOG_TAIL_SETTLE_MS) return undefined
  return `${capture.pendingTailLines} required line(s) remained unsaved ${Math.round(capture.newestTailLineAgeMs)} ms after the newest line`
}

/** Let production's normal active-tail debounce run, pause the renderer, prove
 * the in-memory tail exactly matches its durable copy while paused, then take
 * the browser snapshot before resuming. A line that races in before the pause
 * makes checkpointed false; no line can race between the proof and snapshot.
 * Failures in page evaluation or debugger control never suppress storageState. */
export async function captureRelaunchStorage(
  page: Page,
  context: Pick<BrowserContext, "cookies" | "newCDPSession" | "storageState">,
  options: { settleMs?: number; pauseTimeoutMs?: number; budgetMs?: number; allowPause?: boolean } = {},
): Promise<RelaunchStorageCapture> {
  const deadline = Date.now() + Math.max(1, options.budgetMs ?? RELAUNCH_STORAGE_RESERVE_MS)
  const remaining = (reserveMs = 0) => Math.max(1, deadline - Date.now() - reserveMs)
  const within = <T,>(promise: Promise<T>, label: string, capMs?: number, reserveMs = 0) =>
    timed(promise, Math.max(1, Math.min(remaining(reserveMs), capMs ?? Number.POSITIVE_INFINITY)), label)
  let checkpointed = false
  let checkpointError: string | undefined
  let pendingTailLines: number | undefined
  let newestTailLineAgeMs: number | null | undefined
  let baseline: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined
  let pausedStorage: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined
  let cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | undefined
  let paused = false
  let pauseRequested = false
  try {
    // Preserve cookies and every origin even if the renderer starts dying
    // before the settle/pause seam. The current origin is replaced below by
    // one atomic read from the paused call frame.
    baseline = await within(context.storageState(), "baseline storage snapshot", undefined, RELAUNCH_FALLBACK_RESERVE_MS)
    const settledTail = await within(page.evaluate(async (settleMs) => {
      await new Promise<void>((resolve) => setTimeout(resolve, settleMs))
      return (globalThis as unknown as { __jollityHarness?: { gameLogTailState?(): { durable: boolean; pendingLines: number; newestLineAgeMs: number | null } } }).__jollityHarness?.gameLogTailState?.() ?? null
    }, options.settleMs ?? GAME_LOG_TAIL_SETTLE_MS), "game-log tail settle", (options.settleMs ?? GAME_LOG_TAIL_SETTLE_MS) + 100, RELAUNCH_FALLBACK_RESERVE_MS)
    if (settledTail) {
      checkpointed = settledTail.durable === true
      pendingTailLines = settledTail.durable === true ? 0 : typeof settledTail.pendingLines === "number" ? settledTail.pendingLines : undefined
      newestTailLineAgeMs = settledTail.durable === true ? null : typeof settledTail.newestLineAgeMs === "number" || settledTail.newestLineAgeMs === null ? settledTail.newestLineAgeMs : undefined
    }
    if (options.allowPause === false) throw new Error("renderer pause skipped because preparatory page evidence timed out")
    cdp = await within(context.newCDPSession(page), "debugger session", undefined, RELAUNCH_FALLBACK_RESERVE_MS)
    await within(cdp.send("Debugger.enable"), "debugger enable", undefined, RELAUNCH_FALLBACK_RESERVE_MS)
    const pausedEvent = new Promise<{ callFrames: Array<{ callFrameId: string }> }>((resolve) => {
      cdp!.once("Debugger.paused", (event) => resolve(event as { callFrames: Array<{ callFrameId: string }> }))
    })
    pauseRequested = true
    await within(cdp.send("Debugger.pause"), "renderer pause request", undefined, RELAUNCH_FALLBACK_RESERVE_MS)
    const event = await within(pausedEvent, "renderer pause", options.pauseTimeoutMs ?? 1_000, RELAUNCH_FALLBACK_RESERVE_MS)
    paused = true
    const frame = event.callFrames[0]
    if (!frame) throw new Error("renderer paused with no call frames")
    {
      const result = await within(cdp.send("Debugger.evaluateOnCallFrame", {
        callFrameId: frame.callFrameId,
        expression: `(() => ({
          tail: globalThis.__jollityHarness?.gameLogTailState?.() ?? {
            durable: globalThis.__jollityHarness?.gameLogTailDurable?.() === true,
            pendingLines: 0,
            newestLineAgeMs: null,
          },
          origin: location.origin,
          localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })),
        }))()`,
        returnByValue: true,
      }), "paused storage read", undefined, RELAUNCH_FALLBACK_RESERVE_MS) as { result?: { value?: { tail?: { durable?: unknown; pendingLines?: unknown; newestLineAgeMs?: unknown }; origin?: unknown; localStorage?: unknown } } }
      const value = result.result?.value
      if (typeof value?.origin !== "string" || !Array.isArray(value.localStorage)) throw new Error("paused localStorage snapshot unavailable")
      checkpointed = value.tail?.durable === true
      pendingTailLines = typeof value.tail?.pendingLines === "number" ? value.tail.pendingLines : undefined
      newestTailLineAgeMs = typeof value.tail?.newestLineAgeMs === "number" || value.tail?.newestLineAgeMs === null ? value.tail.newestLineAgeMs : undefined
      const cookies = await within(context.cookies(), "latest cookie snapshot", undefined, RELAUNCH_FALLBACK_RESERVE_MS)
      const origins = [
        ...(baseline.origins ?? []).filter((entry) => entry.origin !== value.origin),
        { origin: value.origin, localStorage: value.localStorage as Array<{ name: string; value: string }> },
      ]
      pausedStorage = { cookies, origins }
    }
  } catch (error) {
    checkpointed = false
    checkpointError = String(error).split("\n")[0]
  } finally {
    if (cdp) {
      // Never let the caller proceed to Page.crash until a requested pause is
      // explicitly released. Cleanup is deliberately not cut short by the
      // capture deadline.
      if (paused || pauseRequested) await cdp.send("Debugger.resume").catch(() => {})
      await cdp.send("Debugger.disable").catch(() => {})
      await cdp.detach().catch(() => {})
    }
  }

  let fallback: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined
  if (!pausedStorage) {
    try {
      fallback = await within(context.storageState(), "post-settle fallback storage snapshot")
    } catch (error) {
      const fallbackError = String(error).split("\n")[0]
      checkpointError = checkpointError ? `${checkpointError}; ${fallbackError}` : fallbackError
    }
  }
  const storage = pausedStorage ?? fallback ?? baseline
  if (!storage) throw new Error(checkpointError ?? "relaunch storage snapshot unavailable")
  return {
    checkpointed,
    storage,
    ...(checkpointError ? { checkpointError } : {}),
    ...(pendingTailLines === undefined ? {} : { pendingTailLines }),
    ...(newestTailLineAgeMs === undefined ? {} : { newestTailLineAgeMs }),
  }
}

/** T6 must prove that at least one record present before replacement boot was
 * delivered by that replacement document. This prevents a dying page's
 * pre-freeze grace period from masquerading as next-open recovery. */
export async function proveNextOpenGameLogDelivery(page: Page, timeoutMs = 10_000): Promise<{ pending: number; delivered: number }> {
  const result = await timed(page.evaluate(async (waitMs) => {
    const key = "jollity.telemetry.game-log-outbox.v1"
    const prefix = `${key}.chunk.`
    const before = (globalThis as { __e2eTelemetryBeforeBoot?: StorageRecord[] }).__e2eTelemetryBeforeBoot ?? []
    const ids = before.flatMap((record) => {
      if (!record.name.startsWith(prefix)) return []
      try {
        const parsed = JSON.parse(record.value) as { id?: unknown } | null
        return typeof parsed?.id === "string" ? [parsed.id] : []
      } catch {
        return []
      }
    })
    const deadline = performance.now() + waitMs
    let delivered = 0
    do {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as { delivered?: Array<{ id?: unknown }> } | null
        const receipts = new Set((parsed?.delivered ?? []).flatMap((receipt) => typeof receipt.id === "string" ? [receipt.id] : []))
        delivered = ids.filter((id) => receipts.has(id)).length
      } catch {
        delivered = 0
      }
      if (delivered > 0 || performance.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    } while (true)
    return { pending: ids.length, delivered }
  }, Math.max(0, timeoutMs - 100)), timeoutMs, "next-open game-log delivery")
  if (result.pending < 1) throw new Error("T6 NOT PROVEN: replacement boot found no pending game-log record from the killed document")
  if (result.delivered < 1) throw new Error(`T6 NOT PROVEN: replacement page delivered 0/${result.pending} pending game-log record(s)`)
  return result
}

const GAME_LOG_OUTBOX_KEY = "jollity.telemetry.game-log-outbox.v1"
const GAME_LOG_CHUNK_KEY_PREFIX = `${GAME_LOG_OUTBOX_KEY}.chunk.`

const gameLogDeliveryInit = () => {
  ;(globalThis as { __jollityGameLogToSentry?: true }).__jollityGameLogToSentry = true
}

const telemetryRecoveryInit = () => {
  const outboxKey = "jollity.telemetry.game-log-outbox.v1"
  const chunkPrefix = `${outboxKey}.chunk.`
  const records: StorageRecord[] = []
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const name = localStorage.key(index)
      if (name !== outboxKey && !name?.startsWith(chunkPrefix)) continue
      const value = localStorage.getItem(name)
      if (name && value !== null) records.push({ name, value })
    }
  } catch {
    /* diagnosed through the reopened export */
  }
  ;(globalThis as { __e2eTelemetryBeforeBoot?: StorageRecord[] }).__e2eTelemetryBeforeBoot = records
}

/** Capture browser-local outbox evidence before application startup can drain it. */
export async function installTelemetryRecoveryInit(context: Pick<BrowserContext, "addInitScript">): Promise<void> {
  await context.addInitScript(telemetryRecoveryInit)
}

/** Opt every document created by this context into game-log delivery. This
 * must finish before context.newPage(), because app startup can drain logs
 * retained by a document that a torture profile killed. */
export async function installGameLogDeliveryInit(
  context: Pick<BrowserContext, "addInitScript">,
  enabled = process.env.GAME_LOG_TO_SENTRY === "1",
): Promise<void> {
  if (!enabled) return
  await context.addInitScript(gameLogDeliveryInit)
}

/** Opt a bot document into game-log delivery. The init script covers every
 * future navigation; evaluate covers a document the recorder already owns. */
export async function installGameLogDeliveryFlag(
  page: Page,
  enabled = process.env.GAME_LOG_TO_SENTRY === "1",
): Promise<void> {
  if (!enabled) return
  await installGameLogDeliveryInit(page, enabled)
  await page.evaluate(gameLogDeliveryInit)
}

type StorageRecord = { name: string; value: string }

/** Page-owned checkpoint/send boundaries. Pending chunks matter just as much
 * as delivered receipts: they prove the page recorded lines for delivery even
 * when Sentry never received them. */
function checkpointReceipts(records: readonly StorageRecord[]): Array<{ gameIndex: number; to: number }> {
  const receipts: Array<{ gameIndex: number; to: number }> = []
  const keep = (value: unknown) => {
    const item = value as { gameIndex?: unknown; to?: unknown } | null
    if (typeof item?.gameIndex === "number" && typeof item.to === "number") receipts.push({ gameIndex: item.gameIndex, to: item.to })
  }
  for (const record of records) {
    if (record.name !== GAME_LOG_OUTBOX_KEY && !record.name.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) continue
    const parsed: unknown = JSON.parse(record.value)
    if (record.name.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) keep(parsed)
    else {
      const index = parsed as { chunks?: unknown[]; delivered?: unknown[] } | null
      for (const item of [...(Array.isArray(index?.chunks) ? index.chunks : []), ...(Array.isArray(index?.delivered) ? index.delivered : [])]) keep(item)
    }
  }
  return receipts
}

function outboxChunkLines(records: readonly StorageRecord[]): LogLine[] {
  const chunks = new Map<string, StorageRecord>()
  for (const record of records) if (record.name.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) chunks.set(record.name, record)
  const lines: LogLine[] = []
  for (const record of chunks.values()) {
    const value = JSON.parse(record.value) as { entries?: LogLine[]; lines?: LogLine[] }
    lines.push(...(Array.isArray(value.entries) ? value.entries : []), ...(Array.isArray(value.lines) ? value.lines : []))
  }
  return lines
}

function outboxChunks(records: readonly StorageRecord[]): Map<string, LogLine[]> {
  const chunks = new Map<string, LogLine[]>()
  for (const record of records) {
    if (!record.name.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) continue
    const value = JSON.parse(record.value) as { id?: unknown; entries?: LogLine[]; lines?: LogLine[] }
    const suffix = record.name.slice(GAME_LOG_CHUNK_KEY_PREFIX.length)
    const id = typeof value.id === "string" ? value.id : decodeURIComponent(suffix)
    chunks.set(id, [
      ...(Array.isArray(value.entries) ? value.entries : []),
      ...(Array.isArray(value.lines) ? value.lines : []),
    ])
  }
  return chunks
}

function outboxEvidenceIds(records: readonly StorageRecord[]): Set<string> {
  const ids = new Set<string>()
  for (const record of records) {
    if (record.name.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) {
      const parsed = JSON.parse(record.value) as { id?: unknown } | null
      const suffix = record.name.slice(GAME_LOG_CHUNK_KEY_PREFIX.length)
      ids.add(typeof parsed?.id === "string" ? parsed.id : decodeURIComponent(suffix))
      continue
    }
    if (record.name !== GAME_LOG_OUTBOX_KEY) continue
    const parsed = JSON.parse(record.value) as { delivered?: unknown[] } | null
    for (const value of Array.isArray(parsed?.delivered) ? parsed.delivered : []) {
      const receipt = value as { id?: unknown; kind?: unknown } | null
      if (receipt && (receipt.kind === undefined || receipt.kind === "chunk") && typeof receipt.id === "string") ids.add(receipt.id)
    }
  }
  return ids
}

function durableChunkEvidence(records: readonly StorageRecord[]): Array<{ id: string; gameIndex: number; bytes: number }> {
  const evidence = new Map<string, { id: string; gameIndex: number; bytes: number }>()
  const keep = (value: unknown, bytes = 0) => {
    const item = value as { id?: unknown; gameIndex?: unknown; kind?: unknown } | null
    if (!item || (item.kind !== undefined && item.kind !== "chunk") || typeof item.id !== "string" || typeof item.gameIndex !== "number") return
    const key = `${item.gameIndex}:${item.id}`
    const previous = evidence.get(key)
    evidence.set(key, { id: item.id, gameIndex: item.gameIndex, bytes: Math.max(bytes, previous?.bytes ?? 0) })
  }
  for (const record of records) {
    try {
      const parsed: unknown = JSON.parse(record.value)
      if (record.name.startsWith(GAME_LOG_CHUNK_KEY_PREFIX)) {
        const chunk = parsed as { id?: unknown } | null
        const suffix = record.name.slice(GAME_LOG_CHUNK_KEY_PREFIX.length)
        keep({ ...(chunk && typeof chunk === "object" ? chunk : {}), id: typeof chunk?.id === "string" ? chunk.id : decodeURIComponent(suffix) }, Buffer.byteLength(record.value, "utf8"))
        continue
      }
      if (record.name !== GAME_LOG_OUTBOX_KEY) continue
      const index = parsed as { chunks?: unknown[]; delivered?: unknown[] } | null
      for (const item of [...(Array.isArray(index?.chunks) ? index.chunks : []), ...(Array.isArray(index?.delivered) ? index.delivered : [])]) keep(item)
    } catch {
      // A corrupt sibling cannot erase valid durable identities. The caller's
      // checkpoint parser still marks the overall telemetry truth unavailable.
    }
  }
  return [...evidence.values()]
}

function occurrenceMap(lines: readonly LogLine[], keyFor: (line: LogLine) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of lines) {
    const key = keyFor(line)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function maxUnion(target: Map<string, number>, source: ReadonlyMap<string, number>): void {
  for (const [key, count] of source) target.set(key, Math.max(target.get(key) ?? 0, count))
}

function retainedRingCandidates(lines: readonly LogLine[], killedAt: number): LogLine[] {
  const handover = lines.findLastIndex((line) => line.tag === "telemetry" && /^game \d+ handover$/.test(line.message))
  if (handover < 0) return []
  // Every flush begins a fresh non-empty chunk, even when the previous one
  // had ample byte capacity. Without the persisted chunk index we cannot
  // reconstruct those boundaries from exported lines. The last RING_SLOTS
  // lines are the largest provably retained suffix: even in the
  // worst case where every line occupied its own flush/chunk, all survive.
  // Select that suffix before checking age: recent lines can share an older
  // line's armed flush and consume chunks that evict older eligible records.
  return lines.slice(handover).slice(-RING_SLOTS).filter((line) => line.ts <= killedAt - FLUSH_INTERVAL_MS)
}

/** One in-page read: the stage facts and every tile slot. */
export async function readPage(page: Page, includeTelemetry = false) {
  return page.evaluate((captureTelemetry) => {
    const telemetryOutboxRecords: StorageRecord[] = []
    if (captureTelemetry) {
      try {
        const outboxKey = "jollity.telemetry.game-log-outbox.v1"
        const chunkPrefix = `${outboxKey}.chunk.`
        for (let index = 0; index < localStorage.length; index += 1) {
          const name = localStorage.key(index)
          if (name !== outboxKey && !name?.startsWith(chunkPrefix)) continue
          const value = localStorage.getItem(name)
          if (name && value !== null) telemetryOutboxRecords.push({ name, value })
        }
      } catch {
        /* the ground-truth verdict fails closed if no successful read saw one */
      }
    }
    const pill = document.querySelector('[aria-label^="Turn "]')
    const visibleHeadlines = [...document.querySelectorAll("span")].filter((s) => s.getAttribute("aria-hidden") !== "true")
    const hostIntroHeadline = visibleHeadlines.some((s) => s.textContent === "It's your turn!")
    const headline = hostIntroHeadline || visibleHeadlines.some((s) => s.textContent === "Meet new host")
    const confirm = [...document.querySelectorAll("button")].some((b) => /Confirm votes|Confirming|tap to retry/.test(b.textContent ?? ""))
    const tiles = [...document.querySelectorAll("[data-tile-slot]")].map((slot) => {
      const all = [slot, ...slot.querySelectorAll("*")]
      const rot = [...slot.querySelectorAll<HTMLElement>("div")].find((d) => /rotateY/.test(d.style.transform))
      const attrs: Record<string, string> = {}
      for (const el of all) for (const a of el.getAttributeNames()) if (a.startsWith("data-tile") || a === "data-cue") attrs[a] = el.getAttribute(a) ?? ""
      const aria = all.flatMap((el) => (el.getAttribute("aria-label") ? [el.getAttribute("aria-label") as string] : []))
      const r = slot.getBoundingClientRect()
      const cx = r.x + r.width / 2
      const cy = r.y + r.height / 2
      const top = document.elementFromPoint(cx, cy)
      const style = getComputedStyle(slot)
      const inView = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight
      const tap = slot.querySelector<HTMLElement>("[data-tile-votable]")
      return {
        id: slot.getAttribute("data-id") ?? "",
        role: (slot.getAttribute("data-tile-role") as "host" | "you" | "empty" | "unseen" | "coplayer" | null) ?? undefined,
        hasImage: slot.querySelector("img") !== null,
        cursorPointer: !!slot.querySelector(".cursor-pointer"),
        votable: tap ? tap.dataset.tileVotable === "true" : undefined,
        tapReady: tap ? tap.dataset.tileTapReady === "true" : undefined,
        verdict: tap?.dataset.tileVerdict,
        transform: rot?.style.transform ?? null,
        attrs,
        text: ((slot as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
        aria,
        box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        visible: r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0 && inView,
        // is the tile's own centre what a click there would hit? (the tap loop
        // clicks with force:true, which goes to the coordinates)
        hit: top === null ? null : slot.contains(top) ? "self" : `${top.tagName.toLowerCase()}.${String(top.getAttribute("class") ?? "").slice(0, 40)}`,
      }
    })
    return {
      url: location.href,
      pillLabel: pill?.getAttribute("aria-label") ?? null,
      ducked: pill?.getAttribute("aria-hidden") === "true",
      introHeadline: headline,
      hostIntroHeadline,
      confirmButton: confirm,
      sessionStage: document.querySelector("[data-stage]")?.getAttribute("data-stage") ?? null,
      sessionTurn: Number(document.querySelector("[data-turn]")?.getAttribute("data-turn")) || null,
      viewport: { width: innerWidth, height: innerHeight },
      // A navigation/reload creates a new document and a new performance
      // time origin even when Playwright keeps the same Page object.
      documentIdentity: `${location.href}|${performance.timeOrigin}`,
      telemetryOutboxRecords,
      tiles,
      // Captured inside the same evaluation, after the DOM facts above were
      // read. This is the snapshot's time, not the Node scheduling time. It is
      // on the RUNNER's clock: a profile clock (clockScript) shifts the page's
      // Date by __e2eClockOffMs, and jumpClock rewrites it, so taking it off
      // keeps snapshotAt inside the read bracket (game 317, bot 3 at +75 s:
      // every row failed reconciledRow and a co-player first decoded in the
      // ending read "opportunity evidence unknown").
      snapshotAt: new Date(Date.now() - ((globalThis as { __e2eClockOffMs?: number }).__e2eClockOffMs ?? 0)).toISOString(),
    }
  }, includeTelemetry)
}

/** Confirm-role copy is authoritative only once every label-only Co-player
 * tile has its rendered product text. A Co-player with a real in-memory still
 * is already visually authoritative and intentionally has no fallback copy.
 * An Unseen player has no tile on confirm at all. */
export function recapTilesReady(tiles: readonly { role?: string; text: string; hasImage?: boolean }[]): boolean {
  return tiles
    .filter((tile) => tile.role === "coplayer")
    .every((tile) => tile.hasImage === true || /Seen earlier/i.test(tile.text))
}

/** Lets a freeze stop the recorder's page reads: hold() waits for the read in flight and starts no new one until
 *  release(). A read on a page paused in the debugger only waits for the thaw and then times out (evaluate, screenshot). */
export class HoldGate {
  held = false
  private inFlight = new Set<Promise<unknown>>()
  /** Register page work that began before a freeze. hold() waits for all of
   * it, including work scheduled by another registered operation. */
  track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work)
    const done = () => this.inFlight.delete(work)
    void work.then(done, done)
    return work
  }
  /** run one read unless held; false = skipped */
  async run(read: () => Promise<void>): Promise<boolean> {
    if (this.held) return false
    const p = this.track(read())
    await p
    return true
  }
  async hold(): Promise<void> {
    this.held = true
    // A sampling read already in flight may enqueue its screenshot before it
    // settles. Drain until no pre-hold page work remains.
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight].map((work) => work.catch(() => {})))
  }
  release(): void {
    this.held = false
  }
}

export class BotRecorder {
  private running = false
  private loop: Promise<void> | null = null
  private pending = new Map<string, string>()
  private rounds = new RoundTracker()
  private shots = 0
  private stageShots = 0
  private lastKey = ""
  private lastShotAt = 0
  private ticks = 0
  /** Distinguishes evidence either side of a page replacement/reload. */
  private pageGeneration = 0
  /** devLog exported already (idempotent) */
  trail: VoteTrail | null = null
  /** every devLog line read so far (snapshots before a kill or reload, then the export), each once: the devlog guards' evidence */
  private devLines = new Map<string, LogLine[]>()
  /** Every failed document read is fatal to the oracle, even if another document exported. */
  private devLogFailures: string[] = []
  /** Page generations with at least one successful, non-empty snapshot/export. */
  private successfulDocuments = new Set<number>()
  /** Latest line boundary the page itself placed in a checkpoint/send. Never
   * inferred from what Sentry happened to receive. */
  private truthCutoffByGame = new Map<number, number>()
  /** Page-owned durable chunk identities and the largest payload observed for
   * each one, grouped by game. Delivered receipts remain valid evidence. */
  private durableChunksByGame = new Map<number, Map<string, number>>()
  /** Maximum known missing occurrence count per stable line across kills. A
   * line missing at two successive kills is one loss, not two. */
  private unpersistedByKey = new Map<string, number>()
  /** Pre-retirement truth that the reopened host-backed ring must reproduce. */
  private pendingReopenExpected: { required: Map<string, number>; known: Map<string, number>; outboxChunks: Map<string, LogLine[]> } | null = null

  private mergePendingReopenExpected(expected: NonNullable<BotRecorder["pendingReopenExpected"]>): void {
    const pending = this.pendingReopenExpected
    if (!pending) {
      this.pendingReopenExpected = expected
      return
    }
    maxUnion(pending.required, expected.required)
    maxUnion(pending.known, expected.known)
    for (const [id, lines] of expected.outboxChunks) pending.outboxChunks.set(id, lines)
  }
  /** Explicit pre-confirm snapshot after role copy has rendered. */
  recap: { t: string; tiles: TileRow[] } | null = null

  constructor(
    private page: Page,
    readonly n: number,
    private out: string,
    private shotsDir: string,
  ) {
    writeFileSync(join(out, `tiles-${n}.jsonl`), "")
    writeFileSync(join(out, `screenshots-${n}.jsonl`), "")
  }

  /** A role's action (role-proof.ts) as a line in the tile timeline, so it reads next to what the tiles did. */
  mark(id: string, detail: string) {
    appendFileSync(
      join(this.out, `tiles-${this.n}.jsonl`),
      JSON.stringify({
        recordType: "role-action",
        t: new Date().toISOString(),
        roleAction: { id, detail },
        // Keep the established readable field for retained evidence/tools.
        role: `${id}: ${detail}`,
      }) + "\n",
    )
  }

  /** held while the page is frozen (the freeze role): no read starts, the one in flight is waited for */
  readonly gate = new HoldGate()

  /** The page was relaunched (kill-relaunch): watch the new one, keep the same files and counters. */
  rebind(page: Page) {
    if (this.page === page) return
    this.page = page
    this.pageGeneration++
  }

  /** One authoritative DOM read plus its Node-side latency bracket. */
  private async snapshot() {
    const page = this.page
    const pageGeneration = this.pageGeneration
    const readStartedAt = new Date().toISOString()
    const value = await readPage(page, true)
    this.keepCheckpointEvidence(value.telemetryOutboxRecords ?? [], "page snapshot")
    const readCompletedAt = new Date().toISOString()
    return { value, pageGeneration, readStartedAt, readCompletedAt }
  }

  private keepCheckpointEvidence(records: readonly StorageRecord[], label: string): void {
    try {
      for (const receipt of checkpointReceipts(records)) {
        this.truthCutoffByGame.set(receipt.gameIndex, Math.max(receipt.to, this.truthCutoffByGame.get(receipt.gameIndex) ?? -Infinity))
      }
    } catch (error) {
      this.devLogFailures.push(`${label}: unreadable page checkpoint evidence: ${String(error).slice(0, 120)}`)
    }
    try {
      for (const chunk of durableChunkEvidence(records)) {
        const game = this.durableChunksByGame.get(chunk.gameIndex) ?? new Map<string, number>()
        game.set(chunk.id, Math.max(chunk.bytes, game.get(chunk.id) ?? 0))
        this.durableChunksByGame.set(chunk.gameIndex, game)
      }
    } catch (error) {
      this.devLogFailures.push(`${label}: unreadable page durable chunk evidence: ${String(error).slice(0, 120)}`)
    }
  }

  /** Read one app-side transition without treating a missing early hook as a
   * document-export failure. Registration polling uses this as evidence that
   * the sign-up actually reached broadcast, independently of the click. */
  async observeDevLogAt(tag: string, messageIncludes: string): Promise<number | null> {
    try {
      const json = await this.page.evaluate(async () => {
        const hook = (window as unknown as { __jollityHarness?: { exportLogs(): Promise<string> } }).__jollityHarness
        return hook ? await hook.exportLogs() : null
      })
      if (json === null) return null
      this.keepLines(parseExport(json).lines)
      return this.latestDevLogAt(tag, messageIncludes)
    } catch {
      return null
    }
  }

  /** The app's devLog as it stands now, to devlog-N-<label>.json; for evidence that dies with the page (a kill). Never throws. */
  private async captureDevLog(label: string, timeoutMs = 10_000, waitForHook = false, recordFailure = true): Promise<{ summary: string; lines: LogLine[]; records: StorageRecord[]; exported: boolean }> {
    try {
      const captured = await Promise.race([
        this.page.evaluate(async (hookWaitMs) => {
          let hook = (window as unknown as { __jollityHarness?: { exportLogs(): Promise<string> } }).__jollityHarness
          const deadline = performance.now() + hookWaitMs
          while (!hook && performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            hook = (window as unknown as { __jollityHarness?: { exportLogs(): Promise<string> } }).__jollityHarness
          }
          const outboxKey = "jollity.telemetry.game-log-outbox.v1"
          const chunkPrefix = `${outboxKey}.chunk.`
          const records: StorageRecord[] = []
          try {
            for (let index = 0; index < localStorage.length; index += 1) {
              const name = localStorage.key(index)
              if (name !== outboxKey && !name?.startsWith(chunkPrefix)) continue
              const value = localStorage.getItem(name)
              if (name && value !== null) records.push({ name, value })
            }
          } catch {
            /* missing storage is diagnosed by the absent page cutoff below */
          }
          const beforeBoot = (globalThis as { __e2eTelemetryBeforeBoot?: StorageRecord[] }).__e2eTelemetryBeforeBoot ?? []
          return { json: hook ? await hook.exportLogs() : null, records: [...beforeBoot, ...records] }
        }, waitForHook ? Math.max(0, timeoutMs - 100) : 0),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs)),
      ])
      const { json, records } = typeof captured === "string" || captured === null
        ? { json: captured, records: [] as StorageRecord[] }
        : captured
      const { lines } = json === null ? { lines: [] } : parseExport(json)
      this.keepCheckpointEvidence(records, label)
      if (recordFailure && (json === null || lines.length === 0)) this.devLogFailures.push(`${label}: ${json === null ? "no harness hook" : "empty export"}`)
      else this.successfulDocuments.add(this.pageGeneration)
      this.keepLines(lines)
      writeFileSync(join(this.out, `devlog-${this.n}-${label}.json`), JSON.stringify({ entries: lines.length, trail: voteTrail(lines), lines }, null, 1))
      return { summary: `${lines.length} lines`, lines, records, exported: json !== null && lines.length > 0 }
    } catch (error) {
      const failure = `${label}: ${String(error).slice(0, 120)}`
      if (recordFailure) this.devLogFailures.push(failure)
      return { summary: `snapshot failed: ${failure}`, lines: [], records: [], exported: false }
    }
  }

  async snapshotDevLog(label: string, timeoutMs?: number): Promise<string> {
    return (await this.captureDevLog(label, timeoutMs)).summary
  }

  /** A reload creates a new document. Wait for DebugBoot to reinstall the
   * document-local harness before treating its export as missing. */
  async snapshotReopenedDevLog(label: string, timeoutMs?: number): Promise<string> {
    return (await this.captureDevLog(label, timeoutMs, true)).summary
  }

  /** Export the replacement document's host-backed ring and compare it with
   * every occurrence known before the intentional page death. */
  async recoverReopenedTelemetry(label: string, timeoutMs = 10_000): Promise<string> {
    const expected = this.pendingReopenExpected
    this.pendingReopenExpected = null
    const first = await this.captureDevLog(label, timeoutMs, true, false)
    const captured = first.exported ? first : await this.captureDevLog(`${label}-retry`, timeoutMs, true, true)
    if (!expected) return captured.summary
    if (!captured.exported) {
      return `${captured.summary}; durability recovery not evaluated: reopened export failed`
    }
    let reopenedOutbox: LogLine[] = []
    try {
      reopenedOutbox = outboxChunkLines(captured.records)
      this.keepLines(reopenedOutbox)
    } catch (error) {
      this.devLogFailures.push(`${label}: malformed reopened durable record: ${String(error).slice(0, 120)}`)
    }
    const actual = occurrenceMap(captured.lines, (line) => this.lineKey(line))
    maxUnion(actual, occurrenceMap(reopenedOutbox, (line) => this.lineKey(line)))
    let reopenedIds = new Set<string>()
    try {
      reopenedIds = outboxEvidenceIds(captured.records)
    } catch (error) {
      this.devLogFailures.push(`${label}: malformed reopened outbox identity: ${String(error).slice(0, 120)}`)
    }
    for (const [id, lines] of expected.outboxChunks) {
      if (reopenedIds.has(id)) maxUnion(actual, occurrenceMap(lines, (line) => this.lineKey(line)))
    }
    let missingRequired = 0
    for (const [key, count] of expected.required) {
      const missing = Math.max(0, count - (actual.get(key) ?? 0))
      missingRequired += missing
    }
    for (const [key, count] of expected.known) {
      const missing = Math.max(0, count - (actual.get(key) ?? 0))
      if (missing > (this.unpersistedByKey.get(key) ?? 0)) this.unpersistedByKey.set(key, missing)
    }
    if (missingRequired > 0) this.devLogFailures.push(`${label}: reopened durable stores miss ${missingRequired} required pre-retirement occurrence(s)`)
    return `${captured.summary}; reopened durable recovery misses ${missingRequired} required pre-retirement occurrence(s)`
  }

  /** Recover browser-local outbox evidence before replacement boot. The debug
   * ring is host-backed and is verified through recoverReopenedTelemetry. */
  recoverPersistedTelemetry(storage: TelemetryStorageState | undefined, label: string, killedAt = Date.now()): string {
    try {
      const records = (storage?.origins ?? []).flatMap((origin) => origin.localStorage ?? [])
      this.keepCheckpointEvidence(records, label)
      const outboxLines = outboxChunkLines(records)
      const savedOutboxChunks = outboxChunks(records)
      const before = this.allDevLines()
      // The debug ring and game-log outbox intentionally overlap. Preserve the
      // higher occurrence count per line across the two stores, never their
      // sum, while retaining genuine duplicates within either store.
      const merged = new Map<string, LogLine[]>()
      for (const source of [outboxLines]) {
        const current = new Map<string, LogLine[]>()
        for (const line of source) {
          const key = this.lineKey(line)
          const bucket = current.get(key) ?? []
          bucket.push(line)
          current.set(key, bucket)
        }
        for (const [key, bucket] of current) if (bucket.length > (merged.get(key)?.length ?? 0)) merged.set(key, bucket)
      }
      const lines = [...merged.values()].flat()
      this.keepLines(lines)
      const knownLines = before.filter((line) => line.ts <= killedAt)
      const known = occurrenceMap(knownLines, (line) => this.lineKey(line))
      const required = occurrenceMap(retainedRingCandidates(knownLines, killedAt), (line) => this.lineKey(line))
      maxUnion(required, occurrenceMap(outboxLines, (line) => this.lineKey(line)))
      maxUnion(known, required)
      this.mergePendingReopenExpected({ required, known, outboxChunks: savedOutboxChunks })
      return `${label}: ${lines.length} pending browser-outbox line(s); host ring verification deferred to reopened page`
    } catch (error) {
      const failure = `${label} persisted fallback: ${String(error).slice(0, 120)}`
      this.devLogFailures.push(failure)
      return failure
    }
  }

  /** The tap loop reports each click it makes and what came of it. */
  tapped(id: string, result: string) {
    this.pending.set(id, result)
  }

  /** Wait through the first confirm animation frame and retain the actual DOM
   * copy before the CTA can navigate away. Missing copy fails the harness; it
   * is never inferred from role attributes. */
  async captureRecap(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let detail = "no confirm row"
    while (Date.now() < deadline) {
      const { value: p, pageGeneration, readStartedAt, readCompletedAt } = await this.snapshot()
      const { stage, turn, turnsPerRound } = readStage(p)
      detail = p.tiles.map((tile) => `${tile.id.slice(0, 8)}:${tile.role ?? "?"}:${JSON.stringify(tile.text)}`).join(", ")
      if (stage === "confirm" && recapTilesReady(p.tiles)) {
        const at = new Date().toISOString()
        const tiles: TileRow[] = p.tiles.map(({ transform, hasImage, ...tile }) => {
          void hasImage
          return {
            ...tile,
            rotateY: parseRotateY(transform),
            rotY: parseRotY(transform),
            tapped: false,
            click: null,
          }
        })
        this.recap = { t: at, tiles }
        appendFileSync(
          join(this.out, `tiles-${this.n}.jsonl`),
          JSON.stringify({
            t: at,
            readStartedAt,
            snapshotAt: p.snapshotAt,
            readCompletedAt,
            pageGeneration,
            documentIdentity: p.documentIdentity,
            url: p.url,
            stage,
            turn,
            turnsPerRound,
            sessionStage: p.sessionStage,
            sessionTurn: p.sessionTurn,
            viewport: p.viewport,
            confirm: true,
            recap: true,
            tiles,
          }) + "\n",
        )
        return
      }
      await this.page.waitForTimeout(100)
    }
    throw new Error(`recap role copy did not render within ${timeoutMs} ms (${detail})`)
  }

  start() {
    if (this.running) return
    this.running = true
    this.loop = this.run()
  }

  async stop() {
    this.running = false
    await this.loop?.catch(() => {})
    this.loop = null
  }

  /** Read the app-owned bounded sender evidence. This is acceptance evidence,
   * not a second implementation of RTC stats in Playwright. */
  async captureSendAdaptation(): Promise<AdaptiveUploadResult["page"]> {
    try {
      return await Promise.race([
        this.page.evaluate(() => {
          const hook = (window as unknown as {
            __jollityHarness?: { sendAdaptation?(): AdaptiveUploadResult["page"] }
          }).__jollityHarness
          return hook?.sendAdaptation?.() ?? null
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("send adaptation export timed out")), 10_000)),
      ])
    } catch {
      return null
    }
  }

  private async shot(
    round: number,
    turn: number | null,
    stage: Parameters<typeof shotName>[2],
    sessionStage: string | null | undefined,
    trigger: "stage" | "periodic",
  ) {
    const shot = ++this.shots
    const path = join(this.shotsDir, shotName(round, turn, stage, shot))
    const log = join(this.out, `screenshots-${this.n}.jsonl`)
    const page = this.page
    const write = (status: "queued" | "started" | "saved" | "error" | "deferred", detail?: { error?: unknown; reason?: string }) =>
      appendFileSync(
        log,
        JSON.stringify({
          t: new Date().toISOString(),
          status,
          shot,
          round,
          turn,
          stage,
          trigger,
          sessionStage: sessionStage ?? null,
          path,
          ...(detail?.reason === undefined ? {} : { reason: detail.reason }),
          ...(detail?.error === undefined ? {} : { error: String(detail.error) }),
        }) + "\n",
      )
    // Gameplay and ending are authoritative observation/gesture windows. A
    // due secondary capture is retained as an explicit terminal deferral;
    // there is no backlog that can start later under a stale stage label.
    if (stage === "play" || sessionStage === "gameplay" || sessionStage === "ending") {
      write("deferred", { reason: `authoritative observation window (${sessionStage ?? stage})` })
      return
    }
    write("queued")
    write("started")
    try {
      // Await inline only after the sampler's authoritative snapshot. This
      // makes admission, completion and the following read one serialized
      // contract rather than an independent promise queue on the same Page.
      await page.screenshot({ path, timeout: SHOT_OPERATION_TIMEOUT_MS })
      write("saved")
    } catch (error) {
      write("error", { error })
    }
  }

  private async run() {
    const file = join(this.out, `tiles-${this.n}.jsonl`)
    const started = Date.now()
    while (this.running) {
      const tickAt = Date.now()
      // a frozen page (the freeze role) is not read: the read would wait for the thaw and time out
      await this.gate.run(async () => {
        try {
          const { value: p, pageGeneration, readStartedAt, readCompletedAt } = await this.snapshot()
          const { stage, turn, turnsPerRound } = readStage(p)
          const round = this.rounds.next(turn)
          const tiles: TileRow[] = p.tiles.map(({ transform, hasImage, ...t }) => {
            void hasImage
            const click = this.pending.get(t.id) ?? null
            return { ...t, rotateY: parseRotateY(transform), rotY: parseRotY(transform), tapped: click !== null, click }
          })
          this.pending.clear()
          if (p.url.includes("/game") || tiles.length > 0) {
            this.ticks++
            appendFileSync(
              file,
              JSON.stringify({
                // Historical scheduling fields remain unchanged. The read
                // bracket and in-page snapshot time below are authoritative
                // when deciding whether an opportunity was actually seen.
                t: new Date(tickAt).toISOString(),
                ms: tickAt - started,
                readStartedAt,
                snapshotAt: p.snapshotAt,
                readCompletedAt,
                pageGeneration,
                documentIdentity: p.documentIdentity,
                url: p.url,
                stage,
                round,
                turn,
                turnsPerRound,
                sessionStage: p.sessionStage,
                sessionTurn: p.sessionTurn,
                viewport: p.viewport,
                pill: p.pillLabel,
                ducked: p.ducked,
                intro: p.introHeadline,
                confirm: p.confirmButton,
                tiles,
              }) + "\n",
            )
          }
          if (p.url.includes("/game") && stage !== "waiting") {
            const key = `${round}:${turn}:${stage}`
            if (key !== this.lastKey && this.stageShots < SHOT_CAP + STAGE_SHOT_HEADROOM) {
              this.lastKey = key
              this.stageShots++
              this.lastShotAt = Date.now()
              await this.shot(round, turn, stage, p.sessionStage, "stage")
            } else if (Date.now() - this.lastShotAt >= SHOT_EVERY_MS && this.shots < SHOT_CAP) {
              this.lastShotAt = Date.now()
              await this.shot(round, turn, stage, p.sessionStage, "periodic")
            }
          }
        } catch (error) {
          // a navigation or a closing page: note it, keep watching
          appendFileSync(file, JSON.stringify({ t: new Date(tickAt).toISOString(), error: String(error).slice(0, 200) }) + "\n")
        }
      })
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, TICK_MS - (Date.now() - tickAt))))
    }
  }

  /** The app's devLog, from the page's own export (window.__jollityHarness,
   *  lib/telemetry/harness.ts: a dev build, or a served bundle with the test tag set). Not IndexedDB: every
   *  host deletes it, so the log is in the page's memory. Written to
   *  devlog-N.json. BEST-EFFORT: an empty export says why and is never a test
   *  failure. The chain decode (chain-read.mts votes) is the vote oracle. */
  async exportDevLog(): Promise<VoteTrail | null> {
    const file = join(this.out, `devlog-${this.n}.json`)
    try {
      const captured = await Promise.race([
        this.page.evaluate(async () => {
          const hook = (window as unknown as { __jollityHarness?: { exportLogs(): Promise<string>; smoothness?(): { ms: number; endedAt: number; scene: string }[] } }).__jollityHarness
          const probe = { url: location.href, hook: typeof hook }
          // the app's own long tasks (lib/telemetry/smoothness.ts, what Sentry gets as ui.long_task_ms): read, never measured here
          const longTasks = hook?.smoothness ? hook.smoothness() : []
          const outboxKey = "jollity.telemetry.game-log-outbox.v1"
          const chunkPrefix = `${outboxKey}.chunk.`
          const records: StorageRecord[] = []
          try {
            for (let index = 0; index < localStorage.length; index += 1) {
              const name = localStorage.key(index)
              if (name !== outboxKey && !name?.startsWith(chunkPrefix)) continue
              const value = localStorage.getItem(name)
              if (name && value !== null) records.push({ name, value })
            }
          } catch {
            /* missing storage is diagnosed by the absent page cutoff below */
          }
          return { probe, json: hook ? await hook.exportLogs() : null, longTasks, records }
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("devLog export timed out")), 15_000)),
      ])
      const got = typeof captured === "string"
        ? { probe: { url: "test", hook: "object" }, json: captured, longTasks: [], records: [] as StorageRecord[] }
        : captured
      const { meta, lines } = got.json === null ? { meta: null, lines: [] } : parseExport(got.json)
      this.keepCheckpointEvidence(got.records, "final")
      if (got.json !== null && lines.length > 0) this.successfulDocuments.add(this.pageGeneration)
      this.keepLines(lines)
      const allLines = this.allDevLines()
      this.trail = voteTrail(allLines)
      this.longTasks = got.longTasks
      const why =
        lines.length > 0
          ? null
          : got.json === null
            ? "no window.__jollityHarness in this page: the build carries it under next dev or with a test tag set (telemetry on for the run)"
            : "the page's export holds no lines"
      if (why) this.devLogFailures.push(`final: ${why}`)
      this.devLogNote = why ?? `${allLines.length} merged entries (${String(meta?.store ?? "?")})${this.trail.reports.length === 0 ? ", none of them a filed report" : ""}`
      writeFileSync(file, JSON.stringify({ entries: allLines.length, why, probe: got.probe, longTasks: this.longTasks, meta, trail: this.trail, lines: allLines }, null, 1))
    } catch (error) {
      this.devLogNote = `export failed: ${String(error)}`
      this.devLogFailures.push(`final: ${String(error).slice(0, 120)}`)
      const allLines = this.allDevLines()
      writeFileSync(file, JSON.stringify({ error: String(error), entries: allLines.length, trail: this.trail, lines: allLines }, null, 1))
      return null
    }
    return this.trail
  }
  /** the app's own long tasks at the export (window.__jollityHarness.smoothness): the stalls the freeze verdict reads */
  longTasks: { ms: number; endedAt: number; scene: string }[] = []
  /** what the devLog export found, or why it found nothing */
  devLogNote = "not exported"

  private keepLines(lines: readonly LogLine[]) {
    const snapshot = new Map<string, LogLine[]>()
    for (const line of lines) {
      const key = this.lineKey(line)
      const bucket = snapshot.get(key) ?? []
      bucket.push(line)
      snapshot.set(key, bucket)
    }
    for (const [key, bucket] of snapshot) if (bucket.length > (this.devLines.get(key)?.length ?? 0)) this.devLines.set(key, bucket)
  }

  private lineKey(line: LogLine): string {
    return `${line.ts}|${line.sessionId ?? ""}|${line.tag}|${line.message}`
  }

  private allDevLines(): LogLine[] {
    return [...this.devLines.values()].flat().sort((a, b) => a.ts - b.ts)
  }

  /** Timestamp of an app-observed devLog transition. Unlike a harness click,
   * this proves the page reached the named app-side state. */
  latestDevLogAt(tag: string, messageIncludes: string): number | null {
    return this.allDevLines().filter((line) => line.tag === tag && line.message.includes(messageIncludes)).at(-1)?.ts ?? null
  }

  /** Stable line identities for the cross-Sentry completeness oracle. Lines
   * from pre-kill/pre-reload snapshots are already merged into devLines. */
  telemetryGroundTruth(gameIndex?: number, expectedDocuments = 1): TelemetryGroundTruth {
    const all = this.allDevLines()
    const coldStart = all.some((line) => line.tag === "clock" && line.message === "clock ready" && (line.data as { late?: unknown } | undefined)?.late === true)
    const handover = gameIndex === undefined ? undefined : all.find((line) => line.tag === "telemetry" && line.message === `game ${gameIndex} handover`)
    const nextHandover = handover === undefined ? undefined : all.find((line) => line.ts > handover.ts && line.tag === "telemetry" && /^game \d+ handover$/.test(line.message) && line.message !== `game ${gameIndex} handover`)
    const lines = all
      .filter((line) => handover === undefined || (line.ts >= handover.ts && (nextHandover === undefined || line.ts < nextHandover.ts)))
      .map(({ ts, sessionId, tag, message }) => ({ ts, sessionId: sessionId ?? "", tag, message }))
      .sort((a, b) => a.ts - b.ts || a.sessionId.localeCompare(b.sessionId) || a.tag.localeCompare(b.tag) || a.message.localeCompare(b.message))
    const uncovered = Array.from({ length: expectedDocuments }, (_, generation) => generation).filter((generation) => !this.successfulDocuments.has(generation))
    const truthCutoffAt = gameIndex === undefined ? undefined : this.truthCutoffByGame.get(gameIndex)
    const durableChunks = gameIndex === undefined ? undefined : this.durableChunksByGame.get(gameIndex)
    const durableChunkIds = durableChunks ? [...durableChunks.keys()].sort() : []
    const failures = [
      ...this.devLogFailures,
      ...(uncovered.length ? [`documents without a successful snapshot/export: ${uncovered.join(", ")}`] : []),
      ...(gameIndex !== undefined && truthCutoffAt === undefined ? [`no page-owned checkpoint/send evidence for game ${gameIndex}`] : []),
    ]
    return {
      source: "page-export",
      lines,
      coldStart,
      ...(truthCutoffAt === undefined ? {} : { truthCutoffAt }),
      ...(durableChunkIds.length === 0 ? {} : {
        durableChunkIds,
        durableChunkBytes: [...(durableChunks?.values() ?? [])].reduce((sum, bytes) => sum + bytes, 0),
      }),
      ...(!handover && gameIndex !== undefined ? { unavailable: `no game ${gameIndex} handover in page truth` } : {}),
      ...(lines.length === 0 ? { unavailable: "telemetry truth is empty" } : {}),
      ...(failures.length ? { unavailable: `document export failed: ${failures.join("; ")}`, failedDocuments: failures } : {}),
      unpersistedAtKill: [...this.unpersistedByKey.values()].reduce((sum, count) => sum + count, 0),
      limitations: ["Truth is bounded by the app's 5,000-line/2 MiB memory export plus the 32-slot durable debug ring; a line evicted from both before any harness snapshot cannot be reconstructed."],
    }
  }

  /** the devLog lines read so far, oldest first, for the devlog guards */
  devlogEvidence(): DevlogEvidence {
    const lines = this.allDevLines().map(({ ts, sessionId, tag, message, data }) => ({
      ts,
      ...(sessionId === undefined ? {} : { sessionId }),
      tag,
      message,
      ...(data === undefined ? {} : { data }),
    }))
    return { lines, note: this.devLogNote }
  }
}

/** The game's log to Sentry before the page closes (window.__jollityHarness.
 *  flushGameLog: the usual `game-log` event, unless the payoff already sent
 *  it). A bot that failed before the payoff otherwise sends none, and its log
 *  is what explains the failure. Never throws; says what happened. */
export async function flushGameLog(page: Page, timeoutMs = 75_000): Promise<string> {
  try {
    const got = await Promise.race([
      (async () => {
        await installGameLogDeliveryFlag(page)
        return page.evaluate(async () => {
          const hook = (window as unknown as { __jollityHarness?: { flushGameLog(): Promise<{ gameIndex: number | null; sent: boolean; note: string }> } }).__jollityHarness
          return hook ? await hook.flushGameLog() : null
        })
      })(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000} s`)), timeoutMs)),
    ])
    if (!got) return "no window.__jollityHarness in this page"
    return got.gameIndex === null ? got.note : `game ${got.gameIndex}: ${got.note}`
  } catch (error) {
    return `flush failed: ${String(error).slice(0, 200)}`
  }
}
