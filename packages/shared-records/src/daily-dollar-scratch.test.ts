// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { DAILY_DOLLAR_SCRATCH_KEY, DAILY_DOLLAR_SCRATCH_LIFETIME_SECONDS, dailyDollarScratchStore } from "./daily-dollar-scratch"

function memory() {
  const data = new Map<string, unknown>()
  return {
    data,
    storage: {
      readJSON: async (key: string) => data.get(key) ?? null,
      writeJSON: async (key: string, value: unknown) => void data.set(key, value),
    },
  }
}

describe("dailyDollarScratchStore", () => {
  it("keeps the first scratch of a draw, case-insensitively", async () => {
    const { storage } = memory()
    const store = dailyDollarScratchStore(async () => storage)
    await store.markScratched("0xAB", 100)
    await store.markScratched("0xab", 200)
    expect(await store.scratchedAt("0xAb")).toBe(100)
    expect(await store.scratchedAt("0xcd")).toBeNull()
  })

  it("prunes entries past their lifetime and ignores malformed ones", async () => {
    const { data, storage } = memory()
    data.set(DAILY_DOLLAR_SCRATCH_KEY, { "0x01": 0, "0x02": 50, junk: 1, "0x03": "x" })
    await dailyDollarScratchStore(async () => storage).markScratched("0x04", DAILY_DOLLAR_SCRATCH_LIFETIME_SECONDS + 10)
    expect(data.get(DAILY_DOLLAR_SCRATCH_KEY)).toEqual({ "0x02": 50, "0x04": DAILY_DOLLAR_SCRATCH_LIFETIME_SECONDS + 10 })
  })

  it("drops writes when the storage is read-only or absent", async () => {
    await expect(dailyDollarScratchStore(async () => ({ readJSON: async () => null })).markScratched("0x01", 1)).resolves.toBeUndefined()
    expect(await dailyDollarScratchStore(async () => null).scratchedAt("0x01")).toBeNull()
  })
})
