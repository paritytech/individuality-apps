// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createBrowserDrawIdle } from "./draw-idle"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("the browser's idle watch", () => {
  it("takes back the window listeners it adds when it is detached", () => {
    const added = vi.spyOn(window, "addEventListener")
    const removed = vi.spyOn(window, "removeEventListener")
    const idle = createBrowserDrawIdle("game-7", () => {})
    const listeners = added.mock.calls.filter(([type]) => type === "pagehide" || type === "pageshow")
    expect(listeners.map(([type]) => type)).toEqual(["pagehide", "pageshow"])
    idle.detach()
    for (const [type, listener] of listeners) expect(removed).toHaveBeenCalledWith(type, listener)
  })
})
