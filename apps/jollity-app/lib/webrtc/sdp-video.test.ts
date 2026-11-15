// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import fixture from "./fixtures/chrome-lane-sdp.json"
import { sdpVideoFeatures, videoRtpNames } from "./sdp-video"

const withRtx = (sdp: string) => sdp.replace("a=rtpmap:118 red/90000", "a=rtpmap:97 rtx/90000\r\na=rtpmap:118 red/90000")

describe("videoRtpNames", () => {
  it("reads the payload names of the video section only, lowercased", () => {
    const names = videoRtpNames(fixture.laneOffer)
    expect(names).toEqual(new Set(["h264", "vp8", "vp9", "av1", "red", "ulpfec"]))
  })

  it("ignores rtpmaps of a non-video section", () => {
    const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=rtpmap:111 opus/48000/2\r\na=rtpmap:63 red/48000/2\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n"
    expect(videoRtpNames(sdp)).toEqual(new Set(["vp8"]))
  })

  it("is empty without an SDP", () => {
    expect(videoRtpNames(undefined).size).toBe(0)
  })
})

describe("sdpVideoFeatures", () => {
  it("says which repair formats both descriptions carry: the negotiated set", () => {
    expect(sdpVideoFeatures(fixture.laneOffer, fixture.laneAnswer)).toEqual({ rtx: false, red: true, ulpfec: true, flexfec: false })
  })

  it("a format only one side wrote is not negotiated", () => {
    expect(sdpVideoFeatures(withRtx(fixture.laneOffer), fixture.laneAnswer)?.rtx).toBe(false)
    expect(sdpVideoFeatures(withRtx(fixture.laneOffer), withRtx(fixture.laneAnswer))?.rtx).toBe(true)
  })

  it("is undefined until both descriptions exist", () => {
    expect(sdpVideoFeatures(fixture.laneOffer, undefined)).toBeUndefined()
    expect(sdpVideoFeatures(undefined, fixture.laneAnswer)).toBeUndefined()
  })
})
