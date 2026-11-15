// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import type { PeopleClient } from "@individuality/people-chain"
import { claimStanding, evaluateClaimEligibility, fetchPrizeBalances, prizeAssetKey, type ScoreParticipant } from "./prize"

describe("prize balances", () => {
  const PUSD = { parents: 1, interior: { type: "X3", value: [{ type: "Parachain", value: 1500 }, { type: "GeneralIndex", value: 50000413n }] } }
  const OTHER = { parents: 0, interior: { type: "Here" } }

  it("reads the game account in every prize asset and keeps the held ones", async () => {
    const account = vi.fn(async (asset: unknown) => (asset === PUSD ? { balance: 60_000_000n } : undefined))
    const api = {
      query: {
        Airdrop: { SupportedAssets: { getEntries: vi.fn().mockResolvedValue([{ keyArgs: [PUSD] }, { keyArgs: [OTHER] }]) } },
        Assets: { Account: { getValue: account } },
      },
    }

    const balances = await fetchPrizeBalances({ api } as unknown as PeopleClient, "5Game")

    expect(balances).toEqual([{ assetKey: prizeAssetKey(PUSD), amount: 60_000_000n }])
    expect(account).toHaveBeenCalledWith(PUSD, "5Game", { at: "best" })
    expect(prizeAssetKey(PUSD)).toContain('"50000413"')
  })
})

describe("claim eligibility from the score row", () => {
  const row = (overrides: Partial<ScoreParticipant> = {}) =>
    ({
      score: 3,
      streak: { type: "Attended", value: 1 },
      attendance_history: 1,
      credit: 0n,
      cashed_out: false,
      reached_personhood: false,
      has_ever_reached_personhood: false,
      recognition: { type: "NotRecognized", value: undefined },
      last_attended_game: 7,
      ...overrides,
    }) as unknown as ScoreParticipant

  it("reads the recognition, personhood and last game off the row", () => {
    expect(claimStanding(row({ recognition: { type: "ExternallyRecognized", value: 1n } } as never))).toEqual({
      recognized: true,
      reachedPersonhood: false,
      lastAttendedGame: 7,
    })
    expect(claimStanding(undefined)).toBeUndefined()
  })

  it("pays a member of the last game attended, and no candidate", () => {
    expect(evaluateClaimEligibility(row({ reached_personhood: true }), 7).eligible).toBe(true)
    expect(evaluateClaimEligibility(row(), 7)).toMatchObject({ eligible: false, personhood: false })
  })
})
