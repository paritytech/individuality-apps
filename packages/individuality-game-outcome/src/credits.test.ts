// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { gameCredits, type Credit } from "./credits"

const credits: Credit[] = [
  { gameIndex: 7, state: "claimable" },
  { gameIndex: 7, state: "claimed" },
  { gameIndex: 7, state: "unprovable" },
  { gameIndex: null, state: "earned" },
  { gameIndex: 6, state: "claimable" },
]

describe("the credits a game earned", () => {
  it("counts the game's own and, while it is the last one attended, those still waiting for a root", () => {
    expect(gameCredits(credits, 7, true)).toEqual({ total: 3, pending: 1, claimable: 1, claimed: 1 })
  })

  it("leaves the rootless credits to the later game once another was attended", () => {
    expect(gameCredits(credits, 7, false)).toEqual({ total: 2, pending: 0, claimable: 1, claimed: 1 })
  })

  it("never counts a credit a claim cannot prove, or another game's", () => {
    expect(gameCredits(credits, 6, false)).toEqual({ total: 1, pending: 0, claimable: 1, claimed: 0 })
  })
})
