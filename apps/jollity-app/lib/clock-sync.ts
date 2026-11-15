// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The game clock of one page, as pure state. It starts on the device time (offset 0), and
 * only the peer check sets a new target. The shown offset closes the gap to the target at the
 * speed of its zone, so the shown game time never moves backward. No I/O, no clock read, no
 * timer: the caller passes the device ms.
 */

/** A gap at or under this starts no correction. */
export const DEAD_BAND_MS = 250
/** The limit between a small and a big gap. */
export const BIG_GAP_MS = 5_000
/** A peer reply with a longer round trip is dropped. */
export const PEER_RTT_MAX_MS = 1_000
/** The ping period while a peer check window is open. */
export const PEER_PING_MS = 2_000
/** The fewest peers a peer median needs. */
export const PEER_MIN = 3
/** A peer within this of the median agrees with it. */
export const PEER_AGREE_MS = 1_000
/** The length of a late, resume or step peer check window. */
export const PEER_CHECK_MS = 20_000

/** How fast the game clock moves against the device clock. "Small" is a gap up to
 * `BIG_GAP_MS`. "jump" sets the target at once. */
export const SPEEDS = {
  waiting: { behindSmall: 2, behindBig: 4, aheadSmall: 0.5, aheadBig: 0.25 },
  game: { behindSmall: 1.5, behindBig: "jump", aheadSmall: 0.67, aheadBig: 0.25 },
} as const

/** Only a correction that starts with a gap over this is an event. */
const LOGGED_GAP_MS = 1_000

/** Every offset is game ms minus device ms. */
export interface ClockSync {
  targetMs: number
  shownMs: number
  correcting: boolean
  lastDeviceMs?: number
}
export type ClockEvent =
  | { kind: "correction"; fromMs: number; toMs: number; speed: number }
  | { kind: "corrected"; offsetMs: number }
  | { kind: "jump"; reason: "tiles-enter" | "game"; fromMs: number; toMs: number }

export type ClockSyncInput =
  | { type: "set-target"; targetMs: number }
  | { type: "advance"; deviceMs: number; gameFromMs?: number }

export interface ClockSyncStep {
  state: ClockSync
  commands: ClockEvent[]
}

export type PeerVerdict =
  | { result: "few"; peers: number }
  | { result: "split" | "ok"; peers: number; medianMs: number; agree: number }

export function createClockSync(): ClockSync {
  return { targetMs: 0, shownMs: 0, correcting: false }
}

/** The clock's pure reducer. Callers that keep a stable object use the
 * adapters below (`setTarget`, `advance`); all decisions live here and time
 * arrives in the event. */
export function clockSyncStep(state: ClockSync, event: ClockSyncInput): ClockSyncStep {
  const next = { ...state }
  const commands =
    event.type === "set-target"
      ? applyTarget(next, event.targetMs)
      : applyAdvance(next, event.deviceMs, event.gameFromMs)
  return { state: next, commands }
}

/** "ok" needs peers >= PEER_MIN and 2 * agree > peers, where agree counts the
 *  offsets within PEER_AGREE_MS of the median. Even count: mean of the two middle values. */
export function peerVerdict(offsetsMs: readonly number[]): PeerVerdict {
  const peers = offsetsMs.length
  if (peers < PEER_MIN) return { result: "few", peers }
  const medianMs = median(offsetsMs)
  const agree = offsetsMs.filter((o) => Math.abs(o - medianMs) <= PEER_AGREE_MS).length
  return { result: 2 * agree > peers ? "ok" : "split", peers, medianMs, agree }
}

/** A peer median must hold this long before the clock moves to it. */
export const PEER_CONFIRM_MS = PEER_PING_MS

/** One peer's kept reply: its offset to this device clock, and the round trip it came with. */
export interface PeerSample {
  offsetMs: number
  rttMs: number
}

/** The sample with the shorter round trip. A tie keeps the kept one. */
export function betterSample(kept: PeerSample | undefined, next: PeerSample): PeerSample {
  return kept !== undefined && kept.rttMs <= next.rttMs ? kept : next
}

