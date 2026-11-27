// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * THE CAMERA — one owner for the whole app.
 *
 * Every screen that shows or sends your face reads the SAME stream from here,
 * and nothing else calls `getUserMedia` for it. That is the whole point:
 *
 *  - Android hands a camera to one opener at a time, and hands it back
 *    asynchronously after a track stops. Two opens side by side, or a close
 *    followed straight by an open, found it still held, and the mesh fell
 *    back to sending a canvas stand-in. iOS shares one camera between opens,
 *    which is why only Android showed it.
 *  - Opening once also means one prompt, one warm-up, and one place that
 *    notices the camera going away.
 *
 * Holding: a screen HOLDS the camera while it needs it (`holdCamera`, or the
 * `useCamera` hook). The first hold opens it and the last release stops it,
 * after a grace period, so a route change (the waiting room handing over to
 * /game) passes the stream across instead of closing and reopening it.
 *
 * NO CAMERA, NO GAME. Jollity is played on camera, so a camera that cannot be
 * opened is `unavailable`, with the reason, and the screens say so and offer
 * a retry. Nothing ever stands in for it: a placeholder canvas would only
 * hide the failure from everyone.
 *
 * RECOVERY. While it is held, the camera is watched and reopened when it goes:
 *
 *  - the track ENDS: Android stops capture for an app in the background (9+),
 *    and a call or another app can take the camera outright;
 *  - the track is MUTED and stays that way: iOS mutes capture while the app is
 *    not in front (backgrounded, a call, an interruption) and normally unmutes
 *    it on return, but a host WebView does not always, and Android can mute
 *    before it ends.
 *
 * Nothing can open a camera from the background on either platform, so an
 * open, the first one included, waits for the page to be visible. A failed
 * open is retried with a backoff for as long as the camera is held and the
 * page is in front, and never given up on: a hidden page is retried once on
 * its return instead. A denial from that return open gets one retry after a
 * short wake beat; any other refusal waits for the player's tap, so a timed
 * loop can never raise the host's camera prompt again and again. Whoever
 * sends the camera subscribes and adopts the new stream (the mesh swaps it
 * into every connection with replaceTrack, no renegotiation).
 *
 * A COLD FIRST OPEN IS SLOW, NOT FAILED (#226). On a phone that has just
 * opened or resumed the app the first open can take longer than 6 s, while a
 * retry 2 s later works at once (the waiting room staggers its warm-up for
 * the same reason, lib/camera-help.ts). So an open that times out stays THE
 * open: the timeout only tells the player it
 * is taking longer, the retries wait for it, and the camera it answers with
 * is taken, up to a ceiling. A second open alongside the first is what
 * Android fails.
 */
import { useEffect, useSyncExternalStore } from "react"
import { CameraError, getLocalMedia, type CameraFailure } from "./webrtc/media"
import { devLog } from "./debug/log-store"
import { describeError } from "./host/error-detail"
import { recordCount, recordDistribution, reportCameraRestore, reportFailure } from "./telemetry"
import { cameraRecovered, cameraRecovering, currentGameTurn } from "./journeys/game-trace"
import { pageHidden, watchPageActivity, watchPageHidden } from "./page-lifecycle"
import { withTimeout } from "./with-timeout"
import { CAMERA_FRAME_TIMEOUT_MS, observeCameraFrames, type FrameObservation } from "./camera-frame"
import {
  acceptCameraStream,
  cameraOutboundAdvancing,
  cameraStreamId,
  clearCameraTrail,
  finishNoFrames,
  recordCameraJoin,
  recordCameraReuse,
  recordCameraTrail,
  recordNoFrames,
  recordSelfAttach,
  recordSelfFirstFrame,
  recordSelfPlay,
  recordSelfWindow,
  updateCameraTrack,
  type CameraCheckpoint,
  type CameraOpenTrigger,
} from "./camera-diagnostics"
export { cameraHandoverSummary } from "./camera-diagnostics"

export type { CameraFailure } from "./webrtc/media"

export type CameraState =
  | { kind: "off" }
  | { kind: "opening" }
  /** `muted`: the OS has paused capture (the app left the front, a call);
   *  it normally comes back on its own, and is reopened if it does not */
  | { kind: "live"; stream: MediaStream; muted: boolean }
  | { kind: "unavailable"; reason: CameraFailure }

/** how long the camera stays open after its last holder lets go. It has to
 *  outlast a route change in the host, where the next screen's code can still
 *  be coming off the gateway; a close in that gap would be the reopen Android
 *  fails. The light stays on this long after a game, which is the cost. */
const RELEASE_GRACE_MS = 10_000

/** 360×360: a 183 px tile is 366 device px on a 2× phone, so 360 is shown
 *  about 1:1, and the 3× iPhones see it a little soft. Against 480 it is 44%
 *  fewer pixels to encode and decode, five times over, where real games
 *  found iPhones struggling and every phone bandwidth-limited. 640 was
 *  decode time and memory no screen showed. The mesh sends it as H.264, capped. */
const OPEN = { video: true, audio: false, width: 360, height: 360, fps: 24, facing: "user" } as const
/** a muted camera gets this long, visible, to unmute on its own before it is
 *  reopened: iOS unmutes on return, and a reopen would cost it a blink. The
 *  wait is owned by the reducer (#1539): 3 s while no tap is offered, so the
 *  offer lands on the third still-muted check, about 9 s in; then one 6 s
 *  step and a 12 s cap for as long as the tap is offered or spent (Ionut,
 *  27 Nov), so a stuck host camera is not opened every 3 s (#1539) and a
 *  never-tapping player still gets a working camera back. Only a frame (not
 *  while tapping), an unmute, a page return or a working tap resets it. */
const MUTED_GRACE_BACKOFF_MS = [3_000, 6_000, 12_000]
/** waits between reopen attempts after a failed one, the last repeating.
 *  Capped at 10 s so a recovering camera comes back within one turn. */
const RETRY_BACKOFF_MS = [2000, 4000, 8000, 10_000]
/** A busy camera is retried at this steady pace instead: a player who ends a
 *  call without leaving Jollity sees it come on within one beat, where a
 *  backoff could cost them most of a 12 s turn. */
const BUSY_RETRY_MS = 2000
/** A return-triggered denial can be the WebView waking rather than a real
 *  refusal. Give it one short beat before the single retry. */
const RETURN_RETRY_MS = 500
/** how long after it began a timed-out open is still waited for, before a
 *  fresh one is asked for instead */
const LATE_CEILING_MS = 30_000
const NO_FRAME_REOPEN_INTERVAL_MS = 60_000
const NO_FRAME_REOPEN_LIMIT = 3
const QUICK_MUTE_MS = 2_000
const TAP_FRAME_WINDOW_MS = 5_000

/** The camera's retry/recovery decisions. Media, timers and page reads stay
 * in the host; their facts arrive on events and effects leave as commands.
 * The reducer owns the still-muted backoff: `mutedChecks` counts the checks
 * since the camera was last healthy, and `mutedGraceMs` turns it into the
 * wait (#1539). */
export interface CameraRecoveryState {
  retries: number
  deferred: boolean
  scheduledAttempt: number | null
  mutedStreak: number
  mutedChecks: number
  tap: "none" | "offered" | "tapping" | "spent"
}

export type CameraRecoveryEvent =
  | { kind: "recover"; held: boolean; hidden: boolean; reason: string; trigger: CameraOpenTrigger; deferWithoutHolder?: boolean }
  | { kind: "retry"; held: boolean; hidden: boolean; reason: CameraFailure; waitOverride?: number; trigger: CameraOpenTrigger }
  | { kind: "retry-fired"; attempt: number; held: boolean; hidden: boolean }
  | { kind: "shown"; held: boolean; hidden: boolean; unavailable: boolean }
  | { kind: "clear" }
  | { kind: "live" }
  | { kind: "still-muted-quick" | "still-muted-slow" }
  | { kind: "unmuted" | "frame" | "hidden" | "tap" | "tap-frames" | "tap-muted" | "tap-error" }
  | { kind: "stop" }

export type CameraRecoveryCommand =
  | { kind: "recover"; reason: string; trigger: CameraOpenTrigger }
  | { kind: "schedule"; reason: CameraFailure; trigger: CameraOpenTrigger; attempt: number; waitMs: number }
  | { kind: "offer-tap" }
  | { kind: "episode-end"; reason: "recovered" | "hidden" | "game_end" | "frames" | "still_muted" | "error" }

export function startCameraRecovery(): CameraRecoveryState {
  return { retries: 0, deferred: false, scheduledAttempt: null, mutedStreak: 0, mutedChecks: 0, tap: "none" }
}

/** the wait before the next still-muted check reopens the camera: 3 s while
 *  no tap is offered (the offer lands on the third check, ~9 s in), then one
 *  6 s step, then the 12 s cap while the tap is offered, tapping or spent
 *  (Ionut, 27 Nov). `mutedChecks` counts the still-muted checks since the
 *  camera was last healthy; the check that offers the tap is the third, so
 *  the 6 s step is the wait after the FOURTH check. */
export function mutedGraceMs(state: CameraRecoveryState): number {
  if (state.tap === "none") return MUTED_GRACE_BACKOFF_MS[0]!
  return MUTED_GRACE_BACKOFF_MS[Math.min(Math.max(0, state.mutedChecks - 2), MUTED_GRACE_BACKOFF_MS.length - 1)]!
}

export function cameraRecoveryStep(
  state: CameraRecoveryState,
  event: CameraRecoveryEvent,
): { state: CameraRecoveryState; commands: CameraRecoveryCommand[] } {
  const stay = { state, commands: [] as CameraRecoveryCommand[] }
  if (event.kind === "stop") return {
    state: startCameraRecovery(),
    commands: state.tap === "offered" || state.tap === "tapping" ? [{ kind: "episode-end", reason: "game_end" }] : [],
  }
  if (event.kind === "live") return { state: { ...state, retries: 0 }, commands: [] }
  if (event.kind === "clear") return { state: { ...state, deferred: false, scheduledAttempt: null }, commands: [] }
  if (event.kind === "still-muted-quick" || event.kind === "still-muted-slow") {
    if (state.tap === "tapping") return stay
    const mutedStreak = event.kind === "still-muted-quick" ? state.mutedStreak + 1 : 1
    const mutedChecks = state.mutedChecks + 1
    if (state.tap === "none" && mutedStreak >= 3) return {
      state: { ...state, mutedStreak, mutedChecks, tap: "offered" },
      commands: [{ kind: "offer-tap" }, { kind: "recover", reason: "still muted", trigger: "force" }],
    }
    return {
      state: { ...state, mutedStreak, mutedChecks },
      commands: [{ kind: "recover", reason: "still muted", trigger: "force" }],
    }
  }
  if (event.kind === "tap") {
    if (state.tap !== "offered") return stay
    return { state: { ...state, tap: "tapping" }, commands: [] }
  }
  if (event.kind === "tap-frames" || event.kind === "tap-muted" || event.kind === "tap-error") {
    if (state.tap !== "tapping") return stay
    const reason = event.kind === "tap-frames" ? "frames" : event.kind === "tap-muted" ? "still_muted" : "error"
    return {
      // only a WORKING tap is health: it resets the backoff too, so the next
      // mute starts at the 3 s grace again. A spent tap (muted again, error)
      // changes nothing about the camera, so the backoff stays at the cap
      // (#1539 review)
      state: { ...state, mutedStreak: 0, mutedChecks: event.kind === "tap-frames" ? 0 : state.mutedChecks, tap: event.kind === "tap-frames" ? "none" : "spent" },
      commands: [{ kind: "episode-end", reason }],
    }
  }
  if (event.kind === "unmuted" || event.kind === "frame" || event.kind === "hidden") {
    // a frame while tapping is the tapped stream's own frame, not health: it
    // does not clear the episode or reset the backoff (#1539 review)
    if (state.tap === "tapping" && event.kind !== "hidden") return stay
    const commands: CameraRecoveryCommand[] = state.tap === "offered" || state.tap === "tapping"
      ? [{ kind: "episode-end", reason: event.kind === "hidden" ? "hidden" : "recovered" }]
      : []
    return { state: { ...state, mutedStreak: 0, mutedChecks: 0, tap: "none" }, commands }
  }
  if (event.kind === "recover") {
    if (event.hidden && (event.held || event.deferWithoutHolder))
      return { state: { ...state, deferred: true }, commands: [] }
    if (!event.held) return stay
    return { state, commands: [{ kind: "recover", reason: event.reason, trigger: event.trigger }] }
  }
  if (event.kind === "retry") {
    if (!event.held) return stay
    if (event.hidden) return { state: { ...state, deferred: true }, commands: [] }
    const attempt = state.retries + 1
    const waitMs = event.waitOverride ??
      (event.reason === "busy" ? BUSY_RETRY_MS : RETRY_BACKOFF_MS[Math.min(state.retries, RETRY_BACKOFF_MS.length - 1)]!)
    return {
      state: { ...state, retries: attempt, scheduledAttempt: attempt },
      commands: [{ kind: "schedule", reason: event.reason, trigger: event.trigger, attempt, waitMs }],
    }
  }
  if (event.kind === "retry-fired") {
    if (state.scheduledAttempt !== event.attempt) return stay
    if (!event.held) return { state: { ...state, scheduledAttempt: null }, commands: [] }
    if (event.hidden)
      return { state: { ...state, deferred: true, scheduledAttempt: null }, commands: [] }
    return {
      state: { ...state, scheduledAttempt: null },
      commands: [{ kind: "recover", reason: `retry ${state.retries}`, trigger: "retry" }],
    }
  }
  if (event.kind !== "shown" || !event.held || event.hidden || (!state.deferred && !event.unavailable)) return stay
  return {
    state: { ...state, deferred: false },
    commands: [{ kind: "recover", reason: "back in front", trigger: "return" }],
  }
}

let state: CameraState = { kind: "off" }
let opening: Promise<MediaStream | null> | null = null
let holders = 0
let releaseTimer: ReturnType<typeof setTimeout> | undefined
let mutedTimer: ReturnType<typeof setTimeout> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let recovery = startCameraRecovery()
let openedAt = 0
let mutedQuick = false
let tappedStream: MediaStream | null = null
let tappedObserver: FrameObservation | null = null
let tappedFirstFrameMs: number | undefined
let tappedFrames5s: number | undefined
let tappedError: CameraFailure | undefined
let tapEpisode: {
  beganAt: number
  autoRetries: number
  shownAt?: number
  turnShown?: number
  tappedAt?: number
} | null = null
/** the camera has been live since it was last stopped: a failure now is a
 *  recovery's, not a first open's */
let wasLive = false
/** a recovery that has to wait for the page to come back to the front */
let unwatchTrack: (() => void) | null = null
let watchingPage = false
let hiddenSinceOpen = false
let recoveryReason: string | null = null
let requestedJoin = false
let joinMetricRecorded = false
let cameraGeneration = 0
const checked = new Set<string>()
const firstFrameStreams = new WeakSet<MediaStream>()
const previewObservers = new Map<CameraCheckpoint, FrameObservation>()
const previewObserverStreams = new Map<CameraCheckpoint, MediaStream>()
let noFrameIncident: {
  original: MediaStream
  checkpoint: CameraCheckpoint
  generation: number
  hidden: boolean
  reopenPending: boolean
  replacementGeneration?: number
  timer?: ReturnType<typeof setTimeout>
} | null = null
const noFrameReopens: number[] = []
let terminalNoFrameGeneration = -1
/** recovery has given up on a camera that sends no frames (#1338): the player
 *  must restart the Polkadot app. Cleared when any frame is presented. */
let cameraGaveUp = false
let pageWasSuspended = false
let pageActivityPaused = false
/** the attempts since the camera was last live (or first asked for): when
 *  the first began, how many, whether the page was hidden meanwhile, whether
 *  the failure was reported (one event per outage), and the open that timed
 *  out and may still answer */
type CameraOutage = {
  began: number
  attempts: number
  hidden: boolean
  reported: boolean
  late: { answer: Promise<MediaStream | null>; began: number; awaited: boolean } | null
}
let outage: CameraOutage | null = null
const listeners = new Set<() => void>()
type CameraTapSnapshot = { tap: CameraRecoveryState["tap"]; opening: boolean }
const SERVER_CAMERA_TAP_SNAPSHOT: CameraTapSnapshot = { tap: "none", opening: false }
let cameraTapSnapshot: CameraTapSnapshot = SERVER_CAMERA_TAP_SNAPSHOT

function setState(next: CameraState) {
  state = next
  notifyCamera()
}

function notifyCamera() {
  const openingNow = opening !== null
  if (cameraTapSnapshot.tap !== recovery.tap || cameraTapSnapshot.opening !== openingNow)
    cameraTapSnapshot = { tap: recovery.tap, opening: openingNow }
  for (const listener of listeners) listener()
}

function setCameraGaveUp(next: boolean) {
  if (cameraGaveUp === next) return
  cameraGaveUp = next
  for (const listener of listeners) listener()
}

/** true once recovery gave up on a camera that sends no frames while a screen holds it */
export function cameraRecoveryGaveUp(): boolean {
  return cameraGaveUp
}

export function cameraTapState(): CameraTapSnapshot {
  return cameraTapSnapshot
}

export function cameraState(): CameraState {
  return state
}

export function subscribeCamera(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function isLive(stream: MediaStream): boolean {
  return stream.getVideoTracks().some((track) => track.readyState === "live")
}

/**
 * The camera's stream, opening it if nobody has; null when it could not be
 * opened (the state says why). A dead track is replaced by a fresh open, so
 * asking again is also how a caller retries. Concurrent callers share one
 * open. `force` reopens a camera that still reads live (a muted one that
 * never came back).
 */
export function openCamera(force = false): Promise<MediaStream | null> {
  return openCameraFor(force, force ? "force" : "warm-up")
}

function openCameraFor(force: boolean, trigger: CameraOpenTrigger): Promise<MediaStream | null> {
  if (opening) return opening
  if (!force && state.kind === "live" && isLive(state.stream)) {
    recordCameraReuse(state.stream)
    return Promise.resolve(state.stream)
  }
  watchPage()
  if (pageHidden()) {
    recordCameraTrail("open.requested", state.kind === "live" ? state.stream : null, { trigger, attempt: (outage?.attempts ?? 0) + 1, deferred: true })
    // nothing opens a camera from the background: it opens on return
    recovery = cameraRecoveryStep(recovery, {
      kind: "recover",
      held: holders > 0,
      hidden: true,
      reason: "open requested",
      trigger,
      deferWithoutHolder: true,
    }).state
    return Promise.resolve(null)
  }
  const previous = state.kind === "live" ? state.stream : null
  clearRecovery()
  const tries = (outage ??= { began: Date.now(), attempts: 0, hidden: false, reported: false, late: null })
  if (trigger === "return") tries.hidden = true
  recordCameraTrail("open.requested", previous, { trigger, attempt: tries.late ? Math.max(1, tries.attempts) : tries.attempts + 1 })
  // a timed-out open still in flight keeps the player's "taking longer"
  if (!tries.late) setState({ kind: "opening" })
  opening = attempt(previous, tries, trigger).finally(() => {
    opening = null
    notifyCamera()
  })
  notifyCamera()
  return opening
}

async function attempt(previous: MediaStream | null, tries: CameraOutage, trigger: CameraOpenTrigger): Promise<MediaStream | null> {
  // the old stream goes first: on Android a camera still held by it is
  // exactly what makes the new open fail
  previous?.getTracks().forEach((track) => track.stop())
  const answered = await awaitLate(tries)
  if (answered) return goLive(answered, true, trigger, Date.now() - tries.began)
  if (state.kind !== "opening") setState({ kind: "opening" })
  return freshAttempt(previous, tries, trigger)
}

function freshAttempt(
  previous: MediaStream | null,
  tries: CameraOutage,
  trigger: CameraOpenTrigger,
  options: { retryBusy?: boolean; retryFailure?: boolean; tapped?: boolean } = {},
): Promise<MediaStream | null> {
  tries.attempts++
  const began = Date.now()
  const answer = getLocalMedia(OPEN, { retryBusy: options.retryBusy })
  return answer.then(
    (stream) => goLive(stream, false, trigger, Date.now() - began),
    (error) => {
      const reason = error instanceof CameraError ? error.reason : "unknown"
      if (options.tapped) tappedError = reason
      recordCameraTrail("open.failed", previous, { trigger, attempt: tries.attempts, reason })
      if (error instanceof CameraError && error.late) keepLate(tries, error.late, began)
      if (options.retryFailure !== false && reason === "denied" && trigger === "return") {
        scheduleRetry(reason, RETURN_RETRY_MS, "return")
        return null
      }
      setState({ kind: "unavailable", reason })
      if (!tries.reported) {
        tries.reported = true
        reportFailure("camera-unavailable", {
          reason,
          context: {
            detail: describeError(error),
            open: wasLive ? "recovery" : "first",
            attempts: String(tries.attempts),
            since_first_ms: String(Date.now() - tries.began),
            hidden: String(tries.hidden),
          },
        })
      }
      // a refusal waits for the player: a timed retry would prompt again
      if (options.tapped) {
        markNoFramesTerminal()
        stepRecovery({ kind: "tap-error" })
      }
      if (options.retryFailure !== false && reason !== "denied") scheduleRetry(reason)
      return null
    },
  )
}

/** the camera is live: count the wait, if it was the first, and watch it */
function goLive(stream: MediaStream, answeredLate: boolean, trigger: CameraOpenTrigger, openMs: number): MediaStream {
  // never two cameras: a late answer taken over a live one stops the other
  if (state.kind === "live" && state.stream !== stream) state.stream.getTracks().forEach((track) => track.stop())
  const track = stream.getVideoTracks()[0]
  const settings = track?.getSettings()
  devLog("camera", "camera open", {
    width: settings?.width,
    height: settings?.height,
    facing: settings?.facingMode,
  })
  if (outage && !wasLive) {
    // how long the player was without a camera, from the first attempt
    const ms = Date.now() - outage.began
    devLog("camera", "first camera live", { ms, attempts: outage.attempts, late: answeredLate })
    recordDistribution("camera.first_open_ms", ms, "millisecond", {
      "camera.attempts": String(outage.attempts),
      "camera.late": String(answeredLate),
    })
  }
  const triesAttempts = outage?.attempts ?? 1
  outage = null
  recovery = cameraRecoveryStep(recovery, { kind: "live" }).state
  openedAt = Date.now()
  mutedQuick = false
  if (trigger === "tap") tappedStream = stream
  // a healthy reopen (a track that is live and not muted) does NOT restart
  // the tap episode: a stuck camera reopens unmuted and re-mutes ~500 ms
  // later, and each such reopen would otherwise restart the episode, so the
  // #1535 report would only count the last mute (~12.5 s of ~23 s dead).
  // Only a frame, an unmute or a page return clears it. A tap's own open
  // keeps the episode, and an offered tap must stay offered.
  wasLive = true
  hiddenSinceOpen = false
  cameraGeneration++
  acceptCameraStream(stream, performance.now())
  noteNoFrameReplacementLive()
  recordCameraTrail("open.resolved", stream, { trigger, attempt: triesAttempts, open_ms: openMs, late: answeredLate })
  setState({ kind: "live", stream, muted: track?.muted === true })
  watchTrack(stream)
  if (recoveryReason && recoveryReason !== "no-frames") {
    recordCameraTrail("recover.done", stream, { reason: recoveryReason, outcome: "frame-source-open" })
    recoveryReason = null
  }
  if (recoveryReason !== "no-frames") cameraRecovered()
  return stream
}

/** a timed-out open stays the open: its camera is taken when it answers, by
 *  the open waiting on it or, with none, here; once given up on, stopped */
function keepLate(tries: CameraOutage, answer: Promise<MediaStream>, began: number) {
  const late = { answer: answer.then((stream) => stream, () => null), began, awaited: false }
  tries.late = late
  void late.answer.then((stream) => {
    if (outage?.late !== late) {
      stream?.getTracks().forEach((track) => track.stop())
      return
    }
    outage.late = null
    if (!stream || late.awaited) return // a failure is retried already; the open waiting takes it
    if (holders === 0) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    devLog("camera", "the camera answered late")
    clearRecovery()
    goLive(stream, true, "retry", Date.now() - late.began)
  })
}

/** the late open's camera, waited for up to the ceiling; null with none, or
 *  past it, when its camera is stopped if it ever comes */
async function awaitLate(tries: CameraOutage): Promise<MediaStream | null> {
  const late = tries.late
  if (!late) return null
  late.awaited = true
  const stream = await withTimeout(late.answer, late.began + LATE_CEILING_MS - Date.now())
  late.awaited = false
  if (tries.late === late) tries.late = null
  return stream
}

/**
 * The camera's stream once there is one: now, if it is live, or when a later
 * open succeeds (a retry). Opens it if nobody has.
 * The mesh waits here, so no room ever connects without your face. Resolves
 * null if `signal` aborts first.
 */
export function waitForCamera(signal?: AbortSignal): Promise<MediaStream | null> {
  return new Promise((resolve) => {
    const done = (stream: MediaStream | null) => {
      stop()
      signal?.removeEventListener("abort", onAbort)
      resolve(stream)
    }
    const onAbort = () => done(null)
    const check = () => {
      if (state.kind !== "live") return false
      done(state.stream)
      return true
    }
    const stop = subscribeCamera(() => void check())
    if (signal?.aborted) return done(null)
    signal?.addEventListener("abort", onAbort)
    if (!check()) void openCamera()
  })
}

// ── recovery ────────────────────────────────────────────────────────────────

function clearRecovery() {
  unwatchTrack?.()
  unwatchTrack = null
  if (mutedTimer) clearTimeout(mutedTimer)
  if (retryTimer) clearTimeout(retryTimer)
  mutedTimer = retryTimer = undefined
  recovery = cameraRecoveryStep(recovery, { kind: "clear" }).state
}

function stepRecovery(event: CameraRecoveryEvent): void {
  // the reducer owns the still-muted backoff: unmuted, frame (not while
  // tapping), hidden and stop reset it inside cameraRecoveryStep, so the
  // commands emitted by this step already see the count of the new episode
  const step = cameraRecoveryStep(recovery, event)
  recovery = step.state
  step.commands.forEach(runRecoveryCommand)
  notifyCamera()
}

function finishTapEpisode(reason: Extract<CameraRecoveryCommand, { kind: "episode-end" }>["reason"]): void {
  const episode = tapEpisode
  if (!episode?.shownAt) {
    tapEpisode = null
    return
  }
  const tapped = episode.tappedAt !== undefined
  reportCameraRestore({
    ...(episode.turnShown === undefined ? {} : { turnShown: episode.turnShown }),
    deadMs: Math.max(0, episode.shownAt - episode.beganAt),
    autoRetries: episode.autoRetries,
    tapped,
    ...(episode.tappedAt === undefined ? {} : { tapMs: Math.max(0, episode.tappedAt - episode.shownAt) }),
    ...(["recovered", "hidden", "game_end"].includes(reason)
      ? { end: reason as "recovered" | "hidden" | "game_end", ...(currentGameTurn() === undefined ? {} : { turnEnd: currentGameTurn() }) }
      : {
          outcome: reason as "frames" | "still_muted" | "error",
          ...(tappedFirstFrameMs === undefined ? {} : { firstFrameMs: tappedFirstFrameMs }),
          ...(tappedFrames5s === undefined ? {} : { frames5s: tappedFrames5s }),
          ...(tappedError === undefined ? {} : { error: tappedError }),
        }),
  })
  tapEpisode = null
  tappedStream = null
  tappedObserver?.stop()
  tappedObserver = null
  tappedFirstFrameMs = undefined
  tappedFrames5s = undefined
  tappedError = undefined
}

function runRecoveryCommand(command: CameraRecoveryCommand): void {
  if (command.kind === "offer-tap") {
    tapEpisode ??= { beganAt: Date.now(), autoRetries: recovery.mutedStreak }
    tapEpisode.autoRetries = Math.max(0, recovery.mutedStreak - 1)
    tapEpisode.shownAt = Date.now()
    tapEpisode.turnShown = currentGameTurn()
    notifyCamera()
    return
  }
  if (command.kind === "episode-end") {
    finishTapEpisode(command.reason)
    return
  }
  if (command.kind === "schedule") {
    recordCount("camera.retry", 1, {
      "camera.open": wasLive ? "recovery" : "first",
      "camera.reason": command.reason,
      "camera.attempt": String(command.attempt),
      "camera.wait_ms": String(command.waitMs),
      "camera.trigger": command.trigger === "warm-up" ? "open" : command.trigger,
    })
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      const fired = cameraRecoveryStep(recovery, {
        kind: "retry-fired",
        attempt: command.attempt,
        held: holders > 0,
        hidden: pageHidden(),
      })
      recovery = fired.state
      fired.commands.forEach(runRecoveryCommand)
    }, command.waitMs)
    return
  }
  devLog("camera", "reopening the camera", { reason: command.reason }, "warn")
  recordCameraTrail("recover.started", state.kind === "live" ? state.stream : null, { reason: command.reason, trigger: command.trigger })
  if (recoveryReason !== "no-frames") recoveryReason = command.reason
  void openCameraFor(true, command.trigger)
}

