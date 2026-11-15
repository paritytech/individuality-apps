// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

const sdk = vi.hoisted(() => ({ payments: null as unknown }))
vi.mock("@parity/product-sdk-host", () => ({ getPaymentManager: async () => sdk.payments }))

import { topUpPrize } from "./prize-topup"

afterEach(() => vi.useRealTimers())

const ID = `0x${"ab".repeat(32)}` as const
const refusal = (tag: string) =>
  new Error(`payment topUp failed: ${tag}`, { cause: { tag: "Domain", value: { tag: "V1", value: { tag } } } })

describe("topUpPrize", () => {
  it("tops up from the game account under the id", async () => {
    const topUp = vi.fn(async () => {})
    sdk.payments = { topUp }
    expect(await topUpPrize(60_000_000n, ID)).toBe("sent")
    expect(topUp).toHaveBeenCalledWith({
      id: ID,
      amount: 60_000_000n,
      source: { tag: "ProductAccount", value: { derivationIndex: { tag: "Index", value: 1 } } },
    })
  })

  it("is no-host outside a host", async () => {
    sdk.payments = null
    expect(await topUpPrize(1n, ID)).toBe("no-host")
  })

  it("names the refusals of the host", async () => {
    sdk.payments = { topUp: async () => Promise.reject(refusal("AlreadyExists")) }
    expect(await topUpPrize(1n, ID)).toBe("already-sent")
    sdk.payments = { topUp: async () => Promise.reject(refusal("SourceBusy")) }
    expect(await topUpPrize(1n, ID)).toBe("busy")
    sdk.payments = { topUp: async () => Promise.reject(refusal("InvalidSource")) }
    expect(await topUpPrize(1n, ID)).toBe("refused")
  })

  it("gives up after ten seconds", async () => {
    vi.useFakeTimers()
    sdk.payments = { topUp: () => new Promise(() => {}) }
    const pending = topUpPrize(1n, ID)
    await vi.advanceTimersByTimeAsync(10_100)
    expect(await pending).toBe("timeout")
  })
})
