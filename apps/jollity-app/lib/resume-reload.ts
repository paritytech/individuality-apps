// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { chainNowMs } from "./chain-clock"
import { devLog } from "./debug/log-store"
import { requestSelfReload } from "./self-reload"
import { watchForegroundReturn, type ForegroundContext, type ForegroundReturn } from "./telemetry/foreground"
import { recordCount, recordDistribution } from "./telemetry/metrics"

export const LONG_RETURN_OBSERVE_MS = 60_000
export const LONG_SUSPENSION_RELOAD_MS = 5 * 60_000
export const RETURN_CANDIDATE_WINDOW_MS = 5_000
const RETURN_CANDIDATE_KEY = "jollity:return-candidate-probe"
const RETURN_CANDIDATE_TTL_MS = 10 * 60_000
/** A home screen holding a seat reloads on a long return this close to kickoff (#1157). */
const HOME_RELOAD_BEFORE_KICKOFF_S = 10 * 60

interface PendingCandidateProbe {
  awayMs: number
  screen: string
  stage: string
  reloaded: boolean
  armedAt: number
}

let pending: PendingCandidateProbe | null = null
/** kickoff (unix seconds on the game clock) of the game whose seat the mounted home screen holds */
let heldSeatGameAt: number | null = null

/** The home page publishes the seat it holds, and null when it holds none or unmounts. */
export function noteHeldSeat(gameAt: number | null): void {
  heldSeatGameAt = gameAt
}

/**
 * The home screen counts only with a seat in a game that kicks off within
 * HOME_RELOAD_BEFORE_KICKOFF_S of `nowS` (game-clock seconds): a host session
 * left stale across a long absence costs that game's first round (#1157).
 */
export function reloadAllowedAfterReturn(context: ForegroundContext, nowS: number | null = null, gameAt = heldSeatGameAt): boolean {
  if (context.screen === "home")
    return gameAt !== null && nowS !== null && nowS < gameAt && gameAt - nowS <= HOME_RELOAD_BEFORE_KICKOFF_S
  return context.screen === "waiting" ||
    (context.screen === "game" && context.stage === "connecting" && !context.playStarted)
}

/** Game-clock seconds now. A visible freeze leaves the game clock behind by the freeze
 *  (lib/device-clock.ts) and home has no peer check to close it, so add it back. */
function chainNowAfterReturn(awayMs: number, suspended: boolean): number | null {
  const ms = chainNowMs()
  return ms === null ? null : (ms + (suspended ? awayMs : 0)) / 1000
}

function savePending(value: PendingCandidateProbe): void {
  pending = value
  try {
    sessionStorage.setItem(RETURN_CANDIDATE_KEY, JSON.stringify(value))
  } catch {
    /* memory is enough until a reload; storage is best effort */
  }
}

function readPending(): PendingCandidateProbe | null {
  if (pending) return pending
  try {
    const value = JSON.parse(sessionStorage.getItem(RETURN_CANDIDATE_KEY) ?? "null") as PendingCandidateProbe | null
    if (!value || !Number.isFinite(value.awayMs) || !Number.isFinite(value.armedAt)) return null
    pending = value
    return value
  } catch {
    return null
  }
}

function clearPending(): void {
  pending = null
  try {
    sessionStorage.removeItem(RETURN_CANDIDATE_KEY)
  } catch {
    /* no-op */
  }
}

export function observeForegroundReturn(value: ForegroundReturn): void {
  if (value.awayMs === null || value.awayMs < LONG_RETURN_OBSERVE_MS) return
  const eligible = reloadAllowedAfterReturn(value.returned, chainNowAfterReturn(value.awayMs, value.suspended))
  const shouldReload = eligible && value.awayMs >= LONG_SUSPENSION_RELOAD_MS
  const base: PendingCandidateProbe = {
    awayMs: value.awayMs,
    screen: value.returned.screen,
    stage: value.returned.stage,
    reloaded: false,
    armedAt: Date.now(),
  }
  const reloaded = shouldReload && requestSelfReload(
    "long-suspension",
    {
      awayMs: value.awayMs,
      screen: value.returned.screen,
      stage: value.returned.stage,
    },
    () => savePending({ ...base, reloaded: true }),
  )
  if (!reloaded) savePending(base)
  const attrs = {
    "app.screen": value.returned.screen,
    "game.stage": value.returned.stage,
    "app.reloaded": reloaded ? "true" : "false",
    "app.suspended": value.suspended ? "true" : "false",
  }
  devLog("lifecycle", "long foreground return", {
    away_ms: value.awayMs,
    screen: value.returned.screen,
    stage: value.returned.stage,
    reloaded,
  })
  recordCount("app.long_return", 1, attrs)
  recordDistribution("app.long_return_ms", value.awayMs, "millisecond", attrs)
}

export function watchLongSuspensionReload(): () => void {
  return watchForegroundReturn(observeForegroundReturn)
}

/** Claimed once by the first RTCPeerConnection created after a long return. */
export function takeReturnCandidateProbe(peer: string): { candidate: () => void } | null {
  const value = readPending()
  clearPending()
  if (!value || Date.now() - value.armedAt > RETURN_CANDIDATE_TTL_MS) return null
  let candidates = 0
  setTimeout(() => {
    const attrs = {
      "app.screen": value.screen,
      "game.stage": value.stage,
      "app.reloaded": value.reloaded ? "true" : "false",
    }
    devLog("rtc", "local candidates after long return", {
      peer,
      candidates,
      window_ms: RETURN_CANDIDATE_WINDOW_MS,
      away_ms: value.awayMs,
      reloaded: value.reloaded,
    })
    recordDistribution("rtc.return_local_candidates", candidates, "none", attrs)
  }, RETURN_CANDIDATE_WINDOW_MS)
  return { candidate: () => { candidates += 1 } }
}

export function resetResumeReloadForTests(): void {
  pending = null
  heldSeatGameAt = null
}
