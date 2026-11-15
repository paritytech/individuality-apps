// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One diagnostic record for each stretch that a peer reads as away. The
 * period belongs to the peer rather than an RTCPeerConnection, so rebuilding
 * a link cannot split it or lose its last recovery attempt.
 */

export type AwayReturn =
  | "link_connected"
  | "said_back"
  | "statement_description"
  | "session_rejoin"
  | "offer_refused_rejoin"
  | "own_absence_sweep"
  | "heard_again"
  | "peer_left"
  | "mesh_closed"

export type AwayAttempt = "none" | "ice_restart" | "rebuild" | "yield" | "stranded_offer" | "answer"
export type AwayOfferer = "self" | "peer" | "none"

export interface AwayPeriodEvent {
  reason: "said" | "timeout"
  return: AwayReturn
  lastAttempt: AwayAttempt
  attempts: number
  offerer: AwayOfferer
  offererRole?: "initiator" | "answerer"
  ms: number
}

interface OpenAwayPeriod {
  reason: "said" | "timeout"
  at: number
  attempts: number
  lastAttempt: AwayAttempt
}

/** A description received from the peer says who made its offer. Under
 * statement glare the first description can differ from the offer that wins;
 * analysis must join both phones' rows on rtc.pair rather than read one alone. */
export function offererOfReceived(type: string | undefined): AwayOfferer {
  return type === "offer" ? "peer" : type === "answer" ? "self" : "none"
}

/** The current local description says who made a connected link's offer. */
export function offererOfLocal(type: string | undefined): AwayOfferer {
  return type === "offer" ? "self" : type === "answer" ? "peer" : "none"
}

export class AwayPeriods {
  private open = new Map<string, OpenAwayPeriod>()

  constructor(
    private emit: (peerId: string, event: AwayPeriodEvent) => void,
    private selfInitiates: (peerId: string) => boolean,
  ) {}

  mark(peerId: string, reason: "said" | "timeout", now: number): void {
    if (!this.open.has(peerId)) this.open.set(peerId, { reason, at: now, attempts: 0, lastAttempt: "none" })
  }

  attempt(peerId: string, attempt: Exclude<AwayAttempt, "none">): void {
    const period = this.open.get(peerId)
    if (!period) return
    period.attempts++
    period.lastAttempt = attempt
  }

  /** One supervisor decision can try restartIce and synchronously fall back
   * to rebuilding. Keep what it finally did without counting a second try. */
  fallback(peerId: string, attempt: Exclude<AwayAttempt, "none">): void {
    const period = this.open.get(peerId)
    if (period) period.lastAttempt = attempt
  }

  end(peerId: string, cause: AwayReturn, offerer: AwayOfferer, now: number): void {
    const period = this.open.get(peerId)
    if (!period) return
    this.open.delete(peerId)
    const offererRole = offerer === "none"
      ? undefined
      : (offerer === "self") === this.selfInitiates(peerId) ? "initiator" : "answerer"
    this.emit(peerId, {
      reason: period.reason,
      return: cause,
      lastAttempt: period.lastAttempt,
      attempts: period.attempts,
      offerer,
      ...(offererRole ? { offererRole } : {}),
      ms: Math.max(0, Math.round(now - period.at)),
    })
  }

  closeAll(now: number): void {
    for (const peerId of [...this.open.keys()]) this.end(peerId, "mesh_closed", "none", now)
  }
}
