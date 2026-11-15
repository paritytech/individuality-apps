// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The gesture frame on the mesh data channel, in the wire shape of the native
 * Polkadot-app game clients (now discontinued; kept for compatibility), so a
 * browser player and a phone in one game read each other.
 *
 * Two layers. The outer `DataChannelMessage` is a multiplexing envelope: a
 * use-case id and an opaque byte vector. The inner `GestureAcceptanceMessage`
 * is the gesture itself, an enum of `Accept` and `Unaccept` over one body.
 *
 * Decoding never throws. A peer can send anything, and one bad frame must not
 * take the channel down with it.
 */
import { Bytes, Enum, Struct, str, u32 } from "scale-ts"

/** The multiplexing envelope. Both stacks put every channel frame in one. */
const DataChannelMessage = Struct({
  id: str,
  data: Bytes(),
})

/** The envelope id a gesture rides under. A frame under any other id is not
 *  a gesture: the same channel carries the mesh's own frames (the
 *  renegotiation lane, link views, away/back), clock pings, and the native
 *  clients' media-state traffic, which this app does not speak. */
export const USE_CASE_GESTURE_ACCEPTANCE = "video_game_gesture_acceptance"

const GestureBody = Struct({
  roundIndex: u32,
  acceptorAccountId: Bytes(32),
})

const GestureAcceptanceMessage = Enum({
  Accept: GestureBody,
  Unaccept: GestureBody,
})

/** An account id is a fixed 32 bytes on the wire. */
const ACCOUNT_ID_BYTES = 32

/** The wire's own two names for a verdict. `Accept` puts the sender in your
 *  accepter set for the round, `Unaccept` takes the sender back out. */
export type GestureTag = "Accept" | "Unaccept"

export interface Gesture {
  tag: GestureTag
  /** the round the SENDER was in. A receiver in a different round drops the
   *  gesture, because a stale one must not celebrate. */
  roundIndex: number
  /** the sender's own account. The connection already says who sent the frame,
   *  so nothing here needs the field — the native clients put it on the wire,
   *  so we carry it. */
  acceptorAccountId: Uint8Array
}

/**
 * Build the bytes for one outbound gesture.
 *
 * Returns null when the account id is not 32 bytes. `Bytes(32)` writes whatever
 * it is handed, so a short id would build a frame every conforming receiver
 * drops, and the sender would never learn it.
 */
export function encodeGesture(gesture: Gesture): Uint8Array<ArrayBuffer> | null {
  if (gesture.acceptorAccountId.length !== ACCOUNT_ID_BYTES) return null
  const data = GestureAcceptanceMessage.enc({
    tag: gesture.tag,
    value: {
      roundIndex: gesture.roundIndex,
      acceptorAccountId: gesture.acceptorAccountId,
    },
  })
  return new Uint8Array(DataChannelMessage.enc({ id: USE_CASE_GESTURE_ACCEPTANCE, data }))
}

/**
 * Read one inbound channel frame.
 *
 * Returns null for anything that is not a whole gesture: a frame that does not
 * decode, a frame under another use case, an unknown enum tag, or a body cut
 * short. Never throws.
 */
export function decodeGesture(bytes: Uint8Array): Gesture | null {
  let frame: { id: string; data: Uint8Array }
  try {
    frame = DataChannelMessage.dec(bytes)
  } catch {
    return null
  }
  if (frame.id !== USE_CASE_GESTURE_ACCEPTANCE) return null

  let message: { tag: GestureTag; value: { roundIndex: number; acceptorAccountId: Uint8Array } }
  try {
    message = GestureAcceptanceMessage.dec(frame.data)
  } catch {
    return null
  }
  // A truncated body does NOT throw: the byte vector's length prefix survives
  // the cut, and `Bytes(32)` hands back the few bytes that are left. The length
  // is the only thing that tells a short frame from a whole one.
  if (message.value.acceptorAccountId.length !== ACCOUNT_ID_BYTES) return null

  return {
    tag: message.tag,
    roundIndex: message.value.roundIndex,
    acceptorAccountId: message.value.acceptorAccountId,
  }
}