/** reopen now if the page is in front, or as soon as it comes back */
function recover(reason: string, trigger: CameraOpenTrigger = "force") {
  const step = cameraRecoveryStep(recovery, { kind: "recover", held: holders > 0, hidden: pageHidden(), reason, trigger })
  recovery = step.state
  step.commands.forEach(runRecoveryCommand)
}

function scheduleRetry(reason: CameraFailure, waitOverride?: number, trigger: CameraOpenTrigger = "warm-up") {
  const step = cameraRecoveryStep(recovery, {
    kind: "retry",
    held: holders > 0,
    hidden: pageHidden(),
    reason,
    waitOverride,
    trigger,
  })
  recovery = step.state
  step.commands.forEach(runRecoveryCommand)
}

/** a muted camera that is visible and stays muted for the grace is reopened */
function scheduleMutedCheck() {
  if (mutedTimer) clearTimeout(mutedTimer)
  mutedTimer = undefined
  if (pageHidden()) return // checked again when the page comes back
  // the still-muted reopen waits as long as the reducer's backoff says, so a
  // stuck camera is not reopened every 3 s (#1539)
  const graceMs = mutedGraceMs(recovery)
  mutedTimer = setTimeout(() => {
    mutedTimer = undefined
    if (holders > 0 && state.kind === "live" && state.muted) {
      cameraRecovering("still-muted")
      tapEpisode ??= { beganAt: Date.now(), autoRetries: 0 }
      stepRecovery({ kind: mutedQuick ? "still-muted-quick" : "still-muted-slow" })
    }
  }, graceMs)
}

