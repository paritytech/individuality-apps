// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { getLocalMedia } from "./media"

const OPEN = { video: true, audio: false, width: 360, height: 360, fps: 24, facing: "user" } as const

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("one-attempt camera opens", () => {
  it("does not retry NotReadableError after the tap's user activation is gone", async () => {
    vi.useFakeTimers()
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("camera held", "NotReadableError")
    })
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } })

    await expect(getLocalMedia(OPEN, { retryBusy: false })).rejects.toMatchObject({ reason: "busy" })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(getUserMedia).toHaveBeenCalledOnce()
  })
})
