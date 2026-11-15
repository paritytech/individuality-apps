// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { getClaims } from "@parity/product-sdk-nfts"
import { readGameCredits, type ClaimsChain } from "./credits"

vi.mock("@parity/product-sdk-nfts", () => ({ getClaims: vi.fn() }))

const chain = {} as ClaimsChain

beforeEach(() => {
  vi.mocked(getClaims).mockReset()
})

describe("the credits a game earned, read", () => {
  it("counts the game's credits from the claims of the player's account", async () => {
    // Given
    vi.mocked(getClaims).mockResolvedValue({
      ok: true,
      value: { claims: [{ gameIndex: 7, state: "claimable" }, { gameIndex: null, state: "earned" }] },
    } as never)

    // When
    const credits = await readGameCredits(chain, { address: "5F...", gameIndex: 7, latestGame: true })

    // Then
    expect(credits).toEqual({ total: 2, pending: 1, claimable: 1, claimed: 0 })
    expect(getClaims).toHaveBeenCalledWith(chain, { claimant: { tag: "Account", address: "5F..." }, individualityAt: "best" })
  })

  it("answers null for a read that failed", async () => {
    vi.mocked(getClaims).mockResolvedValue({ ok: false, error: new Error("no Asset Hub") } as never)
    expect(await readGameCredits(chain, { address: "5F...", gameIndex: 7, latestGame: true })).toBeNull()
  })
})
