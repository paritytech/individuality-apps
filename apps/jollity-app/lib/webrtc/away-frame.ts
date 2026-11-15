// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The "away" / "back" frame on the mesh data channel (#229): a phone tells its
 * peers it is going to the background, or that it is back. It is this app's
 * own, not part of the native clients' wire: a peer that does not know the
 * use-case id reads it as a frame
 * it cannot use and drops it, and it never rides the statement store.
 *
 * Same two layers as gesture.ts: the `DataChannelMessage` envelope (use-case id
 * plus bytes) around one byte, 1 = away, 0 = back. Decoding never throws.
 */
import { decodeChannelMessage, encodeChannelMessage } from "@jollity/statement-core"

/** The envelope id the frame rides under. Wire, not a name we may pick freely
 *  once a peer reads it. */
export const USE_CASE_PEER_AWAY = "jollity_peer_away_use_case"

/** The frame a phone puts on a channel to say it is away (true) or back (false). */
export function encodeAway(away: boolean): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encodeChannelMessage({ id: USE_CASE_PEER_AWAY, data: new Uint8Array([away ? 1 : 0]) }))
}

/** Read one inbound channel frame: true = away, false = back, null for anything
 *  that is not an away frame. Never throws. */
export function decodeAway(bytes: Uint8Array): boolean | null {
  try {
    const frame = decodeChannelMessage(bytes)
    if (frame.id !== USE_CASE_PEER_AWAY || frame.data.length < 1) return null
    return frame.data[0] === 1
  } catch {
    return null
  }
}
