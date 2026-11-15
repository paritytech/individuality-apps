// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The proof body, checked where it has to agree with someone else.
 *
 * The issuer re-derives the message rather than reading it, so a change to the
 * encoding here breaks credential issuance with no local symptom at all. That
 * makes the vector below the only cheap guard we have.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { blake2b } from "@noble/hashes/blake2.js"
import { freshnessMessage } from "./turn-proof"

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

describe("freshnessMessage", () => {
  it("hashes the label followed by a big-endian timestamp", () => {
    // Built by hand from the rule the issuer states in
    // crates/turn/src/proof/message.rs, which is
    // blake2b256("dub/turn-credential/v1" ++ timestamp.to_be_bytes()).
    const timestamp = 1_790_008_853
    const label = new TextEncoder().encode("dub/turn-credential/v1")
    const expected = blake2b(
      new Uint8Array([...label, 0x00, 0x00, 0x00, 0x00, 0x6a, 0xb1, 0x5e, 0x15]),
      { dkLen: 32 },
    )
    expect(hex(freshnessMessage(timestamp))).toBe(hex(expected))
  })

  it("is big-endian, so a byte-swapped timestamp gives a different message", () => {
    expect(hex(freshnessMessage(1))).not.toBe(hex(freshnessMessage(1 << 24)))
  })

  it("changes with every second, since the proof is deterministic otherwise", () => {
    expect(hex(freshnessMessage(1_790_008_853))).not.toBe(hex(freshnessMessage(1_790_008_854)))
  })

  it("covers a timestamp past 2^32, which a 32-bit write would truncate", () => {
    const far = 2 ** 32 + 5
    expect(hex(freshnessMessage(far))).not.toBe(hex(freshnessMessage(5)))
  })
})

describe("turn proof failure naming works", () => {
  const GENESIS = `0x${"ab".repeat(32)}`

  async function prove(host: {
    inside?: boolean
    expectedGenesis?: string
    genesis?: string | null
    accounts?: boolean
    keys?: "none" | "fails"
    proof?: "ok" | "refused" | "not-allowlisted" | "throws"
  }) {
    vi.resetModules()
    const accounts = {}
    vi.doMock("@parity/product-sdk-host", () => ({
      isInsideContainerSync: () => host.inside ?? true,
      getHostChainInfo: async () => {
        if (host.expectedGenesis) throw new Error("local must not discover a chain")
        return { chains: host.genesis === null ? {} : { People: host.genesis ?? GENESIS } }
      },
      getAccountsProvider: async () => (host.accounts === false ? null : accounts),
    }))
    vi.doMock("@parity/product-sdk-individuality", () => ({ ringCollectionId: () => new Uint8Array(32) }))
    // the SDK's prover over these accounts, in the words it gives a failure
    vi.doMock("@parity/product-sdk-individuality/host", () => ({
      hostPersonhoodProver: (given: unknown) => ({
        holds: async (ring: { ring: { chainId: string } }) => {
          if (host.expectedGenesis) expect(ring.ring.chainId).toBe(host.expectedGenesis)
          expect(given).toBe(accounts)
          if (host.keys === "fails") throw new Error("the host could not list the keys of peopl.paseo: NotAllowlisted")
          return host.keys !== "none"
        },
        prove: async () => {
          if (host.proof === "throws") throw new Error("bridge gone")
          if (host.proof === "not-allowlisted") throw new Error("the host refused the lite proof: NotAllowlisted")
          if (host.proof === "refused") throw new Error("the host refused the lite proof: Denied")
          return { proof: new Uint8Array(4), ringIndex: 1, ringRevision: 2 }
        },
      }),
    }))
    const { turnProofBody } = await import("./turn-proof")
    return turnProofBody("dim2.paseo", 1)
  }

  afterEach(() => {
    vi.doUnmock("@parity/product-sdk-host")
    vi.doUnmock("@parity/product-sdk-individuality")
    vi.doUnmock("@parity/product-sdk-individuality/host")
  })

  it("uses the local People ring without consulting hosted discovery", async () => {
    const { localEnv } = await import("../../../../packages/jollity-protocol/src/local-network.fixture")
    for (const [name, value] of Object.entries(localEnv)) vi.stubEnv(name, value)
    try {
      const { localNetwork } = await import("@jollity/protocol")
      const readLocal = localNetwork()!
      const result = await prove({ genesis: null, expectedGenesis: localEnv.NEXT_PUBLIC_PEOPLE_GENESIS })
      expect(result).toHaveProperty("body")
      expect(readLocal.genesis.people).toBe(localEnv.NEXT_PUBLIC_PEOPLE_GENESIS)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    ["no-host", { inside: false }],
    ["no-chain-info", { genesis: null }],
    ["no-accounts", { accounts: false }],
    ["key-list-failed", { keys: "fails" as const }],
    ["no-ring-key", { keys: "none" as const }],
    ["proof-refused", { proof: "refused" as const }],
    ["proof-threw", { proof: "throws" as const }],
    ["grant-missing", { proof: "not-allowlisted" as const }],
  ])("names %s", async (code, host) => {
    // When
    const result = await prove(host)

    // Then
    expect(result).toMatchObject({ code })
  })

  it("carries no code on a proof", async () => {
    // When
    const result = await prove({})

    // Then
    expect(result).toMatchObject({ body: { productId: "dim2.paseo", ringIndex: 1, ringRevision: 2, timestamp: 1 } })
  })
})
