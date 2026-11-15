// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => ({
  getVerifiedArtwork: vi.fn(),
  gatewaySource: vi.fn((): ((address: unknown) => Promise<Uint8Array | null>) => async () => null),
  preimageSource: vi.fn((): ((address: unknown) => Promise<Uint8Array | null>) => async () => null),
}))
vi.mock("@parity/product-sdk-nfts", () => sdk)
vi.mock("@parity/product-sdk-host", () => ({ isInsideContainerSync: () => false }))
vi.mock("./debug/log-store", () => ({ devLog: () => {} }))
vi.mock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())

import { loadManifestArt, matchesAddress } from "./collectable-art"
import { recorded, resetRecorded } from "./telemetry/testing"

const manifest = (asset: object) =>
  new TextEncoder().encode(JSON.stringify({ assets: { thumbnail: asset } }))

function verified(bytes: Uint8Array) {
  return { ok: true, value: { tag: "Verified", address: {}, bytes } }
}

let blobTypes: string[]
beforeEach(() => {
  vi.clearAllMocks()
  resetRecorded()
  blobTypes = []
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
    blobTypes.push((blob as Blob).type)
    return "blob:art"
  })
})

describe("manifest art loading works", () => {
  it("labels the image with the type the manifest gives", async () => {
    // Given
    sdk.getVerifiedArtwork
      .mockResolvedValueOnce(verified(manifest({ cid: "bimage", mime: "image/png" })))
      .mockResolvedValueOnce(verified(new Uint8Array([1])))

    // When
    const url = await loadManifestArt("bmanifest-png")

    // Then
    expect(url).toBe("blob:art")
    expect(blobTypes).toEqual(["image/png"])
  })
})

describe("manifest art loading fails", () => {
  it("asks again after a failed load instead of remembering the failure", async () => {
    // Given
    sdk.getVerifiedArtwork.mockResolvedValueOnce({ ok: true, value: { tag: "Missing", address: {} } })
    expect(await loadManifestArt("bmanifest-retry")).toBe("")
    sdk.getVerifiedArtwork
      .mockResolvedValueOnce(verified(manifest({ cid: "bimage" })))
      .mockResolvedValueOnce(verified(new Uint8Array([1])))

    // When
    const url = await loadManifestArt("bmanifest-retry")

    // Then
    expect(url).toBe("blob:art")
  })
})

describe("art source inside a host works", () => {
  it("falls back to the gateway when the host holds no bytes", async () => {
    // Given
    vi.resetModules()
    const gateway = vi.fn(async () => new Uint8Array([7]))
    const preimage = vi.fn(async () => null)
    vi.doMock("@parity/product-sdk-host", () => ({
      isInsideContainerSync: () => true,
      getPreimageManager: async () => ({ lookup: () => ({}) }),
    }))
    sdk.preimageSource.mockReturnValue(preimage)
    sdk.gatewaySource.mockReturnValue(gateway)
    let source: ((address: unknown) => Promise<Uint8Array | null>) | undefined
    sdk.getVerifiedArtwork.mockImplementation(async (_image: unknown, options: { source: typeof source }) => {
      source = options.source
      return { ok: true, value: { tag: "Missing", address: {} } }
    })
    const art = await import("./collectable-art")
    await art.loadVerifiedImage("bsomething")

    // When
    const bytes = await source!({ cid: "bsomething" })

    // Then
    expect(preimage).toHaveBeenCalled()
    expect(bytes).toEqual(new Uint8Array([7]))
    vi.doUnmock("@parity/product-sdk-host")
  })

  it("asks the gateway when the host bytes do not match the address", async () => {
    // Given
    vi.resetModules()
    const gateway = vi.fn(async () => new Uint8Array([7]))
    vi.doMock("@parity/product-sdk-host", () => ({
      isInsideContainerSync: () => true,
      getPreimageManager: async () => ({ lookup: () => ({}) }),
    }))
    sdk.preimageSource.mockReturnValue(async () => new Uint8Array([9, 9]))
    sdk.gatewaySource.mockReturnValue(gateway)
    let source: ((address: unknown) => Promise<Uint8Array | null>) | undefined
    sdk.getVerifiedArtwork.mockImplementation(async (_image: unknown, options: { source: typeof source }) => {
      source = options.source
      return { ok: true, value: { tag: "Missing", address: {} } }
    })
    const art = await import("./collectable-art")
    await art.loadVerifiedImage("bsomething")

    // When
    const bytes = await source!({ cid: "bsomething", digest: `0x${"00".repeat(32)}`, multihash: 0xb220 })

    // Then
    expect(gateway).toHaveBeenCalled()
    expect(bytes).toEqual(new Uint8Array([7]))
    vi.doUnmock("@parity/product-sdk-host")
  })
})

