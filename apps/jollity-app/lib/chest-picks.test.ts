// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChestChoice, ChestItem } from "./scarcity"

const host = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  return {
    values,
    available: true,
    getHostLocalStorage: vi.fn(),
    readJSON: vi.fn(async (key: string) => values.get(key) ?? null),
    writeJSON: vi.fn(async (key: string, value: unknown) => {
      values.set(key, JSON.parse(JSON.stringify(value)))
    }),
  }
})
vi.mock("@parity/product-sdk-host", () => ({
  getHostLocalStorage: host.getHostLocalStorage,
}))
vi.mock("./debug/log-store", () => ({ devLog: () => {} }))

type ChestPicksModule = typeof import("./chest-picks")
let readChestPicks: ChestPicksModule["readChestPicks"]
let saveChestPick: ChestPicksModule["saveChestPick"]
let withPicks: ChestPicksModule["withPicks"]
let canChangePick: ChestPicksModule["canChangePick"]

const HARE = `0x${"1".padStart(64, "0")}`
const PIZZA = `0x${"2".padStart(64, "0")}`
const manyHashes = () => Array.from({ length: 500 }, (_, i) => `0x${(i + 0x1000).toString(16).padStart(64, "0")}`)
const lateWrite = async (key: string, value: unknown) => {
  const written = JSON.parse(JSON.stringify(value))
  await new Promise((resolve) => setTimeout(resolve, 5))
  host.values.set(key, written)
}
const writeInFlight = () => new Promise((resolve) => setTimeout(resolve, 0))

const choice = (collectionId: number, name: string, rarity: ChestChoice["rarity"] = "common"): ChestChoice => ({
  collectionId,
  collection: `Collection ${collectionId}`,
  name,
  rarity,
  image: `blob:${name}`,
})

function dealt(hash: string, choices: ChestChoice[]): ChestItem {
  const shown = choices[0]!
  return {
    hash,
    proof: null,
    state: "claimable",
    name: shown.name,
    rarity: shown.rarity,
    image: shown.image,
    collection: shown.collection,
    choices,
  }
}

// a fresh module per test, since the picks last read and the queued saves are module state
beforeEach(async () => {
  host.values.clear()
  host.available = true
  host.readJSON.mockImplementation(async (key: string) => host.values.get(key) ?? null)
  host.writeJSON.mockImplementation(async (key: string, value: unknown) => {
    host.values.set(key, JSON.parse(JSON.stringify(value)))
  })
  host.getHostLocalStorage.mockImplementation(async () =>
    host.available ? { readJSON: host.readJSON, writeJSON: host.writeJSON } : null,
  )
  vi.clearAllMocks()
  vi.resetModules()
  ;({ canChangePick, readChestPicks, saveChestPick, withPicks } = await import("./chest-picks"))
})

