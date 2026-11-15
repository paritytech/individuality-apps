// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The actor's recovery invariant (peer-actor.ts missingRecoveryDeadline): every
 * open, non-connected actor holds the deadline its link recovers by, unless a
 * named exemption holds it. */
import { missingRecoveryDeadline, type ClockSnapshot } from "../../../state-machines/peer-actor"
import type { Side } from "../../core/labels"
import type { Monitor } from "./wire"

const SIDES: readonly Side[] = ["a", "b"]

/** The clock snapshot of a side's connection, as Mesh's sweep reads it (the parts the invariant needs). */
export function snapshotOf(conn: { pc: { connectionState: RTCPeerConnectionState; signalingState: RTCSignalingState; localDescription: unknown; remoteDescription: unknown }; channel?: { readyState: string } | null; away: "said" | "timeout" | null; framesSeen: number } | undefined): ClockSnapshot {
  return {
    browserConnectionState: conn?.pc.connectionState ?? "closed",
    haveLocalOffer: conn?.pc.signalingState === "have-local-offer",
    localDescription: Boolean(conn?.pc.localDescription),
    remoteDescription: Boolean(conn?.pc.remoteDescription),
    hasChannel: Boolean(conn?.channel),
    laneOpen: conn?.channel?.readyState === "open",
    away: conn?.away ?? null,
    framesSeen: conn?.framesSeen ?? 0,
    sawVideoThisRound: false,
    canRestartIce: false,
  }
}

export const DEADLINE: Monitor = {
  id: "D",
  closed: true,
  afterStep(room, record) {
    return SIDES.flatMap((side) => {
      const internals = room.internals(side)
      const peer = side === "a" ? "b" : "a"
      const actor = internals.runner?.state(peer)
      if (!actor) return []
      const missing = missingRecoveryDeadline(actor, Date.now(), snapshotOf(internals.conns.get(peer) as Parameters<typeof snapshotOf>[0]))
      return missing ? [{ property: "D" as const, atStep: record.index, detail: `${side}'s actor for ${peer}: ${missing}` }] : []
    })
  },
}