function setMuted(muted: boolean) {
  if (state.kind !== "live" || state.muted === muted) return
  setState({ ...state, muted })
}

function watchTrack(stream: MediaStream) {
  const track = stream.getVideoTracks()[0]
  if (!track) return
  const onEnded = () => {
    devLog("camera", "camera track ended", { visible: !pageHidden() }, "warn")
    recordCameraTrail("track.ended", stream, { visible: !pageHidden() })
    updateCameraTrack(stream)
    cameraRecovering("track-ended")
    recover("track ended")
  }
  const onMute = () => {
    devLog("camera", "camera paused", { visible: !pageHidden() })
    recordCameraTrail("track.muted", stream, { visible: !pageHidden() })
    updateCameraTrack(stream)
    setMuted(true)
    mutedQuick = Date.now() - openedAt <= QUICK_MUTE_MS
    tapEpisode ??= { beganAt: Date.now(), autoRetries: 0 }
    if (recovery.tap === "tapping" && stream === tappedStream) {
      tappedFrames5s ??= 0
      markNoFramesTerminal()
      stepRecovery({ kind: "tap-muted" })
      scheduleMutedCheck()
      return
    }
    scheduleMutedCheck()
  }
  const onUnmute = () => {
    devLog("camera", "camera resumed")
    recordCameraTrail("track.unmuted", stream)
    updateCameraTrack(stream)
    setMuted(false)
    if (mutedTimer) clearTimeout(mutedTimer)
    mutedTimer = undefined
    stepRecovery({ kind: "unmuted" })
    if (recovery.tap === "none") tapEpisode = null
  }
  track.addEventListener("ended", onEnded)
  track.addEventListener("mute", onMute)
  track.addEventListener("unmute", onUnmute)
  unwatchTrack = () => {
    track.removeEventListener("ended", onEnded)
    track.removeEventListener("mute", onMute)
    track.removeEventListener("unmute", onUnmute)
  }
  if (track.muted) {
    mutedQuick = Date.now() - openedAt <= QUICK_MUTE_MS
    tapEpisode ??= { beganAt: Date.now(), autoRetries: 0 }
    scheduleMutedCheck()
  }
}

