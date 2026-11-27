// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE LAST-SESSION RECORD: synchronous evidence for an app that reopens.
 *
 * A killed webview cannot run cleanup. The only reliable witness is therefore
 * a small localStorage record written while the page is alive: every twenty
 * seconds while visible, whenever its game position changes, and synchronously
 * at each lifecycle edge. The next page load classifies that record once and
 * replaces it before sending the diagnostic.
 *
 * Host storage is deliberately not the heartbeat: crossing the host bridge is
 * asynchronous and may never finish while iOS freezes or kills the content
 * process.
 */
import { newId, SESSION_ID } from "../debug/session-id"
import { captureReplayObservation } from "./replay-capture"
import { isOpenJourneyRecord, openJourneyRecoveryRecords, setOpenJourneyListener, type OpenJourneyRecord } from "./journeys"
import { currentScene, heapMbNow, setSceneListener } from "./smoothness"
import { pageHidden } from "./util"
import { readHostTelemetryContext } from "./host-context"
import { readLaunchSource } from "./launch-source"
import { chainNowMs } from "../chain-clock"
import { readPageResourceCounters, type PageResourceCounters } from "./resource-counters"
import { pageLifecycleRecord, type PageLifecycleEvent } from "./index"

export const LAST_SESSION_KEY = "jollity.telemetry.last-session"
export const SESSION_LINEAGE_KEY = "jollity.telemetry.session-lineage"
export const HEARTBEAT_MS = 20_000
export const HOST_RELOAD_MAX_GAP_MS = 2_000
export const STALE_AFTER_MS = 30 * 60_000
/** A previous page still alive this recently means a second copy was opened
 *  alongside it (archive#1882): the double-open signature. */
export const CONCURRENT_PAGE_MAX_GAP_MS = 5_000
export const MAX_PAYOFF_SAMPLES_PER_PHASE = 15

type PreviousExit =
  | "clean-close"
  | "killed-background"
  | "crash-or-kill-foreground"
  | "host-reload"
  | "own-reload"
  | "unknown"

interface SessionRecord {
  sessionId: string
  /** Explicit join to exported logs; older stored records may lack it (their heartbeat ids used another namespace). */
  logSessionId?: string
  lineageId: string
  lastSeenAt: number
  cleanExit: boolean
  hidden: boolean
  screen?: string
  /** Read compatibility for the pre-#232 record. New writes use screen. */
  scene?: string
  gameIndex?: number
  turn?: number
  inGame: boolean
  liveVideo?: number
  heapMb?: number
  pagehideSeen?: boolean
  pagehidePersisted?: boolean
  freezeSeen?: boolean
  visibilityChanges?: number
  ownReload?: boolean
  hostChannelLost?: boolean
  openJourneys?: OpenJourneyRecord[]
  gameState?: GameStateRecord
}

export interface GameStateRecord {
  gameIndex?: number
  phase: string
  visibility: "hidden" | "visible"
  hiddenSinceMs?: number
  chainTimeMs?: number
  sampledAtMs: number
  counters: PageResourceCounters
}

export interface PreviousSessionDiagnostic {
  classification: PreviousExit
  previousSessionId?: string
  gapMs?: number
  screen?: string
  gameIndex?: number
  turn?: number
  liveVideo?: number
  heapMb?: number
  pagehideSeen: boolean
  pagehidePersisted?: boolean
  freezeSeen: boolean
  visibilityChanges: number
  lastVisibility: "hidden" | "visible" | "unknown"
  inGame: boolean
  openJourneys: string[]
  openJourneySteps: string[]
  gameState?: GameStateRecord
}

export interface GameFacts {
  inGame: boolean
  gameIndex?: number
  turn?: number
  liveVideo?: number
}

let probe: () => GameFacts = () => ({ inGame: false })

export function setSessionProbe(next: () => GameFacts): void {
  probe = next
}

export interface StartOptions {
  record: (diagnostic: PreviousSessionDiagnostic) => void
  sample?: (state: GameStateRecord) => void
  recover?: (records: readonly OpenJourneyRecord[], previousSessionId: string, lastSeenAt: number) => void
}

let current: SessionRecord | null = null
let timer: ReturnType<typeof setInterval> | undefined
let started = false
let queued = false
let sampleSink: ((state: GameStateRecord) => void) | undefined
let gameEvidenceEnded = false
let payoffSamplePhase: string | undefined
let payoffSampleCount = 0
let cappedPayoffPhase: string | undefined

