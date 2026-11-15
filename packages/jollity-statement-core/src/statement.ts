// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * SCALE codec for sp-statement-store statements as produced by the mobile
 * apps, plus the expiry scheme and the StatementData request/response
 * framing.
 *
 * Wire-format parity targets (the native Polkadot apps' implementation):
 * - Statement = Vec<Field>: compact(count) then fields in strictly
 *   ascending tag order — proof(0), expiry(2), channel(3), topic1(4),
 *   data(8). Mobile always emits exactly these five.
 * - Proof::Sr25519 = 0x00 ‖ signature[64] ‖ signer[32]
 * - Signature payload = the same field sequence without the compact
 *   prefix and without the proof field.
 * - Expiry u64: high 32 bits = 0xFFFF_FFFF (never expires), low 32 bits =
 *   monotonic sequence seeded from (unixNow − PROTOCOL_EPOCH).
 * - StatementData enum: 0 Request { request_id, messages }, 1 Response
 *   { request_id, response_code }. Variants 2/3 (multi-device) are not
 *   part of the game protocol and decode as an error.
 */
import { blake2b } from "@noble/hashes/blake2.js"
import { Bytes, Enum, Struct, Vector, str, u8, type CodecType } from "scale-ts"

// --- constants ------------------------------------------------------------

/** 2025-11-15T00:00:00Z — both platforms */
export const PROTOCOL_EPOCH_SECONDS = 1_763_164_800
/** Client-side statement size cap (Android's 1 KiB; the intended cap) */
export const MAX_STATEMENT_BYTES = 1024

const TAG_PROOF = 0
const TAG_DECRYPTION_KEY = 1
const TAG_EXPIRY = 2
const TAG_CHANNEL = 3
const TAG_TOPIC1 = 4
const TAG_TOPIC4 = 7
const TAG_DATA = 8

const PROOF_VARIANT_SR25519 = 0

// --- expiry scheme ----------------------------------------------------------

const EXPIRY_HIGH = 0xffff_ffffn << 32n

/** 0xFFFFFFFF_00000000 | max(0, unixNowSeconds − PROTOCOL_EPOCH) */
export function timestampExpiry(unixNowSeconds: number): bigint {
  const seq = Math.max(0, Math.floor(unixNowSeconds) - PROTOCOL_EPOCH_SECONDS)
  return EXPIRY_HIGH | BigInt(seq)
}

/**
 * Next monotonic expiry: max(previous + 1, timestampExpiry(now)).
 * With `previous` undefined this is the session-initial expiry.
 */
export function nextExpiry(
  previous: bigint | undefined,
  unixNowSeconds: number,
): bigint {
  const fromClock = timestampExpiry(unixNowSeconds)
  if (previous === undefined) return fromClock
  return previous + 1n > fromClock ? previous + 1n : fromClock
}

// --- small SCALE helpers ----------------------------------------------------

function compactEncode(value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) throw new Error(`bad compact ${value}`)
  if (value < 1 << 6) return Uint8Array.of(value << 2)
  if (value < 1 << 14) {
    const v = (value << 2) | 0b01
    return Uint8Array.of(v & 0xff, v >>> 8)
  }
  if (value < 1 << 30) {
    const v = (value * 4 + 0b10) >>> 0
    return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
  }
  throw new Error(`compact value too large: ${value}`)
}

class Cursor {
  offset = 0
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  u8(): number {
    const b = this.bytes[this.offset]
    if (b === undefined) throw new Error("statement truncated")
    this.offset += 1
    return b
  }