/** back in front: finish a recovery that had to wait, try a camera that could
 *  not be opened (the player may have just allowed it in their settings), and
 *  look at one that may have been taken while nobody was watching. Once per
 *  return: the open it starts is the one open in flight. */
function onShown() {
  if (pageHidden() || holders === 0) return
  const shown = cameraRecoveryStep(recovery, {
    kind: "shown",
    held: holders > 0,
    hidden: pageHidden(),
    unavailable: state.kind === "unavailable",
  })
  recovery = shown.state
  if (shown.commands.length > 0) {
    shown.commands.forEach(runRecoveryCommand)
    return
  }
  if (state.kind !== "live") return
  if (!isLive(state.stream)) {
    cameraRecovering("ended-while-away")
    recover("ended while away")
  }
  else if (state.muted) scheduleMutedCheck()
}

function watchPage() {
  if (watchingPage) return
  watchingPage = true
  watchPageHidden(() => {
    if (outage) outage.hidden = true
    stepRecovery({ kind: "hidden" })
    if (recovery.tap === "none") tapEpisode = null
    pauseNoFrameTerminalCheck()
  }, () => {
    resumeNoFrameTerminalCheck()
    onShown()
  })
  watchPageActivity((hidden, suspended) => {
    if (state.kind === "live" && (hidden || suspended)) hiddenSinceOpen = true
    if (suspended && !pageWasSuspended)
      recordCameraTrail("page.frozen", state.kind === "live" ? state.stream : null, { hidden_since_open: hiddenSinceOpen })
    else if (!hidden)
      recordCameraTrail("page.shown", state.kind === "live" ? state.stream : null, { hidden_since_open: hiddenSinceOpen, suspended })
    else if (!suspended)
      recordCameraTrail("page.hidden", state.kind === "live" ? state.stream : null, { hidden_since_open: hiddenSinceOpen })
    // The foreground tracker can report a shown edge as (false, true). That
    // edge completes this freeze episode even though it carries the metadata.
    pageWasSuspended = hidden ? suspended : false
    // A shown edge may carry suspended=true to say the page just returned
    // from a silent freeze. It is a resume edge, not a still-frozen state.
    pageActivityPaused = hidden
    if (pageActivityPaused) pauseNoFrameTerminalCheck()
    else resumeNoFrameTerminalCheck()
  })
}

