// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE CONNECTION FUNNEL: the five steps a link passes on its way to video, so
 * a dashboard can count how many pairs reach each one and where the rest stop
 * (signalling, ICE or media). The Mesh stamps each step the first time a peer
 * reaches it, in ms from the mesh opening (lib/webrtc/mesh.ts markStage);
 * lib/journeys/rtc-funnel.ts turns it into the `rtc.funnel_ms` metric.
 *
 * Both ends see the same five steps, from their own side:
 *
 *   offer          the link's first offer exists: this side sent it (the
 *                  initiator, or an answerer that re-offered) or received it
 *   answer         the answer exists: this side received it, or sent it
 *   ice_checking   the ICE connection state reached `checking`
 *   connected      the peer connection reached `connected`
 *   first_frame    an inbound video frame was decoded (seen by the getStats
 *                  loop, so up to one report interval, 3 s, late)
 *
 * Which end this is comes from `isInitiator`, the one rule the Mesh and the
 * trace share. Reading both ends' points under one rtc.pair gives the whole
 * exchange, and an answerer's pairs still reach every stage a dashboard counts.
 */
export const FUNNEL_STAGES = ["offer", "answer", "ice_checking", "connected", "first_frame"] as const
export type FunnelStage = (typeof FUNNEL_STAGES)[number]

export interface StageEvent {
  stage: FunnelStage
  /** ms from the mesh opening */
  ms: number
}

/** The lower account offers first (glare-free): the one compare the Mesh
 *  negotiates by and the trace names `rtc.role` by. */
export function isInitiator(self: string, peer: string): boolean {
  return self < peer
}
