// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Every return to the foreground, wherever the player is in the app.
 *
 * Browser hide/show events provide the exact edges when the host sends them.
 * iOS can instead freeze the page without an event, so a short heartbeat
 * compares wall and monotonic movement: only the wall advances in a freeze,
 * while both advance during a busy-main-thread stall.
 * A hidden page is not always a backgrounded app: a minimized game tab or
 * another screen inside the host keeps the page running. While hidden, the
 * tick therefore tracks whether it keeps coming (ranHiddenMs) or stops for
 * longer than a freeze (suspendedHidden), so a reader can tell the two apart.
 * The duration is a metric value (numeric in Sentry), never a span attribute.
 */
import { chainNowMs } from "../chain-clock"
import { devLog } from "../debug/log-store"
import { FREEZE_SLACK_MS, pageFroze, pageHidden as readPageHidden, reportPageActivity, watchPageHidden as watchHidden } from "../page-lifecycle"
import { recordCount, recordDistribution } from "./metrics"
import { NOTIFICATION_MOMENTS, NOTIFICATION_PARAM, REMINDER_VALUE, MOMENT_PARAM } from "./notification-url"
import { currentMoment, currentScene, MOMENTS, type MomentName, type SceneName } from "./smoothness"

export { NOTIFICATION_MOMENTS } from "./notification-url"

export const FOREGROUND_TICK_MS = 500

type AppScreen = "home" | "waiting" | "game" | "payoff"

export interface ForegroundContext {
  screen: AppScreen
  stage: string
  playStarted: boolean
}

export interface ForegroundReturn {
  awayMs: number | null
  left: ForegroundContext
  returned: ForegroundContext
  /** true only when the heartbeat found a freeze with no hide event */
  suspended: boolean
  source: ForegroundReturnSource
}

const foregroundReturnListeners = new Set<(value: ForegroundReturn) => void>()

export function watchForegroundReturn(listener: (value: ForegroundReturn) => void): () => void {
  foregroundReturnListeners.add(listener)
  return () => foregroundReturnListeners.delete(listener)
}

function publishForegroundReturn(value: ForegroundReturn): void {
  for (const listener of foregroundReturnListeners) {
    try {
      listener(value)
    } catch {
      /* lifecycle observers never break foreground telemetry */
    }
  }
}

type ForegroundReturnSource = "notification" | "other"

/** How the return was detected: the page's visibility flipped, a pageshow
 *  fired (a bfcache restore), or the heartbeat found a freeze with no event. */
type AwayVia = "visibility" | "pageshow" | "freeze-detected"

/**
 * One proven absence, for the game log (#435). The aggregate metrics keep the
 * duration and the count; this keeps WHEN, so a report can intersect it with a
 * turn. `*Chain` is the game clock (lib/chain-clock.ts) in seconds (null before the first anchor):
 * the one a turn's schedule is on. It trails across a visible freeze, so the
 * wall edges are kept too, and the monotonic readings let a reader tell a
 * wall step from a real absence.
 */
export interface AwayInterval {
  hiddenAtMs: number
  shownAtMs: number
  hiddenMono: number
  shownMono: number
  hiddenChainS: number | null
  shownChainS: number | null
  via: AwayVia
  from: string
  fromStage: string
  to: string
  toStage: string
  suspended: boolean
  source: ForegroundReturnSource
  /** this session's count of logged intervals, 1-based */
  seq: number
  /** the hidden edge is the install time: the page started hidden, so the real start is earlier */
  startedHidden: boolean
  /** how long after the hide the page kept ticking with no gap (monotonic ms) */
  ranHiddenMs: number
  /** a gap longer than one tick plus FREEZE_SLACK_MS was seen while hidden: the page was suspended */
  suspendedHidden: boolean
}

/** The marker for an absence still open (see AWAY_OPEN_MESSAGE). */
export interface AwayOpen {
  hiddenAtMs: number
  hiddenMono: number
  hiddenChainS: number | null
  from: string
  fromStage: string
  startedHidden: boolean
}