// ── holding ─────────────────────────────────────────────────────────────────

/** recovery gives up on this generation's silent camera: the player must restart the app */
function markNoFramesTerminal(): void {
  terminalNoFrameGeneration = cameraGeneration
  setCameraGaveUp(true)
}

function closeNoFrameIncident(outcome: "frame" | "no-frame" | "open-failed" | "unresolved", replacement: MediaStream | null): void {
  const incident = noFrameIncident
  if (!incident) return
  if (incident.timer) clearTimeout(incident.timer)
  noFrameIncident = null
  if (outcome === "no-frame") markNoFramesTerminal()
  finishNoFrames(incident.original, replacement, incident.checkpoint, incident.hidden, outcome)
  recoveryReason = null
  cameraRecovered(outcome === "frame" ? "ready" : outcome)
}

function canReopenNoFrames(): boolean {
  const now = Date.now()
  return noFrameReopens.length < NO_FRAME_REOPEN_LIMIT && (noFrameReopens.length === 0 || now - noFrameReopens.at(-1)! >= NO_FRAME_REOPEN_INTERVAL_MS)
}

function beginNoFrameIncident(stream: MediaStream, checkpoint: CameraCheckpoint): void {
  const incident: NonNullable<typeof noFrameIncident> = {
    original: stream,
    checkpoint,
    generation: cameraGeneration,
    hidden: hiddenSinceOpen,
    reopenPending: true,
  }
  noFrameIncident = incident
  noFrameReopens.push(Date.now())
  recordNoFrames(stream, checkpoint, hiddenSinceOpen)
  recordCount("camera.reopen", 1, { "camera.reason": "no-frames", "camera.checkpoint": checkpoint })
  cameraRecovering("no-frames")
  recoveryReason = "no-frames"
  recordCameraTrail("recover.started", stream, { reason: "no-frames", checkpoint, generation: incident.generation })
}

