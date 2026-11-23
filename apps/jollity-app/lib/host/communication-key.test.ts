// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { COMMUNICATION_KEY_KEY, fromHex } from "@individuality/shared-records"
import { communicationKeyFrom } from "@individuality/sign-up"
import { COMMUNICATION_ENTROPY_CONTEXT } from "@jollity/protocol"

const host = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  humanity: new Map<string, unknown>(),
  deriveEntropy: vi.fn(),
  /** the next read of this product's storage never answers */
  hangNextRead: false,
  /** Humanity's storage rejects every read with this */
  humanityError: null as unknown,
  logs: [] as string[],
}))

vi.mock("../debug/log-store", () => ({ devLog: (_tag: string, message: string) => void host.logs.push(message) }))
vi.mock("@parity/product-sdk-host", () => ({ deriveEntropy: host.deriveEntropy }))
vi.mock("./storage", () => ({
  hostStorage: async () => ({
    readJSON: (key: string) => {
      if (host.hangNextRead) {
        host.hangNextRead = false
        return new Promise(() => {})
      }
      return Promise.resolve(host.stored.get(key) ?? null)
    },
    writeJSON: async (key: string, value: unknown) => void host.stored.set(key, value),
  }),
}))

vi.mock("./game-registration", () => ({
  humanityStorage: async () => ({
    readJSON: async (key: string) => {
      if (host.humanityError) throw host.humanityError
      return host.humanity.get(key) ?? null
    },
  }),
}))

import { communicationKeyRecord, freshCommunicationKey } from "@individuality/sign-up"
import { communicationIdentifier, lookUpSignallingSecret, signallingSecret } from "./communication-key"
import { HostReadRefused } from "./error-detail"

const ENTROPY = new Uint8Array(32).fill(5)

beforeEach(() => {
  host.stored.clear()
  host.humanity.clear()
  host.deriveEntropy.mockReset()
  host.hangNextRead = false
  host.humanityError = null
  host.logs.length = 0
})

describe("the app's communication key", () => {
  it("is the one the chat derives for the game, kept in this product's storage and sent again", async () => {
    host.deriveEntropy.mockResolvedValue({ ok: true, value: ENTROPY })

    const sent = await communicationIdentifier(7)
    const kept = host.stored.get(COMMUNICATION_KEY_KEY) as { gameIndex: number; publicKey: string }

    expect(host.deriveEntropy).toHaveBeenCalledWith(COMMUNICATION_ENTROPY_CONTEXT)
    expect(sent).toEqual(communicationKeyFrom(ENTROPY, 7).publicKey)
    expect(kept.gameIndex).toBe(7)
    expect(fromHex(kept.publicKey)).toEqual(sent)
    expect(await communicationIdentifier(7)).toEqual(sent)
  })

  it("keeps a random key when the host gives no entropy", async () => {
    host.deriveEntropy.mockResolvedValue({ ok: false, error: new Error("denied") })

    const sent = await communicationIdentifier(8)
    const kept = host.stored.get(COMMUNICATION_KEY_KEY) as { gameIndex: number; publicKey: string }

    expect(sent).toHaveLength(65)
    expect(kept.gameIndex).toBe(8)
    expect(fromHex(kept.publicKey)).toEqual(sent)
  })
})

