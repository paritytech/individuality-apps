// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { lastBackgroundReturnAtMs, noteBackgroundEdge, watchBackgroundReturns } from "./background-return"

describe("the return from the background", () => {
  it("stamps a shown edge only after a hidden one, and tells each watcher once", () => {
    const seen = vi.fn()
    const stop = watchBackgroundReturns(seen)
    noteBackgroundEdge(false, 100)
    expect(lastBackgroundReturnAtMs()).toBeNull()
    noteBackgroundEdge(true, 200)
    noteBackgroundEdge(false, 900)
    noteBackgroundEdge(false, 950)
    expect(lastBackgroundReturnAtMs()).toBe(900)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith(900)
    stop()
    noteBackgroundEdge(true, 1000)
    noteBackgroundEdge(false, 1500)
    expect(lastBackgroundReturnAtMs()).toBe(1500)
    expect(seen).toHaveBeenCalledTimes(1)
  })
})