/** A shorter absence than this is a flap (a pull-down shade, a permission
 *  sheet) and is not a game-log line: it cannot have hidden a turn. */
export const AWAY_MIN_LOGGED_MS = 1000
const AWAY_INTERVAL_TAG = "foreground"
const AWAY_INTERVAL_MESSAGE = "away interval"
/** Written once a hide has lasted AWAY_MIN_LOGGED_MS, before any return: an app
 *  killed while hidden never writes the interval, and this marker is all that
 *  says it left. The interval that closes it has the same hiddenAtMs. */
const AWAY_OPEN_MESSAGE = "away open"
/** Written once, when a hidden page has kept ticking this long without a gap:
 *  the page is not suspended, so the app is not in the background (a minimized
 *  game tab or another screen). It is the only evidence an away that never
 *  closes (the game ends, the page dies) carries. */
const AWAY_RUNNING_MESSAGE = "away running"
export const AWAY_RUNNING_LOGGED_MS = 10_000

/** The marker for a hidden page that is still running (see AWAY_RUNNING_MESSAGE). */
export interface AwayRunning {
  hiddenAtMs: number
  hiddenMono: number
  ranHiddenMs: number
  from: string
  fromStage: string
}

export const FOREGROUND_LITERALS = [
  "foreground",
  "away running",
  "app.away_ms",
  "app.opened_from_notification",
  "notification.moment",
  "app.resumed",
  "app.return_source",
  "app.screen",
  "app.screen.from",
  "game.stage",
  "game.stage.from",
  "app.suspended",
  "play.started",
  "home",
  "waiting",
  "game",
  "payoff",
  "none",
  "connecting",
  "game.round",
  "game.confirm",
  ...MOMENTS.map((moment) => `game.round.${moment}`),
  "true",
  "false",
  "notification",
  "other",
  ...NOTIFICATION_MOMENTS,
] as const

let notificationMoment: string | null = null

const PAYOFF_PATHS = ["/collectables", "/prize-draw"]

/** Classify the route and the chain-driven game scene into stable metric tags. */
export function foregroundContext(pathname: string, scene?: SceneName, moment?: MomentName): ForegroundContext {
  if (scene === "waiting") return { screen: "waiting", stage: "none", playStarted: false }
  if (scene === "game.confirm") return { screen: "game", stage: "game.confirm", playStarted: true }
  if (scene === "game.round") {
    return { screen: "game", stage: moment ? `game.round.${moment}` : "game.round", playStarted: true }
  }
  if (scene === "chest" || scene === "draw.wheel" || PAYOFF_PATHS.some((path) => pathname.startsWith(path))) {
    return { screen: "payoff", stage: "none", playStarted: false }
  }
  if (pathname.startsWith("/game")) return { screen: "game", stage: "connecting", playStarted: false }
  return { screen: "home", stage: "none", playStarted: false }
}

function currentContext(): ForegroundContext {
  try {
    const pathname = typeof location === "undefined" ? "/" : location.pathname
    return foregroundContext(pathname, currentScene(), currentMoment())
  } catch {
    return { screen: "home", stage: "none", playStarted: false }
  }
}

