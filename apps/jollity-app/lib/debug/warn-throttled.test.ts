// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const devLog = vi.fn()
vi.mock("./log-store", () => ({ devLog: (...args: unknown[]) => devLog(...args) }))

import { resetWarnThrottled, warnThrottled } from "./warn-throttled"

describe("warnThrottled", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    devLog.mockClear()
    resetWarnThrottled()
  })
  afterEach(() => vi.useRealTimers())

  it("logs the first failure with its detail and suppresses the repeat", () => {
    warnThrottled("k", "tag", "read failed", new Error("boom"))
    warnThrottled("k", "tag", "read failed", new Error("boom"))
    expect(devLog).toHaveBeenCalledTimes(1)
    expect(devLog).toHaveBeenCalledWith("tag", "read failed", { detail: "boom" }, "warn")
  })

  it("logs again for a new reason", () => {
    warnThrottled("k", "tag", "read failed", new Error("boom"))
    warnThrottled("k", "tag", "read failed", new Error("bang"))
    expect(devLog).toHaveBeenCalledTimes(2)
  })

  it("logs the same reason again once the window has passed", () => {
    warnThrottled("k", "tag", "read failed", new Error("boom"))
    vi.advanceTimersByTime(59_000)
    warnThrottled("k", "tag", "read failed", new Error("boom"))
    expect(devLog).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2_000)
    warnThrottled("k", "tag", "read failed", new Error("boom"))
    expect(devLog).toHaveBeenCalledTimes(2)
  })

  it("keeps keys apart, and marks the key before logging so a failure inside devLog cannot feed itself", () => {
    devLog.mockImplementationOnce(() => warnThrottled("k", "tag", "read failed", new Error("boom")))
    warnThrottled("k", "tag", "read failed", new Error("boom"))
    warnThrottled("other", "tag", "read failed", new Error("boom"))
    expect(devLog).toHaveBeenCalledTimes(2)
  })
})
