// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("a developer's URL parameter", () => {
  it("is read in a development or test build", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const { devUrlParam } = await import("./dev-url")
    expect(devUrlParam("player", "?game=4&player=5Amy")).toBe("5Amy")
    expect(devUrlParam("sendRung", "?game=4")).toBeUndefined()
  })

  it("is never read in a production build", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const { devUrlParam } = await import("./dev-url")
    expect(devUrlParam("player", "?player=5Amy")).toBeUndefined()
    expect(devUrlParam("tutorial", "?tutorial=1")).toBeUndefined()
  })
})
