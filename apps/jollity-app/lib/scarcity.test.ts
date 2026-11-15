// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Claim } from "@parity/product-sdk-nfts"

const sdk = vi.hoisted(() => ({
  getApprovedCollections: vi.fn(),
  getClaims: vi.fn(),
  getClaimableCollections: vi.fn(),
  getCollectionItems: vi.fn(),
  previewClaim: vi.fn(),
}))
vi.mock("@parity/product-sdk-nfts", () => sdk)
vi.mock("./collectable-art", () => ({
  loadManifestArt: async (cid: string) => `art:${cid}`,
}))
vi.mock("./debug/log-store", () => ({ devLog: () => {} }))
vi.mock("@jollity/protocol", async (original) => ({
  ...(await original<typeof import("@jollity/protocol")>()),
  chainGenesis: () => "0x4349b00e54897e21196fd331015fc5be0f14e118beb0375ed2bb1793737bb57a",
}))

import { localEnv } from "../../../packages/jollity-protocol/src/local-network.fixture"

import { indexFor } from "@jollity/collectables"
import { ChestReadError, readChest, readChestPinned } from "./scarcity"
import type { ScarcityChain } from "./engine"

const chain = { raw: { assetHub: {} } } as unknown as ScarcityChain
const at = { blockHash: "0xab", blockNumber: 7 }

function credit(overrides: Partial<Claim>): Claim {
  return {
    hash: "0x01",
    awardBlock: 10,
    awardedAt: 1,
    gameIndex: 92,
    leafIndex: 0,
    proof: ["0xaa"],
    state: "claimable",
    ...overrides,
  }
}

const collections = [
  { id: 17, name: "Coffee and Tea", itemCount: 2, owner: null, selection: { tag: "Random" } },
  { id: 18, name: "Jobs", itemCount: 1, owner: null, selection: { tag: "Random" } },
  { id: 90, name: "Not approved", itemCount: 1, owner: null, selection: { tag: "Random" } },
]

function items(id: number) {
  const table: Record<number, unknown[]> = {
    17: [
      {
        index: 0,
        rarity: "100",
        attributes: { archetype: "coffee", manifest: "m-coffee", rarities: "100=Common,200=Rare" },
      },
      {
        index: 1,
        rarity: "200",
        attributes: { archetype: "tea", manifest: "m-tea", rarities: "100=Common,200=Rare" },
      },
    ],
    18: [{ index: 0, rarity: "common", attributes: { archetype: "engineer", manifest: "m-engineer" } }],
    26: [{ index: 0, rarity: "200", attributes: { archetype: "piece-26", manifest: "m-26", rarities: "100=Common,200=Rare" } }],
    27: [{ index: 0, rarity: "100", attributes: { archetype: "piece-27", manifest: "m-27", rarities: "100=Common,200=Rare" } }],
    28: [{ index: 0, rarity: "100", attributes: { archetype: "piece-28", manifest: "m-28", rarities: "100=Common,200=Rare" } }],
    90: [{ index: 0, rarity: "rare", attributes: { archetype: "forbidden", manifest: "m-forbidden" } }],
  }
  return {
    ok: true,
    value: {
      tag: "Found",
      at,
      idCeiling: 2,
      nextId: null,
      collection: { id, name: "", itemCount: 0, items: table[id] },
    },
  }
}

function mints(collection: number, item: number) {
  return { collection, outcome: { tag: "Mints", item, via: { tag: "Random" }, name: null, rarity: null, imageRef: null } }
}

const fullHash = `0x${"ff".repeat(32)}`

