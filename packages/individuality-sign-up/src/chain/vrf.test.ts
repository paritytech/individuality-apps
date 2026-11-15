// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { getPublicKey, secretFromSeed, vrf } from "@scure/sr25519"
import { verifyVrf } from "./vrf"

const bytes = (text: string) => new TextEncoder().encode(text)

/** The transcript `vrf.sign` of `@scure/sr25519` builds for a message under an empty context. */
const scureTranscript = (message: Uint8Array) => ({
  label: bytes("SigningContext"),
  items: [
    { label: bytes(""), value: new Uint8Array() },
    { label: bytes("sign-bytes"), value: message },
  ],
})

describe("verifyVrf", () => {
  const secret = secretFromSeed(new Uint8Array(32).fill(3))
  const message = bytes("draw 0")
  const signature = vrf.sign(message, secret, new Uint8Array(), new Uint8Array())
  const split = { preOutput: signature.subarray(0, 32), proof: signature.subarray(32) }

  it("accepts a VRF signed by the upstream schnorrkel port", () => {
    expect(verifyVrf(getPublicKey(secret), scureTranscript(message), split)).toBe(true)
  })

  it("rejects it under another key", () => {
    const other = getPublicKey(secretFromSeed(new Uint8Array(32).fill(4)))
    expect(verifyVrf(other, scureTranscript(message), split)).toBe(false)
  })

  it("rejects the right bytes split in the wrong place", () => {
    const whole = { preOutput: signature, proof: new Uint8Array() }
    expect(verifyVrf(getPublicKey(secret), scureTranscript(message), whole)).toBe(false)
  })

  it("rejects it over another transcript", () => {
    expect(verifyVrf(getPublicKey(secret), scureTranscript(bytes("draw 1")), split)).toBe(false)
  })
})
