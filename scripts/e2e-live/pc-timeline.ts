// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Raw devLog shape retained by recorder.ts. Only this module knows the
 * production RTC prose used by the synchronized-collapse guard. */
export interface PcTimelineLine {
  ts?: number
  sessionId?: string
  tag: string
  message: string
  data?: unknown
}

export type PcTimelineTransition =
  | { ts: number; kind: "mesh"; state: "opening" | "closing"; room: string | null; lifecycle: string | null; cause: string | null }
  | { ts: number; kind: "pc"; peer: string; state: "connected" | "failed" }
  | { ts: number; kind: "away"; peer: string }
  | { ts: number; kind: "back"; peer: string }

export interface SynchronizedCollapse {
  peers: number
  span: number
}

export interface SynchronizedPcFailureResult {
  collapse?: SynchronizedCollapse
  peakPeers: number
}

const PC_PREFIX = "[jollity-rtc] pc "
const AWAY_PREFIX = "[jollity-rtc] peer away "
const BACK_PREFIX = "[jollity-rtc] peer back "

/** Convert exact production RTC evidence into a small typed timeline. Prefix
 * gates keep unrelated devLog prose away from the regex contracts. */
export function parsePcTimeline(lines: readonly PcTimelineLine[]): PcTimelineTransition[] {
  const transitions: PcTimelineTransition[] = []
  for (const line of lines) {
    if (line.tag !== "rtc" || typeof line.ts !== "number") continue
    if (line.message === "mesh opening" || line.message === "mesh closing") {
      const data = typeof line.data === "object" && line.data !== null ? line.data as Record<string, unknown> : null
      const room = typeof data?.room === "string" ? data.room : null
      const generation = typeof data?.generation === "number" ? data.generation : null
      transitions.push({
        ts: line.ts,
        kind: "mesh",
        state: line.message === "mesh opening" ? "opening" : "closing",
        room,
        // Generation counters restart after reload; the recorder session keeps
        // equal numbers from different documents in distinct lifecycles.
        lifecycle: generation === null ? null : `${line.sessionId ?? "legacy"}:${generation}`,
        cause: typeof data?.cause === "string" ? data.cause : null,
      })
      continue
    }
    if (line.message.startsWith(PC_PREFIX)) {
      const match = /^\[jollity-rtc\] pc (\S+) (connected|failed)$/.exec(line.message)
      if (match) transitions.push({ ts: line.ts, kind: "pc", peer: match[1], state: match[2] as "connected" | "failed" })
      continue
    }
    if (line.message.startsWith(AWAY_PREFIX)) {
      const match = /^\[jollity-rtc\] peer away (\S+) said$/.exec(line.message)
      if (match) transitions.push({ ts: line.ts, kind: "away", peer: match[1] })
      continue
    }
    if (line.message.startsWith(BACK_PREFIX)) {
      const match = /^\[jollity-rtc\] peer back (\S+)$/.exec(line.message)
      if (match) transitions.push({ ts: line.ts, kind: "back", peer: match[1] })
    }
  }
  return transitions.sort((a, b) => a.ts - b.ts)
}

interface FailureWindow {
  peers: Set<string>
  failedAt: Map<string, number>
  startedAt: number
}

interface CollapseCandidate extends SynchronizedCollapse {
  lifecycle: string | null
  room: string | null
  endedAt: number
}

const isPlannedClose = (transition: Extract<PcTimelineTransition, { kind: "mesh" }>) =>
  transition.state === "closing" && (transition.cause === "room-change" || transition.cause === "inactive")

const closesCandidate = (transition: Extract<PcTimelineTransition, { kind: "mesh" }>, candidate: CollapseCandidate, withinMs: number) =>
  isPlannedClose(transition) &&
  candidate.lifecycle !== null &&
  candidate.lifecycle === transition.lifecycle &&
  candidate.room !== null &&
  candidate.room === transition.room &&
  transition.ts >= candidate.endedAt &&
  transition.ts - candidate.endedAt <= withinMs

/** Detect a synchronized collapse without letting planned room teardown,
 * stale failures, explicit departures, or merged documents manufacture one. */
export function detectSynchronizedPcFailure(
  transitions: readonly PcTimelineTransition[],
  { withinMs, minPeers }: { withinMs: number; minPeers: number },
): SynchronizedPcFailureResult {
  const connected = new Set<string>()
  // A peer-back line restores only a link observed connected before its
  // explicit departure. Truncated evidence must not invent connectivity.
  const explicitlyAwayConnected = new Set<string>()
  let failureWindow: FailureWindow | null = null
  let candidates: CollapseCandidate[] = []
  let lifecycle: string | null = null
  let room: string | null = null
  let peakPeers = 0

  for (const transition of transitions) {
    if (transition.kind === "mesh") {
      if (transition.state === "opening") {
        lifecycle = transition.lifecycle
        room = transition.room
      } else {
        // Remove only candidates excused by explicit planned-close evidence.
        // Recovery, unmount, missing data, and every mismatch fail closed.
        candidates = candidates.filter((candidate) => !closesCandidate(transition, candidate, withinMs))
      }
      connected.clear()
      explicitlyAwayConnected.clear()
      failureWindow = null
      if (transition.state === "closing") {
        lifecycle = null
        room = null
      }
      continue
    }

    if (transition.kind === "away") {
      if (connected.delete(transition.peer)) explicitlyAwayConnected.add(transition.peer)
      if (failureWindow?.peers.has(transition.peer)) failureWindow = null
      continue
    }

    if (transition.kind === "back") {
      if (!explicitlyAwayConnected.delete(transition.peer)) continue
      connected.add(transition.peer)
      peakPeers = Math.max(peakPeers, connected.size)
      continue
    }

    if (transition.state === "connected") {
      const recovered = !connected.has(transition.peer)
      connected.add(transition.peer)
      explicitlyAwayConnected.delete(transition.peer)
      if (recovered && failureWindow?.peers.has(transition.peer)) failureWindow = null
      peakPeers = Math.max(peakPeers, connected.size)
      continue
    }

    // Browser close() emits no connection-state edge. Count only failures for
    // peers observed connected in this lifecycle.
    if (!connected.has(transition.peer)) continue
    if (!failureWindow || transition.ts - failureWindow.startedAt > withinMs || !failureWindow.peers.has(transition.peer)) {
      // Snapshot before removing this peer; an old failure cannot poison a
      // later B+C window.
      failureWindow = { peers: new Set(connected), failedAt: new Map(), startedAt: transition.ts }
    }
    connected.delete(transition.peer)
    if (failureWindow.peers.size < minPeers) {
      failureWindow = null
      continue
    }
    failureWindow.failedAt.set(transition.peer, transition.ts)
    if (![...failureWindow.peers].every((peer) => failureWindow!.failedAt.has(peer))) continue
    const times = [...failureWindow.failedAt.values()]
    const span = Math.max(...times) - Math.min(...times)
    if (span <= withinMs) {
      candidates.push({ lifecycle, room, peers: failureWindow.peers.size, span, endedAt: Math.max(...times) })
    }
    failureWindow = null
  }

  const collapse = candidates[0]
  return collapse ? { collapse: { peers: collapse.peers, span: collapse.span }, peakPeers } : { peakPeers }
}
