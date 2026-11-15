// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { getPublicKey, secretFromSeed, sign, verify } from "@scure/sr25519"
import {
  MAX_STATEMENT_BYTES,
  PROTOCOL_EPOCH_SECONDS,
  buildSignedStatement,
  keypairStatementProver,
  decodeStatement,
  decodeStatementData,
  encodeRequestData,
  encodeResponseData,
  encodeSignaturePayload,
  encodeStatement,
  nextExpiry,
  statementHash,
  statementSizeForData,
  timestampExpiry,
  type SigningKeypair,
} from "./statement"

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

function testKeypair(seedByte: number): SigningKeypair {
  const secret = secretFromSeed(new Uint8Array(32).fill(seedByte))
  return {
    publicKey: getPublicKey(secret),
    sign: (message) => sign(secret, message),
  }
}

const keypair = testKeypair(7)
const prover = keypairStatementProver(keypair)
const fields = {
  expiry: (0xffff_ffffn << 32n) | 12345n,
  channel: new Uint8Array(32).fill(3),
  topic1: new Uint8Array(32).fill(4),
  data: new Uint8Array([9, 8, 7, 6, 5]),
}

describe("expiry scheme", () => {
  it("sets high 32 bits to 0xFFFFFFFF and seeds low half from the epoch", () => {
    const expiry = timestampExpiry(PROTOCOL_EPOCH_SECONDS + 100)
    expect(expiry >> 32n).toBe(0xffff_ffffn)
    expect(expiry & 0xffff_ffffn).toBe(100n)
  })

  it("clamps pre-epoch clocks to sequence 0", () => {
    expect(timestampExpiry(PROTOCOL_EPOCH_SECONDS - 5) & 0xffff_ffffn).toBe(0n)
  })

  it("is strictly monotonic across sends", () => {
    const now = PROTOCOL_EPOCH_SECONDS + 50
    let expiry = nextExpiry(undefined, now)
    for (let i = 0; i < 5; i++) {
      const bumped = nextExpiry(expiry, now)
      expect(bumped).toBeGreaterThan(expiry)
      expiry = bumped
    }
  })

  it("stays monotonic when the clock jumps backwards", () => {
    const initial = nextExpiry(undefined, PROTOCOL_EPOCH_SECONDS + 1000)
    const bumped = nextExpiry(initial, PROTOCOL_EPOCH_SECONDS + 10)
    expect(bumped).toBe(initial + 1n)
  })

  it("re-floors from the clock when it outruns the sequence", () => {
    const initial = nextExpiry(undefined, PROTOCOL_EPOCH_SECONDS + 10)
    const later = nextExpiry(initial, PROTOCOL_EPOCH_SECONDS + 5000)
    expect(later).toBe(timestampExpiry(PROTOCOL_EPOCH_SECONDS + 5000))
  })
})

describe("statement encode/decode", () => {
  it("roundtrips a signed statement", async () => {
    const { statement, hash } = await buildSignedStatement(prover, fields)
    const decoded = decodeStatement(statement)
    expect(decoded.expiry).toBe(fields.expiry)
    expect(decoded.channel).toEqual(fields.channel)
    expect(decoded.topic1).toEqual(fields.topic1)
    expect(decoded.data).toEqual(fields.data)
    expect(decoded.proof.signer).toEqual(keypair.publicKey)
    expect(decoded.hash).toEqual(hash)
    expect(decoded.encoded).toEqual(statement)
  })

  it("emits the native apps' exact field layout", async () => {
    const { statement } = await buildSignedStatement(prover, fields)
    expect(statement[0]).toBe(0x14) // compact(5)
    expect(statement[1]).toBe(0x00) // field tag: proof
    expect(statement[2]).toBe(0x00) // proof variant: Sr25519
    // 64-byte signature ‖ 32-byte signer, then expiry field
    expect(statement[3 + 96]).toBe(0x02)
    expect(statement[3 + 96 + 9]).toBe(0x03) // channel after 8-byte expiry
    expect(statement[3 + 96 + 9 + 33]).toBe(0x04) // topic1
    expect(statement[3 + 96 + 9 + 33 + 33]).toBe(0x08) // data
    expect(statement[3 + 96 + 9 + 33 + 33 + 1]).toBe(5 << 2) // compact(5) data len
    expect(statement.length).toBe(statementSizeForData(fields.data.length))
  })

  it("signature payload = fields sans proof, no compact prefix", async () => {
    const payload = encodeSignaturePayload(fields)
    expect(payload[0]).toBe(0x02)
    // the full statement embeds the payload verbatim after the proof
    const { statement } = await buildSignedStatement(prover, fields)
    expect(hex(statement.slice(1 + 2 + 96))).toBe(hex(payload))
  })

  it("produces an sr25519 proof that verifies over the signature payload", async () => {
    const { statement } = await buildSignedStatement(prover, fields)
    const decoded = decodeStatement(statement)
    const payload = encodeSignaturePayload(fields)
    expect(verify(payload, decoded.proof.signature, decoded.proof.signer)).toBe(
      true,
    )
    // and not over anything else
    payload[0] = 0x03
    expect(verify(payload, decoded.proof.signature, decoded.proof.signer)).toBe(
      false,
    )
  })

  it("statement hash covers the full encoding including the proof", async () => {
    const { statement } = await buildSignedStatement(prover, fields)
    const twin = statement.slice()
    twin[5] = twin[5]! ^ 0xff // mutate a signature byte
    expect(hex(statementHash(twin))).not.toBe(hex(statementHash(statement)))
  })

  it("rejects out-of-order fields, unknown tags and trailing bytes", async () => {
    const { statement } = await buildSignedStatement(prover, fields)
    expect(() =>
      decodeStatement(new Uint8Array([...statement, 0x00])),
    ).toThrow(/trailing/)
    // swap expiry tag (2) to 9 → unknown
    const unknownTag = statement.slice()
    unknownTag[3 + 96] = 0x09
    expect(() => decodeStatement(unknownTag)).toThrow(/unknown|order/)
    expect(() => decodeStatement(statement.slice(0, 40))).toThrow(/truncated/)
  })

  it("rejects non-sr25519 proof variants", async () => {
    const { statement } = await buildSignedStatement(prover, fields)
    const ed = statement.slice()
    ed[2] = 0x01 // Proof::Ed25519
    expect(() => decodeStatement(ed)).toThrow(/proof variant/)
  })

  it("enforces 32-byte channel/topic on encode", () => {
    expect(() =>
      encodeStatement(
        { signature: new Uint8Array(64), signer: new Uint8Array(32) },
        { ...fields, channel: new Uint8Array(31) },
      ),
    ).toThrow(/channel/)
  })
})

