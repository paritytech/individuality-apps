// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const store = new Map<string, string>()
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}
vi.stubGlobal("sessionStorage", storage)

const { CRASH_RELOAD_BACKOFF_MS, clearCrashReload, crashReloadDelayMs, markCrashReload } = await import("./crash-reload")

beforeEach(() => {
  store.clear()
  vi.stubGlobal("sessionStorage", storage)
})

describe("the reload after a render crash", () => {
  it("is at once on the first crash of a page load", () => {
    expect(crashReloadDelayMs()).toBe(0)
  })

  it("backs off through the crashes that come straight back, and holds the longest wait", () => {
    const waits: number[] = []
    for (let i = 0; i < CRASH_RELOAD_BACKOFF_MS.length + 2; i++) {
      waits.push(crashReloadDelayMs()!)
      markCrashReload()
    }
    expect(waits).toEqual([0, 5000, 10_000, 20_000, 30_000, 30_000, 30_000])
  })

  it("starts over once a clean start clears the count", () => {
    markCrashReload()
    markCrashReload()
    clearCrashReload()
    expect(crashReloadDelayMs()).toBe(0)
  })

  it("waits the longest without storage, where the crashes cannot be counted", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("SecurityError")
      },
    })
    expect(crashReloadDelayMs()).toBe(30_000)
  })
})
