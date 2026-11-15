// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { ASK_UNDER_WAY_MS, askUnderClaim, askUnderWay, cancelNextGame, remindNextGame, type HostReminder } from "./reminder"

const ok = () => Promise.resolve({ isOk: () => true })
const err = (error: unknown) => Promise.resolve({ isOk: () => false, error })

describe("remindNextGame", () => {
  it("sends the start in whole milliseconds as a bigint", async () => {
    const remind = vi.fn(ok)
    const outcome = await remindNextGame({ game: { remindNextGame: remind, cancelNextGame: ok } }, 1_700_000_000_000.4)
    expect(outcome).toBe("held")
    expect(remind).toHaveBeenCalledWith({ startsAt: 1_700_000_000_000n })
  })

  it("names the refusals of the host", async () => {
    const answering = (error: unknown) => ({ game: { remindNextGame: () => err(error), cancelNextGame: ok } })
    expect(await remindNextGame(answering({ tag: "Unsupported" }), 1)).toBe("unsupported")
    expect(await remindNextGame(answering({ tag: "Denied" }), 1)).toBe("denied")
    expect(await remindNextGame(answering({ tag: "Domain", value: { tag: "V1", value: "StartsInPast" } }), 1)).toBe("starts-in-past")
    expect(await remindNextGame(answering({ tag: "HostFailure", value: { reason: "no alarm" } }), 1)).toBe("failed")
  })

  it("answers failed when the call throws", async () => {
    const throwing = { game: { remindNextGame: () => Promise.reject(new Error("gone")), cancelNextGame: ok } }
    expect(await remindNextGame(throwing, 1)).toBe("failed")
  })

  it("passes the refusal of the host on in its own words", async () => {
    const answering = (error: unknown) => ({ game: { remindNextGame: () => err(error), cancelNextGame: ok } })
    const reasons: string[] = []
    const onError = (text: string) => void reasons.push(text)

    await remindNextGame(answering({ tag: "HostFailure", value: { reason: "notifications are off" } }), 1, onError)
    await remindNextGame(answering({ tag: "Domain", value: { tag: "V1", value: "StartsInPast" } }), 1, onError)
    await remindNextGame(answering({ tag: "Domain", value: { tag: "V2", value: { reason: "busy" } } }), 1, onError)
    await remindNextGame(answering({ tag: "Unsupported" }), 1, onError)
    await remindNextGame(answering(undefined), 1, onError)

    expect(reasons).toEqual(["HostFailure: notifications are off", "Domain.V1: StartsInPast", "Domain.V2: busy", "Unsupported", "undefined"])
  })

  it("passes the error of a call that throws on", async () => {
    const onError = vi.fn()

    await remindNextGame({ game: { remindNextGame: () => Promise.reject(new TypeError("gone")), cancelNextGame: ok } }, 1, onError)

    expect(onError).toHaveBeenCalledWith("TypeError: gone")
  })

  it("passes nothing on when the host holds the reminder", async () => {
    const onError = vi.fn()

    await remindNextGame({ game: { remindNextGame: ok, cancelNextGame: ok } }, 1, onError)

    expect(onError).not.toHaveBeenCalled()
  })
})

describe("cancelNextGame", () => {
  it("drops the reminder with an empty request", async () => {
    const cancel = vi.fn(ok)
    expect(await cancelNextGame({ game: { remindNextGame: ok, cancelNextGame: cancel } })).toBe("dropped")
    expect(cancel).toHaveBeenCalledWith({})
  })

  it("takes a domain error of the cancel as a failure to retry", async () => {
    const failing = { game: { remindNextGame: ok, cancelNextGame: () => err({ tag: "Domain", value: { tag: "V1", value: { reason: "busy" } } }) } }
    expect(await cancelNextGame(failing)).toBe("failed")
  })

  it("passes the refusal of the cancel on in its own words", async () => {
    const onError = vi.fn()
    const failing = { game: { remindNextGame: ok, cancelNextGame: () => err({ tag: "Domain", value: { tag: "V1", value: { reason: "busy" } } }) } }

    await cancelNextGame(failing, onError)

    expect(onError).toHaveBeenCalledWith("Domain.V1: busy")
  })
})

describe("askUnderClaim", () => {
  function memoryStore(initial: HostReminder | null = null) {
    let record = initial
    return {
      get record() {
        return record
      },
      store: {
        read: async () => record,
        write: async (next: HostReminder) => {
          record = next
        },
      },
      set(next: HostReminder | null) {
        record = next
      },
    }
  }

  it("records the start before it asks, then the answer", async () => {
    const memory = memoryStore()
    const seen: (HostReminder | null)[] = []
    const ask = vi.fn(async () => {
      seen.push(memory.record)
      return "held" as const
    })

    const outcome = await askUnderClaim(ask, memory.store, null, 1_700_000_000, 1_700_000_000_000.4)

    expect(outcome).toBe("held")
    expect(ask).toHaveBeenCalledWith(1_700_000_000_000)
    expect(seen[0]).toMatchObject({ gamePlayTime: 1_700_000_000, startsAt: 1_700_000_000_000, outcome: "asking" })
    expect(memory.record).toMatchObject({ gamePlayTime: 1_700_000_000, startsAt: 1_700_000_000_000, outcome: "held" })
  })

  it("sends the start the record holds for the same game", async () => {
    const stored: HostReminder = { gamePlayTime: 1_700_000_000, startsAt: 1_700_000_000_000, outcome: "failed", at: 1 }
    const ask = vi.fn(async () => "held" as const)

    await askUnderClaim(ask, memoryStore(stored).store, stored, 1_700_000_000, 1_700_000_004_000)

    expect(ask).toHaveBeenCalledWith(1_700_000_000_000)
  })

  it("asks nothing when the claim cannot be written", async () => {
    const ask = vi.fn(async () => "held" as const)
    const store = { read: async () => null, write: () => Promise.reject(new Error("full")) }

    expect(await askUnderClaim(ask, store, null, 1_700_000_000, 1)).toBe("unrecorded")
    expect(ask).not.toHaveBeenCalled()
  })

  it("leaves a newer record alone when the answer comes late", async () => {
    const memory = memoryStore()
    const newer: HostReminder = { gamePlayTime: 1_700_000_000, outcome: "dropped", at: 2 }
    const ask = vi.fn(async () => {
      memory.set(newer)
      return "held" as const
    })

    await askUnderClaim(ask, memory.store, null, 1_700_000_000, 1)

    expect(memory.record).toBe(newer)
  })
})

describe("askUnderWay works", () => {
  const GAME = 1_700_000_000
  const NOW = 1_800_000_000_000

  it.each([
    ["a claim for the game younger than a host call gets", true, { gamePlayTime: GAME, outcome: "asking", at: NOW - ASK_UNDER_WAY_MS + 1 }],
    ["a claim for the game as old as a host call gets", false, { gamePlayTime: GAME, outcome: "asking", at: NOW - ASK_UNDER_WAY_MS }],
    ["a fresh claim for another game", false, { gamePlayTime: GAME - 3600, outcome: "asking", at: NOW }],
    ["a fresh answer for the game", false, { gamePlayTime: GAME, outcome: "failed", at: NOW }],
    ["no record", false, null],
  ] as const)("on %s answers %s", (_, underWay, record) => {
    // Given / When / Then
    expect(askUnderWay(record, GAME, NOW)).toBe(underWay)
  })
})
