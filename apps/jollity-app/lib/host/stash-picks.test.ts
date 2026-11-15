// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => ({
  api: null as null | { localStorage: { read: ReturnType<typeof vi.fn> } },
  getTruApi: vi.fn(),
  formatHostError: vi.fn((error: unknown) => String(error)),
}))

vi.mock("@parity/product-sdk-host", () => ({
  getTruApi: host.getTruApi,
  formatHostError: host.formatHostError,
}))
vi.mock("@jollity/protocol", () => ({ network: () => ({ dotnsTLD: "paseo" }) }))
vi.mock("../debug/log-store", () => ({ devLog: () => {} }))

import { STASH_PICKS_KEY, readStashPicks, stashProduct } from "./stash-picks"

const HASH = "a".repeat(64)
const toHex = (value: unknown) =>
  `0x${Array.from(new TextEncoder().encode(JSON.stringify(value)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
const ok = (value: unknown) => ({ match: (onOk: (value: unknown) => unknown) => onOk(value) })
const refused = (error: unknown) => ({
  match: (_onOk: (value: unknown) => unknown, onError: (reason: unknown) => unknown) => onError(error),
})

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  host.api = { localStorage: { read: vi.fn() } }
  host.getTruApi.mockImplementation(async () => host.api)
})

describe("Scarcity pick storage doorway", () => {
  it("reads stash.picks from the network-specific Scarcity product", async () => {
    host.api!.localStorage.read.mockResolvedValue(ok({ value: toHex({ [`0x${HASH}`]: { collectionId: 18 } }) }))

    expect(await readStashPicks()).toEqual(new Map([[HASH, 18]]))
    expect(host.api!.localStorage.read).toHaveBeenCalledWith({ product: "stash.paseo", key: "stash.picks" })
    expect(stashProduct()).toBe("stash.paseo")
    expect(STASH_PICKS_KEY).toBe("stash.picks")
  })

  it("distinguishes an absent value from a failed read", async () => {
    host.api!.localStorage.read.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(refused("AccessNotGranted"))

    expect(await readStashPicks()).toEqual(new Map())
    expect(await readStashPicks()).toBeNull()
  })

  it.each([
    ["no host", async () => null],
    ["host rejection", async () => Promise.reject(new Error("gone"))],
  ])("falls back after %s", async (_case, acquire) => {
    host.getTruApi.mockImplementation(acquire)
    expect(await readStashPicks()).toBeNull()
  })

  it.each(["0xgg", "0x7b", toHex("not an object")])("falls back after malformed storage: %s", async (value) => {
    host.api!.localStorage.read.mockResolvedValue(ok({ value }))
    expect(await readStashPicks()).toBeNull()
  })

  it("bounds host acquisition and storage reading within one total budget", async () => {
    vi.useFakeTimers()
    host.getTruApi.mockImplementation(() => new Promise(() => {}))
    const acquisition = readStashPicks({ timeoutMs: 25 })
    await vi.advanceTimersByTimeAsync(25)
    await expect(acquisition).resolves.toBeNull()

    host.getTruApi.mockImplementation(async () => host.api)
    host.api!.localStorage.read.mockImplementation(() => new Promise(() => {}))
    const read = readStashPicks({ timeoutMs: 25 })
    await vi.advanceTimersByTimeAsync(25)
    await expect(read).resolves.toBeNull()
  })
})