describe("chest pick saving works", () => {
  it("reads a saved pick back on the next visit", async () => {
    // Given
    await readChestPicks()
    await saveChestPick(HARE, 3)

    // When
    const picks = await readChestPicks()

    // Then
    expect(picks).toEqual(new Map([[HARE.slice(2), 3]]))
    expect(host.values.get("jollity.chest")).toEqual({ [HARE]: { collectionId: 3 } })
  })

  it("keeps both picks when the first write lands after the second pick", async () => {
    // Given
    await readChestPicks()
    host.writeJSON.mockImplementationOnce(lateWrite)
    const first = saveChestPick(HARE, 1)
    await writeInFlight()

    // When
    await Promise.all([first, saveChestPick(PIZZA, 2)])

    // Then
    expect(host.values.get("jollity.chest")).toEqual({ [HARE]: { collectionId: 1 }, [PIZZA]: { collectionId: 2 } })
  })

  it("replaces the earlier pick for the same claim", async () => {
    // Given
    await readChestPicks()
    await saveChestPick(HARE, 1)

    // When
    await saveChestPick(HARE, 2)

    // Then
    expect(await readChestPicks()).toEqual(new Map([[HARE.slice(2), 2]]))
  })

  it("adds a pick to the ones read when the chest opened, without reading again", async () => {
    // Given
    host.values.set("jollity.chest", { [PIZZA]: { collectionId: 2 } })
    await readChestPicks()
    host.readJSON.mockClear()

    // When
    await saveChestPick(HARE, 1)

    // Then
    expect(host.values.get("jollity.chest")).toEqual({ [PIZZA]: { collectionId: 2 }, [HARE]: { collectionId: 1 } })
    expect(host.readJSON).not.toHaveBeenCalled()
  })

  it("drops the oldest picks once five hundred are kept", async () => {
    // Given
    const hashes = manyHashes()
    host.values.set("jollity.chest", Object.fromEntries(hashes.map((hash) => [hash, { collectionId: 0 }])))
    await readChestPicks()

    // When
    await saveChestPick(HARE, 4)

    // Then
    const picks = await readChestPicks()
    expect(picks.size).toBe(500)
    expect(picks.get(hashes[0]!.slice(2))).toBeUndefined()
    expect(picks.get(HARE.slice(2))).toBe(4)
  })

  it("keeps a claim picked again when a new pick trims the oldest", async () => {
    // Given
    const hashes = manyHashes()
    host.values.set("jollity.chest", Object.fromEntries(hashes.map((hash) => [hash, { collectionId: 0 }])))
    await readChestPicks()
    await saveChestPick(hashes[0]!, 1)

    // When
    await saveChestPick(HARE, 4)

    // Then
    const picks = await readChestPicks()
    expect(picks.get(hashes[0]!.slice(2))).toBe(1)
    expect(picks.get(hashes[1]!.slice(2))).toBeUndefined()
  })

  it("writes over a value that is not JSON", async () => {
    // Given
    host.values.set("jollity.chest", "not picks")
    host.readJSON.mockRejectedValueOnce(new SyntaxError("Unexpected token"))
    await readChestPicks()

    // When
    await saveChestPick(HARE, 1)

    // Then
    expect(host.values.get("jollity.chest")).toEqual({ [HARE]: { collectionId: 1 } })
  })

  it("reads the picks only after a save in flight has landed", async () => {
    // Given
    await readChestPicks()
    host.writeJSON.mockImplementationOnce(lateWrite)
    const first = saveChestPick(HARE, 1)
    await writeInFlight()

    // When
    const picks = await readChestPicks()
    await first
    await saveChestPick(PIZZA, 2)

    // Then
    expect(picks).toEqual(new Map([[HARE.slice(2), 1]]))
    expect(host.values.get("jollity.chest")).toEqual({ [HARE]: { collectionId: 1 }, [PIZZA]: { collectionId: 2 } })
  })
})

describe("chest pick saving fails", () => {
  it("writes nothing when the chest could not read the saved picks, so they survive", async () => {
    // Given
    host.values.set("jollity.chest", { [PIZZA]: { collectionId: 2 } })
    host.readJSON.mockRejectedValueOnce(new Error("Unknown"))
    await readChestPicks()

    // When
    await saveChestPick(HARE, 1)

    // Then
    expect(host.writeJSON).not.toHaveBeenCalled()
    expect(host.values.get("jollity.chest")).toEqual({ [PIZZA]: { collectionId: 2 } })
  })

  it("reads no picks and writes nothing when the host offers no storage", async () => {
    // Given
    host.available = false

    // When
    const picks = await readChestPicks()
    await saveChestPick(HARE, 1)

    // Then
    expect(picks).toEqual(new Map())
    expect(host.writeJSON).not.toHaveBeenCalled()
  })
})