function isRecord(value: unknown): value is SessionRecord {
  const record = value as Partial<SessionRecord> | null
  return !!record && typeof record === "object" && typeof record.sessionId === "string" && typeof record.lastSeenAt === "number" && typeof record.cleanExit === "boolean"
}

function parseRecord(raw: string | null): SessionRecord | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    return { ...parsed, lineageId: typeof parsed.lineageId === "string" ? parsed.lineageId : parsed.sessionId }
  } catch {
    return null
  }
}

function readPrevious(): SessionRecord | null {
  try {
    return parseRecord(localStorage.getItem(LAST_SESSION_KEY))
  } catch {
    return null
  }
}

function lineage(): string {
  try {
    const known = sessionStorage.getItem(SESSION_LINEAGE_KEY)
    if (known) return known
    const created = newId()
    sessionStorage.setItem(SESSION_LINEAGE_KEY, created)
    return created
  } catch {
    return newId()
  }
}

function writeCurrent(): boolean {
  try {
    if (!current) return false
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(current))
    return true
  } catch {
    return false
  }
}

function routeScreen(): "game" | undefined {
  try {
    const pathname = window.location.pathname.replace(/\/$/, "")
    return pathname === "/game" || pathname.endsWith("/game") ? "game" : undefined
  } catch {
    return undefined
  }
}

function phaseOf(screen: string | undefined): string {
  if (screen === "draw.wheel") return "draw"
  if (screen === "chest") return "chest"
  return screen ?? "unknown"
}

function refresh(over: Partial<SessionRecord> = {}, sample = false): boolean {
  try {
    if (!current) return false
    const facts = probe()
    const route = routeScreen()
    const screen = currentScene() ?? route
    const payoffPhase = screen === "draw.wheel" || screen === "chest"
    const phase = phaseOf(screen)
    if (payoffPhase && payoffSamplePhase !== phase) {
      payoffSamplePhase = phase
      payoffSampleCount = 0
      cappedPayoffPhase = undefined
    }
    if (facts.inGame && !payoffPhase) {
      gameEvidenceEnded = false
      payoffSamplePhase = undefined
      payoffSampleCount = 0
      cappedPayoffPhase = undefined
    }
    const activeGame = !gameEvidenceEnded && cappedPayoffPhase !== phase && (facts.inGame || payoffPhase)
    const counters = activeGame ? readPageResourceCounters(sample) : undefined
    const chainTimeMs = activeGame ? chainNowMs() : null
    const hidden = pageHidden()
    const gameState = activeGame
      ? {
          gameIndex: facts.gameIndex ?? current.gameState?.gameIndex,
          phase,
          visibility: hidden ? "hidden" as const : "visible" as const,
          ...(hidden ? { hiddenSinceMs: current.gameState?.visibility === "hidden" ? current.gameState.hiddenSinceMs ?? Date.now() : Date.now() } : {}),
          ...(chainTimeMs === null ? {} : { chainTimeMs }),
          sampledAtMs: Date.now(),
          counters: counters as PageResourceCounters,
        }
      : undefined
    const next: SessionRecord = {
      ...current,
      hidden,
      inGame: facts.inGame || route === "game",
      screen,
      gameIndex: facts.gameIndex,
      turn: facts.turn,
      liveVideo: facts.liveVideo,
      heapMb: roundedHeap(),
      openJourneys: openJourneyRecoveryRecords(),
      ...(gameState ? { gameState } : {}),
      ...over,
    }
    if (!gameState) delete next.gameState
    current = { ...next, lastSeenAt: Date.now() }
    const written = writeCurrent()
    if (sample && activeGame && gameState) {
      try { sampleSink?.(gameState) } catch { /* sampling is diagnostic only */ }
      if (payoffPhase && ++payoffSampleCount >= MAX_PAYOFF_SAMPLES_PER_PHASE) {
        cappedPayoffPhase = phase
        if (current) {
          delete current.gameState
          writeCurrent()
        }
      }
    }
    return written
  } catch {
    return false
  }
}

function roundedHeap(): number | undefined {
  const heap = heapMbNow()
  return heap === undefined ? undefined : Math.round(heap)
}

function navigationType(): string | null {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return null
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
    return typeof entry?.type === "string" ? entry.type : null
  } catch {
    return null
  }
}