function pauseNoFrameTerminalCheck(): void {
  const incident = noFrameIncident
  if (!incident?.timer) return
  clearTimeout(incident.timer)
  incident.timer = undefined
}

function resumeNoFrameTerminalCheck(): void {
  const incident = noFrameIncident
  if (!incident?.replacementGeneration || pageHidden() || pageActivityPaused) return
  if (incident.timer) clearTimeout(incident.timer)
  const replacementGeneration = incident.replacementGeneration
  incident.timer = setTimeout(() => {
    if (noFrameIncident !== incident || replacementGeneration !== cameraGeneration) return
    const replacement = state.kind === "live" ? state.stream : null
    const hasReplacementObserver = replacement !== null && [...previewObserverStreams.values()].some((stream) => stream === replacement)
    closeNoFrameIncident(hasReplacementObserver ? "no-frame" : "unresolved", replacement)
  }, CAMERA_FRAME_TIMEOUT_MS)
}

function noteNoFrameReplacementLive(): void {
  const incident = noFrameIncident
  if (!incident || cameraGeneration <= incident.generation) return
  if (incident.timer) clearTimeout(incident.timer)
  incident.reopenPending = false
  incident.replacementGeneration = cameraGeneration
  // The terminal bound starts only once a replacement is genuinely live.
  // It is reset if that replacement itself ends before presenting a frame,
  // and paused while the page cannot present one.
  resumeNoFrameTerminalCheck()
}

