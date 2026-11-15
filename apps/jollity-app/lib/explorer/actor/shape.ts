// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * An actor event's shape: the fields that say which fact it is, without
 * epochs, times or counters. T15's differential (room-differential.test.ts)
 * compares Mesh's events with the alphabet's by it, and the confirm pipeline
 * (room/to-mesh.ts) matches an abstract half's events with a Mesh side's.
 */
import type { PeerActorEvent } from "../../state-machines/peer-actor"

const SHAPE_FIELDS = [
  "state", "lane", "description", "accepted", "departedSession", "away", "marked", "hidden", "standby", "keyframe",
  "commandKind", "outcome", "site", "reason", "haveLocalOffer", "polite", "remoteCarriesVideo", "localOffer", "negotiated",
  "noVideoDeadline", "peerCannotSeeUs", "recoveryDue", "cameraLive", "browserConnectionState",
] as const

export function shape(event: PeerActorEvent): string {
  const record = event as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { type: event.type }
  // a sweep is told by the commands it issues, not by its facts
  if (event.type === "clock") return JSON.stringify(out)
  for (const field of SHAPE_FIELDS) if (record[field] !== undefined) out[field] = record[field]
  if (event.type === "description-observed") out.newRemoteSession = Boolean(event.newRemoteSession)
  if (event.type === "visibility-changed" && event.hiddenForMs !== undefined) out.kick = event.hiddenForMs > 8000
  if (event.type === "stats-observed") out.frames = Math.sign(event.framesDecoded)
  return JSON.stringify(out)
}