describe("first bytes works", () => {
  it("starts the fallback after the head start when the host stays silent", async () => {
    // Given
    vi.useFakeTimers()
    const { firstBytes } = await import("./collectable-art")
    const fallback = vi.fn(async () => new Uint8Array([2]))

    // When
    const race = firstBytes(new Promise(() => {}), fallback, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)

    // Then
    await expect(race).resolves.toEqual(new Uint8Array([2]))
    vi.useRealTimers()
  })

  it("never asks the fallback when the host answers in time", async () => {
    // Given
    const { firstBytes } = await import("./collectable-art")
    const fallback = vi.fn(async () => new Uint8Array([2]))

    // When
    const bytes = await firstBytes(Promise.resolve(new Uint8Array([1])), fallback, 1_000)

    // Then
    expect(bytes).toEqual(new Uint8Array([1]))
    expect(fallback).not.toHaveBeenCalled()
  })
})

describe("host bytes check works", () => {
  it("accepts bytes whose blake2b-256 digest is the address", async () => {
    // Given
    const { blake2b } = await import("@noble/hashes/blake2.js")
    const bytes = new Uint8Array([1, 2, 3])
    const digest = `0x${Array.from(blake2b(bytes, { dkLen: 32 }), (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`

    // When
    const ok = matchesAddress(bytes, { cid: "b", digest, multihash: 0xb220 })

    // Then
    expect(ok).toBe(true)
  })
})

describe("host bytes check fails", () => {
  it("rejects bytes that do not hash to the address", () => {
    // Given
    const digest = `0x${"00".repeat(32)}` as `0x${string}`

    // When
    const ok = matchesAddress(new Uint8Array([1, 2, 3]), { cid: "b", digest, multihash: 0xb220 })

    // Then
    expect(ok).toBe(false)
  })
})

describe("sha2-256 host bytes check works", () => {
  it("checks a sha2-256 address rather than letting it through", async () => {
    // Given
    const { sha256 } = await import("@noble/hashes/sha2.js")
    const bytes = new Uint8Array([4, 5])
    const hex = (d: Uint8Array) => `0x${Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`

    // When
    const right = matchesAddress(bytes, { cid: "b", digest: hex(sha256(bytes)), multihash: 0x12 })
    const wrong = matchesAddress(bytes, { cid: "b", digest: `0x${"00".repeat(32)}`, multihash: 0x12 })

    // Then
    expect([right, wrong]).toEqual([true, false])
  })
})

describe("art that does not load is reported", () => {
  it("names the hash and why, once per hash", async () => {
    sdk.getVerifiedArtwork.mockResolvedValue({ ok: false, error: new Error("preimage timeout") })
    await expect(loadManifestArt("bmanifest-gone")).resolves.toBe("")
    await expect(loadManifestArt("bmanifest-gone")).resolves.toBe("")
    expect(recorded.failures).toEqual([
      expect.objectContaining({ kind: "art-failed", details: { reason: "read-failed", context: { hash: "bmanifest-gone", detail: "preimage timeout" } } }),
    ])
  })

  it("says when the bytes did not match their address", async () => {
    sdk.getVerifiedArtwork.mockResolvedValue({ ok: true, value: { tag: "Mismatch" } })
    await loadManifestArt("bmanifest-swapped")
    expect(recorded.failures[0]).toMatchObject({ kind: "art-failed", details: { reason: "not-verified", context: { hash: "bmanifest-swapped" } } })
  })
})