  take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) throw new Error("statement truncated")
    const out = this.bytes.slice(this.offset, this.offset + n)
    this.offset += n
    return out
  }

  compact(): number {
    const first = this.u8()
    const mode = first & 0b11
    if (mode === 0b00) return first >>> 2
    if (mode === 0b01) return (first | (this.u8() << 8)) >>> 2
    if (mode === 0b10) {
      const rest = this.take(3)
      const value =
        first + rest[0]! * 0x100 + rest[1]! * 0x10000 + rest[2]! * 0x1000000
      return Math.floor(value / 4)
    }
    throw new Error("compact big-integer mode not supported in statements")
  }

  u64le(): bigint {
    const bytes = this.take(8)
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true)
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function u64leEncode(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

// --- statement encode/sign/decode -------------------------------------------

export interface StatementProof {
  signature: Uint8Array // 64 bytes, sr25519
  signer: Uint8Array // 32 bytes, sr25519 public key = AccountId
}

export interface StatementFields {
  expiry: bigint
  channel: Uint8Array // 32 bytes
  topic1: Uint8Array // 32 bytes
  data: Uint8Array // encrypted payload
}

export interface SigningKeypair {
  publicKey: Uint8Array
  sign: (message: Uint8Array) => Uint8Array
}

/**
 * Produces the Sr25519 proof for a statement's fields. The seam sits at the
 * field level (not "sign these bytes") because hosted builds delegate to the
 * host's `statementStore.createProof`, which takes the fields and builds the
 * `for_signing` encoding itself — the raw payload never leaves this module in
 * that mode.
 */
export interface StatementProver {
  /** signer AccountId (32-byte sr25519 public key) the proofs commit to */
  publicKey: Uint8Array
  prove: (fields: StatementFields) => Promise<StatementProof>
}

/** In-page prover: sign the `for_signing` payload with a local keypair. */
export function keypairStatementProver(keypair: SigningKeypair): StatementProver {
  return {
    publicKey: keypair.publicKey,
    prove: (fields) =>
      Promise.resolve({
        signature: keypair.sign(encodeSignaturePayload(fields)),
        signer: keypair.publicKey,
      }),
  }
}

export interface DecodedStatement extends StatementFields {
  proof: StatementProof
  /** blake2b-256 of the full encoding — the store's dedup identity */
  hash: Uint8Array
  encoded: Uint8Array
}

function checkFields({ channel, topic1, expiry }: StatementFields): void {
  if (channel.length !== 32) throw new Error("channel must be 32 bytes")
  if (topic1.length !== 32) throw new Error("topic1 must be 32 bytes")
  if (expiry < 0n || expiry > 0xffff_ffff_ffff_ffffn)
    throw new Error("expiry out of u64 range")
}

/**
 * Signature material: field sequence sans proof, no compact field-count
 * prefix (sp-statement-store `encoded(for_signing = true)`).
 */
export function encodeSignaturePayload(fields: StatementFields): Uint8Array {
  checkFields(fields)
  return concat([
    Uint8Array.of(TAG_EXPIRY),
    u64leEncode(fields.expiry),
    Uint8Array.of(TAG_CHANNEL),
    fields.channel,
    Uint8Array.of(TAG_TOPIC1),
    fields.topic1,
    Uint8Array.of(TAG_DATA),
    compactEncode(fields.data.length),
    fields.data,
  ])
}

/** Full SCALE statement: compact(5) ‖ proof field ‖ signature payload */
export function encodeStatement(
  proof: StatementProof,
  fields: StatementFields,
): Uint8Array {
  if (proof.signature.length !== 64) throw new Error("signature must be 64 bytes")
  if (proof.signer.length !== 32) throw new Error("signer must be 32 bytes")
  return concat([
    compactEncode(5),
    Uint8Array.of(TAG_PROOF, PROOF_VARIANT_SR25519),
    proof.signature,
    proof.signer,
    encodeSignaturePayload(fields),
  ])
}

/** blake2b-256 of the full encoded statement */
export function statementHash(encoded: Uint8Array): Uint8Array {
  return blake2b(encoded, { dkLen: 32 })
}

/**
 * Exact encoded size of a statement whose Data field holds `dataLength`
 * bytes: compact(5) + proof field + expiry + channel + topic1 + data.
 */
export function statementSizeForData(dataLength: number): number {
  // 1 + (1+1+64+32) + (1+8) + (1+32) + (1+32) + (1 + compact + data)
  return 175 + compactEncode(dataLength).length + dataLength
}

/** Prove the fields (locally or via the host) and assemble the statement */
export async function buildSignedStatement(
  prover: StatementProver,
  fields: StatementFields,
): Promise<{ statement: Uint8Array; hash: Uint8Array }> {
  const proof = await prover.prove(fields)
  const statement = encodeStatement(proof, fields)
  return { statement, hash: statementHash(statement) }
}

/**
 * Decode a full statement. Requires the five mobile fields (proof, expiry,
 * channel, topic1, data) to be present; tolerates the never-set tags 1 and
 * 5–7 by skipping them. Enforces strictly ascending tags and exact
 * consumption, mirroring the node's decoder.
 */
export function decodeStatement(encoded: Uint8Array): DecodedStatement {
  const cursor = new Cursor(encoded)
  const count = cursor.compact()
  let proof: StatementProof | undefined
  let expiry: bigint | undefined
  let channel: Uint8Array | undefined
  let topic1: Uint8Array | undefined
  let data: Uint8Array | undefined
  let previousTag = -1
  for (let i = 0; i < count; i++) {
    const tag = cursor.u8()
    if (tag <= previousTag)
      throw new Error(`statement fields out of order (tag ${tag} after ${previousTag})`)
    previousTag = tag
    if (tag === TAG_PROOF) {
      const variant = cursor.u8()
      if (variant !== PROOF_VARIANT_SR25519)
        throw new Error(`unsupported proof variant ${variant}`)
      proof = { signature: cursor.take(64), signer: cursor.take(32) }
    } else if (tag === TAG_DECRYPTION_KEY) {
      cursor.take(32)
    } else if (tag === TAG_EXPIRY) {
      expiry = cursor.u64le()
    } else if (tag === TAG_CHANNEL) {
      channel = cursor.take(32)
    } else if (tag >= TAG_TOPIC1 && tag <= TAG_TOPIC4) {
      const topic = cursor.take(32)
      if (tag === TAG_TOPIC1) topic1 = topic
    } else if (tag === TAG_DATA) {
      data = cursor.take(cursor.compact())
    } else {
      throw new Error(`unknown statement field tag ${tag}`)
    }
  }
  if (cursor.offset !== encoded.length)
    throw new Error("trailing bytes after statement")
  if (!proof || expiry === undefined || !channel || !topic1 || !data)
    throw new Error("statement is missing required fields")
  return {
    proof,
    expiry,
    channel,
    topic1,
    data,
    hash: statementHash(encoded),
    encoded: encoded.slice(),
  }
}

// --- StatementData framing ---------------------------------------------------

/**
 * Decrypted statement payload. request_id is an opaque UUID string echoed
 * back in the Response; response_code 0 = success. Multi-device variants
 * (tags 2/3) are not used by the video game and fail to decode.
 */
export const StatementData = Enum({
  Request: Struct({
    requestId: str,
    messages: Vector(Bytes()),
  }),
  Response: Struct({
    requestId: str,
    responseCode: u8,
  }),
})

export type StatementDataValue = CodecType<typeof StatementData>

export function encodeRequestData(
  requestId: string,
  messages: Uint8Array[],
): Uint8Array {
  return StatementData.enc({ tag: "Request", value: { requestId, messages } })
}

export function encodeResponseData(
  requestId: string,
  responseCode = 0,
): Uint8Array {
  return StatementData.enc({ tag: "Response", value: { requestId, responseCode } })
}

export function decodeStatementData(plaintext: Uint8Array): StatementDataValue {
  return StatementData.dec(plaintext)
}