describe("the secret the game's signalling is sealed with", () => {
  const engine = (identifier: Uint8Array | null, gameIndex = 9) => ({
    communicationIdentifier: vi.fn(async () => identifier),
    game: vi.fn(async () => ({ index: gameIndex }) as never),
  })

  it("is the secret of whichever kept key the chain holds: this product's or Humanity's", async () => {
    const jollity = freshCommunicationKey()
    const humanity = freshCommunicationKey()
    host.stored.set(COMMUNICATION_KEY_KEY, communicationKeyRecord(9, jollity))
    host.humanity.set(COMMUNICATION_KEY_KEY, communicationKeyRecord(9, humanity))

    expect(await signallingSecret("alice", engine(humanity.publicKey))).toEqual(humanity.secret)
    expect(await signallingSecret("alice", engine(jollity.publicKey))).toEqual(jollity.secret)
  })

  it("is the one the entropy derives for the game when no kept key matches", async () => {
    host.deriveEntropy.mockResolvedValue({ ok: true, value: ENTROPY })
    const derived = communicationKeyFrom(ENTROPY, 11)

    expect(await signallingSecret("bob", engine(derived.publicKey, 11))).toEqual(derived.secret)
  })

  it("is null with no identifier on chain or no key that matches it, and asked again after", async () => {
    host.deriveEntropy.mockResolvedValue({ ok: false, error: new Error("denied") })
    const lost = freshCommunicationKey()

    expect(await signallingSecret("carol", engine(null))).toBeNull()
    expect(await signallingSecret("carol", engine(lost.publicKey))).toBeNull()

    host.humanity.set(COMMUNICATION_KEY_KEY, communicationKeyRecord(9, lost))
    expect(await signallingSecret("carol", engine(lost.publicKey))).toEqual(lost.secret)
  })

  it("passes over a corrupt record to a sound one behind it", async () => {
    host.deriveEntropy.mockResolvedValue({ ok: false, error: new Error("denied") })
    const real = freshCommunicationKey()
    const corrupt = { ...communicationKeyRecord(9, real), secret: communicationKeyRecord(9, freshCommunicationKey()).secret }
    host.stored.set(COMMUNICATION_KEY_KEY, corrupt)
    host.humanity.set(COMMUNICATION_KEY_KEY, communicationKeyRecord(9, real))

    expect(await signallingSecret("erin", engine(real.publicKey))).toEqual(real.secret)
  })

  it("is null for a kept record whose secret is not the one behind the identifier", async () => {
    host.deriveEntropy.mockResolvedValue({ ok: false, error: new Error("denied") })
    const real = freshCommunicationKey()
    const forged = { ...communicationKeyRecord(9, real), secret: communicationKeyRecord(9, freshCommunicationKey()).secret }
    host.humanity.set(COMMUNICATION_KEY_KEY, forged)

    expect(await signallingSecret("dave", engine(real.publicKey))).toBeNull()
  })

  it("is asked afresh after a lookup that never answered: the transport gives one up and tries again", async () => {
    const derived = communicationKeyFrom(ENTROPY, 12)
    host.deriveEntropy.mockReturnValueOnce(new Promise(() => {})) // the host never answers
    void signallingSecret("frank", engine(derived.publicKey, 12))
    await vi.waitFor(() => expect(host.deriveEntropy).toHaveBeenCalledTimes(1))

    host.deriveEntropy.mockResolvedValue({ ok: true, value: ENTROPY })
    // a hung first lookup kept as the answer would hang this one too (the test's timeout)
    expect(await signallingSecret("frank", engine(derived.publicKey, 12))).toEqual(derived.secret)
  })

  it("gives up a storage read that hangs, and finds the secret once the storage answers again", async () => {
    vi.useFakeTimers()
    try {
      host.deriveEntropy.mockResolvedValue({ ok: false, error: new Error("denied") })
      const kept = freshCommunicationKey()
      host.stored.set(COMMUNICATION_KEY_KEY, communicationKeyRecord(9, kept))
      host.hangNextRead = true

      // the hung read is given up on its own, not left for the transport's timeout
      const first = signallingSecret("grace", engine(kept.publicKey))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await first).toBeNull()
      // told as a read that hung, not as a key that is missing
      expect(host.logs.some((line) => line.includes("gave no answer"))).toBe(true)
      expect(host.logs.some((line) => line.includes("no kept key matches"))).toBe(false)

      // the storage answers again: the next try finds the secret
      expect(await signallingSecret("grace", engine(kept.publicKey))).toEqual(kept.secret)
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives up an identifier read that hangs, and says so", async () => {
    vi.useFakeTimers()
    try {
      const hung = { communicationIdentifier: vi.fn(() => new Promise<Uint8Array | null>(() => {})), game: vi.fn(async () => ({ index: 9 }) as never) }
      const first = signallingSecret("heidi", hung)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await first).toBeNull()
      expect(host.logs.some((line) => line.includes("identifier on chain gave no answer"))).toBe(true)
      expect(host.logs.some((line) => line.includes("no communication identifier on chain"))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("why this player's own key was or was not found", () => {
  const engine = (identifier: Uint8Array | null, gameIndex = 9) => ({
    communicationIdentifier: vi.fn(async () => identifier),
    game: vi.fn(async () => ({ index: gameIndex }) as never),
  })

  beforeEach(() => {
    host.deriveEntropy.mockResolvedValue({ ok: false, error: new Error("denied") })
  })

  it("says read-refused when Humanity's storage refuses the read and no key matches, and keeps the host's words", async () => {
    host.humanityError = new HostReadRefused("peopl.paseo", "AccessNotGranted")

    const lookup = await lookUpSignallingSecret("ivan", engine(freshCommunicationKey().publicKey))

    expect(lookup).toEqual({
      secret: null,
      cause: "read-refused",
      reads: { own: "answered", humanity: "refused" },
      refusal: "AccessNotGranted",
    })
  })

  it("says no-identifier when the chain holds none for the player", async () => {
    expect(await lookUpSignallingSecret("judy", engine(null))).toEqual({ secret: null, cause: "no-identifier" })
  })

  it("says no-match when every read answered and no key matches", async () => {
    host.humanity.set(COMMUNICATION_KEY_KEY, communicationKeyRecord(9, freshCommunicationKey()))

    const lookup = await lookUpSignallingSecret("kim", engine(freshCommunicationKey().publicKey))

    expect(lookup).toEqual({ secret: null, cause: "no-match", reads: { own: "answered", humanity: "answered" } })
  })

  it("says failed for a read that broke without a refusal, and no-match for the lookup", async () => {
    host.humanityError = new Error("bridge closed")

    const lookup = await lookUpSignallingSecret("leo", engine(freshCommunicationKey().publicKey))

    expect(lookup).toMatchObject({ secret: null, cause: "no-match", reads: { own: "answered", humanity: "failed" } })
  })

  it("says no-answer when a read hangs, for the kept keys and for the identifier", async () => {
    vi.useFakeTimers()
    try {
      host.hangNextRead = true
      const kept = lookUpSignallingSecret("mia", engine(freshCommunicationKey().publicKey))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await kept).toEqual({ secret: null, cause: "no-answer", reads: { own: "no-answer", humanity: "answered" } })

      const hung = { communicationIdentifier: vi.fn(() => new Promise<Uint8Array | null>(() => {})), game: vi.fn(async () => ({ index: 9 }) as never) }
      const identifier = lookUpSignallingSecret("mia", hung)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await identifier).toEqual({ secret: null, cause: "no-answer" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("says read-refused over no-answer: the refusal is why nothing could match", async () => {
    vi.useFakeTimers()
    try {
      host.hangNextRead = true
      host.humanityError = new HostReadRefused("peopl.paseo", "AccessNotGranted")
      const lookup = lookUpSignallingSecret("nora", engine(freshCommunicationKey().publicKey))
      await vi.advanceTimersByTimeAsync(5_000)
      expect((await lookup).cause).toBe("read-refused")
    } finally {
      vi.useRealTimers()
    }
  })

  it("names the key that matched: this product's, Humanity's or the derived one, also once it is kept", async () => {
    const jollity = freshCommunicationKey()
    const humanity = freshCommunicationKey()
    host.stored.set(COMMUNICATION_KEY_KEY, communicationKeyRecord(9, jollity))
    host.humanity.set(COMMUNICATION_KEY_KEY, communicationKeyRecord(9, humanity))

    expect(await lookUpSignallingSecret("olga", engine(jollity.publicKey))).toMatchObject({ secret: jollity.secret, cause: "found", source: "jollity" })
    expect(await lookUpSignallingSecret("olga", engine(humanity.publicKey))).toMatchObject({ secret: humanity.secret, cause: "found", source: "humanity" })
    expect(await lookUpSignallingSecret("olga", engine(humanity.publicKey))).toEqual({ secret: humanity.secret, cause: "found", source: "humanity" })

    host.deriveEntropy.mockResolvedValue({ ok: true, value: ENTROPY })
    const derived = communicationKeyFrom(ENTROPY, 13)
    expect(await lookUpSignallingSecret("olga", engine(derived.publicKey, 13))).toMatchObject({ secret: derived.secret, cause: "found", source: "derived" })
  })
})
