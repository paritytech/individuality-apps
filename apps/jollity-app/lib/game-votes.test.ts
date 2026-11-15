// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const S = vi.hoisted(() => ({ value: null as string | null, fail: false }))
vi.mock("./host/storage", () => ({
  tryReadStoredString: async () => (S.fail ? { ok: false } : { ok: true, value: S.value }),
  writeStoredJSON: async () => {},
}))

import { readStoredVotesGame } from "./game-votes"

beforeEach(() => {
  S.value = null
  S.fail = false
})

describe("readStoredVotesGame tells unreadable from absent", () => {
  it("names the game this account's books are for", async () => {
    S.value = JSON.stringify({ gameIndex: 7, account: "5A" })
    expect(await readStoredVotesGame("5A")).toEqual({ ok: true, gameIndex: 7 })
  })
  it("reads no books as absent", async () => {
    expect(await readStoredVotesGame("5A")).toEqual({ ok: true, gameIndex: undefined })
  })
  it("reads another account's books as absent", async () => {
    S.value = JSON.stringify({ gameIndex: 7, account: "5B" })
    expect(await readStoredVotesGame("5A")).toEqual({ ok: true, gameIndex: undefined })
  })
  it("reads a failed storage read as unreadable, not absent", async () => {
    S.fail = true
    expect(await readStoredVotesGame("5A")).toEqual({ ok: false })
  })
})
