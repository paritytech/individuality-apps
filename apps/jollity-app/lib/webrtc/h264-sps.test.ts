// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { findSpsNal, parseSps, spsAttrs, spsFromFrame, unescapeRbsp } from "./h264-sps"

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))

/**
 * Every vector below is real encoder output or checked against an
 * independent parser: each expectation was read off ffmpeg's trace_headers
 * bitstream filter for the same bytes (10 Oct 2026).
 */
const VECTORS = {
  // Chrome 153 (headless, macOS), OpenH264, as its RECEIVER's encoded transform
  // handed it over: POC type 2, VUI with bitstream_restriction
  chromeOpenH264: "6742c01e8c68170bf9658078442350",
  // ffmpeg h264_videotoolbox -realtime 1 -profile baseline (360x360): POC 0, no VUI
  vtBaseline: "27420015ab40b85fcb2a",
  // ffmpeg h264_videotoolbox -realtime 1 -profile high (640x480): POC 0, no VUI
  vtHigh: "2764001eac5680a03d90",
  // libx264 high with B-frames: POC 0, VUI restriction (reorder 2, dec buf 4), emulation-prevention bytes
  x264High: "67640015acd94170bf965c0440000003004000000c03c58b6580",
  // libx264 with nal-hrd=cbr: timing info + a NAL HRD block before the restriction
  x264Hrd: "6764000dacd94141fb01100000030010000003030602001e840007a13930c01e28532c",
  // libx264 -tune zerolatency baseline: POC 2, reorder 0
  x264ZeroLatency: "6742c00dd90141fb011000000300100000030308f142a480",
  // written bit by bit, then checked against ffmpeg: high profile with SPS
  // scaling lists (one ended early by a zero next scale), POC type 1 with a
  // two-entry cycle, a VUI with extended SAR, colour description, timing whose
  // time_scale has the top bit set, both NAL and VCL HRD, and a restriction
  synthetic: "6764001fad880c82924924924924924924924924924924924924924924924924a14cc4360a0fdff80008000b501010140000030007c00000030180003e9003e8af7be300007d2007d15ef7c1b41108a240",
}

describe("parseSps", () => {
  it("reads Chrome's OpenH264 SPS as POC type 2 with a restriction of no reordering", () => {
    expect(parseSps(hex(VECTORS.chromeOpenH264))).toEqual({
      profileIdc: 66,
      constraintFlags: 0xc0,
      levelIdc: 30,
      pocType: 2,
      numRefFrames: 1,
      vui: true,
      bitstreamRestriction: true,
      maxNumReorderFrames: 0,
      maxDecFrameBuffering: 1,
      complete: true,
    })
  })

  it("reads a VideoToolbox baseline SPS as POC type 0 with no VUI at all", () => {
    expect(parseSps(hex(VECTORS.vtBaseline))).toEqual({
      profileIdc: 66,
      constraintFlags: 0,
      levelIdc: 21,
      pocType: 0,
      numRefFrames: 1,
      vui: false,
      bitstreamRestriction: false,
      complete: true,
    })
  })

  it("reads a VideoToolbox high-profile SPS (the chroma/bit-depth branch) as POC type 0, no VUI", () => {
    const sps = parseSps(hex(VECTORS.vtHigh))
    expect(sps).toMatchObject({ profileIdc: 100, levelIdc: 30, pocType: 0, numRefFrames: 1, vui: false, bitstreamRestriction: false, complete: true })
  })

  it("reads a POC type 0 stream whose VUI says it reorders (x264 with B-frames)", () => {
    expect(parseSps(hex(VECTORS.x264High))).toMatchObject({
      profileIdc: 100,
      levelIdc: 21,
      pocType: 0,
      numRefFrames: 4,
      vui: true,
      bitstreamRestriction: true,
      maxNumReorderFrames: 2,
      maxDecFrameBuffering: 4,
      complete: true,
    })
  })

  it("walks over timing info and a NAL HRD block to reach the restriction", () => {
    expect(parseSps(hex(VECTORS.x264Hrd))).toMatchObject({
      levelIdc: 13,
      pocType: 0,
      bitstreamRestriction: true,
      maxNumReorderFrames: 2,
      maxDecFrameBuffering: 4,
      complete: true,
    })
  })

  it("reads x264's zero-latency baseline as POC type 2, reorder 0", () => {
    expect(parseSps(hex(VECTORS.x264ZeroLatency))).toMatchObject({
      profileIdc: 66,
      constraintFlags: 0xc0,
      levelIdc: 13,
      pocType: 2,
      numRefFrames: 3,
      bitstreamRestriction: true,
      maxNumReorderFrames: 0,
      maxDecFrameBuffering: 3,
    })
  })

  it("skips scaling lists, a POC type 1 cycle and both HRD blocks without losing its place", () => {
    expect(parseSps(hex(VECTORS.synthetic))).toEqual({
      profileIdc: 100,
      constraintFlags: 0,
      levelIdc: 31,
      pocType: 1,
      numRefFrames: 2,
      vui: true,
      bitstreamRestriction: true,
      maxNumReorderFrames: 1,
      maxDecFrameBuffering: 3,
      complete: true,
    })
  })

  it("keeps what it read when the SPS is cut short, and never throws", () => {
    const whole = hex(VECTORS.x264High)
    for (let cut = 4; cut < whole.length; cut++) {
      const sps = parseSps(whole.subarray(0, cut))
      expect(sps?.profileIdc).toBe(100)
      expect(sps?.levelIdc).toBe(21)
    }
    // cut inside the VUI: the POC type is there, the restriction is not
    const partial = parseSps(whole.subarray(0, 12))
    expect(partial).toMatchObject({ pocType: 0, complete: false })
    expect(partial?.maxNumReorderFrames).toBeUndefined()
  })

  it("is null for something that is not an SPS", () => {
    expect(parseSps(hex("68ce3c80"))).toBeNull() // a PPS
    expect(parseSps(hex("67"))).toBeNull()
    expect(parseSps(new Uint8Array())).toBeNull()
    expect(parseSps(hex("e742c01e"))).toBeNull() // forbidden_zero_bit set
  })

  it("survives random bytes after a valid header", () => {
    let seed = 7
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff)
    for (let i = 0; i < 500; i++) {
      const bytes = Uint8Array.from({ length: 4 + (i % 40) }, rand)
      bytes[0] = 0x67
      expect(() => parseSps(bytes)).not.toThrow()
    }
  })
})

