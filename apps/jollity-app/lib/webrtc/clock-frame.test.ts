// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { decodeChannelMessage, encodeChannelMessage } from "@jollity/statement-core"
import { PEER_RTT_MAX_MS } from "../clock-sync"
import { decodeClockFrame, encodeClockPing, encodeClockReply, handleClockFrame, USE_CASE_CLOCK, type MeshClock } from "./clock-frame"

const clock = (reply: number) => ({
  reply: () => reply,
  wants: () => true,
  offer: vi.fn<MeshClock["offer"]>(),
})

describe("the clock frame", () => {
  it("round-trips a ping and a reply", () => {
    expect(decodeClockFrame(encodeClockPing(1_234.5))).toEqual({ kind: "ping", sentDeviceMs: 1_234.5 })
    expect(decodeClockFrame(encodeClockReply(1_234.5, 1_760_000_000_123.25))).toEqual({
      kind: "reply",
      sentDeviceMs: 1_234.5,
      clockMs: 1_760_000_000_123.25,
    })
    expect(decodeChannelMessage(encodeClockPing(1)).id).toBe(USE_CASE_CLOCK)
  })

  it("reads a foreign frame as null", () => {
    expect(decodeClockFrame(new Uint8Array(encodeChannelMessage({ id: "other", data: new Uint8Array(17) })))).toBeNull()
    expect(decodeClockFrame(new Uint8Array(encodeChannelMessage({ id: USE_CASE_CLOCK, data: new Uint8Array([7, ...new Uint8Array(16)]) })))).toBeNull()
    expect(decodeClockFrame(new Uint8Array([9, 9, 9]))).toBeNull()
  })

  it("reads a short frame as null", () => {
    const short = (data: number[]) => new Uint8Array(encodeChannelMessage({ id: USE_CASE_CLOCK, data: new Uint8Array(data) }))
    expect(decodeClockFrame(short([]))).toBeNull()
    expect(decodeClockFrame(short([0, 1, 2, 3]))).toBeNull()
    expect(decodeClockFrame(short([1, ...new Uint8Array(12)]))).toBeNull()
    expect(decodeClockFrame(new Uint8Array())).toBeNull()
  })
})

describe("handleClockFrame", () => {
  it("always replies to a ping with the echo and the clock ms", () => {
    const send = vi.fn()
    const lane = clock(1_760_000_000_000)
    lane.wants = () => false
    handleClockFrame({ kind: "ping", sentDeviceMs: 500 }, "peer-a", 9_000, lane, send, vi.fn())
    expect(send).toHaveBeenCalledOnce()
    expect(decodeClockFrame(send.mock.calls[0][0])).toEqual({ kind: "reply", sentDeviceMs: 500, clockMs: 1_760_000_000_000 })
    expect(lane.offer).not.toHaveBeenCalled()
  })

  it("offers the peer's clock plus half the round trip, minus the device ms now, with the round trip", () => {
    const lane = clock(0)
    const drop = vi.fn()
    handleClockFrame({ kind: "reply", sentDeviceMs: 1_000, clockMs: 50_000 }, "peer-a", 1_300, lane, vi.fn(), drop)
    expect(lane.offer).toHaveBeenCalledWith("peer-a", 50_150 - 1_300, 300)
    handleClockFrame({ kind: "reply", sentDeviceMs: 1_000, clockMs: 50_000 }, "peer-b", 1_000 + PEER_RTT_MAX_MS, lane, vi.fn(), drop)
    expect(lane.offer).toHaveBeenLastCalledWith("peer-b", 50_000 + PEER_RTT_MAX_MS / 2 - (1_000 + PEER_RTT_MAX_MS), PEER_RTT_MAX_MS)
    expect(drop).not.toHaveBeenCalled()
  })

  it("offers 0 for a peer on the same clock", () => {
    const lane = clock(0)
    handleClockFrame({ kind: "reply", sentDeviceMs: 1_000, clockMs: 1_200 }, "peer-a", 1_400, lane, vi.fn(), vi.fn())
    expect(lane.offer).toHaveBeenCalledWith("peer-a", 0, 400)
  })

  it("drops a reply with a round trip over 1 s, or below 0", () => {
    const lane = clock(0)
    const drop = vi.fn()
    handleClockFrame({ kind: "reply", sentDeviceMs: 1_000, clockMs: 50_000 }, "peer-a", 1_000 + PEER_RTT_MAX_MS + 1, lane, vi.fn(), drop)
    handleClockFrame({ kind: "reply", sentDeviceMs: 1_000, clockMs: 50_000 }, "peer-a", 999, lane, vi.fn(), drop)
    expect(lane.offer).not.toHaveBeenCalled()
    expect(drop.mock.calls).toEqual([[PEER_RTT_MAX_MS + 1], [-1]])
  })
})
