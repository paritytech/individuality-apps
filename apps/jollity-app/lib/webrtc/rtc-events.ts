// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE MESH'S ONE EVENT STREAM: everything the Mesh tells the telemetry about a
 * link, as one union on `kind`, through the single `onRtcEvent` option
 * (lib/webrtc/mesh.ts). lib/journeys/game-trace.ts `recordMeshEvent` switches
 * on it.
 *
 *   stage       a link reached a step of the connection funnel (funnel.ts)
 *   gather      a peer connection finished gathering (gather.ts)
 *   ice_error   the browser raised an icecandidateerror (gather.ts)
 *   heal        a self-heal attempt ended, healed or not (heal.ts)
 *   heal_episode one terminal row for all attempts since the link was healthy
 *   heal_cohort near-simultaneous failures across established links
 *   link_failed one established link failed, and how (torn down or timed out; heal-cohort.ts)
 *   away_period one terminal row for a peer's complete stretch away
 *   signal_rtt  an answer came back to an offer of ours (offer-clock.ts)
 *   negotiation_error  a lane SDP could not be applied or created
 *   resume      a link's video came back after a phone's return from the background (#557)
 *   codec_guard an engine that must not negotiate RTX was about to (#559)
 *   sps         the SPS tap read the sender's first key frame on a link (#629;
 *               from useMesh's tap, not the Mesh itself)
 */
import type { StageEvent } from "./funnel"
import type { GatherEvent, IceErrorEvent } from "./gather"
import type { HealEpisodeEvent, HealEvent } from "./heal"
import type { HealCohortEvent, LinkFailure } from "./heal-cohort"
import type { AwayPeriodEvent } from "./away-period"
import type { SpsTapEvent } from "./sps-tap"

export interface SignalRttEvent {
  /** ms from the offer being handed to the transport to the answer being applied */
  ms: number
  /** the first negotiation goes over the signalling wire (the statement store);
   *  every later one rides the data channel's renegotiation lane */
  via: "statement" | "channel"
  /** the peer had been heard from within the presence window when the offer was
   *  posted; false = the offer may have waited for an app that was not running (#370) */
  peerPresent: boolean
  /** for an offer to an absent peer: ms from the peer's first frame after the
   *  offer to the answer; absent when the answer was that first frame */
  fromSeenMs?: number
}

export interface NegotiationErrorEvent {
  /** DOMException name, limited by the Mesh to hard SDP failures */
  name: "InvalidAccessError" | "InvalidStateError" | "OperationError"
  /** the SDP description being applied or created */
  stage: "offer" | "answer"
  /** which browser operation rejected */
  operation: "set-local" | "set-remote"
  /** whether libwebrtc named the known duplicate receive-stream failure */
  reason: "ssrc-collision" | "other"
}

/** An engine with the M111–M123 RTX bug (rtxSafeEngine false) whose own
 *  codec preferences did not hold (#559): setCodecPreferences is missing or
 *  threw, or the lane offer it wrote still carried RTX. The last one is caught
 *  before the offer is sent and the offer is rewritten without RTX. */
interface CodecGuardEvent {
  reason: "prefs-missing" | "prefs-refused" | "offer-rtx"
}

/** How a keyframe was forced on our senders when this phone came back (#557):
 *  the encoder switched off and on, the track swapped out and in, or nothing worked */
export type KeyframeMethod = "active-toggle" | "replace-track" | "none"

export interface ResumeEvent {
  /** self = this phone came back; peer = the far end's away flag cleared */
  side: "self" | "peer"
  /** ms, monotonic, from the return to the next increase in framesDecoded on the link */
  ms: number
  /** self side only: the keyframe method that was tried, and whether keyFramesEncoded confirmed it */
  keyframe?: { method: KeyframeMethod; verified: "true" | "false" | "unsupported" }
}

export type RtcEvent =
  | ({ kind: "stage" } & StageEvent)
  | ({ kind: "gather" } & GatherEvent)
  | ({ kind: "ice_error" } & IceErrorEvent)
  | ({ kind: "heal" } & HealEvent)
  | ({ kind: "heal_episode" } & HealEpisodeEvent)
  | ({ kind: "heal_cohort" } & HealCohortEvent)
  | ({ kind: "link_failed" } & LinkFailure)
  | ({ kind: "away_period" } & AwayPeriodEvent)
  | ({ kind: "signal_rtt" } & SignalRttEvent)
  | ({ kind: "negotiation_error" } & NegotiationErrorEvent)
  | ({ kind: "resume" } & ResumeEvent)
  | ({ kind: "codec_guard" } & CodecGuardEvent)
  | ({ kind: "sps" } & SpsTapEvent)

/** Run a telemetry callback so that it can never break the mesh. */
export function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    /* telemetry never breaks the mesh */
  }
}
