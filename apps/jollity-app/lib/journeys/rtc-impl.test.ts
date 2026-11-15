// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest"
import type { RtcSample } from "../webrtc/rtc-stats"
import { implFamily, implKind, resetImplChanges, trackImplChanges } from "./rtc-impl"

describe("implFamily", () => {
  it("keeps the implementation in use, not what it fell back from", () => {
    expect(implFamily("FFmpeg (fallback from: ExternalDecoder (MediaCodecVideoDecoder))")).toBe("FFmpeg")
    expect(implFamily("ExternalDecoder (MediaCodecVideoDecoder)")).toBe("ExternalDecoder")
    expect(implFamily("VideoToolbox")).toBe("VideoToolbox")
  })

  it("is undefined for nothing", () => {
    expect(implFamily(undefined)).toBeUndefined()
    expect(implFamily("  ")).toBeUndefined()
  })
})

describe("implKind", () => {
  it("trusts the browser's power-efficient flag first", () => {
    expect(implKind("libvpx", true)).toBe("hardware")
    expect(implKind("ExternalDecoder", false)).toBe("software")
  })

  it("names the known hardware and software implementations", () => {
    for (const name of ["VideoToolbox", "MediaCodec", "ExternalEncoder (MediaCodecVideoEncoder)", "ExternalDecoder", "D3D11VideoDecoder", "VaapiVideoDecoder", "MediaFoundationVideoEncodeAccelerator", "NdkVideoEncodeAccelerator", "OMX.SEC.avc.dec", "OMX.SEC.avc.enc"])
      expect(implKind(name), name).toBe("hardware")
    for (const name of ["libvpx", "FFmpeg", "OpenH264", "libaom", "dav1d", "libdav1d", "OMX.google.h264.decoder", "OMX.SEC.avc.sw.dec", "c2.android.avc.decoder", "c2.google.avc.encoder", "FFmpeg (fallback from: ExternalDecoder (MediaCodecVideoDecoder))"])
      expect(implKind(name), name).toBe("software")
  })

  it("says unsupported when it cannot tell", () => {
    expect(implKind(undefined)).toBe("unsupported")
    expect(implKind("SimulcastEncoderAdapter")).toBe("unsupported")
  })
})

const sample = (link: number, inbound?: Partial<NonNullable<RtcSample["inbound"]>>, outbound?: Partial<NonNullable<RtcSample["outbound"]>>): RtcSample => ({
  link,
  ...(inbound ? { inbound: { id: "in", ...inbound } } : {}),
  ...(outbound ? { outbound: { id: "out", ...outbound } } : {}),
})

describe("trackImplChanges", () => {
  beforeEach(() => resetImplChanges())

  it("the first sight of a link is no change", () => {
    expect(trackImplChanges([{ id: "a", quality: sample(1, { decoderImplementation: "ExternalDecoder", codec: "H264" }, { encoderImplementation: "OpenH264", codec: "H264" }) }])).toEqual([])
  })

  it("an Android decoder falling back to software reads as one inbound change, before and after", () => {
    trackImplChanges([{ id: "a", quality: sample(1, { decoderImplementation: "ExternalDecoder (MediaCodecVideoDecoder)", codec: "H264", codecFmtp: "profile-level-id=42e01f" }) }])
    const changes = trackImplChanges([{ id: "a", quality: sample(1, { decoderImplementation: "FFmpeg (fallback from: ExternalDecoder (MediaCodecVideoDecoder))" }) }])
    expect(changes).toEqual([
      {
        id: "a",
        attrs: {
          "rtc.direction": "in",
          "rtc.impl_from": "ExternalDecoder",
          "rtc.impl": "FFmpeg",
          "rtc.impl_kind_from": "hardware",
          "rtc.impl_kind": "software",
          "rtc.codec_from": "H264",
          "rtc.codec": "H264",
          "rtc.codec_fmtp": "profile-level-id=42e01f",
        },
      },
    ])
  })

  it("an encoder switch and an outbound codec switch are outbound changes", () => {
    trackImplChanges([{ id: "a", quality: sample(1, undefined, { encoderImplementation: "MediaCodec", codec: "H264", powerEfficientEncoder: true }) }])
    const [change] = trackImplChanges([{ id: "a", quality: sample(1, undefined, { encoderImplementation: "libvpx", codec: "VP8", powerEfficientEncoder: false }) }])
    expect(change.attrs).toMatchObject({ "rtc.direction": "out", "rtc.impl_from": "MediaCodec", "rtc.impl": "libvpx", "rtc.impl_kind_from": "hardware", "rtc.impl_kind": "software", "rtc.codec_from": "H264", "rtc.codec": "VP8" })
  })

  it("the power-efficient flag flipping under the same name is a change of kind", () => {
    trackImplChanges([{ id: "a", quality: sample(1, { decoderImplementation: "ExternalDecoder", powerEfficientDecoder: true }) }])
    const [change] = trackImplChanges([{ id: "a", quality: sample(1, { decoderImplementation: "ExternalDecoder", powerEfficientDecoder: false }) }])
    expect(change.attrs).toMatchObject({ "rtc.impl_kind_from": "hardware", "rtc.impl_kind": "software" })
  })

  it("a reading without a field keeps the last one, and a rebuilt link starts afresh", () => {
    trackImplChanges([{ id: "a", quality: sample(1, { decoderImplementation: "VideoToolbox", codec: "H264" }) }])
    expect(trackImplChanges([{ id: "a", quality: sample(1, {}) }])).toEqual([])
    expect(trackImplChanges([{ id: "a", quality: sample(2, { decoderImplementation: "libvpx", codec: "VP8" }) }])).toEqual([])
  })

  it("a change is reported once", () => {
    trackImplChanges([{ id: "a", quality: sample(1, { codec: "H264" }) }])
    expect(trackImplChanges([{ id: "a", quality: sample(1, { codec: "VP8" }) }])).toHaveLength(1)
    expect(trackImplChanges([{ id: "a", quality: sample(1, { codec: "VP8" }) }])).toEqual([])
  })
})
