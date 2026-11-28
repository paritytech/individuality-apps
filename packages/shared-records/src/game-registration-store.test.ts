// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { ENDED_TTL_MS, GAME_REGISTRATION_KEY, REGISTERING_TTL_MS, type GameRegistration } from "./game-registration"
import { decodeStoredJSON, gameRegistrationStore, type JSONStorage } from "./game-registration-store"

const NOW = 1_700_000_000_000
const record = (phase: GameRegistration["phase"], at = NOW - 1_000): GameRegistration => ({ gameIndex: 7, phase, surface: "app", at, attempt: NOW - 5_000 })

function fakeStorage(): JSONStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    values,
    readJSON: vi.fn(async (key: string) => values.get(key) ?? null),
    writeJSON: vi.fn(async (key: string, value: unknown) => void values.set(key, value)),
  }
}

describe("gameRegistrationStore", () => {
  it("reads the live record under the key, and null for none, a stale one or no storage", async () => {
    const storage = fakeStorage()
    const store = gameRegistrationStore(async () => storage)
    await expect(store.read(NOW)).resolves.toBeNull()
    storage.values.set(GAME_REGISTRATION_KEY, record("registering"))
    await expect(store.read(NOW)).resolves.toEqual(record("registering"))
    storage.values.set(GAME_REGISTRATION_KEY, record("registering", NOW - REGISTERING_TTL_MS - 1))
    await expect(store.read(NOW)).resolves.toBeNull()
    await expect(gameRegistrationStore(async () => null).read(NOW)).resolves.toBeNull()
  })

  it("reads a record whatever its age with readAny, which read drops once it is stale", async () => {
    const storage = fakeStorage()
    const store = gameRegistrationStore(async () => storage)
    // a sign-up that landed hours before the game it is for
    const old = record("registered", NOW - ENDED_TTL_MS - 3 * 3_600_000)
    storage.values.set(GAME_REGISTRATION_KEY, old)
    await expect(store.read(NOW)).resolves.toBeNull()
    await expect(store.readAny()).resolves.toEqual(old)
  })

  it("reads null with readAny for none, a malformed record or no storage, and rejects when the storage does", async () => {
    const storage = fakeStorage()
    const store = gameRegistrationStore(async () => storage)
    await expect(store.readAny()).resolves.toBeNull()
    storage.values.set(GAME_REGISTRATION_KEY, { gameIndex: 7, phase: "registered", surface: "elsewhere", at: NOW, attempt: 1 })
    await expect(store.readAny()).resolves.toBeNull()
    await expect(gameRegistrationStore(async () => null).readAny()).resolves.toBeNull()
    vi.mocked(storage.readJSON).mockRejectedValueOnce(new Error("refused"))
    await expect(store.readAny()).rejects.toThrow("refused")
  })

  it("rejects a read the storage rejects, so the product decides what to log", async () => {
    const storage = fakeStorage()
    vi.mocked(storage.readJSON).mockRejectedValueOnce(new Error("bridge closed"))
    await expect(gameRegistrationStore(async () => storage).read(NOW)).rejects.toThrow("bridge closed")
  })

  it("writes and clears under the key, one write after the other", async () => {
    const storage = fakeStorage()
    let releaseFirst: () => void = () => {}
    vi.mocked(storage.writeJSON!).mockImplementationOnce(
      (key, value) =>
        new Promise<void>((resolve) => {
          releaseFirst = () => {
            storage.values.set(key, value)
            resolve()
          }
        }),
    )
    const store = gameRegistrationStore(async () => storage)
    const first = store.write(record("registering"))
    const second = store.write(null)
    await vi.waitFor(() => expect(storage.writeJSON).toHaveBeenCalledTimes(1))
    expect(storage.values.has(GAME_REGISTRATION_KEY)).toBe(false)
    releaseFirst()
    await first
    await second
    expect(storage.values.get(GAME_REGISTRATION_KEY)).toBeNull()
    expect(vi.mocked(storage.writeJSON!).mock.calls.map(([, value]) => value)).toEqual([record("registering"), null])
  })

  it("lets a failed write reject its caller and still runs the next one", async () => {
    const storage = fakeStorage()
    vi.mocked(storage.writeJSON!).mockRejectedValueOnce(new Error("no storage"))
    const store = gameRegistrationStore(async () => storage)
    await expect(store.write(record("registering"))).rejects.toThrow("no storage")
    await store.write(record("sent"))
    expect(storage.values.get(GAME_REGISTRATION_KEY)).toEqual(record("sent"))
  })

  it("drops a write when there is no storage, or a storage that only reads", async () => {
    await expect(gameRegistrationStore(async () => null).write(record("sent"))).resolves.toBeUndefined()
    const readOnly: JSONStorage = { readJSON: async () => null }
    await expect(gameRegistrationStore(async () => readOnly).write(record("sent"))).resolves.toBeUndefined()
  })
})

describe("decodeStoredJSON", () => {
  it("decodes the hex of a stored JSON string, with or without the 0x prefix", () => {
    const hex = Array.from(new TextEncoder().encode(JSON.stringify({ gameIndex: 7, phase: "sent" })), (b) => b.toString(16).padStart(2, "0")).join("")
    expect(decodeStoredJSON(`0x${hex}`)).toEqual({ gameIndex: 7, phase: "sent" })
    expect(decodeStoredJSON(hex)).toEqual({ gameIndex: 7, phase: "sent" })
    expect(() => decodeStoredJSON("0x7b6e6f")).toThrow()
  })
})
