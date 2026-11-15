// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { Bytes, Struct, str } from "scale-ts"
import {
  decodeGesture,
  encodeGesture,
  USE_CASE_GESTURE_ACCEPTANCE,
  type Gesture,
} from "./gesture"

/** The envelope, rebuilt here from scale-ts so a test frame is independent of
 *  the codec under test. */
const Envelope = Struct({ id: str, data: Bytes() })

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const account = Uint8Array.from({ length: 32 }, (_, i) => i + 1)

describe("encodeGesture", () => {
  it("writes the bytes a mobile peer expects", () => {
    const bytes = encodeGesture({ tag: "Unaccept", roundIndex: 3, acceptorAccountId: account })
    expect(bytes).not.toBeNull()
    expect(hex(bytes!)).toBe(
      // "video_game_gesture_acceptance" as a compact-prefixed string (0x74 = 29 << 2),
      "74766964656f5f67616d655f676573747572655f616363657074616e6365" +
        // the payload as a byte vector: 0x94 = 37 << 2
        "94" +
        // Unaccept, round 3 little-endian, the 32-byte account
        "01" +
        "03000000" +
        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    )
  })

  it("refuses an account id that is not 32 bytes", () => {
    expect(
      encodeGesture({ tag: "Accept", roundIndex: 0, acceptorAccountId: new Uint8Array(4) }),
    ).toBeNull()
    expect(
      encodeGesture({ tag: "Accept", roundIndex: 0, acceptorAccountId: new Uint8Array(40) }),
    ).toBeNull()
  })
})

describe("decodeGesture", () => {
  it("round-trips both verdicts", () => {
    for (const tag of ["Accept", "Unaccept"] as const) {
      const sent: Gesture = { tag, roundIndex: 1234, acceptorAccountId: account }
      const decoded = decodeGesture(encodeGesture(sent)!)
      expect(decoded).toEqual(sent)
    }
  })

  it("reads the largest round index the wire holds", () => {
    const sent: Gesture = {
      tag: "Accept",
      roundIndex: 0xffffffff,
      acceptorAccountId: account,
    }
    expect(decodeGesture(encodeGesture(sent)!)).toEqual(sent)
  })

  it("drops a frame cut short in the envelope", () => {
    const frame = encodeGesture({ tag: "Accept", roundIndex: 7, acceptorAccountId: account })!
    expect(decodeGesture(frame.slice(0, 2))).toBeNull()
    expect(decodeGesture(new Uint8Array(0))).toBeNull()
  })

  it("drops a frame cut short in the body", () => {
    const frame = encodeGesture({ tag: "Accept", roundIndex: 7, acceptorAccountId: account })!
    // 68 bytes whole. A cut at 60 leaves a body whose account id is 24 bytes,
    // which scale-ts decodes without complaint.
    expect(frame.length).toBe(68)
    expect(decodeGesture(frame.slice(0, 60))).toBeNull()
    expect(decodeGesture(frame.slice(0, 34))).toBeNull()
  })

  it("drops a frame under another use case", () => {
    const frame = encodeGesture({ tag: "Accept", roundIndex: 2, acceptorAccountId: account })!
    // The id header is 30 bytes and the body's length prefix is one more, so the
    // rest is a body that WOULD decode. Only the id makes this frame foreign.
    const body = frame.slice(31)
    const foreign = new Uint8Array(
      Envelope.enc({ id: "webrtc_media_state_use_case", data: body }),
    )
    expect(decodeGesture(foreign)).toBeNull()
    // Same body under our own id still reads.
    expect(
      decodeGesture(new Uint8Array(Envelope.enc({ id: USE_CASE_GESTURE_ACCEPTANCE, data: body }))),
    ).toEqual({ tag: "Accept", roundIndex: 2, acceptorAccountId: account })
  })

  it("drops an unknown enum tag", () => {
    const body = new Uint8Array(37)
    body[0] = 9 // neither Accept (0) nor Unaccept (1)
    const frame = new Uint8Array(
      Envelope.enc({ id: USE_CASE_GESTURE_ACCEPTANCE, data: body }),
    )
    expect(decodeGesture(frame)).toBeNull()
  })

  it("drops an empty body", () => {
    const frame = new Uint8Array(
      Envelope.enc({ id: USE_CASE_GESTURE_ACCEPTANCE, data: new Uint8Array(0) }),
    )
    expect(decodeGesture(frame)).toBeNull()
  })
})
