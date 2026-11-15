// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { blake2b } from "@noble/hashes/blake2.js"
import {
  buildTurnProof,
  freshnessMessage,
  isTurnPass,
  redeemTurnProof,
  turnPassFor,
  turnPassKey,
  turnPassLeftMs,
  type TurnProofInputs,
} from "./turn-pass"
import type { PersonhoodProver, PersonhoodRing } from "@parity/product-sdk-individuality"

const GENESIS = `0x${"ab".repeat(32)}` as const
const hash = (bytes: Uint8Array) => blake2b(bytes, { dkLen: 32 })
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
const collectionId = (name: "people" | "people-lite") => new Uint8Array(32).fill(name === "people" ? 1 : 2)
const INPUTS: TurnProofInputs = { productId: "dim2.paseo", genesis: GENESIS, timestamp: 1_790_008_853, collectionId, hash }

/** Personhood keys the host holds for the rings `held` names, refusing or failing as `options` says,
 *  in the words the SDK's `hostPersonhoodProver` and the chat's prover use. */
function proverHolding(
  held: (ring: PersonhoodRing) => boolean,
  options: { listing?: "fails"; proof?: "refused" | "not-allowlisted" | "throws" } = {},
) {
  const holds = vi.fn(async (ring: PersonhoodRing) => {
    if (options.listing === "fails") throw new Error(`the host could not list the keys of ${ring.owner}: Unavailable`)
    return held(ring)
  })
  const prove = vi.fn(async (ring: PersonhoodRing) => {
    if (options.proof === "throws") throw new Error("bridge gone")
    if (options.proof === "not-allowlisted") throw new Error(`the host refused the ${ring.key} proof: NotAllowlisted`)
    if (options.proof === "refused") throw new Error(`the host refused the ${ring.key} proof: Denied`)
    return { proof: Uint8Array.of(9, 9), ringIndex: 3, ringRevision: 4 }
  })
  return { prover: { holds, prove } as unknown as PersonhoodProver, prove }
}

const collectionOf = (ring: PersonhoodRing) => ring.ring.junctions.find((junction) => junction.tag === "CollectionId")?.value

describe("the freshness message works", () => {
  it("hashes the label followed by a big-endian timestamp", () => {
    // Given
    const label = new TextEncoder().encode("dub/turn-credential/v1")
    const expected = hash(new Uint8Array([...label, 0x00, 0x00, 0x00, 0x00, 0x6a, 0xb1, 0x5e, 0x15]))

    // When
    const message = freshnessMessage(1_790_008_853, hash)

    // Then
    expect(hex(message)).toBe(hex(expected))
  })
})

describe("turn proof building works", () => {
  it("proves with peopl's lite key in the lite ring, over the freshness message of the stamp", async () => {
    // Given
    const lite = `0x${hex(collectionId("people-lite"))}`
    const { prover, prove } = proverHolding((ring) => collectionOf(ring) === lite)

    // When
    const result = await buildTurnProof(prover, INPUTS)

    // Then
    expect(result).toEqual({
      body: { productId: "dim2.paseo", collection: lite, proof: "0x0909", ringIndex: 3, ringRevision: 4, timestamp: 1_790_008_853 },
      ring: "people-lite",
    })
    expect(prove).toHaveBeenCalledWith(
      { owner: "peopl.paseo", key: "lite", ring: { chainId: GENESIS, junctions: [{ tag: "CollectionId", value: lite }] } },
      { productId: "dim2.paseo", suffix: { tag: "Index", value: 0 } },
      freshnessMessage(1_790_008_853, hash),
    )
  })

  it("falls back to the full key in the people ring", async () => {
    // Given
    const people = `0x${hex(collectionId("people"))}`
    const { prover, prove } = proverHolding((ring) => collectionOf(ring) === people)

    // When
    const result = await buildTurnProof(prover, INPUTS)

    // Then
    expect(result).toMatchObject({ body: { collection: people }, ring: "people" })
    expect(prove.mock.calls[0]![0]).toMatchObject({ key: "full" })
  })

  it("proves in the lite ring first when the host holds a key for both", async () => {
    // Given
    const { prover, prove } = proverHolding(() => true)

    // When
    const result = await buildTurnProof(prover, INPUTS)

    // Then
    expect(result).toMatchObject({ body: { collection: `0x${hex(collectionId("people-lite"))}` }, ring: "people-lite" })
    expect(prove).toHaveBeenCalledOnce()
  })
})

describe("turn proof building fails", () => {
  it.each([
    ["key-list-failed", { listing: "fails" as const }],
    ["proof-refused", { proof: "refused" as const }],
    ["grant-missing", { proof: "not-allowlisted" as const }],
    ["proof-threw", { proof: "throws" as const }],
  ])("names %s", async (code, options) => {
    // Given
    const { prover } = proverHolding(() => true, options)

    // When
    const result = await buildTurnProof(prover, INPUTS)

    // Then
    expect(result).toMatchObject({ code })
  })

  it("names no-ring-key when the host holds no key for either ring", async () => {
    // Given
    const { prover, prove } = proverHolding(() => false)

    // When
    const result = await buildTurnProof(prover, INPUTS)

    // Then
    expect(result).toMatchObject({ code: "no-ring-key" })
    expect(prove).not.toHaveBeenCalled()
  })

  it("keeps the words of the host in the reason of a refusal", async () => {
    // Given
    const { prover } = proverHolding(() => true, { proof: "not-allowlisted" })

    // When
    const result = await buildTurnProof(prover, INPUTS)

    // Then
    expect(result).toMatchObject({ reason: expect.stringContaining("NotAllowlisted") })
  })
})