/** Consume the worker reminder marker without disturbing another route state. */
export function consumeNotificationReturnSource(): "notification" | null {
  try {
    if (typeof location === "undefined") return null
    const params = new URLSearchParams(location.search)
    if (params.get(NOTIFICATION_PARAM) !== REMINDER_VALUE) return null
    const moment = params.get(MOMENT_PARAM)
    notificationMoment = moment === null ? null : NOTIFICATION_MOMENTS.has(moment) ? moment : "other"
    params.delete(NOTIFICATION_PARAM)
    params.delete(MOMENT_PARAM)
    const query = params.toString()
    try {
      history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`)
    } catch {
      /* attribution still matters when a host forbids history replacement */
    }
    return "notification"
  } catch {
    return null
  }
}

/** Send one return as an aggregatable duration plus an exact return count. */
export function recordForegroundReturn(value: ForegroundReturn): void {
  try {
    const moment = value.source === "notification" ? notificationMoment : null
    if (value.source === "notification") notificationMoment = null
    const returnedAttrs = {
      "app.screen": value.returned.screen,
      "game.stage": value.returned.stage,
      "app.suspended": value.suspended ? "true" : "false",
      "play.started": value.returned.playStarted ? "true" : "false",
      "app.return_source": value.source,
      ...(moment ? { "notification.moment": moment } : {}),
    }
    if (value.awayMs === null) {
      recordCount("app.opened_from_notification", 1, returnedAttrs)
      return
    }
    const attrs = {
      "app.screen.from": value.left.screen,
      ...returnedAttrs,
      "game.stage.from": value.left.stage,
    }
    recordDistribution("app.away_ms", value.awayMs, "millisecond", attrs)
    recordCount("app.resumed", 1, attrs)
  } catch {
    /* telemetry never changes the app */
  }
}

interface WatchOptions {
  wallNow?: () => number
  monoNow?: () => number
  pageHidden?: () => boolean
  context?: () => ForegroundContext
  watchPageHidden?: (onHidden: () => void, onShown: (event?: ShownEvent) => void) => () => void
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (id: unknown) => void
  emit?: (value: ForegroundReturn) => void
  returnSource?: () => "notification" | null
  /** the game clock (lib/chain-clock.ts) in ms, null before it has an anchor */
  chainNow?: () => number | null
  /** where an interval goes: the game log's line */
  logInterval?: (interval: AwayInterval) => void
  logOpen?: (open: AwayOpen) => void
  logRunning?: (running: AwayRunning) => void
}

/** The page lifecycle hands the pageshow event to onShown; a visibility flip gives none. */
type ShownEvent = { type?: string } | undefined

interface Away {
  atInstall: boolean
  openLogged: boolean
  runningLogged: boolean
  /** the last hidden tick (or the hide itself), to see a gap between ticks */
  lastHiddenTick: ClockReading
  ranHiddenMs: number
  suspendedHidden: boolean
  at: ClockReading
  context: ForegroundContext
}

interface ClockReading {
  wall: number
  mono: number
  chainS: number | null
}

function logAwayInterval(interval: AwayInterval): void {
  devLog(AWAY_INTERVAL_TAG, AWAY_INTERVAL_MESSAGE, interval)
}

function logAwayOpen(open: AwayOpen): void {
  devLog(AWAY_INTERVAL_TAG, AWAY_OPEN_MESSAGE, open)
}

function logAwayRunning(running: AwayRunning): void {
  devLog(AWAY_INTERVAL_TAG, AWAY_RUNNING_MESSAGE, running)
}

function elapsedAcrossAbsence(from: ClockReading, to: ClockReading): number {
  const mono = to.mono - from.mono
  const wall = to.wall - from.wall
  if (wall >= mono && wall > 0) return wall
  return mono > 0 ? mono : 0
}

/** Install the page-lifetime watcher. The returned cleanup is idempotent. */
export function watchForegroundReturns(options: WatchOptions = {}): () => void {
  const wallNow = options.wallNow ?? (() => Date.now())
  const monoNow = options.monoNow ?? (() => performance.now())
  const hidden = options.pageHidden ?? readPageHidden
  const context = options.context ?? currentContext
  const watch = options.watchPageHidden ?? watchHidden
  const every = options.setInterval ?? ((callback, ms) => globalThis.setInterval(callback, ms))
  const clear = options.clearInterval ?? ((id) => globalThis.clearInterval(id as ReturnType<typeof globalThis.setInterval>))
  const emit = options.emit ?? recordForegroundReturn
  const returnSource = options.returnSource ?? consumeNotificationReturnSource
  const chainNow = options.chainNow ?? chainNowMs
  const logInterval = options.logInterval ?? logAwayInterval
  const logOpen = options.logOpen ?? logAwayOpen
  const logRunning = options.logRunning ?? logAwayRunning
  let loggedIntervals = 0

  let stopped = false
  let away: Away | null = null
  let lastTick: ClockReading = { wall: 0, mono: 0, chainS: null }
  let lastContext: ForegroundContext = { screen: "home", stage: "none", playStarted: false }
  let pendingSource: "notification" | null = null
  let notificationSourceArmed = true

  const readClock = (read: () => number, fallback: number): number => {
    try {
      const value = read()
      return Number.isFinite(value) ? value : fallback
    } catch {
      return fallback
    }
  }
  const readChainS = (): number | null => {
    try {
      const ms = chainNow()
      return ms === null || !Number.isFinite(ms) ? null : Math.round(ms) / 1000
    } catch {
      return null
    }
  }
  const readClocks = (): ClockReading => ({
    wall: readClock(wallNow, lastTick.wall),
    mono: readClock(monoNow, lastTick.mono),
    chainS: readChainS(),
  })
  const writeInterval = (from: ClockReading, to: ClockReading, via: AwayVia, left: ForegroundContext, returned: ForegroundContext, suspended: boolean, source: ForegroundReturnSource, startedHidden = false, hiddenRun = { ranHiddenMs: 0, suspendedHidden: false }): void => {
    try {
      // a game clock behind across a visible freeze would give the interval a
      // sliver of a span: the edges stay null and a reader falls back to the wall
      const chain = via !== "freeze-detected"
      if (Math.max(to.wall - from.wall, to.mono - from.mono) < AWAY_MIN_LOGGED_MS) return
      loggedIntervals += 1
      logInterval({
        hiddenAtMs: from.wall,
        shownAtMs: to.wall,
        hiddenMono: from.mono,
        shownMono: to.mono,
        hiddenChainS: chain ? from.chainS : null,
        shownChainS: chain ? to.chainS : null,
        via,
        from: left.screen,
        fromStage: left.stage,
        to: returned.screen,
        toStage: returned.stage,
        suspended,
        source,
        seq: loggedIntervals,
        startedHidden,
        ranHiddenMs: Math.round(hiddenRun.ranHiddenMs),
        suspendedHidden: hiddenRun.suspendedHidden,
      })
    } catch {
      /* a log line never changes the app */
    }
  }
  const readContext = (): ForegroundContext => {
    try {
      return context()
    } catch {
      return lastContext
    }
  }
  const readSource = (): "notification" | null => {
    try {
      const source = returnSource()
      if (!source) {
        notificationSourceArmed = true
        return null
      }
      if (!notificationSourceArmed) return null
      notificationSourceArmed = false
      return source
    } catch {
      return null
    }
  }
  const takeSource = (observed: "notification" | null = readSource()): ForegroundReturnSource => {
    const source = pendingSource ?? observed ?? "other"
    pendingSource = null
    // The real consumer removes the query synchronously. Observe that absence
    // now so a later reminder can arm, while a marker restored by Next remains
    // disarmed because the provider still returns notification.
    if (source === "notification") readSource()
    return source
  }

  lastTick = readClocks()
  lastContext = readContext()

  let installing = true
  const onHidden = (): void => {
    if (stopped || away) return
    // A cleaned marker seen as absent arms attribution for a later tap. A
    // marker restored continuously by Next stays disarmed.
    readSource()
    const at = readClocks()
    away = { at, context: readContext(), atInstall: installing, openLogged: false, runningLogged: false, lastHiddenTick: at, ranHiddenMs: 0, suspendedHidden: false }
    reportPageActivity(true)
  }

  /** A gap between two hidden ticks longer than a freeze means the page was suspended;
   *  otherwise the page is running and the run extends to this reading. */
  const trackHiddenRun = (current: Away, at: ClockReading): void => {
    const gap = Math.max(at.wall - current.lastHiddenTick.wall, at.mono - current.lastHiddenTick.mono)
    if (gap > FOREGROUND_TICK_MS + FREEZE_SLACK_MS) current.suspendedHidden = true
    else if (!current.suspendedHidden) current.ranHiddenMs = Math.max(current.ranHiddenMs, at.mono - current.at.mono)
    current.lastHiddenTick = at
  }

  const onShown = (event?: ShownEvent): void => {
    if (stopped || hidden() || !away) return
    const returnedAt = readClocks()
    const returned = readContext()
    reportPageActivity(false)
    trackHiddenRun(away, returnedAt)
    const source = takeSource()
    const value = { awayMs: elapsedAcrossAbsence(away.at, returnedAt), left: away.context, returned, suspended: false, source } satisfies ForegroundReturn
    emit(value)
    publishForegroundReturn(value)
    writeInterval(away.at, returnedAt, event?.type === "pageshow" ? "pageshow" : "visibility", away.context, returned, false, source, away.atInstall, away)
    away = null
    lastTick = returnedAt
    lastContext = returned
  }

  const tick = (): void => {
    if (stopped) return
    if (away || hidden()) {
      pendingSource ??= readSource()
      if (away) {
        const current = away
        trackHiddenRun(current, readClocks())
        if (!current.runningLogged && !current.suspendedHidden && current.ranHiddenMs >= AWAY_RUNNING_LOGGED_MS) {
          current.runningLogged = true
          try {
            logRunning({ hiddenAtMs: current.at.wall, hiddenMono: current.at.mono, ranHiddenMs: Math.round(current.ranHiddenMs), from: current.context.screen, fromStage: current.context.stage })
          } catch {
            /* a log line never changes the app */
          }
        }
      }
      if (away && !away.openLogged && readClocks().wall - away.at.wall >= AWAY_MIN_LOGGED_MS) {
        away.openLogged = true
        try {
          logOpen({ hiddenAtMs: away.at.wall, hiddenMono: away.at.mono, hiddenChainS: away.at.chainS, from: away.context.screen, fromStage: away.context.stage, startedHidden: away.atInstall })
        } catch {
          /* a log line never changes the app */
        }
      }
      return
    }
    const tickAt = readClocks()
    const returned = readContext()
    const observedSource = readSource()
    const wallDelta = tickAt.wall - lastTick.wall
    const monoDelta = tickAt.mono - lastTick.mono
    const frozenDelta = wallDelta - monoDelta
    if (wallDelta > 0 && monoDelta >= 0 && pageFroze(0, frozenDelta, FOREGROUND_TICK_MS)) {
      reportPageActivity(true, true)
      reportPageActivity(false, true)
      const source = takeSource(observedSource)
      const value = { awayMs: frozenDelta, left: lastContext, returned, suspended: true, source } satisfies ForegroundReturn
      emit(value)
      publishForegroundReturn(value)
      writeInterval(lastTick, tickAt, "freeze-detected", lastContext, returned, true, source)
    } else if (pendingSource || observedSource) {
      const value = { awayMs: null, left: lastContext, returned, suspended: false, source: takeSource(observedSource) } satisfies ForegroundReturn
      emit(value)
      publishForegroundReturn(value)
    }
    lastTick = tickAt
    lastContext = returned
  }

  let stopWatching = () => {}
  let timer: unknown
  try {
    const startsHidden = hidden()
    if (startsHidden) onHidden()
    installing = false
    stopWatching = watch(onHidden, onShown)
    timer = every(tick, FOREGROUND_TICK_MS)
    const initialSource = readSource()
    if (startsHidden) pendingSource = initialSource
    else if (initialSource) {
      emit({ awayMs: null, left: lastContext, returned: lastContext, suspended: false, source: initialSource })
    }
  } catch {
    /* a partial install is still safely removable */
  }

  return () => {
    if (stopped) return
    stopped = true
    try {
      stopWatching()
    } catch {
      /* never throws */
    }
    try {
      if (timer !== undefined) clear(timer)
    } catch {
      /* never throws */
    }
  }
}
