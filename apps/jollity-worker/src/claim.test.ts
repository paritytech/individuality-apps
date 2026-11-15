// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DispatchResult, PalletPrizeBalance } from "@jollity/protocol"
import { prizeTopUpId, type TopUpOutcome } from "@individuality/prize"
import { blake2b256 } from "./host"

const PRIZE = { assetKey: '{"parents":1}', amount: "60000000" }

const failures: [string, string][] = []
vi.mock("./telemetry", () => ({
  chatCount: () => {},
  chatFailure: (kind: string, reason: string) => void failures.push([kind, reason]),
}))

const { createClaims } = await import("./claim")
type ClaimHost = Parameters<typeof createClaims>[0]["host"]

function claimsWith(options: {
  signer?: boolean
  sends: (DispatchResult | Error)[]
  claimed?: (boolean | undefined)[]
  balances?: () => Promise<PalletPrizeBalance[]>
  topUp?: TopUpOutcome
}) {
  const sent: number[] = []
  const topUps: [number, bigint, string][] = []
  let reads = 0
  const host = {
    accounts: { signer: async () => (options.signer === false ? null : {}) },
    topUp: async (index: number, amount: bigint, id: string) => {
      topUps.push([index, amount, id])
      return options.topUp ?? "sent"
    },
  } as unknown as ClaimHost
  const claims = createClaims({
    host,
    connect: async () => ({
      address: "5Player",
      engine: {
        claimPrize: async () => {
          const next = options.sends[sent.length]!
          sent.push(sent.length)
          if (next instanceof Error) throw next
          return next
        },
        prizeBalances: options.balances ?? (async () => [PRIZE]),
      },
    }),
    claimed: async () => (options.claimed ?? [false])[Math.min(reads++, (options.claimed ?? [false]).length - 1)],
    account: { name: "jollity", index: 0 },
    sleep: async () => {},
  })
  return { claims, sent, topUps }
}

describe("the claim of the card", () => {
  beforeEach(() => void failures.splice(0))

  it("claims and says so", async () => {
    const { claims, sent } = claimsWith({ sends: [{ ok: true }] })
    await claims.claim(7, 0)
    expect(claims.state(7)).toEqual({ kind: "claimed" })
    expect(sent).toHaveLength(1)
    expect(failures).toEqual([])
  })

  it("lets the player claim again after closing the signing sheet", async () => {
    const { claims, sent } = claimsWith({ sends: [{ ok: false, error: "signing was rejected" }, { ok: true }] })
    await claims.claim(7, 0)
    expect(claims.state(7)).toEqual({ kind: "failed", failure: "cancelled", detail: "signing was rejected" })
    expect(failures).toEqual([["claim-failed", "cancelled"]])
    await claims.claim(7, 0)
    expect(claims.state(7)).toEqual({ kind: "claimed" })
    expect(sent).toHaveLength(2)
  })

  it("takes no tap after a refusal", async () => {
    const { claims, sent } = claimsWith({ sends: [{ ok: false, error: "NotWinner" }] })
    await claims.claim(7, 0)
    expect(claims.state(7)).toEqual({ kind: "failed", failure: "refused", detail: "NotWinner" })
    await claims.claim(7, 0)
    expect(sent).toHaveLength(1)
  })

  it("gives up after every automatic send dropped", async () => {
    const dropped = new Error("socket closed")
    const { claims, sent } = claimsWith({ sends: [dropped, dropped, dropped, dropped] })
    await claims.claim(7, 0)
    expect(claims.state(7)).toEqual({ kind: "failed", failure: "failed", detail: "socket closed" })
    expect(sent).toHaveLength(4)
    expect(failures).toEqual([["claim-failed", "failed"]])
  })

  it("fails without a signer and sends nothing", async () => {
    const { claims, sent } = claimsWith({ signer: false, sends: [] })
    await claims.claim(7, 0)
    expect(claims.state(7)).toEqual({ kind: "failed", failure: "failed", detail: "no signer" })
    expect(sent).toHaveLength(0)
  })

  it("hands the game account to the CASH purse once the claim lands", async () => {
    const { claims, topUps } = claimsWith({ sends: [{ ok: true }] })
    await claims.claim(7, 1)
    const id = prizeTopUpId(blake2b256, { namespace: "jollity", product: "jollity", address: "5Player" }, PRIZE, { gameIndex: 7, airdropIndex: 1 })
    expect(topUps).toEqual([[0, 60_000_000n, id]])
  })

  it("hands a second win of the same amount to the purse under another id", async () => {
    // Given
    const { claims, topUps } = claimsWith({ sends: [{ ok: true }, { ok: true }] })

    // When
    await claims.claim(7, 0)
    await claims.claim(8, 0)

    // Then
    expect(topUps.map(([, amount]) => amount)).toEqual([60_000_000n, 60_000_000n])
    expect(topUps[1]![2]).not.toBe(topUps[0]![2])
  })

  it("tops up nothing when the claim does not land", async () => {
    const { claims, topUps } = claimsWith({ sends: [{ ok: false, error: "NotWinner" }] })
    await claims.claim(7, 0)
    expect(topUps).toEqual([])
  })

  it("keeps the claim claimed when the top-up is refused or the balances are unread", async () => {
    const refused = claimsWith({ sends: [{ ok: true }], topUp: "refused" })
    await refused.claims.claim(7, 0)
    expect(refused.claims.state(7)).toEqual({ kind: "claimed" })
    expect(failures).toEqual([["prize-topup-failed", "refused"]])
    const unread = claimsWith({ sends: [{ ok: true }], balances: () => Promise.reject(new Error("no chain")) })
    await unread.claims.claim(8, 0)
    expect(unread.claims.state(8)).toEqual({ kind: "claimed" })
    expect(unread.topUps).toEqual([])
  })

  it("reports nothing for a busy, already-sent or no-host top-up", async () => {
    for (const topUp of ["busy", "already-sent", "no-host"] as const) {
      const { claims, topUps } = claimsWith({ sends: [{ ok: true }], topUp })
      await claims.claim(7, 0)
      expect(topUps).toHaveLength(1)
    }
    expect(failures).toEqual([])
  })
})