describe("the turn pass works", () => {
  const NOW = 1_700_000_000_000
  const credentials = { servers: ["turn:relay.example:3478"], username: "u", password: "p", ttl: 1800 }

  it("lives for the time to live less the five seconds it is let go early", () => {
    // Given
    const issuedAt = NOW

    // When
    const pass = turnPassFor(credentials, issuedAt)

    // Then
    expect(pass).toEqual({ turn: [{ urls: "turn:relay.example:3478", username: "u", credential: "p" }], expiresAtWallMs: NOW + 1_795_000 })
    expect(turnPassLeftMs(pass, NOW + 60_000)).toBe(1_735_000)
    expect(isTurnPass(pass)).toBe(true)
  })

  it("keeps one key per player and issuer, the key the app has always read", () => {
    // Given
    const player = Uint8Array.of(0, 171, 255)
    const issuers = ["https://a.example", "https://b.example"]

    // When
    const key = turnPassKey("dim2.testnet", player, issuers)

    // Then
    expect(key).toBe("jollity.turn.v1:dim2.testnet:00abff:https://a.example,https://b.example")
  })
})

describe("the turn pass fails", () => {
  it.each([
    ["nothing", null],
    ["a pass with no relays", { expiresAtWallMs: 1 }],
    ["a pass with a relay that has no address", { turn: [{ username: "u" }], expiresAtWallMs: 1 }],
    ["a pass with a relay that is not an object", { turn: [null], expiresAtWallMs: 1 }],
    ["a pass with no expiry", { turn: [] }],
    ["a pass with an expiry that is not finite", { turn: [], expiresAtWallMs: Infinity }],
  ])("is not read from %s", (_what, value) => {
    // Given
    const stored: unknown = value

    // When
    const read = isTurnPass(stored)

    // Then
    expect(read).toBe(false)
  })
})

describe("turn proof redemption works", () => {
  const BODY = { productId: "dim2.paseo", collection: "0x01", proof: "0x02", ringIndex: 0, ringRevision: 0, timestamp: 1 }

  it("posts the body to the issuer and reads the pass from its answer", async () => {
    // Given
    const fetch = vi.fn(async () => ({
      status: 201,
      json: async () => ({ servers: ["turn:relay.example:3478"], username: "u", password: "p", ttl: 1800 }),
      text: async () => "",
    }))

    // When
    const result = await redeemTurnProof(fetch, "https://issuer.example", BODY)

    // Then
    expect(result).toEqual({ credentials: { servers: ["turn:relay.example:3478"], username: "u", password: "p", ttl: 1800 } })
    expect(fetch).toHaveBeenCalledWith("https://issuer.example/api/v1/turn/issue-with-proof", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BODY),
    })
  })
})

describe("turn proof redemption fails", () => {
  const BODY = { productId: "dim2.paseo", collection: "0x01", proof: "0x02", ringIndex: 0, ringRevision: 0, timestamp: 1 }
  const answer = (status: number, body: unknown) => async () => ({
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    [400, { error: "timestamp outside the accepted window" }, "timestamp-window"],
    [400, { error: "ring revision unknown" }, "bad-request"],
    [403, { error: "proof did not verify" }, "proof-rejected"],
    [404, "", "no-route"],
    [429, { error: "redemption limit reached" }, "redemption-limit"],
    [503, { error: "no ring roots yet" }, "no-ring-roots"],
    [502, "bad gateway", "server-error"],
  ])("names a %i by its cause", async (status, body, cause) => {
    // When
    const result = await redeemTurnProof(answer(status, body), "https://issuer.example", BODY)

    // Then
    expect(result).toMatchObject({ cause, status })
  })

  it("keeps the reason the issuer gave", async () => {
    // When
    const result = await redeemTurnProof(answer(403, { error: "proof did not verify" }), "https://issuer.example", BODY)

    // Then
    expect(result).toMatchObject({ reason: "proof did not verify" })
  })

  it("names an answer that is not a pass as a server error", async () => {
    // When
    const result = await redeemTurnProof(answer(201, { servers: "nope" }), "https://issuer.example", BODY)

    // Then
    expect(result).toMatchObject({ cause: "server-error" })
  })

  it("names a fetch that throws as a server error", async () => {
    // Given
    const fetch = async () => {
      throw new Error("network down")
    }

    // When
    const result = await redeemTurnProof(fetch, "https://issuer.example", BODY)

    // Then
    expect(result).toMatchObject({ cause: "server-error", reason: expect.stringContaining("network down") })
  })

  it("names an issuer that never answers as a timeout", async () => {
    // Given
    vi.useFakeTimers()
    const fetch = () => new Promise<never>(() => {})

    // When
    const result = redeemTurnProof(fetch, "https://issuer.example", BODY, 5_000)
    await vi.advanceTimersByTimeAsync(5_000)

    // Then
    await expect(result).resolves.toMatchObject({ cause: "timeout" })
  })
})
