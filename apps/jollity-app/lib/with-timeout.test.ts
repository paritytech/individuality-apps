// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { withTimeout } from "./with-timeout"

afterEach(() => vi.useRealTimers())

describe("withTimeout", () => {
  it("passes the value through when it arrives in time", async () => {
    expect(await withTimeout(Promise.resolve(7), 1000)).toBe(7)
  })
  it("answers null once the time is up, and clears its timer either way", async () => {
    vi.useFakeTimers()
    const pending = withTimeout(new Promise<number>(() => {}), 1000)
    await vi.advanceTimersByTimeAsync(1100)
    expect(await pending).toBeNull()
    await withTimeout(Promise.resolve(1), 1000)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("lets a rejection through", async () => {
    await expect(withTimeout(Promise.reject(new Error("x")), 1000)).rejects.toThrow("x")
  })
})
