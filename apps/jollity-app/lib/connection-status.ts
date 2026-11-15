// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE CONNECTING PHASE, AS THE PLAYER READS IT: the waiting room's status line
 * on /game. Everything here is a live reading, recomputed whenever a link or
 * the path probe changes — never a timer.
 *
 *  - network  checking, direct, relay (TURN carries the links) or blocked
 *  - people   how many of the co-players still to play with are linked, out of how many
 *  - quality  bars from the slowest round trip among the links that are up
 */
import type { PathProbe } from "./webrtc/path-mode"

export type NetworkIcon = "checking" | "direct" | "relay" | "blocked"
/** 4 Great, 3 Good, 2 Fair, 1 Poor */
export type QualityBars = 1 | 2 | 3 | 4

export interface ConnectionLink {
  id: string
  conn: RTCPeerConnectionState
  path: "direct" | "relay" | "unknown"
  rttMs?: number
}

export interface ConnectionStatus {
  network: NetworkIcon
  connected: number
  expected: number
  /** null with no link up to measure */
  quality: QualityBars | null
  /** the path probe is running */
  checking: boolean
}

export function connectionStatus(input: {
  probe: PathProbe | null
  checking: boolean
  links: readonly ConnectionLink[]
  /** the co-players of each round still to play, from the one being played */
  rounds: readonly (readonly string[])[]
}): ConnectionStatus {
  const everyone = [...new Set(input.rounds.flat())]
  const up = input.links.filter((link) => link.conn === "connected" && everyone.includes(link.id))
  const connected = up.length
  const expected = everyone.length

  const relayed = up.length > 0 && up.every((link) => link.path === "relay")
  const network: NetworkIcon =
    input.probe?.mode === "blocked"
      ? "blocked"
      : input.probe?.mode === "relay" || relayed
        ? "relay"
        : input.probe?.mode === "direct" || connected > 0
          ? "direct"
          : "checking"

  const rtts = up.map((link) => link.rttMs).filter((ms): ms is number => typeof ms === "number")
  const worst = rtts.length ? Math.max(...rtts) : null
  const quality: QualityBars | null = worst === null ? null : worst < 150 ? 4 : worst < 300 ? 3 : worst < 600 ? 2 : 1

  return { network, connected, expected, quality, checking: input.checking }
}