/** Hold the camera open. Returns the release; the last release stops it
 *  after the grace period. */
export function holdCamera(owner = "unknown"): () => void {
  holders++
  if (releaseTimer) {
    clearTimeout(releaseTimer)
    releaseTimer = undefined
  }
  let released = false
  return () => {
    if (released) return
    released = true
    holders--
    recordCameraTrail("stream.release", state.kind === "live" ? state.stream : null, { owner, grace_ms: RELEASE_GRACE_MS })
    if (holders > 0) return
    releaseTimer = setTimeout(() => {
      releaseTimer = undefined
      if (holders > 0) return
      void stopCamera()
    }, RELEASE_GRACE_MS)
  }
}

async function stopCamera() {
  const pending = opening
  if (pending) await pending.catch(() => undefined)
  if (holders > 0) return // someone took it back while it was still opening
  clearRecovery()
  stepRecovery({ kind: "stop" })
  wasLive = false
  outage = null // a late answer now is stopped
  for (const observer of previewObservers.values()) observer.stop()
  previewObservers.clear()
  previewObserverStreams.clear()
  closeNoFrameIncident("unresolved", null)
  recoveryReason = null
  noFrameReopens.length = 0
  terminalNoFrameGeneration = -1
  setCameraGaveUp(false)
  tapEpisode = null
  tappedStream = null
  tappedObserver?.stop()
  tappedObserver = null
  pageWasSuspended = false
  pageActivityPaused = false
  if (state.kind === "live") {
    recordCameraTrail("stream.stop", state.stream, { owner: "last-holder", grace_ms: RELEASE_GRACE_MS })
    state.stream.getTracks().forEach((track) => track.stop())
    devLog("camera", "camera closed")
  }
  clearCameraTrail()
  setState({ kind: "off" })
}

// ── actual local previews ──────────────────────────────────────────────────

/** Ask for the explicit game checkpoint. The own tile may not exist until the
 * final-wait ends; its later attachment starts the probe. */
export function requestCameraJoinCheck(): void {
  requestedJoin = true
  joinMetricRecorded = false
  if (state.kind === "live") {
    recordCameraJoin(state.stream)
    joinMetricRecorded = true
  }
}

/** Attach diagnostics and frame health to a real local preview element. Peer
 * videos never call this. */
