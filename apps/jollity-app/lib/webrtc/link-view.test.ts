// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { encodeChannelMessage } from "@jollity/statement-core"
import { USE_CASE_LINK_VIEW, decodeView, decodeViewFrame, encodeView, encodeViewFrame, roomTag } from "./link-view"

const room = ["carol", "amy", "bob", "dave"]
const codes: Record<string, "-" | "0" | "1" | "2" | "3"> = { amy: "-", bob: "3", carol: "2", dave: "0" }

describe("a view row", () => {
  it("lists the members in sorted order behind the room's tag", () => {
    const row = encodeView(room, (m) => codes[m]!)
    expect(row).toBe(`${roomTag(room)}:-320`)
    expect(roomTag(["dave", "bob", "amy", "carol"])).toBe(roomTag(room)) // order does not matter
  })

  it("reads back member by member", () => {
    const view = decodeView(encodeView(room, (m) => codes[m]!), room)
    expect(Object.fromEntries(view!)).toEqual(codes)
  })

  it("is not read by a phone with another roster, a wrong length or a stray character", () => {
    const row = encodeView(room, (m) => codes[m]!)
    expect(decodeView(row, ["amy", "bob", "carol", "erin"])).toBeNull()
    expect(decodeView(`${roomTag(room)}:-32`, room)).toBeNull()
    expect(decodeView(`${roomTag(room)}:-32x`, room)).toBeNull()
    expect(decodeView("nonsense", room)).toBeNull()
  })
})

describe("the view frame", () => {
  it("round-trips the row over the data channel", () => {
    expect(decodeViewFrame(encodeViewFrame("ab12:-3"))).toBe("ab12:-3")
  })

  it("reads nothing else as a view, and never throws", () => {
    expect(decodeViewFrame(new Uint8Array(encodeChannelMessage({ id: "other", data: new Uint8Array([1]) })))).toBeNull()
    expect(decodeViewFrame(new Uint8Array([9, 9, 9]))).toBeNull()
    expect(decodeViewFrame(new Uint8Array())).toBeNull()
    expect(USE_CASE_LINK_VIEW).toBe("jollity_link_view_use_case")
  })
})