describe("unescapeRbsp", () => {
  it("drops the 0x03 of every 00 00 03 and nothing else", () => {
    expect(unescapeRbsp(hex("0000030100000300"))).toEqual(hex("000001000000"))
    expect(unescapeRbsp(hex("00000003"))).toEqual(hex("000000")) // 00 00 00 cannot occur escaped, but 00 00 03 still is
    expect(unescapeRbsp(hex("0003000003"))).toEqual(hex("00030000"))
  })
})

describe("findSpsNal", () => {
  // the first key frame Chrome's receiver handed its transform: SPS, PPS, IDR slice, 4-byte start codes
  const chromeKeyFrame = hex(
    "00000001" + VECTORS.chromeOpenH264 + "00" + "00000001" + "68ce3c80" + "00000001" + "65b8000405388c500010458e000203f1c000407e4e4e",
  )

  it("finds the SPS in an Annex-B access unit", () => {
    expect(findSpsNal(chromeKeyFrame)).toEqual(hex(VECTORS.chromeOpenH264 + "00"))
    expect(spsFromFrame(chromeKeyFrame)).toMatchObject({ pocType: 2, maxDecFrameBuffering: 1 })
  })

  it("finds it behind 3-byte start codes and after other NAL units", () => {
    const au = hex("000001" + "09f0" + "000001" + VECTORS.vtBaseline + "000001" + "28ce3c80")
    expect(spsFromFrame(au)).toMatchObject({ pocType: 0, vui: false })
  })

  it("finds it in a length-prefixed (AVCC) access unit", () => {
    const sps = hex(VECTORS.vtHigh)
    const pps = hex("28ee3cb0")
    const au = new Uint8Array([0, 0, 0, sps.length, ...sps, 0, 0, 0, pps.length, ...pps])
    expect(spsFromFrame(au)).toMatchObject({ profileIdc: 100, pocType: 0 })
  })

  it("is null for a frame with no SPS: a delta frame, a VP8 frame, nothing", () => {
    expect(findSpsNal(hex("0000000141e2"))).toBeNull()
    expect(findSpsNal(hex("9d012a"))).toBeNull()
    expect(findSpsNal(new Uint8Array())).toBeNull()
    expect(spsFromFrame(hex("00000001419a"))).toBeNull()
  })
})

describe("spsAttrs", () => {
  it("names a POC type 0 stream with no VUI", () => {
    expect(spsAttrs(parseSps(hex(VECTORS.vtBaseline))!)).toEqual({
      "rtc.sps.poc_type": "0",
      "rtc.sps.vui": "false",
      "rtc.sps.restriction": "false",
      "rtc.sps.reorder": "none",
      "rtc.sps.dec_buf": "none",
      "rtc.sps.num_ref": "1",
      "rtc.sps.profile": "66",
      "rtc.sps.constraints": "00",
      "rtc.sps.level": "21",
      "rtc.sps.complete": "true",
    })
  })

  it("names the restriction's values when it is there", () => {
    expect(spsAttrs(parseSps(hex(VECTORS.chromeOpenH264))!)).toMatchObject({
      "rtc.sps.poc_type": "2",
      "rtc.sps.vui": "true",
      "rtc.sps.restriction": "true",
      "rtc.sps.reorder": "0",
      "rtc.sps.dec_buf": "1",
      "rtc.sps.constraints": "c0",
    })
  })

  it("says unknown for what a cut-short SPS never reached", () => {
    const attrs = spsAttrs(parseSps(hex(VECTORS.x264High).subarray(0, 5))!)
    expect(attrs["rtc.sps.poc_type"]).toBe("unknown")
    expect(attrs["rtc.sps.complete"]).toBe("false")
  })
})
