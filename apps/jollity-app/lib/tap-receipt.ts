// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { devLog } from "./debug/log-store"
import { pairAttrs } from "./journeys/rtc-pair"
import { recordCount } from "./telemetry"
import type { GestureTag } from "./webrtc/gesture"

type TapOutcome = "shown" | "already-accepted" | "unaccept" | "round-closed" | "round-not-open" | "no-round"

export interface Tap {
  peerId: string
  tag: GestureTag
  round: number
}

export interface TapLedger {
  seen: number
  seq: Map<string, number>
  accepted: Map<string, Set<string>>
}

export interface TapReceipt {
  outcome: TapOutcome
  seq: number
  accepted: number
}

export interface ArrivedTap extends Tap {
  turn: number | null
}

export interface ReceiverContext {
  gameIndex: number | null
  self: string | null
  receiverRound: number | null
  turn: number | null
  stride: number
  hidden: boolean
}

export type ReceivedTapContext = ReceiverContext & Tap

export interface SentTapContext extends Tap {
  gameIndex: number | null
  self: string | null
  turn: number | null
  handed: boolean
  link: string
  seq: number
}

export function newTapLedger(): TapLedger {
  return { seen: 0, seq: new Map(), accepted: new Map() }
}

export function nextSentSeq(seq: Map<string, number>, peerId: string, round: number): number {
  const key = `${peerId}:${round}`
  const next = (seq.get(key) ?? 0) + 1
  seq.set(key, next)
  return next
}

/** A gesture that arrives before this phone reaches its round counts on the first turn of that round. */
export function acceptKey(round: number, arrivalTurn: number | null, stride: number): string {
  const firstTurn = round * stride
  return `${round}:${arrivalTurn === null || arrivalTurn < firstTurn ? firstTurn : arrivalTurn}`
}

interface FiledGesture {
  alreadyAccepted: boolean
  accepters: Set<string>
}

export function fileGesture(acceptersByKey: Map<string, Set<string>>, key: string, gesture: Pick<Tap, "peerId" | "tag">): FiledGesture {
  let accepters = acceptersByKey.get(key)
  if (!accepters) acceptersByKey.set(key, (accepters = new Set()))
  const alreadyAccepted = accepters.has(gesture.peerId)
  if (gesture.tag === "Accept") accepters.add(gesture.peerId)
  else accepters.delete(gesture.peerId)
  return { alreadyAccepted, accepters }
}

export function receiveTap(ledger: TapLedger, tap: Tap, key: string, receiverRound: number | null): TapReceipt {
  const seq = nextSentSeq(ledger.seq, tap.peerId, tap.round)
  const { alreadyAccepted, accepters } = fileGesture(ledger.accepted, key, tap)
  return { outcome: outcomeOf(tap, receiverRound, alreadyAccepted), seq, accepted: accepters.size }
}

function outcomeOf(tap: Tap, receiverRound: number | null, alreadyAccepted: boolean): TapOutcome {
  if (tap.tag === "Unaccept") return "unaccept"
  if (receiverRound === null) return "no-round"
  if (tap.round < receiverRound) return "round-closed"
  if (tap.round > receiverRound) return "round-not-open"
  return alreadyAccepted ? "already-accepted" : "shown"
}

function tapAttrs(ctx: { gameIndex: number | null; self: string | null; turn: number | null } & Tap, seq: number): Record<string, string> {
  return {
    round: String(ctx.round + 1),
    ...pairAttrs(ctx.gameIndex, ctx.self, ctx.peerId, ctx.round + 1),
    "tap.tag": ctx.tag === "Accept" ? "accept" : "unaccept",
    "tap.seq": String(seq),
    "tap.turn": ctx.turn === null ? "none" : String(ctx.turn),
  }
}

export function recordTapReceived(ctx: ReceivedTapContext, receipt: TapReceipt): void {
  recordCount("game.tap_received", 1, {
    ...tapAttrs(ctx, receipt.seq),
    outcome: receipt.outcome,
    "tap.accepted": String(receipt.accepted),
    "tap.receiver_round": ctx.receiverRound === null ? "none" : String(ctx.receiverRound + 1),
    "tap.hidden": String(ctx.hidden),
  })
  devLog("vote", "tap received", {
    round: ctx.round,
    from: ctx.peerId,
    tag: ctx.tag,
    outcome: receipt.outcome,
    seq: receipt.seq,
    receiverRound: ctx.receiverRound,
    turn: ctx.turn,
  })
}

export function recordNewTaps(ledger: TapLedger, gestures: readonly ArrivedTap[], ctx: ReceiverContext): void {
  if (gestures.length < ledger.seen) {
    ledger.seen = 0
    ledger.seq.clear()
    ledger.accepted.clear()
  }
  for (const gesture of gestures.slice(ledger.seen)) {
    const tap = { peerId: gesture.peerId, tag: gesture.tag, round: gesture.round }
    recordTapReceived({ ...ctx, ...tap }, receiveTap(ledger, tap, acceptKey(gesture.round, gesture.turn, ctx.stride), ctx.receiverRound))
  }
  ledger.seen = gestures.length
}

export function recordTapSent(ctx: SentTapContext): void {
  recordCount("game.tap_sent", 1, {
    ...tapAttrs(ctx, ctx.seq),
    outcome: ctx.handed ? "handed" : "not-a-peer",
    "tap.link": ctx.link,
  })
}
