// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  topUp: vi.fn(),
  reportFailure: vi.fn(),
}))
vi.mock("./host/prize-topup", () => ({ topUpPrize: mocks.topUp }))
vi.mock("./telemetry", () => ({ reportFailure: mocks.reportFailure }))

import { productAccount } from "@jollity/protocol"
import { prizeTopUpId } from "@individuality/prize"
import { blake2b256 } from "./host/turn-proof"
import { sweepClaimedPrizes } from "./prize-sweep"

const PUSD = { assetKey: '{"parents":1}', amount: "60000000" }
const CLAIM = { gameIndex: 10, airdropIndex: 1 }

beforeEach(() => {
  mocks.topUp.mockReset()
  mocks.reportFailure.mockReset()
})

describe("sweepClaimedPrizes", () => {
  it("tops up the balance of the game account under one id for one balance", async () => {
    mocks.topUp.mockResolvedValue("sent")
    const balances = vi.fn(async () => [PUSD])
    await sweepClaimedPrizes("5Game", balances, CLAIM)
    await sweepClaimedPrizes("5Game", balances, CLAIM)
    expect(balances).toHaveBeenCalledWith("5Game")
    expect(mocks.topUp).toHaveBeenCalledTimes(2)
    const [first, second] = mocks.topUp.mock.calls
    expect(first![0]).toBe(60_000_000n)
    expect(first![1]).toBe(prizeTopUpId(blake2b256, { namespace: "jollity", product: productAccount(), address: "5Game" }, PUSD, CLAIM))
    expect(second![1]).toBe(first![1])
    expect(mocks.reportFailure).not.toHaveBeenCalled()
  })

  it("sends another id for the same balance after another claim", async () => {
    // Given
    mocks.topUp.mockResolvedValue("sent")
    const balances = async () => [PUSD]

    // When
    await sweepClaimedPrizes("5Game", balances, CLAIM)
    await sweepClaimedPrizes("5Game", balances, { ...CLAIM, gameIndex: 11 })

    // Then
    const [first, second] = mocks.topUp.mock.calls
    expect(second![0]).toBe(first![0])
    expect(second![1]).not.toBe(first![1])
  })

  it("reports a refused or timed out top-up", async () => {
    mocks.topUp.mockResolvedValueOnce("refused").mockResolvedValueOnce("timeout")
    await sweepClaimedPrizes("5Game", async () => [PUSD, { assetKey: "other", amount: "5" }], CLAIM)
    expect(mocks.reportFailure.mock.calls.map(([kind, details]) => [kind, details.reason])).toEqual([
      ["prize-topup-failed", "refused"],
      ["prize-topup-failed", "timeout"],
    ])
  })

  it("reports nothing for busy, already-sent or no-host", async () => {
    mocks.topUp.mockResolvedValueOnce("busy").mockResolvedValueOnce("already-sent").mockResolvedValueOnce("no-host")
    await sweepClaimedPrizes("5Game", async () => [PUSD, { assetKey: "other", amount: "5" }, { assetKey: "third", amount: "7" }], CLAIM)
    expect(mocks.topUp).toHaveBeenCalledTimes(3)
    expect(mocks.reportFailure).not.toHaveBeenCalled()
  })

  it("never throws on a failed balance read", async () => {
    expect(await sweepClaimedPrizes("5Game", () => Promise.reject(new Error("no chain")), CLAIM)).toEqual([])
    expect(mocks.topUp).not.toHaveBeenCalled()
  })

})