/** A peer median out of the dead band that waits for its confirmation. */
export interface PeerCandidate {
  medianMs: number
  sinceMs: number
}

/** Hysteresis for a peer median. `deviceMs` is the step-free device ms now.
 *  On `move`, the caller sets the target to this `medianMs`. */
export function confirmPeerMedian(
  candidate: PeerCandidate | undefined,
  medianMs: number,
  targetMs: number,
  deviceMs: number,
): { candidate: PeerCandidate | undefined; move: boolean } {
  if (Math.abs(medianMs - targetMs) <= DEAD_BAND_MS) return { candidate: undefined, move: false }
  if (candidate !== undefined && Math.abs(medianMs - candidate.medianMs) <= DEAD_BAND_MS) {
    return deviceMs - candidate.sinceMs >= PEER_CONFIRM_MS
      ? { candidate: undefined, move: true }
      : { candidate, move: false }
  }
  return { candidate: { medianMs, sinceMs: deviceMs }, move: false }
}

/** set a new target; the next advance moves the shown offset toward it */
export function setTarget(state: ClockSync, targetMs: number): ClockEvent[] {
  const result = clockSyncStep(state, { type: "set-target", targetMs })
  Object.assign(state, result.state)
  return result.commands
}

function applyTarget(state: ClockSync, targetMs: number): ClockEvent[] {
  state.targetMs = targetMs
  // a new target starts a new correction, so its event names this target
  state.correcting = false
  return []
}

/** Move the shown offset toward the target for the device time since the last call.
 *  `gameFromMs` is the game ms where the `game` row of SPEEDS starts. */
export function advance(state: ClockSync, deviceMs: number, gameFromMs?: number): ClockEvent[] {
  const result = clockSyncStep(state, { type: "advance", deviceMs, gameFromMs })
  Object.assign(state, result.state)
  return result.commands
}

function applyAdvance(state: ClockSync, deviceMs: number, gameFromMs?: number): ClockEvent[] {
  const last = state.lastDeviceMs
  if (last !== undefined && deviceMs <= last) return []
  state.lastDeviceMs = deviceMs
  if (last === undefined) return []
  const gap = state.targetMs - state.shownMs
  if (!state.correcting && Math.abs(gap) <= DEAD_BAND_MS) return []

  const waiting = gameFromMs === undefined || last + state.shownMs < gameFromMs
  const row = waiting ? SPEEDS.waiting : SPEEDS.game
  const big = Math.abs(gap) > BIG_GAP_MS
  const speed = gap > 0 ? (big ? row.behindBig : row.behindSmall) : (big ? row.aheadBig : row.aheadSmall)
  if (speed === "jump") return [jumpTo(state, "game")]

  const events: ClockEvent[] = []
  if (!state.correcting) {
    state.correcting = true
    if (Math.abs(gap) > LOGGED_GAP_MS) {
      events.push({ kind: "correction", fromMs: state.shownMs, toMs: state.targetMs, speed })
    }
  }
  const step = (speed - 1) * (deviceMs - last)
  state.shownMs = Math.abs(step) >= Math.abs(gap) ? state.targetMs : state.shownMs + step
  if (
    waiting
    && gameFromMs !== undefined
    && deviceMs + state.shownMs >= gameFromMs
    && state.targetMs - state.shownMs > DEAD_BAND_MS
  ) {
    events.push(jumpTo(state, "tiles-enter"))
  } else if (state.shownMs === state.targetMs) {
    state.correcting = false
    events.push({ kind: "corrected", offsetMs: state.shownMs })
  }
  return events
}

function jumpTo(state: ClockSync, reason: "tiles-enter" | "game"): ClockEvent {
  const fromMs = state.shownMs
  state.shownMs = state.targetMs
  state.correcting = false
  return { kind: "jump", reason, fromMs, toMs: state.targetMs }
}

/** The middle value. An even count takes the mean of the two middle values. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