export function noteSessionChange(): void {
  if (!current || queued) return
  queued = true
  void Promise.resolve().then(() => {
    queued = false
    refresh()
  })
}

/** The payoff has ended at the hand-off and no longer needs kill evidence. */
export function clearGameSessionState(): void {
  try {
    gameEvidenceEnded = true
    payoffSamplePhase = undefined
    payoffSampleCount = 0
    cappedPayoffPhase = undefined
    if (!current?.gameState) return
    const next: SessionRecord = { ...current, inGame: false, lastSeenAt: Date.now() }
    delete next.gameState
    current = next
    writeCurrent()
  } catch {
    /* cleanup is diagnostic only */
  }
}

/** Call immediately before every reload initiated by Jollity. */
export function noteOwnReload(): void {
  refresh({ ownReload: true })
}

/** Persist the host bridge state before iOS replaces this webview. */
export function noteHostChannelLost(): void {
  refresh({ hostChannelLost: true })
}

/** Clear a transient disconnect if the same page reconnects. */
export function noteHostChannelRestored(): void {
  refresh({ hostChannelLost: false })
}

function install(): void {
  if (started) return
  started = true
  timer = setInterval(() => {
    if (!pageHidden()) refresh({}, true)
  }, HEARTBEAT_MS)
  setSceneListener(noteSessionChange)
  setOpenJourneyListener(noteSessionChange)
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", (event) => {
      const persisted = !!(event as PageTransitionEvent | undefined)?.persisted
      refresh(
        {
          cleanExit: true,
          pagehideSeen: true,
          pagehidePersisted: persisted,
        },
      )
      try {
        if (!probe().inGame) clearGameSessionState()
      } catch {
        /* lifecycle evidence never breaks page teardown */
      }
      logLifecycle("pagehide", persisted)
    })
    window.addEventListener("pageshow", (event) => {
      logLifecycle("pageshow", !!(event as PageTransitionEvent | undefined)?.persisted)
    })
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      const visibilityChanges = (current?.visibilityChanges ?? 0) + 1
      refresh(
        pageHidden()
          ? { hidden: true, visibilityChanges }
          : { hidden: false, cleanExit: false, pagehideSeen: false, pagehidePersisted: undefined, freezeSeen: false, visibilityChanges },
      )
      logLifecycle("visibilitychange")
    })
    document.addEventListener("freeze", () => {
      refresh({ freezeSeen: true })
      logLifecycle("freeze")
    })
    document.addEventListener("resume", () => {
      refresh({ freezeSeen: false })
      logLifecycle("resume")
    })
  }
}

function logLifecycle(event: PageLifecycleEvent, persisted?: boolean): void {
  pageLifecycleRecord({ event, state: pageHidden() ? "hidden" : "visible", monoMs: performance.now(), persisted })
}

function recoverable(previous: SessionRecord): OpenJourneyRecord[] {
  return Array.isArray(previous.openJourneys) ? previous.openJourneys.filter(isOpenJourneyRecord) : []
}

function classify(previous: SessionRecord | null, now: number, currentLineage: string): PreviousSessionDiagnostic {
  if (!previous)
    return {
      classification: "unknown",
      pagehideSeen: false,
      freezeSeen: false,
      visibilityChanges: 0,
      lastVisibility: "unknown",
      inGame: false,
      openJourneys: [],
      openJourneySteps: [],
    }

  const gapMs = now - previous.lastSeenAt
  const recent = gapMs >= 0 && gapMs < STALE_AFTER_MS
  let classification: PreviousExit
  if (previous.ownReload) classification = "own-reload"
  else if (!recent) classification = "unknown"
  else if (previous.lineageId === currentLineage && previous.hostChannelLost && gapMs <= HOST_RELOAD_MAX_GAP_MS) classification = "host-reload"
  else if (previous.pagehideSeen || previous.cleanExit) classification = "clean-close"
  else if (previous.hidden) classification = "killed-background"
  else classification = "crash-or-kill-foreground"
  const openJourneys = recoverable(previous)

  return {
    classification,
    previousSessionId: previous.sessionId,
    gapMs: gapMs >= 0 ? gapMs : undefined,
    screen: previous.screen ?? previous.scene,
    gameIndex: previous.gameIndex,
    turn: previous.turn,
    liveVideo: previous.liveVideo,
    heapMb: previous.heapMb,
    pagehideSeen: !!previous.pagehideSeen || previous.cleanExit,
    pagehidePersisted: previous.pagehidePersisted,
    freezeSeen: !!previous.freezeSeen,
    visibilityChanges: previous.visibilityChanges ?? 0,
    lastVisibility: previous.hidden ? "hidden" : "visible",
    inGame: previous.inGame,
    openJourneys: openJourneys.map((journey) => journey.name),
    openJourneySteps: openJourneys.map((journey) => `${journey.name}:${journey.lastStep}`),
    ...(previous.gameState ? { gameState: previous.gameState } : {}),
  }
}