describe("StatementData framing", () => {
  it("roundtrips a Request", () => {
    const messages = [new Uint8Array([1, 2, 3]), new Uint8Array([4])]
    const id = "b10e9de7-9b2a-4d31-8f00-000000000001"
    const decoded = decodeStatementData(encodeRequestData(id, messages))
    expect(decoded.tag).toBe("Request")
    if (decoded.tag !== "Request") throw new Error("unreachable")
    expect(decoded.value.requestId).toBe(id)
    expect(decoded.value.messages.map(hex)).toEqual(messages.map(hex))
  })

  it("roundtrips a Response", () => {
    const decoded = decodeStatementData(
      encodeResponseData("some-request-id", 0),
    )
    expect(decoded).toEqual({
      tag: "Response",
      value: { requestId: "some-request-id", responseCode: 0 },
    })
  })

  it("rejects the multi-device variants (2/3) as undecodable", () => {
    expect(() => decodeStatementData(new Uint8Array([0x02, 0x00]))).toThrow()
    expect(() => decodeStatementData(new Uint8Array([0x03, 0x00]))).toThrow()
  })

  it("matches a worked example of the native byte layout", () => {
    // envelope prefix: gameIndex 7 (u32 LE) ‖ compact(36) ‖ offerId
    const offerId = "0f2e0000-0000-0000-0000-000000000000"
    const requestId = "b10e9de7-9b2a-4d31-8f00-0000000000ab"
    const envelope = new Uint8Array([
      7, 0, 0, 0,
      0x90, // compact(36)
      ...new TextEncoder().encode(offerId),
      0x01, // SignalingMessage::Offer
      0x0c, // compact(3)
      0xde, 0xad, 0x01, // SdpCoder setup bytes
    ])
    const plaintext = encodeRequestData(requestId, [envelope])
    expect(plaintext[0]).toBe(0x00) // StatementData::Request
    expect(plaintext[1]).toBe(0x90) // compact(36) request id
    const afterId = 2 + 36
    expect(plaintext[afterId]).toBe(0x04) // Vec len 1
    expect(plaintext[afterId + 1]).toBe(envelope.length << 2) // messages[0] len
    expect(hex(plaintext.slice(afterId + 2))).toBe(hex(envelope))
  })
})

describe("size accounting", () => {
  it("statementSizeForData matches real encodings across compact widths", async () => {
    for (const dataLength of [0, 5, 63, 64, 200, 800]) {
      const { statement } = await buildSignedStatement(prover, {
        ...fields,
        data: new Uint8Array(dataLength),
      })
      expect(statement.length).toBe(statementSizeForData(dataLength))
    }
  })

  it("keeps the 1 KiB cap meaningful", () => {
    expect(MAX_STATEMENT_BYTES).toBe(1024)
    expect(statementSizeForData(0)).toBeLessThan(200)
  })
})
