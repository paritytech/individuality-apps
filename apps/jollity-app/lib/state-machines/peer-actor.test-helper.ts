// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Test-only adapters for fixtures written as the older supervisor
 * tick. The product and explorer decide from actor-owned state; this module
 * only keeps compact unit-test fixtures readable. */
import {
  armDeadlines,
  createPeerActorState,
  decideClock,
  type ClockSnapshot,
  type PeerActorEvent,
  type PeerActorState,
  type SupervisorDecision,
} from "./peer-actor"

export interface SupervisorTickFacts extends ClockSnapshot {
  now: number
  everConnected: boolean
  lastSignalAt: number | null
  firstHeardAt: number | null
  lastRecvDescAt: number | null
  offerSentAt: number | null
  yieldedAt: number | null
  upAt: number
  downAt: number
  disconnectedAt: number
}

type ActorTimes = Pick<PeerActorState,
  "lastSignalAt" | "upAt" | "disconnectedAt" | "lastRecvDescAt" |
  "offerSentAt" | "yieldedAt" | "downAt" | "everConnected" | "firstHeardAt"
>

export function snapshotOf(facts: SupervisorTickFacts): ClockSnapshot {
  return {
    browserConnectionState: facts.browserConnectionState,
    haveLocalOffer: facts.haveLocalOffer,
    localDescription: facts.localDescription,
    remoteDescription: facts.remoteDescription,
    hasChannel: facts.hasChannel,
    laneOpen: facts.laneOpen,
    away: facts.away,
    framesSeen: facts.framesSeen,
    sawVideoThisRound: facts.sawVideoThisRound,
    canRestartIce: facts.canRestartIce,
  }
}

const written = new WeakMap<object, ActorTimes>()
const sentinel = (at: number) => (at > 0 ? at : null)
const timesFrom = (facts: SupervisorTickFacts): ActorTimes => ({
  lastSignalAt: facts.lastSignalAt,
  upAt: sentinel(facts.upAt),
  disconnectedAt: sentinel(facts.disconnectedAt),
  lastRecvDescAt: facts.lastRecvDescAt,
  offerSentAt: facts.offerSentAt,
  yieldedAt: facts.yieldedAt,
  downAt: sentinel(facts.downAt),
  everConnected: facts.everConnected,
  firstHeardAt: facts.firstHeardAt,
})

export function clockOf<Epochs extends object = object>(facts: SupervisorTickFacts, epochs?: Epochs): Extract<PeerActorEvent, { type: "clock" }> & Epochs {
  const event = { type: "clock" as const, now: facts.now, snapshot: snapshotOf(facts), ...epochs } as Extract<PeerActorEvent, { type: "clock" }> & Epochs
  written.set(event, timesFrom(facts))
  return event
}

export function timesOf(event: PeerActorEvent): Partial<ActorTimes> {
  return written.get(event) ?? {}
}

export function withTimes<State extends PeerActorState>(state: State, times: Partial<PeerActorState> = {}): State {
  const next = { ...state, ...times }
  return { ...next, deadlines: armDeadlines(next) }
}

export function tickOf(state: PeerActorState, now: number, snapshot: ClockSnapshot): SupervisorTickFacts {
  return {
    now,
    ...snapshot,
    everConnected: state.everConnected,
    lastSignalAt: state.lastSignalAt,
    firstHeardAt: state.firstHeardAt,
    lastRecvDescAt: state.lastRecvDescAt,
    offerSentAt: state.offerSentAt,
    yieldedAt: state.yieldedAt,
    upAt: state.upAt ?? 0,
    downAt: state.downAt ?? 0,
    disconnectedAt: state.disconnectedAt ?? 0,
  }
}

interface ActorView {
  initiator: boolean
  lastAttemptAt: number | null
  lastSignalAt: number | null
  upAt: number | null
  connectingSince: number | null
  disconnectedAt: number | null
  lastRecvDescAt: number | null
  offerSentAt: number | null
  yieldedAt: number | null
  downAt: number | null
  everConnected: boolean
  firstHeardAt: number | null
  budgets: Pick<PeerActorState["budgets"], "failCount" | "noVideoRebuilds">
}

export function decideFromTick(facts: SupervisorTickFacts, view: Partial<ActorView> & Pick<ActorView, "initiator" | "lastAttemptAt" | "budgets">): SupervisorDecision {
  const base = createPeerActorState({ game: 1, roomEpoch: 1, peer: "peer" }, { connectingSince: facts.firstHeardAt })
  const link = facts.browserConnectionState === "connected" ? "connected" : facts.browserConnectionState === "failed" || facts.browserConnectionState === "disconnected" ? "link-down" : "connecting"
  const state = withTimes({ ...base, link, budgets: { ...base.budgets, ...view.budgets } }, { ...timesFrom(facts), ...view, budgets: { ...base.budgets, ...view.budgets } })
  return decideClock(state, facts.now, snapshotOf(facts))
}