export function attachCameraPreview(video: HTMLVideoElement, attached: MediaStream, checkpoint: CameraCheckpoint): () => void {
  if (state.kind !== "live") return () => {}
  const current = state.stream
  const stale = recordSelfAttach(video, attached, current, checkpoint)
  if (stale || video.srcObject !== current) video.srcObject = current
  if (checkpoint === "join" && requestedJoin && !joinMetricRecorded) {
    recordCameraJoin(current)
    joinMetricRecorded = true
  }

  previewObservers.get(checkpoint)?.stop()
  const key = `${cameraStreamId(current)}:${checkpoint}`
  let observer: FrameObservation | undefined
  let disposed = false
  let playState: "pending" | "resolved" | "rejected" = "pending"
  let ownsTappedObserver = false

  const stopObserver = () => {
    if (!observer) return
    if (previewObservers.get(checkpoint) === observer) {
      previewObservers.delete(checkpoint)
      previewObserverStreams.delete(checkpoint)
    }
    observer.stop()
    observer = undefined
  }
  const retryPreviewPlay = () => {
    playState = "pending"
    let playing: Promise<void>
    try {
      playing = video.play()
    } catch (error) {
      playState = "rejected"
      recordSelfPlay(current, checkpoint, "rejected", video, error)
      return
    }
    void playing.then(
      () => {
        playState = "resolved"
        recordSelfPlay(current, checkpoint, "resolved", video)
      },
      (error) => {
        playState = "rejected"
        recordSelfPlay(current, checkpoint, "rejected", video, error)
      },
    )
  }
  const startObserver = () => {
    if (disposed || observer) return
    observer = observeCameraFrames(video, {
      onFirstFrame(ms) {
        if (state.kind !== "live" || state.stream !== current) return
        if (!firstFrameStreams.has(current)) {
          firstFrameStreams.add(current)
          recordSelfFirstFrame(current, checkpoint, ms)
        }
        checked.add(key)
        setCameraGaveUp(false) // a camera that comes back by itself
        stepRecovery({ kind: "frame" })
        if (recovery.tap === "none") tapEpisode = null
        if (noFrameIncident && cameraGeneration > noFrameIncident.generation) closeNoFrameIncident("frame", current)
      },
      onWindow(frames, elapsedMs) {
        if (state.kind === "live" && state.stream === current) recordSelfWindow(current, checkpoint, frames, elapsedMs)
      },
      onTimeout() {
        if (holders === 0 || state.kind !== "live" || state.stream !== current || checked.has(key)) return
        if (recovery.tap === "tapping") return
        if (terminalNoFrameGeneration === cameraGeneration) {
          checked.add(key)
          return
        }
        const outboundAdvancing = cameraOutboundAdvancing()
        if (playState === "rejected" || (playState === "resolved" && video.paused) || outboundAdvancing) {
          recordCameraTrail("self.preview_stuck", current, {
            checkpoint,
            paused: video.paused,
            play_state: playState,
            outbound_advancing: outboundAdvancing,
          })
          retryPreviewPlay()
          return
        }
        if (noFrameIncident) {
          if (cameraGeneration > noFrameIncident.generation) {
            checked.add(key)
            closeNoFrameIncident("no-frame", current)
          }
          return
        }
        if (!canReopenNoFrames()) {
          checked.add(key)
          markNoFramesTerminal()
          recordNoFrames(current, checkpoint, hiddenSinceOpen)
          recordCount("camera.reopen_blocked", 1, { "camera.reason": "budget", "camera.checkpoint": checkpoint })
          recordCameraTrail("recover.skipped", current, { reason: "no-frames-budget", checkpoint, generation: cameraGeneration })
          return
        }
        beginNoFrameIncident(current, checkpoint)
        void openCameraFor(true, "force").then((replacement) => {
          if (!noFrameIncident) return
          if (!replacement && !pageHidden()) closeNoFrameIncident("open-failed", null)
        })
      },
    })
    previewObservers.set(checkpoint, observer)
    previewObserverStreams.set(checkpoint, current)
  }

  // The frame deadline starts at attachment. A camera with no frames can keep
  // play() pending forever, so playback readiness must never gate detection.
  startObserver()
  if (current === tappedStream && recovery.tap === "tapping") {
    tappedObserver?.stop()
    ownsTappedObserver = true
    tappedObserver = observeCameraFrames(video, {
      timeoutMs: TAP_FRAME_WINDOW_MS,
      windowMs: TAP_FRAME_WINDOW_MS,
      onFirstFrame(ms) {
        if (state.kind === "live" && state.stream === current && recovery.tap === "tapping")
          tappedFirstFrameMs = tapEpisode?.tappedAt === undefined ? ms : Math.max(0, Date.now() - tapEpisode.tappedAt)
      },
      onFrame(frames) {
        if (state.kind === "live" && state.stream === current && recovery.tap === "tapping") tappedFrames5s = frames
      },
      onWindow(frames) {
        if (state.kind !== "live" || state.stream !== current || recovery.tap !== "tapping") return
        tappedFrames5s = frames
        stepRecovery({ kind: "tap-frames" })
      },
      onTimeout() {
        if (state.kind !== "live" || state.stream !== current || recovery.tap !== "tapping") return
        tappedFrames5s = 0
        markNoFramesTerminal()
        stepRecovery({ kind: "tap-muted" })
      },
    })
  }
  retryPreviewPlay()
  return () => {
    disposed = true
    stopObserver()
    if (ownsTappedObserver) {
      tappedObserver?.stop()
      tappedObserver = null
    }
    recordCameraTrail("self.detach", current, { checkpoint })
    const incident = noFrameIncident
    if (incident && !incident.reopenPending) {
      setTimeout(() => {
        if (noFrameIncident === incident && previewObservers.size === 0)
          closeNoFrameIncident("unresolved", state.kind === "live" ? state.stream : null)
      }, 0)
    }
  }
}

/**
 * Hold the camera while `enabled`, and read its state. The hold opens it; the
 * state re-renders the caller when the stream is opened, replaced or lost.
 */
export function useCamera(enabled: boolean, openTrigger: CameraOpenTrigger = "warm-up"): CameraState {
  useEffect(() => {
    if (!enabled) return
    const release = holdCamera("screen")
    void openCameraFor(false, openTrigger)
    return release
  }, [enabled, openTrigger])
  return useSyncExternalStore(subscribeCamera, cameraState, () => OFF)
}

const OFF: CameraState = { kind: "off" }

/** whether to tell the player to restart the Polkadot app (#1338) */
export function useCameraGaveUp(): boolean {
  return useSyncExternalStore(subscribeCamera, cameraRecoveryGaveUp, () => false)
}

export function useCameraTapState(): { tap: CameraRecoveryState["tap"]; opening: boolean } {
  return useSyncExternalStore(subscribeCamera, cameraTapState, () => SERVER_CAMERA_TAP_SNAPSHOT)
}

/** One getUserMedia call inside the click; no delayed busy retry can outlive activation. */
export function tapCamera(): void {
  if (recovery.tap !== "offered" || opening) return
  stepRecovery({ kind: "tap" })
  clearRecovery()
  outage = null
  const previous = state.kind === "live" ? state.stream : null
  previous?.getTracks().forEach((track) => track.stop())
  tapEpisode ??= { beganAt: Date.now(), autoRetries: recovery.mutedStreak }
  tapEpisode.tappedAt = Date.now()
  recordCameraTrail("open.requested", previous, { trigger: "tap", attempt: 1 })
  setState({ kind: "opening" })
  const tries: CameraOutage = { began: Date.now(), attempts: 0, hidden: false, reported: false, late: null }
  opening = freshAttempt(previous, tries, "tap", { retryBusy: false, retryFailure: false, tapped: true }).finally(() => {
    opening = null
    notifyCamera()
  })
  notifyCamera()
}

/** Read the camera's state without holding it — for a screen that only
 *  reports on a camera someone else holds. */
export function useCameraState(): CameraState {
  return useSyncExternalStore(subscribeCamera, cameraState, () => OFF)
}
