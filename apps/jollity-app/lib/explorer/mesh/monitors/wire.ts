// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What the slice-1 monitors read: the room's wire log, its
 * delivery log and the controlled PCs' op log, all written by the harness, never by Mesh.
 * Each monitor is a function of `room.logs()`, so a hand-built trace in a stub room
 * exercises it as well as a real schedule does.
 */
import type { StepRecord } from "../../core/labels"
import type { OpLogEntry } from "../controlled-pc"
import type { DeliveryLogEntry, PropertyId, Room, Violation, WireLogEntry } from "../room"

/** A property monitor, run by the room at every quiescent point (after each
 *  step, and after the setup as step -1). It returns what it finds at that
 *  point; the room keeps each (property, detail) once, at its first step. */
export interface Monitor {
  id: PropertyId
  /** Whether this monitor's verdict is a function of the room fingerprint. */
  closed: boolean
  afterStep(room: Room, record: StepRecord): Violation[]
  /** at the schedule's end; slice 1's monitors need none */
  atEnd?(room: Room): Violation[]
}

/** the offer id an `x-answers` value names: `<x-pc>/<ufrag>/<x-offer>`, where
 *  an x-pc is itself `<side>/<n>` (the shape of controlled-pc's answeredOffer) */
export const answeredOffer = (xAnswers: string | undefined): string | undefined =>
  /^[^/]+\/\d+\/[^/]+\/(.+)$/.exec(xAnswers ?? "")?.[1]

/** on the wire: the transport took it into its store, or the lane sent it */
export const onWire = (entry: WireLogEntry): boolean =>
  entry.channel === "statement" ? entry.fate === "published" : entry.fate === "sent"

/** the PC a frame left from: the statement SDP's x-pc, the lane's sending PC */
export const sender = (entry: WireLogEntry): string | undefined => (entry.channel === "statement" ? entry.xPc : entry.pc)

/**
 * A frame Mesh sent down its answer path, whatever the description's type:
 * on the statement wire the only description Mesh sends with a gen of its own
 * is sendStatementAnswer's (mesh.ts, `{ desc, gen }`); its offers carry none.
 * On the lane, answerLane tags the description `Answer`.
 */
export const answerPath = (entry: WireLogEntry): boolean =>
  entry.channel === "statement"
    ? entry.meshGen !== undefined && (entry.kind === "offer" || entry.kind === "answer")
    : entry.kind === "answer"

/** the x-offer of the last offer `pc` resolved through SRD at or before `step`, in op-log order */
export function lastResolvedOffer(ops: readonly OpLogEntry[], pc: string | null, step: number): string | undefined {
  let offer: string | undefined
  for (const entry of ops) {
    if (entry.step > step) break
    if (entry.pc === pc && entry.op === "srd" && entry.outcome === "resolved" && entry.sdpRole === "offer") offer = entry.xOffer
  }
  return offer
}

/** the last delivery to `to` of the offer `xOffer`, at or before `step` */
export function offerDelivery(deliveries: readonly DeliveryLogEntry[], to: string, xOffer: string | undefined, step: number): DeliveryLogEntry | undefined {
  let found: DeliveryLogEntry | undefined
  for (const entry of deliveries) {
    if (entry.step > step) break
    if (entry.to === to && entry.kind === "offer" && entry.xOffer === xOffer) found = entry
  }
  return found
}
