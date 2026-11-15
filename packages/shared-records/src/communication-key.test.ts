// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  COMMUNICATION_KEY_KEY,
  communicationKeyStore,
  fromHex,
  matchCommunicationKey,
  parseCommunicationKey,
  toHex,
  type CommunicationKey,
} from "./communication-key"

const pub = (byte: number) => toHex(new Uint8Array(65).fill(byte))
const key = (gameIndex: number | null, byte: number): CommunicationKey => ({
  version: 1,
  gameIndex,
  publicKey: pub(byte),
  secret: toHex(new Uint8Array(32).fill(byte)),
  at: 1,
})

describe("communication key", () => {
  it("round-trips hex", () => {
    expect(fromHex(toHex(new Uint8Array([0, 1, 255])))).toEqual(new Uint8Array([0, 1, 255]))
  })

  it("rejects malformed records and other versions", () => {
    expect(parseCommunicationKey(null)).toBeNull()
    expect(parseCommunicationKey({ ...key(7, 4), publicKey: "0x04" })).toBeNull()
    expect(parseCommunicationKey({ ...key(7, 4), secret: "nope" })).toBeNull()
    expect(parseCommunicationKey({ ...key(7, 4), version: 2 })).toBeNull()
    expect(parseCommunicationKey({ ...key(7, 4), gameIndex: 1.5 })).toBeNull()
    expect(parseCommunicationKey(key(7, 4))).toEqual(key(7, 4))
    expect(parseCommunicationKey(key(null, 4))).toEqual(key(null, 4))
  })

  it("keeps the key whose public half the chain holds, from either store", () => {
    const jollity = key(7, 1)
    const humanity = key(7, 2)
    expect(matchCommunicationKey([jollity, humanity], fromHex(pub(2)))).toEqual(humanity)
    expect(matchCommunicationKey([jollity, humanity], pub(1).toUpperCase().replace("0X", "0x"))).toEqual(jollity)
  })

  it("finds a key filed under another game, and none the chain does not hold", () => {
    expect(matchCommunicationKey([key(6, 1)], pub(1))).toEqual(key(6, 1))
    expect(matchCommunicationKey([key(7, 1), null], pub(3))).toBeNull()
  })

  it("writes and reads under its key", async () => {
    const stored = new Map<string, unknown>()
    const store = communicationKeyStore(async () => ({
      readJSON: async (k) => stored.get(k) ?? null,
      writeJSON: async (k, v) => void stored.set(k, v),
    }))
    await store.write(key(7, 1))
    expect(stored.has(COMMUNICATION_KEY_KEY)).toBe(true)
    expect(await store.read()).toEqual(key(7, 1))
  })

  it("rejects a write with no storage to keep it in", async () => {
    await expect(communicationKeyStore(async () => null).write(key(7, 1))).rejects.toThrow()
    await expect(communicationKeyStore(async () => ({ readJSON: async () => null })).write(key(7, 1))).rejects.toThrow()
  })
})
