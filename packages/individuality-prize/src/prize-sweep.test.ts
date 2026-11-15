// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { blake2b } from "@noble/hashes/blake2.js"
import { describe, expect, it } from "vitest"
import { prizeTopUpId, sweepPrizes, topUpErrorOutcome, type TopUpOutcome } from "./prize-sweep"
import type { PrizeBalanceHeld } from "./prize-sweep"

const hash = (bytes: Uint8Array) => blake2b(bytes, { dkLen: 32 })
const account = { namespace: "jollity", product: "dim2.paseo", address: "5GameAccount" }
const PUSD = { assetKey: '{"parents":1}', amount: "60000000" }
const OTHER = { assetKey: '{"parents":0}', amount: "5" }
const EMPTY = { assetKey: '{"parents":2}', amount: "0" }
const CLAIM = { gameIndex: 10, airdropIndex: 0 }

type HostAnswer = (amount: bigint, id: string) => TopUpOutcome

function hostRefusingSeenIds() {
  const seen = new Set<string>()
  let purse = 0n
  const answer: HostAnswer = (amount, id) => {
    if (seen.has(id)) return "already-sent"
    seen.add(id)
    purse += amount
    return "sent"
  }
  return { answer, purse: () => purse }
}

function sweep(balances: PrizeBalanceHeld[], answers: TopUpOutcome[] | HostAnswer = [], claim = CLAIM) {
  const calls: { amount: bigint; id: string }[] = []
  let running = 0
  let overlapped = false
  const result = sweepPrizes({
    balances: async () => balances,
    topUp: async (amount, id) => {
      overlapped ||= running > 0
      running++
      calls.push({ amount, id })
      await Promise.resolve()
      running--
      return typeof answers === "function" ? answers(amount, id) : (answers[calls.length - 1] ?? "sent")
    },
    hash,
    account,
    claim,
  })
  return { result, calls, overlapped: () => overlapped }
}

describe("sweepPrizes", () => {
  it("tops up every positive balance once, one after the other", async () => {
    const { result, calls, overlapped } = sweep([PUSD, EMPTY, OTHER])
    expect(await result).toEqual([
      { assetKey: PUSD.assetKey, amount: 60000000n, outcome: "sent" },
      { assetKey: OTHER.assetKey, amount: 5n, outcome: "sent" },
    ])
    expect(calls.map((call) => call.amount)).toEqual([60000000n, 5n])
    expect(overlapped()).toBe(false)
  })

  it("keeps going after a refused top-up", async () => {
    const { result } = sweep([PUSD, OTHER], ["refused", "sent"])
    expect((await result).map((topUp) => topUp.outcome)).toEqual(["refused", "sent"])
  })

  it("sends nothing for an empty account", async () => {
    const { result, calls } = sweep([])
    expect(await result).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("rejects when the balances cannot be read", async () => {
    await expect(
      sweepPrizes({ balances: () => Promise.reject(new Error("no chain")), topUp: async () => "sent", hash, account, claim: CLAIM }),
    ).rejects.toThrow("no chain")
  })

  it("sends another id for the same balance after the next claim", async () => {
    // Given
    const host = hostRefusingSeenIds()
    const first = sweep([PUSD], host.answer, CLAIM)
    await first.result

    // When
    const second = sweep([PUSD], host.answer, { ...CLAIM, gameIndex: 11 })
    const topUps = await second.result

    // Then
    expect.soft(second.calls[0]?.id).not.toBe(first.calls[0]?.id)
    expect.soft(topUps.map((topUp) => topUp.outcome)).toEqual(["sent"])
    expect.soft(host.purse()).toBe(120000000n)
  })

  it("sends another id for the same balance after another airdrop of the game", async () => {
    // Given
    const host = hostRefusingSeenIds()
    const first = sweep([PUSD], host.answer, CLAIM)
    await first.result

    // When
    const second = sweep([PUSD], host.answer, { ...CLAIM, airdropIndex: 1 })
    const topUps = await second.result

    // Then
    expect.soft(second.calls[0]?.id).not.toBe(first.calls[0]?.id)
    expect.soft(topUps.map((topUp) => topUp.outcome)).toEqual(["sent"])
    expect.soft(host.purse()).toBe(120000000n)
  })
})

describe("prizeTopUpId", () => {
  it("gives the same claim and balance the same 32-byte id", () => {
    const id = prizeTopUpId(hash, account, PUSD, CLAIM)
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(prizeTopUpId(hash, account, { ...PUSD }, { ...CLAIM })).toBe(id)
  })

  it("pins the seed of the id", () => {
    const seed = `jollity:prize:${account.product}:${account.address}:${PUSD.assetKey}:${PUSD.amount}:10:0`
    const pinned = `0x${Buffer.from(hash(new TextEncoder().encode(seed))).toString("hex")}`
    expect(prizeTopUpId(hash, account, PUSD, CLAIM)).toBe(pinned)
  })

  it("gives another product's namespace another id", () => {
    expect(prizeTopUpId(hash, { ...account, namespace: "humanity" }, PUSD, CLAIM)).not.toBe(prizeTopUpId(hash, account, PUSD, CLAIM))
  })

  it("gives another amount, asset, account or product another id", () => {
    const id = prizeTopUpId(hash, account, PUSD, CLAIM)
    expect(prizeTopUpId(hash, account, { ...PUSD, amount: "10000000" }, CLAIM)).not.toBe(id)
    expect(prizeTopUpId(hash, account, OTHER, CLAIM)).not.toBe(id)
    expect(prizeTopUpId(hash, { ...account, address: "5Another" }, PUSD, CLAIM)).not.toBe(id)
    expect(prizeTopUpId(hash, { ...account, product: "dim2.previewnet" }, PUSD, CLAIM)).not.toBe(id)
  })

  it("gives the same balance another id after another claim", () => {
    expect(prizeTopUpId(hash, account, PUSD, { ...CLAIM, gameIndex: 11 })).not.toBe(prizeTopUpId(hash, account, PUSD, CLAIM))
  })

  it("gives the same balance another id after another airdrop of the game", () => {
    expect(prizeTopUpId(hash, account, PUSD, { ...CLAIM, airdropIndex: 1 })).not.toBe(prizeTopUpId(hash, account, PUSD, CLAIM))
  })
})

describe("topUpErrorOutcome", () => {
  const thrown = (tag: string, value?: unknown) =>
    new Error(`payment topUp failed: ${tag}`, { cause: { tag: "Domain", value: { tag: "V1", value: { tag, value } } } })

  it("reads the tag of the host under the SDK error", () => {
    expect(topUpErrorOutcome(thrown("AlreadyExists"))).toBe("already-sent")
    expect(topUpErrorOutcome(thrown("SourceBusy"))).toBe("busy")
    expect(topUpErrorOutcome(thrown("Unknown", { reason: "no coinage" }))).toBe("refused")
    expect(topUpErrorOutcome(thrown("InvalidSource"))).toBe("refused")
  })

  it("refuses an error with no tag", () => {
    expect(topUpErrorOutcome(new Error("timeout"))).toBe("refused")
    expect(topUpErrorOutcome({ tag: "Unsupported" })).toBe("refused")
  })
})
