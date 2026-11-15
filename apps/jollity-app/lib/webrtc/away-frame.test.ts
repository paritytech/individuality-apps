// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { decodeChannelMessage, encodeChannelMessage } from "@jollity/statement-core"
import { decodeAway, encodeAway, USE_CASE_PEER_AWAY } from "./away-frame"

describe("the away frame", () => {
  it("round-trips away and back", () => {
    expect(decodeAway(encodeAway(true))).toBe(true)
    expect(decodeAway(encodeAway(false))).toBe(false)
    expect(decodeChannelMessage(encodeAway(true)).id).toBe(USE_CASE_PEER_AWAY)
  })

  it("reads nothing else as away, and never throws", () => {
    expect(decodeAway(new Uint8Array(encodeChannelMessage({ id: "other", data: new Uint8Array([1]) })))).toBeNull()
    expect(decodeAway(new Uint8Array(encodeChannelMessage({ id: USE_CASE_PEER_AWAY, data: new Uint8Array() })))).toBeNull()
    expect(decodeAway(new Uint8Array([9, 9, 9]))).toBeNull()
    expect(decodeAway(new Uint8Array())).toBeNull()
  })
})
