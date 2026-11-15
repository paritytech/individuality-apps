// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The data-channel mux frame and its lane payloads: everything the peers say
 * to each other IN BAND, once the peer connection is up.
 *
 * A `DataChannelMessage` is a mux frame: an `id` naming the lane and an
 * opaque `data` blob whose shape only that lane knows. Renegotiation sends
 * FULL raw SDP over the data channel (`PeerConnectionSignal`); there is no
 * 1 KiB statement cap here. Only the FIRST negotiation touches the statement
 * store, and that goes as JSON frames (statementTransport.ts), not through
 * this module.
 *
 * The lane ids and the SCALE layouts are the ones the web peers speak to
 * each other (the native apps they came from are discontinued), so they are
 * pinned by tests and never changed in passing.
 */
import {
  Bytes,
  Enum,
  Option,
  Struct,
  Vector,
  bool,
  str,
  u32,
  type CodecType,
} from "scale-ts"

// --- Data-channel mux (in-band) ---------------------------------------------

/** Multiplexed frame on the WebRTC data channel: lane id + opaque payload. */
export const DataChannelMessage = Struct({ id: str, data: Bytes() })

export type DataChannelMessageValue = CodecType<typeof DataChannelMessage>

export function encodeChannelMessage(
  message: DataChannelMessageValue,
): Uint8Array {
  return DataChannelMessage.enc(message)
}

export function decodeChannelMessage(
  bytes: Uint8Array,
): DataChannelMessageValue {
  return DataChannelMessage.dec(bytes)
}

/** Lane ids. Verbatim strings — they are the wire, not identifiers. */
export const USE_CASE_RENEGOTIATION = "webrtc_renegotiation_internal_use_case"
export const USE_CASE_MEDIA_STATE = "webrtc_media_state_use_case"
export const USE_CASE_GESTURE_ACCEPTANCE = "video_game_gesture_acceptance"

// --- Lane payloads -----------------------------------------------------------

/**
 * A trickled candidate during in-band renegotiation. Unlike the statement-store
 * path this carries the SDP line verbatim and its own m-line addressing — phase
 * 2 may have several m-lines (audio, video), so "m-line 0" no longer holds.
 */
export const PeerConnectionCandidate = Struct({
  sdp: str,
  sdpMLineIndex: u32,
  sdpMid: Option(str),
})

/** Payload of USE_CASE_RENEGOTIATION frames — full raw SDP, not the minimal codec. */
export const PeerConnectionSignal = Enum({
  Offer: str,
  Answer: str,
  IceCandidates: Vector(PeerConnectionCandidate),
})

export type PeerConnectionCandidateValue = CodecType<
  typeof PeerConnectionCandidate
>
export type PeerConnectionSignalValue = CodecType<typeof PeerConnectionSignal>

export function encodePeerConnectionSignal(
  signal: PeerConnectionSignalValue,
): Uint8Array {
  return PeerConnectionSignal.enc(signal)
}

export function decodePeerConnectionSignal(
  bytes: Uint8Array,
): PeerConnectionSignalValue {
  return PeerConnectionSignal.dec(bytes)
}

/** Payload of USE_CASE_MEDIA_STATE frames — camera/microphone toggles. */
export const MediaStateSignal = Enum({
  CameraEnabled: bool,
  MicrophoneEnabled: bool,
})

export type MediaStateSignalValue = CodecType<typeof MediaStateSignal>
