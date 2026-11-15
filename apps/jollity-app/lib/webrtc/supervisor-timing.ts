// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The supervisor's thresholds, in one place: Mesh (its sweep and presence
 * edges) and the peer actor's clock rules (decideClock in
 * lib/state-machines/peer-actor.ts) both read them. Pure constants, so the
 * actor never imports mesh.ts. The peer model keeps its own copies on
 * purpose: it is the independent oracle.
 */
import { RECOVERY_GRACE_MS } from "@jollity/statement-core"
import { SEAT_TIMES } from "./seat-state"

/** health-check cadence */
export const SUPERVISE_MS = 3000

/** A peer heard after this gap is back. Shared by Mesh's presence edge and
 *  the peer actor's peer-heard transition. */
export const RETURN_GAP_MS = 20_000

export const SUPERVISOR_TIMING = {
  /** a link that was up and stayed down longer than this: the peer is away */
  awayAfterMs: 8000,
  /** how long the initiator waits for the answer to its offer, and a yield
   *  for the peer's offer: the slowest answer in the game logs came 27 s after
   *  the offer */
  answerWaitMs: 30000,
  /** a hello or a signal this recent says the player is still here: the
   *  transport's PEER_TTL_MS */
  presenceFreshMs: 45000,
  /** a link that dropped this recently is chased before a hello */
  dropChaseMs: RECOVERY_GRACE_MS,
  /** let a transient `disconnected` self-recover first */
  disconnectGraceMs: 4000,
  /** heard but never connected this long: the actor replaces the connection
   *  (cause connect-by-deadline) */
  initialTimeoutMs: 18000,
  /** a description of theirs this recent: that negotiation may still finish */
  negotiationQuietMs: 15000,
  /** connected with no channel open this long: rebuild, once a round. One
   *  sweep after the seat's Can't-connect budget, so the seat transition and
   *  its telemetry land first */
  connectedWithoutChannelMs: SEAT_TIMES.reconnectBudgetMs + SUPERVISE_MS,
  backoffBaseMs: 3000,
  backoffMaxMs: 20000,
  /** soft ICE restarts before falling back to a full rebuild */
  restartTries: 1,
} as const

/** How long after an attempt the next may come: the base, doubling with
 *  each failure, at most the max. */
export const backoffMs = (failCount: number): number =>
  Math.min(SUPERVISOR_TIMING.backoffBaseMs * 2 ** failCount, SUPERVISOR_TIMING.backoffMaxMs)
