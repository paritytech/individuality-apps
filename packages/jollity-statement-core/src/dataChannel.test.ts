// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  DataChannelMessage,
  MediaStateSignal,
  PeerConnectionSignal,
  USE_CASE_GESTURE_ACCEPTANCE,
  USE_CASE_MEDIA_STATE,
  USE_CASE_RENEGOTIATION,
  decodeChannelMessage,
  decodePeerConnectionSignal,
  encodeChannelMessage,
  encodePeerConnectionSignal,
} from "./dataChannel"

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

describe("DataChannelMessage", () => {
  it("roundtrips a multiplexed renegotiation frame", () => {
    const inner = encodePeerConnectionSignal({ tag: "Offer", value: "v=0..." })
    const decoded = decodeChannelMessage(
      encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: inner }),
    )
    expect(decoded.id).toBe("webrtc_renegotiation_internal_use_case")
    const signal = decodePeerConnectionSignal(decoded.data)
    expect(signal.tag).toBe("Offer")
    expect(signal.value).toBe("v=0...")
  })

  it("pins the lane ids verbatim", () => {
    expect(USE_CASE_RENEGOTIATION).toBe("webrtc_renegotiation_internal_use_case")
    expect(USE_CASE_MEDIA_STATE).toBe("webrtc_media_state_use_case")
    expect(USE_CASE_GESTURE_ACCEPTANCE).toBe("video_game_gesture_acceptance")
  })

  it("frames a lane id and an opaque blob and nothing else", () => {
    const bytes = DataChannelMessage.enc({
      id: "ab",
      data: new Uint8Array([9, 9]),
    })
    expect(bytesToHex(bytes)).toBe("086162" + "080909")
  })
})

describe("PeerConnectionSignal", () => {
  it("tags Offer=0, Answer=1, IceCandidates=2", () => {
    expect(PeerConnectionSignal.enc({ tag: "Offer", value: "" })[0]).toBe(0)
    expect(PeerConnectionSignal.enc({ tag: "Answer", value: "" })[0]).toBe(1)
    expect(
      PeerConnectionSignal.enc({ tag: "IceCandidates", value: [] })[0],
    ).toBe(2)
  })

  it("roundtrips trickled candidates with their own m-line addressing", () => {
    const signal = decodePeerConnectionSignal(
      encodePeerConnectionSignal({
        tag: "IceCandidates",
        value: [
          {
            sdp: "candidate:1 1 udp 100 10.0.0.1 4000 typ host",
            sdpMLineIndex: 1,
            sdpMid: "1",
          },
          {
            sdp: "candidate:2 1 udp 100 10.0.0.2 4001 typ host",
            sdpMLineIndex: 0,
            sdpMid: undefined,
          },
        ],
      }),
    )
    expect(signal.tag).toBe("IceCandidates")
    expect(signal.value).toEqual([
      {
        sdp: "candidate:1 1 udp 100 10.0.0.1 4000 typ host",
        sdpMLineIndex: 1,
        sdpMid: "1",
      },
      {
        sdp: "candidate:2 1 udp 100 10.0.0.2 4001 typ host",
        sdpMLineIndex: 0,
        sdpMid: undefined,
      },
    ])
  })
})

describe("MediaStateSignal", () => {
  it("tags CameraEnabled=0, MicrophoneEnabled=1 with a bool payload", () => {
    expect([...MediaStateSignal.enc({ tag: "CameraEnabled", value: true })]).toEqual([
      0, 1,
    ])
    expect([
      ...MediaStateSignal.enc({ tag: "MicrophoneEnabled", value: false }),
    ]).toEqual([1, 0])
  })
})
