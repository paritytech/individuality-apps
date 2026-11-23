// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHAT A SEAT SHOWS: one word per co-player's tile, from what the mesh knows
 * of them (Mesh.seats) — never a guess dressed as a fact. Pure; useMesh runs it
 * on its 1 s tick and holds a shown state a moment (settleSeat) so a tile does
 * not flicker.
 *
 *   empty         nobody holds the chair                      static
 *   no-signal     held, and we hear nothing from them now:    static
 *                 no claim about where they are (a native-app
 *                 player, a phone that never opened the room)
 *   connecting    they are here, the link is forming, or      Connecting…
 *                 coming back, within its time
 *   cant-connect  we STILL HEAR them, but the link did not    Can't connect
 *                 form in time; healing carries on
 *   live          their video decodes
 *   weak          their video decodes, badly                  yellow bars
 *   away          their phone said it stepped away            pause icon
 *   camera-off    their camera is off, by their own view      camera icon
 *
 * Our own trouble is not theirs: offline, with the page hidden, or while the
 * health ladder blames our side, nobody reads "Can't connect" or sees No
 * signal's static — they read "Connecting…" and the one notice says what is
 * wrong. A phone too slow for the video (phoneStruggles) is said once, there,
 * not as weak bars on every tile. No vote reads this; No signal and Can't
 * connect only stop the tile taking a tap (the session's `tappable`).
 */
import type { AwayReason } from "./mesh"

export type SeatState = "empty" | "no-signal" | "connecting" | "cant-connect" | "live" | "weak" | "away" | "camera-off"

/** One transition line for the debug log. A cant-connect diagnosis always
 * carries the link's SDP state, including when the link facts disappeared. */
export function seatTransitionMessage(peer: string, previous: SeatState | undefined, next: SeatState, signalingState: RTCSignalingState | undefined): string {
  return next === "cant-connect"
    ? `[jollity-rtc] seat ${peer}: ${previous ?? "∅"} → cant-connect signalingState=${signalingState ?? "missing"}`
    : `[jollity-rtc] seat ${peer}: ${previous ?? "∅"} → ${next}`
}

/** What the mesh knows of one peer (Mesh.seats), on its monotonic clock. */
export interface SeatFacts {
  conn: RTCPeerConnectionState
  /** SDP state on the same link, carried only for the seat transition log. */
  signalingState: RTCSignalingState
  /** a link to them reached `connected` in this room */
  everConnected: boolean
  /** first hello or signal; -Infinity = never heard */
  firstHeardAt: number
  /** last hello or signal */
  lastSignalAt: number
  /** their frames last advanced, on any link to them: a rebuilt link starts
   *  with none, while the tile still shows their face */
  lastFrameAt: number
  /** the current link reached `connected` at; 0 = not connected */
  upAt: number
  /** the current data channel opened at; media negotiation can only start here */
  channelOpenAt: number
  /** a link that had been up went down at; 0 = up, or never up */
  downAt: number
  away: AwayReason | null
  /** their own view says their camera is off */
  cameraOff: boolean
  /** #1917: a frozen link is being healed (the keyframe ask, then the
   *  rebuild): Can't connect is held off as Reconnecting until the mark
   *  clears, delayed, never suppressed (Mesh bounds the mark) */
  healing?: boolean
}

export const SEAT_TIMES = {
  /** never heard: Connecting… this long after we could first hear anyone, then No signal */
  graceMs: 20_000,
  /** heard, never linked: Connecting… this long from first heard */
  connectBudgetMs: 30_000,
  /** linked or was: Connecting… this long without video, then Can't connect */
  reconnectBudgetMs: 20_000,
  /** "we still hear them": a hello or signal this recent */
  heardRecentMs: 20_000,
  /** nothing of theirs for this long, link down: No signal */
  presenceFreshMs: 45_000,
  /** frames this recent: live */
  mediaFreshMs: 7_000,
  /** a shown state stays at least this long, and a change must hold this long */
  holdMs: 1_500,
  /** live → connecting must hold this long: a face that froze for a moment
   *  stays a face, and grain means the video is really gone */
  blipMs: 3_000,
}

export interface SeatContext {
  now: number
  /** when we could first hear anyone: the transport's start */
  heardFrom: number
  /** the trouble may be ours (offline, page hidden): nobody is blamed */
  selfSuspect: boolean
  /** this player's own key was not found, so no co-player gets a frame of
   *  ours: the trouble is ours, as with `selfSuspect`, and the notice says why */
  ownKeyMissing?: boolean
  /** their video is flowing badly (rates over the last report windows) */
  weak: boolean
}

/** The state a seat held by an account (a mesh peer) shows, before settling. */
export function seatState(f: SeatFacts | undefined, ctx: SeatContext, t = SEAT_TIMES): SeatState {
  const { now } = ctx
  const ours = ctx.selfSuspect || ctx.ownKeyMissing === true
  const blame = (state: "no-signal" | "cant-connect"): SeatState => (ours || (state === "cant-connect" && f?.healing === true) ? "connecting" : state)
  if (!f || !Number.isFinite(f.firstHeardAt)) return now - ctx.heardFrom < t.graceMs ? "connecting" : blame("no-signal")
  if (f.away === "said") return "away"
  if (f.cameraOff) return "camera-off"
  if (now - f.lastFrameAt < t.mediaFreshMs) return ctx.weak ? "weak" : "live"
  const heardRecently = now - f.lastSignalAt < t.heardRecentMs
  if (f.conn === "connected") {
    // Linked, no video (yet, or any more): count from the last frame, then the
    // data-channel open, and finally ICE connected. Media cannot negotiate
    // before the channel opens, but a channel that never opens must still
    // become Can't connect and enter the mesh's bounded recovery path.
    const since = Number.isFinite(f.lastFrameAt) ? f.lastFrameAt : f.channelOpenAt || f.upAt
    if (!since) return "connecting"
    if (now - since < t.reconnectBudgetMs) return "connecting"
    return heardRecently ? blame("cant-connect") : "connecting"
  }
  if (now - f.lastSignalAt >= t.presenceFreshMs) return blame("no-signal")
  if (f.everConnected) {
    // was up in this room: coming back
    if (!f.downAt || now - f.downAt < t.reconnectBudgetMs) return "connecting"
    return heardRecently ? blame("cant-connect") : "connecting"
  }
  if (now - f.firstHeardAt < t.connectBudgetMs) return "connecting"
  return heardRecently ? blame("cant-connect") : "connecting"
}

/** A seat's shown state, and a change waiting out its hold. */
export interface ShownSeat {
  state: SeatState
  since: number
  pending: { state: SeatState; since: number } | null
}

/** Whether `next` is shown yet. Up into live, weak or away shows at once; live
 *  falling to connecting holds `blipMs`; every other change holds `holdMs`,
 *  and nothing replaces a state shown for less than `holdMs`. */
export function settleSeat(prev: ShownSeat | undefined, next: SeatState, now: number, t = SEAT_TIMES): ShownSeat {
  if (!prev) return { state: next, since: now, pending: null }
  if (next === prev.state) return prev.pending ? { ...prev, pending: null } : prev
  const at = once(next, prev.state) ? now : prev.pending?.state === next ? prev.pending.since : now
  const hold = prev.state === "live" && next === "connecting" ? t.blipMs : t.holdMs
  const ready = once(next, prev.state) || (now - at >= hold && now - prev.since >= t.holdMs)
  return ready ? { state: next, since: now, pending: null } : { ...prev, pending: { state: next, since: at } }
}

const once = (next: SeatState, from: SeatState) => next === "away" || ((next === "live" || next === "weak") && from !== "live" && from !== "weak")

/** One link over one report window, for whether the trouble is OUR phone's. */
export interface LinkWindow {
  /** their video decoded in the window, or tried to (a weak link counts) */
  video: boolean
  weak: boolean
  /** seconds our encoder spent limited by the CPU, and the window's seconds */
  cpuLimitedS: number
  seconds: number
}

/** It is our phone, not theirs: every link that carries video is weak at once
 *  (two or more — one weak link may be the peer's own), or our encoder spent
 *  most of the window held back by the CPU. Then one notice says so, and no
 *  tile wears "Weak signal". */
export function phoneStruggles(links: readonly LinkWindow[]): boolean {
  if (links.some((l) => l.seconds > 0 && l.cpuLimitedS > l.seconds / 2)) return true
  const video = links.filter((l) => l.video)
  return video.length >= 2 && video.every((l) => l.weak)
}

/** A flag that turns only after `n` windows in a row say so, either way. */
export interface Streak {
  on: boolean
  count: number
}

export function streak(prev: Streak, now: boolean, n = 2): Streak {
  if (now === prev.on) return prev.count ? { on: prev.on, count: 0 } : prev
  const count = prev.count + 1
  return count >= n ? { on: now, count: 0 } : { on: prev.on, count }
}
