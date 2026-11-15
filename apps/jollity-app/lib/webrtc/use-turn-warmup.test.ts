// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const turn = vi.hoisted(() => ({
  events: [] as string[],
  setTurnPlayerAccount: vi.fn((account: Uint8Array) => {
    turn.events.push(`bind:${Array.from(account).join(",")}`)
  }),
  warmIceServers: vi.fn(async () => {
    turn.events.push("warm")
  }),
}))

vi.mock("./ice", () => ({
  retryIceServers: vi.fn(),
  setTurnPlayerAccount: turn.setTurnPlayerAccount,
  warmIceServers: turn.warmIceServers,
}))

import { warmPlayerIceServers, warmupRefreshDelays } from "./use-turn-warmup"

beforeEach(() => {
  turn.events = []
  turn.setTurnPlayerAccount.mockClear()
  turn.warmIceServers.mockClear()
})

describe("warmupRefreshDelays", () => {
  it("re-arms an early registration at T-10m and T-3m", () => {
    const nowMs = 1_000_000
    const gameAt = nowMs / 1000 + 2 * 60 * 60
    expect(warmupRefreshDelays(gameAt, nowMs)).toEqual([
      110 * 60 * 1000,
      117 * 60 * 1000,
    ])
  })

  it("keeps only the remaining checkpoint for a late registration", () => {
    const nowMs = 1_000_000
    const gameAt = nowMs / 1000 + 5 * 60
    expect(warmupRefreshDelays(gameAt, nowMs)).toEqual([2 * 60 * 1000])
  })
})

describe("warmPlayerIceServers", () => {
  it("binds the playing account before it fetches credentials", async () => {
    const account = new Uint8Array([1, 2, 3])

    await warmPlayerIceServers(account)

    expect(turn.events).toEqual(["bind:1,2,3", "warm"])
  })

  it("waits for a playing account instead of warming an unscoped cache", async () => {
    await warmPlayerIceServers(undefined)

    expect(turn.setTurnPlayerAccount).not.toHaveBeenCalled()
    expect(turn.warmIceServers).not.toHaveBeenCalled()
  })
})
