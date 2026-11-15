// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The clock frame on the mesh data channel: while a peer check window is open, a phone pings
 * its peers, and every peer replies with its device ms, never its peer correction
 * (lib/clock-sync.ts). The `DataChannelMessage` envelope holds byte 0 = kind (0 ping, 1 reply),
 * a float64 `sentDeviceMs`, and for a reply a float64 `clockMs`. Decoding never throws.
 */
import { decodeChannelMessage, encodeChannelMessage } from "@jollity/statement-core"
import { PEER_RTT_MAX_MS } from "../clock-sync"

/** The envelope id the frame rides under. Wire, not a name we may pick freely
 *  once a peer reads it. */
export const USE_CASE_CLOCK = "jollity_clock_sync_use_case"

const PING = 0
const REPLY = 1

export type ClockFrame =
  | { kind: "ping"; sentDeviceMs: number }
  | { kind: "reply"; sentDeviceMs: number; clockMs: number }

/** What the mesh needs of the clock. */
export interface MeshClock {
  /** this phone's device ms */
  reply: () => number
  /** a peer check window is open: ping now */
  wants: () => boolean
  /** one peer sample: the peer's clock minus this phone's device clock, ms, and its round trip */
  offer: (peerId: string, offsetMs: number, rttMs: number) => void
}

function encode(kind: number, values: number[]): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(1 + 8 * values.length)
  data[0] = kind
  const view = new DataView(data.buffer)
  values.forEach((value, i) => view.setFloat64(1 + 8 * i, value))
  return new Uint8Array(encodeChannelMessage({ id: USE_CASE_CLOCK, data }))
}

/** A ping, stamped with this phone's device ms. */
export function encodeClockPing(sentDeviceMs: number): Uint8Array<ArrayBuffer> {
  return encode(PING, [sentDeviceMs])
}

/** The reply to a ping: its stamp echoed back, and this phone's clock ms. */
export function encodeClockReply(sentDeviceMs: number, clockMs: number): Uint8Array<ArrayBuffer> {
  return encode(REPLY, [sentDeviceMs, clockMs])
}

/** Read one inbound channel frame, null for anything that is not a clock frame. Never throws. */
export function decodeClockFrame(bytes: Uint8Array): ClockFrame | null {
  try {
    const frame = decodeChannelMessage(bytes)
    if (frame.id !== USE_CASE_CLOCK) return null
    const { data } = frame
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (data[0] === PING && data.length >= 9) {
      const sentDeviceMs = view.getFloat64(1)
      return Number.isFinite(sentDeviceMs) ? { kind: "ping", sentDeviceMs } : null
    }
    if (data[0] === REPLY && data.length >= 17) {
      const sentDeviceMs = view.getFloat64(1)
      const clockMs = view.getFloat64(9)
      return Number.isFinite(sentDeviceMs) && Number.isFinite(clockMs) ? { kind: "reply", sentDeviceMs, clockMs } : null
    }
    return null
  } catch {
    return null
  }
}

/** Act on one clock frame from `peerId` that arrived at device ms `nowMs`. A ping always gets
 *  a reply through `send`. A reply with a round trip in `[0, PEER_RTT_MAX_MS]` goes to `offer`
 *  as an offset, with half the trip added, and with the trip. A slower one goes to `drop`. */
export function handleClockFrame(
  frame: ClockFrame,
  peerId: string,
  nowMs: number,
  clock: MeshClock,
  send: (bytes: Uint8Array<ArrayBuffer>) => void,
  drop: (rttMs: number) => void,
): void {
  if (frame.kind === "ping") {
    send(encodeClockReply(frame.sentDeviceMs, clock.reply()))
    return
  }
  const rttMs = nowMs - frame.sentDeviceMs
  if (rttMs >= 0 && rttMs <= PEER_RTT_MAX_MS) clock.offer(peerId, frame.clockMs + rttMs / 2 - nowMs, rttMs)
  else drop(rttMs)
}