function offerPieces() {
  sdk.getApprovedCollections.mockImplementation((network: string) => (network === "paseo" ? [27, 28, 26] : []))
  sdk.getClaimableCollections.mockResolvedValue({
    ok: true,
    value: {
      at,
      collections: [26, 27, 28].map((id) => ({ id, name: `Collection ${id}`, itemCount: 1, owner: null, selection: { tag: "Random" } })),
      idCeiling: 29,
      nextId: null,
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sdk.getApprovedCollections.mockImplementation((network: string) => (network === "paseo" ? [17, 18, 19] : []))
  sdk.getClaimableCollections.mockResolvedValue({
    ok: true,
    value: { at, collections, idCeiling: 91, nextId: null },
  })
  sdk.getCollectionItems.mockImplementation(async (_chain: unknown, id: number) => items(id))
  sdk.previewClaim.mockResolvedValue({
    ok: true,
    value: { at, previews: [mints(17, 1), { collection: 18, outcome: { tag: "Fails", reason: "Sold out" } }] },
  })
})

function creditsAre(list: Claim[]) {
  sdk.getClaims.mockResolvedValue({ ok: true, value: { at: { individuality: at, assetHub: at }, claims: list } })
}

describe("chest reading works", () => {
  it("keeps only the credits of the asked game", async () => {
    // Given
    creditsAre([credit({ hash: "0x01" }), credit({ hash: "0x02", gameIndex: 93 })])

    // When
    const view = await readChest(chain, "5x", 92)

    // Then
    expect(view.items.map((item) => item.hash)).toEqual(["0x01"])
  })

  it("counts unprovable and still-building credits without showing them", async () => {
    // Given
    creditsAre([
      credit({ hash: null, state: "unprovable" }),
      credit({ hash: null, state: "earned" }),
      credit({ hash: "0x01" }),
    ])

    // When
    const view = await readChest(chain, "5x", 92)

    // Then
    expect(view).toMatchObject({ unprovable: 1, pending: 1 })
    expect(view.items).toHaveLength(1)
  })

  it("names an item after its archetype and maps a non-common rarity to rare", async () => {
    // Given
    creditsAre([credit({})])

    // When
    const [item] = (await readChest(chain, "5x", 92)).items

    // Then
    expect(item).toMatchObject({
      name: "Tea",
      tier: "Rare",
      rarity: "rare",
      collection: "Coffee and Tea",
      image: "art:m-tea",
      proof: ["0xaa"],
      state: "claimable",
    })
  })

  it("offers only the collections the credit can actually mint in", async () => {
    // Given
    creditsAre([credit({})])

    // When
    const [item] = (await readChest(chain, "5x", 92)).items

    // Then
    expect(item!.choices.map((choice) => choice.collectionId)).toEqual([17])
  })

  it("keeps a common item common", async () => {
    // Given
    creditsAre([credit({})])
    sdk.previewClaim.mockResolvedValue({ ok: true, value: { at, previews: [mints(18, 0)] } })

    // When
    const [item] = (await readChest(chain, "5x", 92)).items

    // Then
    expect(item).toMatchObject({ name: "Engineer", tier: "common", rarity: "common", collection: "Jobs" })
  })

  it("reads the collections at the block the credits were read at", async () => {
    // Given
    creditsAre([credit({})])

    // When
    await readChest(chain, "5x", 92)

    // Then
    expect(sdk.getApprovedCollections).toHaveBeenCalledWith("paseo")
    expect(sdk.getClaimableCollections).toHaveBeenCalledWith(chain, { at })
    expect(sdk.previewClaim).toHaveBeenCalledWith(chain, expect.objectContaining({ at, collections: [17, 18] }))
    expect(sdk.getCollectionItems).not.toHaveBeenCalledWith(chain, 90, expect.anything())
  })

  it("offers collections in id order when the registry page arrives in the order of the SDK", async () => {
    // Given
    creditsAre([credit({})])
    sdk.getApprovedCollections.mockReturnValue([18, 17])
    sdk.getClaimableCollections.mockResolvedValue({
      ok: true,
      value: { at, collections: [collections[1], collections[0]], idCeiling: 91, nextId: null },
    })

    // When
    await readChest(chain, "5x", 92)

    // Then
    expect(sdk.previewClaim).toHaveBeenCalledWith(chain, expect.objectContaining({ collections: [17, 18] }))
  })

  it("shows a claim in the first collection of the registry, whichever read lands first", async () => {
    // Given
    creditsAre([credit({})])
    sdk.getCollectionItems.mockImplementation(async (_chain: unknown, id: number) => {
      if (id === 17) await new Promise((resolve) => setTimeout(resolve, 0))
      return items(id)
    })
    sdk.previewClaim.mockImplementation(async (_chain: unknown, options: { collections: number[] }) => ({
      ok: true,
      value: { at, previews: options.collections.map((id) => mints(id, id === 17 ? 1 : 0)) },
    }))

    // When
    const [item] = (await readChest(chain, "5x", 92)).items

    // Then
    expect(item).toMatchObject({ name: "Tea", collection: "Coffee and Tea" })
    expect(item!.choices.map((choice) => choice.collectionId)).toEqual([17, 18])
  })

  it("walks short registry pages at the claims pin and filters before reading catalogues", async () => {
    // Given
    creditsAre([credit({})])
    sdk.getClaimableCollections
      .mockResolvedValueOnce({
        ok: true,
        value: { at, collections: [collections[0], collections[2]], idCeiling: 91, nextId: 18 },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { at, collections: [collections[1]], idCeiling: 91, nextId: null },
      })

    // When
    await readChest(chain, "5x", 92)

    // Then
    expect(sdk.getClaimableCollections).toHaveBeenNthCalledWith(1, chain, { at })
    expect(sdk.getClaimableCollections).toHaveBeenNthCalledWith(2, chain, { at, fromId: 18 })
    expect(sdk.getCollectionItems.mock.calls.map(([, id]) => id)).toEqual(expect.arrayContaining([17, 18]))
    expect(sdk.getCollectionItems.mock.calls.map(([, id]) => id)).not.toContain(90)
  })

  it("walks item pages and resolves a later-page numeric rarity from merged attributes", async () => {
    // Given
    creditsAre([credit({})])
    sdk.getCollectionItems.mockImplementation(async (_chain: unknown, id: number, options: { fromId?: number }) => {
      if (id !== 17) return items(id)
      if (options.fromId === 1) return items(17)
      return {
        ok: true,
        value: {
          tag: "Found",
          at,
          idCeiling: 2,
          nextId: 1,
          collection: {
            id,
            name: "",
            itemCount: 0,
            items: [
              {
                index: 0,
                rarity: "100",
                attributes: { archetype: "coffee", manifest: "m-coffee", rarities: "100=Common,200=Rare" },
              },
            ],
          },
        },
      }
    })

    // When
    const [item] = (await readChest(chain, "5x", 92)).items

    // Then
    expect(sdk.getCollectionItems).toHaveBeenCalledWith(chain, 17, { at, attributes: true, fromId: 1 })
    expect(item).toMatchObject({ name: "Tea", tier: "Rare", rarity: "rare" })
  })

  it("chooses the deterministic default from ascending offered ids, not preview response order", async () => {
    // Given
    const hash = `0x${"00".repeat(32)}`
    creditsAre([credit({ hash })])
    sdk.previewClaim.mockResolvedValue({
      ok: true,
      value: { at, previews: [mints(18, 0), mints(17, 0)] },
    })

    // When
    const [item] = (await readChest(chain, "5x", 92)).items

    // Then
    expect(item!.choices.map((choice) => choice.collectionId)).toEqual([17, 18])
    expect(item!.choices[0]!.collectionId).toBe(17)
  })

  it("deals the collection the hash picks over the offered ids, as the Stash does", async () => {
    // Given
    creditsAre([credit({ hash: fullHash }), credit({ hash: fullHash, leafIndex: 1 })])
    offerPieces()
    sdk.previewClaim.mockResolvedValue({
      ok: true,
      value: { at, previews: [mints(28, 0), mints(26, 0), mints(27, 0)] },
    })

    // When
    const view = await readChest(chain, "5x", 92)

    // Then
    expect(indexFor(fullHash, 3)).toBe(2)
    expect(view.items.map((item) => item.choices.map((choice) => choice.collectionId))).toEqual([[28, 26, 27], [28, 26, 27]])
    expect(view.items.map((item) => item.tier)).toEqual(["Common", "Common"])
  })

  it("deals the collection of the Stash when another offered collection cannot mint", async () => {
    // Given
    creditsAre([credit({ hash: fullHash })])
    offerPieces()
    sdk.previewClaim.mockResolvedValue({
      ok: true,
      value: { at, previews: [mints(28, 0), mints(26, 0), { collection: 27, outcome: { tag: "Fails", reason: "Sold out" } }] },
    })

    // When
    const [item] = (await readChest(chain, "5x", 92)).items

    // Then
    expect(item!.choices.map((choice) => choice.collectionId)).toEqual([28, 26])
  })

  it("deals the collection of the Stash when another offered collection is unreadable", async () => {
    // Given
    creditsAre([credit({ hash: fullHash })])
    offerPieces()
    sdk.getCollectionItems.mockImplementation(async (_chain: unknown, id: number) =>
      id === 27 ? { ok: false, error: new Error("unreadable") } : items(id),
    )
    sdk.previewClaim.mockImplementation(async (_chain: unknown, options: { collections: number[] }) => ({
      ok: true,
      value: { at, previews: options.collections.map((id) => mints(id, 0)) },
    }))

    // When
    const view = await readChest(chain, "5x", 92)

    // Then
    expect(view.items[0]!.choices.map((choice) => choice.collectionId)).toEqual([28, 26])
    expect(view.partial).toBe(true)
  })

  it("deals among the mintable collections when the collection of the Stash cannot mint", async () => {
    // Given
    creditsAre([credit({ hash: fullHash })])
    offerPieces()
    sdk.previewClaim.mockResolvedValue({
      ok: true,
      value: { at, previews: [mints(26, 0), mints(27, 0), { collection: 28, outcome: { tag: "Fails", reason: "Sold out" } }] },
    })

    // When
    const [item] = (await readChest(chain, "5x", 92)).items

    // Then
    expect(indexFor(fullHash, 2)).toBe(0)
    expect(item!.choices.map((choice) => choice.collectionId)).toEqual([26, 27])
  })

  it("deals the mintable collection the hash picks, not the first, when the collection of the Stash cannot mint", async () => {
    // Given
    const hash = `0x${"00".repeat(7)}05${"00".repeat(24)}`
    creditsAre([credit({ hash })])
    offerPieces()
    sdk.previewClaim.mockResolvedValue({
      ok: true,
      value: { at, previews: [mints(27, 0), { collection: 28, outcome: { tag: "Fails", reason: "Sold out" } }, mints(26, 0)] },
    })

    // When
    const [item] = (await readChest(chain, "5x", 92)).items

    // Then
    expect([indexFor(hash, 3), indexFor(hash, 2)]).toEqual([2, 1])
    expect(item!.choices.map((choice) => choice.collectionId)).toEqual([27, 26])
  })

  it("does not read any collection when nothing is held", async () => {
    // Given
    creditsAre([credit({ hash: null, state: "unprovable" })])

    // When
    await readChest(chain, "5x", 92)

    // Then
    expect(sdk.getClaimableCollections).not.toHaveBeenCalled()
  })

  it("previews only the claims not already shown, and nothing when none are new", async () => {
    // Given a chest that already shows 0x01
    creditsAre([credit({ hash: "0x01" }), credit({ hash: "0x02" })])

    // When it is read again, with one new claim and then with none
    const more = await readChest(chain, "5x", 92, { except: new Set(["0x01"]) })
    vi.clearAllMocks()
    creditsAre([credit({ hash: "0x01" }), credit({ hash: "0x02" })])
    const none = await readChest(chain, "5x", 92, { except: new Set(["0x01", "0x02"]) })

    // Then
    expect(more.items.map((item) => item.hash)).toEqual(["0x02"])
    expect(none.items).toEqual([])
    expect(sdk.getClaimableCollections).not.toHaveBeenCalled()
    expect(sdk.previewClaim).not.toHaveBeenCalled()
  })

  it("offers the collections approved for the network this build targets", async () => {
    // Given a Previewnet build, whose Asset Hub genesis no table can name
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "previewnet")
    creditsAre([credit({})])
    sdk.getApprovedCollections.mockImplementation((network: string) => (network === "previewnet" ? [17, 18] : []))

    try {
      // When
      const view = await readChest(chain, "5x", 92)

      // Then
      expect(sdk.getApprovedCollections).toHaveBeenCalledWith("previewnet")
      expect(view.items[0]!.choices.map((choice) => choice.collectionId)).toEqual([17])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("reads nothing on a network with no approved collections", async () => {
    // Given
    creditsAre([credit({})])
    sdk.getApprovedCollections.mockReturnValue([])

    // When
    const read = readChest(chain, "5x", 92)

    // Then
    await expect(read).rejects.toThrow(/no approved collections on paseo/)
    expect(sdk.getClaimableCollections).not.toHaveBeenCalled()
  })
})

describe("chest reading of fresh and spent claims works", () => {
  it("keeps a claim whose game is not known yet in the latest game", async () => {
    // Given
    creditsAre([credit({ hash: "0x09", gameIndex: null, state: "earned", proof: null })])

    // When
    const view = await readChest(chain, "5x", 92, { latestGame: true })

    // Then
    expect(view.items.map((item) => item.hash)).toEqual(["0x09"])
    expect(view.pending).toBe(0)
  })

  it("leaves a claim whose game is not known yet out of an older game", async () => {
    // Given
    creditsAre([credit({ hash: "0x09", gameIndex: null, state: "earned", proof: null })])

    // When
    const view = await readChest(chain, "5x", 92)

    // Then
    expect(view.items).toEqual([])
  })

  it("drops only the claim whose preview is refused", async () => {
    // Given
    creditsAre([credit({ hash: "0x01" }), credit({ hash: "0x02" })])
    sdk.previewClaim.mockImplementation(async (_chain: unknown, options: { credit: string }) =>
      options.credit === "0x02"
        ? { ok: false, error: new Error("refused") }
        : { ok: true, value: { at, previews: [mints(17, 1)] } },
    )

    // When
    const view = await readChest(chain, "5x", 92)

    // Then
    expect(view.items.map((item) => item.hash)).toEqual(["0x01"])
    expect(view.partial).toBe(true)
  })

  it("offers only the collections that could be read", async () => {
    // Given
    creditsAre([credit({})])
    sdk.getCollectionItems.mockImplementation(async (_chain: unknown, id: number) =>
      id === 18 ? { ok: false, error: new Error("unreadable") } : items(id),
    )

    // When
    const view = await readChest(chain, "5x", 92)

    // Then
    expect(sdk.previewClaim).toHaveBeenCalledWith(chain, expect.objectContaining({ collections: [17] }))
    expect(view.partial).toBe(true)
  })

  it("counts a minted claim without dealing it into the chest", async () => {
    // Given
    creditsAre([credit({ hash: "0x07", state: "claimed" })])

    // When
    const view = await readChest(chain, "5x", 92)

    // Then
    expect(view.items).toEqual([])
    expect(view.claimed).toBe(1)
  })
})

describe("chest reading fails", () => {
  it("throws when the credits cannot be read", async () => {
    // Given
    sdk.getClaims.mockResolvedValue({ ok: false, error: new Error("connection lost") })

    // When
    const read = readChest(chain, "5x", 92)

    // Then
    await expect(read).rejects.toBeInstanceOf(ChestReadError)
  })

  it("throws when a claim preview is refused", async () => {
    // Given
    creditsAre([credit({})])
    sdk.previewClaim.mockResolvedValue({ ok: false, error: new Error("refused") })

    // When
    const read = readChest(chain, "5x", 92)

    // Then
    await expect(read).rejects.toBeInstanceOf(ChestReadError)
  })

  it("throws when a held claim has no collection to be minted in", async () => {
    // Given
    creditsAre([credit({})])
    sdk.getClaimableCollections.mockResolvedValue({
      ok: true,
      value: { at, collections: [], idCeiling: 0, nextId: null },
    })

    // When
    const read = readChest(chain, "5x", 92)

    // Then
    await expect(read).rejects.toBeInstanceOf(ChestReadError)
  })

  it("throws when a collection cannot be read", async () => {
    // Given
    creditsAre([credit({})])
    sdk.getCollectionItems.mockResolvedValue({ ok: false, error: new Error("pruned") })

    // When
    const read = readChest(chain, "5x", 92)

    // Then
    await expect(read).rejects.toBeInstanceOf(ChestReadError)
  })
})

describe("pinned chest reading works", () => {
  it("reads again when the node dropped the pinned block", async () => {
    // Given
    sdk.getClaims
      .mockResolvedValueOnce({ ok: false, error: new Error("Block 0xab is not pinned (getRuntimeCtx)") })
      .mockResolvedValueOnce({ ok: true, value: { at: { individuality: at, assetHub: at }, claims: [credit({})] } })

    // When
    const view = await readChestPinned(chain, "5x", 92)

    // Then
    expect(view.items).toHaveLength(1)
    expect(sdk.getClaims).toHaveBeenCalledTimes(2)
  })
})

describe("pinned chest reading fails", () => {
  it("does not retry a failure that is not about pinning", async () => {
    // Given
    sdk.getClaims.mockResolvedValue({ ok: false, error: new Error("connection lost") })

    // When
    const read = readChestPinned(chain, "5x", 92)

    // Then
    await expect(read).rejects.toBeInstanceOf(ChestReadError)
    expect(sdk.getClaims).toHaveBeenCalledTimes(1)
  })
})

describe("partial chest reading fails", () => {
  it("throws a dropped block from one collection so the whole read is retried", async () => {
    // Given
    creditsAre([credit({})])
    sdk.getCollectionItems.mockImplementation(async (_chain: unknown, id: number) =>
      id === 18 ? { ok: false, error: new Error("Block 0xab is not pinned (getRuntimeCtx)") } : items(id),
    )

    // When
    const read = readChest(chain, "5x", 92)

    // Then
    await expect(read).rejects.toThrow(/not pinned/)
  })

  it("throws a dropped block from one preview so the whole read is retried", async () => {
    // Given
    creditsAre([credit({ hash: "0x01" }), credit({ hash: "0x02" })])
    sdk.previewClaim.mockImplementation(async (_chain: unknown, options: { credit: string }) =>
      options.credit === "0x02"
        ? { ok: false, error: new Error("Block 0xab is not pinned (getRuntimeCtx)") }
        : { ok: true, value: { at, previews: [mints(17, 1)] } },
    )

    // When
    const read = readChest(chain, "5x", 92)

    // Then
    await expect(read).rejects.toThrow(/not pinned/)
  })
})

afterEach(() => vi.unstubAllEnvs())
it("reads local collections from explicit ids without asking the SDK registry", async () => {
  for (const [name, value] of Object.entries(localEnv)) vi.stubEnv(name, value)
  vi.stubEnv("NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS", "18")
  sdk.getClaims.mockResolvedValue({ ok: true, value: { at: { assetHub: at }, claims: [credit({})] } })
  sdk.previewClaim.mockResolvedValue({ ok: true, value: { at, previews: [mints(18, 0)] } })
  const view = await readChest(chain, "account", 92)
  expect(view.items[0]?.choices.map((choice) => choice.collectionId)).toEqual([18])
  expect(sdk.getApprovedCollections).not.toHaveBeenCalled()
  expect(sdk.getCollectionItems).toHaveBeenCalledWith(chain, 18, expect.anything())
  expect(sdk.getCollectionItems).not.toHaveBeenCalledWith(chain, 17, expect.anything())
})
