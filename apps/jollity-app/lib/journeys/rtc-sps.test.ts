// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { spsTapAttrs } from "./rtc-sps"
import type { SpsTapEvent } from "../webrtc/sps-tap"

const event = (over: Partial<SpsTapEvent> = {}): SpsTapEvent => ({
  outcome: "sps",
  mime: "video/H264",
  frames: 3,
  inspectMs: 0.4,
  parseMs: 0.1,
  toKeyMs: 80,
  keyFrameRequest: "sent",
  engine: "script",
  attachMs: 0.2,
  sps: { profileIdc: 66, constraintFlags: 0, levelIdc: 31, pocType: 0, numRefFrames: 1, vui: false, bitstreamRestriction: false, complete: true },
  ...over,
})

describe("spsTapAttrs", () => {
  it("carries the SPS fields and how the tap read them, all as text", () => {
    expect(spsTapAttrs(event())).toEqual({
      "rtc.sps.poc_type": "0",
      "rtc.sps.vui": "false",
      "rtc.sps.restriction": "false",
      "rtc.sps.reorder": "none",
      "rtc.sps.dec_buf": "none",
      "rtc.sps.num_ref": "1",
      "rtc.sps.profile": "66",
      "rtc.sps.constraints": "00",
      "rtc.sps.level": "31",
      "rtc.sps.complete": "true",
      "rtc.sps.outcome": "sps",
      "rtc.sps.engine": "script",
      "rtc.sps.mime": "video/H264",
      "rtc.sps.keyframe_request": "sent",
    })
  })

  it("says only how it went when there was no SPS to read", () => {
    const attrs = spsTapAttrs(event({ outcome: "not-h264", mime: "video/VP8", sps: undefined }))
    expect(attrs).toEqual({
      "rtc.sps.outcome": "not-h264",
      "rtc.sps.engine": "script",
      "rtc.sps.mime": "video/VP8",
      "rtc.sps.keyframe_request": "sent",
    })
    expect(Object.values(attrs).every((v) => typeof v === "string")).toBe(true)
  })

  it("names the reason of a link the tap never attached to", () => {
    expect(spsTapAttrs(event({ outcome: "untapped", reason: "not-ready", sps: undefined, mime: "unknown" }))).toMatchObject({
      "rtc.sps.outcome": "untapped",
      "rtc.sps.reason": "not-ready",
    })
  })
})
