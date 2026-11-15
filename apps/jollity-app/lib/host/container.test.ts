// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { hostPortParked } from "./container"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the synchronous container guess", () => {
  it("is true when the host's bridge has parked its port on the window", () => {
    vi.stubGlobal("window", { __HOST_API_PORT__: {} })
    expect(hostPortParked()).toBe(true)
  })

  it("is false on a plain page", () => {
    vi.stubGlobal("window", {})
    expect(hostPortParked()).toBe(false)
  })

  it("is false with no window at all", () => {
    vi.stubGlobal("window", undefined)
    expect(hostPortParked()).toBe(false)
  })
})