export async function startSessionRecord(options: StartOptions): Promise<PreviousSessionDiagnostic> {
  const unknown: PreviousSessionDiagnostic = {
    classification: "unknown",
    pagehideSeen: false,
    freezeSeen: false,
    visibilityChanges: 0,
    lastVisibility: "unknown",
    inGame: false,
    openJourneys: [],
    openJourneySteps: [],
  }
  try {
    if (current) return unknown
    gameEvidenceEnded = false
    payoffSamplePhase = undefined
    payoffSampleCount = 0
    cappedPayoffPhase = undefined
    const now = Date.now()
    const previous = readPrevious()
    const currentLineage = lineage()
    const diagnostic = classify(previous, now, currentLineage)
    sampleSink = options.sample
    const openJourneys = previous && diagnostic.classification !== "clean-close" && diagnostic.classification !== "unknown" ? recoverable(previous) : []
    current = {
      sessionId: newId(),
      logSessionId: SESSION_ID,
      lineageId: currentLineage,
      lastSeenAt: now,
      cleanExit: false,
      hidden: pageHidden(),
      inGame: false,
      pagehideSeen: false,
      freezeSeen: false,
      visibilityChanges: 0,
      ownReload: false,
      hostChannelLost: false,
      openJourneys: [],
    }
    const established = refresh()
    const hostTelemetry = readHostTelemetryContext()
    const pageLocation = typeof window === "undefined" ? undefined : window.location
    const launch = readLaunchSource({ now, search: pageLocation?.search, pathname: pageLocation?.pathname })
    const concurrentPage = diagnostic.gapMs !== undefined && diagnostic.gapMs < CONCURRENT_PAGE_MAX_GAP_MS
    captureReplayObservation("session.link", {
      heartbeatSessionId: current.sessionId,
      logSessionId: SESSION_ID,
      previousHeartbeatSessionId: previous?.sessionId ?? null,
      // Epoch milliseconds plus fractional digits can resemble a card number
      // to ingest scrubbing. This identity anchor needs only millisecond precision.
      timeOriginMs: typeof performance === "undefined" || !Number.isFinite(performance.timeOrigin) ? null : Math.round(performance.timeOrigin),
      navigationType: navigationType(),
      hostSessionId: hostTelemetry?.hostSessionId ?? null,
      previousLogSessionId: typeof previous?.logSessionId === "string" ? previous.logSessionId : null,
      lineageId: currentLineage,
      sameLineage: previous ? previous.lineageId === currentLineage : null,
      previousExitClassification: diagnostic.classification,
      previousLastSeenWallMs: previous?.lastSeenAt ?? null,
      // string attributes: Sentry span attributes are string-typed (archive#1882)
      "app.launch_source": launch.source,
      "app.launch_detail": launch.detail,
      "app.concurrent_page": concurrentPage ? "true" : "false",
      persisted: established,
    })
    if (established && previous && openJourneys.length > 0) {
      try {
        options.recover?.(openJourneys, previous.sessionId, previous.lastSeenAt)
      } catch {
        /* recovery is diagnostic only */
      }
    }
    install()
    try {
      options.record(diagnostic)
    } catch {
      /* classification still stands */
    }
    return diagnostic
  } catch {
    return unknown
  }
}

export function resetSessionRecordForTests(): void {
  current = null
  started = false
  queued = false
  probe = () => ({ inGame: false })
  sampleSink = undefined
  gameEvidenceEnded = false
  payoffSamplePhase = undefined
  payoffSampleCount = 0
  cappedPayoffPhase = undefined
  if (timer) clearInterval(timer)
  timer = undefined
  setSceneListener(null)
  setOpenJourneyListener(null)
}