describe("chest pick reading fails", () => {
  it("bounds host acquisition and reading before it lets the chest continue", async () => {
    vi.useFakeTimers()
    host.getHostLocalStorage.mockImplementation(() => new Promise(() => {}))
    const acquisition = readChestPicks({ timeoutMs: 25 })
    await vi.advanceTimersByTimeAsync(25)
    await expect(acquisition).resolves.toEqual(new Map())

    host.getHostLocalStorage.mockImplementation(async () => ({ readJSON: host.readJSON, writeJSON: host.writeJSON }))
    host.readJSON.mockImplementation(() => new Promise(() => {}))
    const read = readChestPicks({ timeoutMs: 25 })
    await vi.advanceTimersByTimeAsync(25)
    await expect(read).resolves.toEqual(new Map())
    vi.useRealTimers()
  })

  it("keeps only the well-formed entries of a malformed value", async () => {
    // Given
    host.values.set("jollity.chest", { [HARE]: { collectionId: "1" }, [PIZZA]: { collectionId: 2 }, "0x3": null })

    // When
    const picks = await readChestPicks()

    // Then
    expect(picks).toEqual(new Map([[PIZZA.slice(2), 2]]))
  })

  it("reads no picks when storage refuses the first read", async () => {
    // Given
    host.readJSON.mockRejectedValueOnce(new Error("AccessNotGranted"))

    // When
    const picks = await readChestPicks()

    // Then
    expect(picks).toEqual(new Map())
  })

  it("keeps the picks of the last read when a later read is refused", async () => {
    // Given
    host.values.set("jollity.chest", { [PIZZA]: { collectionId: 2 } })
    await readChestPicks()
    host.readJSON.mockRejectedValueOnce(new Error("AccessNotGranted"))

    // When
    const picks = await readChestPicks()

    // Then
    expect(picks).toEqual(new Map([[PIZZA.slice(2), 2]]))
  })
})

describe("dealing a picked collection works", () => {
  it("deals the item of the picked collection and offers it first", () => {
    // Given
    const item = dealt(HARE, [choice(0, "Hare"), choice(1, "Pizza"), choice(2, "Acropolis", "rare")])

    // When
    const [picked] = withPicks([item], new Map([[HARE.slice(2), 2]]))

    // Then
    expect(picked).toMatchObject({ name: "Acropolis", rarity: "rare", image: "blob:Acropolis", collection: "Collection 2" })
    expect(picked!.choices.map((c) => c.collectionId)).toEqual([2, 0, 1])
    expect(picked!.selectionSource).toBe("jollity")
  })

  it("deals the item as it came when the picked collection is not on offer", () => {
    // Given
    const item = dealt(HARE, [choice(0, "Hare"), choice(1, "Pizza")])

    // When
    const [picked] = withPicks(
      [item],
      new Map([
        [HARE.slice(2), 7],
        [PIZZA.slice(2), 1],
      ]),
    )

    // Then
    expect(picked).toBe(item)
  })

  it("keeps a valid Scarcity pick authoritative over Jollity", () => {
    const item = dealt(HARE, [choice(0, "Hare"), choice(1, "Pizza"), choice(2, "Acropolis", "rare")])

    const [picked] = withPicks(
      [item],
      new Map([[HARE.slice(2), 1]]),
      new Map([[HARE.slice(2), 2]]),
    )

    expect(picked).toMatchObject({ name: "Acropolis", selectionSource: "stash" })
    expect(picked!.choices.map((c) => c.collectionId)).toEqual([2, 0, 1])
  })

  it("preserves Scarcity provenance when a later render pass only has local picks", () => {
    const item = dealt(HARE, [choice(0, "Hare"), choice(1, "Pizza"), choice(2, "Acropolis", "rare")])
    const [loaded] = withPicks(
      [item],
      new Map([[HARE.slice(2), 1]]),
      new Map([[HARE.slice(2), 2]]),
    )

    const [rerendered] = withPicks([loaded!], new Map([[HARE.slice(2), 1]]))

    expect(rerendered).toMatchObject({ name: "Acropolis", selectionSource: "stash" })
  })

  it("falls through a stale Scarcity pick to Jollity", () => {
    const item = dealt(HARE, [choice(0, "Hare"), choice(1, "Pizza")])

    const [picked] = withPicks(
      [item],
      new Map([[HARE.slice(2), 1]]),
      new Map([[HARE.slice(2), 99]]),
    )

    expect(picked).toMatchObject({ name: "Pizza", selectionSource: "jollity" })
  })

  it("makes a valid Scarcity-owned selection read-only", () => {
    const item = dealt(HARE, [choice(0, "Hare"), choice(1, "Pizza")])
    const [locked] = withPicks([item], new Map(), new Map([[HARE.slice(2), 1]]))

    expect(canChangePick(locked!)).toBe(false)
    expect(canChangePick(item)).toBe(true)
  })
})
