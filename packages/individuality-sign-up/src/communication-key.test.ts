// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { p256 } from "@noble/curves/nist.js"
import { communicationKeyStore, fromHex, type CommunicationKey } from "@individuality/shared-records"
import { communicationKeyFrom, freshCommunicationKey, keptCommunicationIdentifier } from "./communication-key"

const ENTROPY = new Uint8Array(32).fill(9)

const memoryStore = () => {
  const stored = new Map<string, unknown>()
  return {
    stored,
    store: communicationKeyStore(async () => ({
      readJSON: async (key) => stored.get(key) ?? null,
      writeJSON: async (key, value) => void stored.set(key, value),
    })),
  }
}

describe("the communication key", () => {
  it("derives one key for every try in a game, and another for the next game", () => {
    const key = communicationKeyFrom(ENTROPY, 7)
    expect(communicationKeyFrom(ENTROPY, 7)).toEqual(key)
    expect(key.publicKey).toHaveLength(65)
    expect(key.publicKey[0]).toBe(4)
    expect(() => p256.Point.fromBytes(key.publicKey)).not.toThrow()
    expect(p256.getPublicKey(key.secret, false)).toEqual(key.publicKey)
    expect(communicationKeyFrom(ENTROPY, 8).publicKey).not.toEqual(key.publicKey)
  })

  it("makes a fresh key whose public half is its secret's", () => {
    const key = freshCommunicationKey()
    expect(p256.getPublicKey(key.secret, false)).toEqual(key.publicKey)
  })
})

describe("keptCommunicationIdentifier", () => {
  it("keeps a fresh key before handing its public half out, and sends it again for the same game", async () => {
    const { store } = memoryStore()
    const identifier = keptCommunicationIdentifier(store, vi.fn())
    const first = await identifier(7)
    const kept = (await store.read()) as CommunicationKey
    expect(kept.gameIndex).toBe(7)
    expect(fromHex(kept.publicKey)).toEqual(first)
    expect(p256.getPublicKey(fromHex(kept.secret), false)).toEqual(first)
    expect(await identifier(7)).toEqual(first)
  })

  it("makes a new key for the next game", async () => {
    const { store } = memoryStore()
    const identifier = keptCommunicationIdentifier(store, vi.fn())
    const seven = await identifier(7)
    const eight = await identifier(8)
    expect(eight).not.toEqual(seven)
    expect((await store.read())?.gameIndex).toBe(8)
  })

  it("sends no key it could not keep: the write's failure fails the attempt", async () => {
    const identifier = keptCommunicationIdentifier(
      { read: () => Promise.resolve(null), write: () => Promise.reject(new Error("write")) },
      vi.fn(),
    )
    await expect(identifier(7)).rejects.toThrow("write")
  })

  it("makes and keeps a fresh key when the kept one cannot be read", async () => {
    const warn = vi.fn()
    const written: CommunicationKey[] = []
    const identifier = keptCommunicationIdentifier(
      { read: () => Promise.reject(new Error("read")), write: async (key) => void written.push(key) },
      warn,
    )
    const sent = await identifier(7)
    expect(fromHex(written[0]!.publicKey)).toEqual(sent)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("does not reuse a kept key whose secret is not behind its public half", async () => {
    const { store, stored } = memoryStore()
    const real = await keptCommunicationIdentifier(store, vi.fn())(7)
    const kept = (await store.read()) as CommunicationKey
    stored.set("individuality.communication-key", { ...kept, secret: "0x" + "11".repeat(32) })
    expect(await keptCommunicationIdentifier(store, vi.fn())(7)).not.toEqual(real)
  })

  it("keeps the key with no game when the sign-up has read none", async () => {
    const { store } = memoryStore()
    const sent = await keptCommunicationIdentifier(store, vi.fn())(undefined)
    const kept = (await store.read()) as CommunicationKey
    expect(kept.gameIndex).toBeNull()
    expect(fromHex(kept.publicKey)).toEqual(sent)
  })
})
