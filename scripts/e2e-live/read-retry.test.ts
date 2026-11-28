// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { retryRead } from "./read-retry"

const noSleep = async () => {}
describe("retryRead", () => {
  it("returns the first answer without retrying", async () => {
    let calls = 0
    expect(await retryRead(async () => ++calls, { tries: 3, waitMs: 1, sleep: noSleep })).toBe(1)
  })
  it("rides through a brief outage: failures, then an answer", async () => {
    let calls = 0
    const seen: number[] = []
    const v = await retryRead(
      async () => {
        if (++calls < 4) throw new Error("socket closed")
        return "ok"
      },
      { tries: 10, waitMs: 6000, sleep: noSleep, onRetry: (_e, a) => seen.push(a) },
    )
    expect(v).toBe("ok")
    expect(seen).toEqual([1, 2, 3])
  })
  it("throws the last error when the chain stays unreachable for every try", async () => {
    let calls = 0
    await expect(retryRead(async () => { throw new Error(`down ${++calls}`) }, { tries: 3, waitMs: 1, sleep: noSleep })).rejects.toThrow("down 3")
    expect(calls).toBe(3)
  })
  it("waits waitMs between tries", async () => {
    const waits: number[] = []
    await retryRead(async () => { if (waits.length < 2) throw new Error("x"); return 1 }, { tries: 5, waitMs: 6000, sleep: async (ms) => void waits.push(ms) })
    expect(waits).toEqual([6000, 6000])
  })
})
