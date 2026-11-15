// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

describe("readCameraPermissionState", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"))
  })
  afterEach(() => vi.useRealTimers())

  it("re-checks one denial within a second of page start", async () => {
    const { CAMERA_DENIAL_RECHECK_DELAY_MS, readCameraPermissionState } = await import("./camera-permission-read")
    const query = vi
      .fn()
      .mockResolvedValueOnce({ state: "denied" })
      .mockResolvedValueOnce({ state: "granted" })

    const pending = readCameraPermissionState(query)
    await vi.advanceTimersByTimeAsync(CAMERA_DENIAL_RECHECK_DELAY_MS)

    await expect(pending).resolves.toEqual({ state: "granted" })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it("applies the early-denial window again after a foreground return", async () => {
    const { CAMERA_DENIAL_RECHECK_DELAY_MS, readCameraPermissionState } = await import("./camera-permission-read")
    const { reportPageActivity } = await import("./page-lifecycle")
    await vi.advanceTimersByTimeAsync(5_000)
    reportPageActivity(false, true)
    const query = vi
      .fn()
      .mockResolvedValueOnce({ state: "denied" })
      .mockResolvedValueOnce({ state: "denied" })

    const pending = readCameraPermissionState(query)
    await vi.advanceTimersByTimeAsync(CAMERA_DENIAL_RECHECK_DELAY_MS)

    await expect(pending).resolves.toEqual({ state: "denied" })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it("does not re-check a denial outside the early window", async () => {
    const { readCameraPermissionState } = await import("./camera-permission-read")
    await vi.advanceTimersByTimeAsync(1_001)
    const query = vi.fn().mockResolvedValue({ state: "denied" })

    await expect(readCameraPermissionState(query)).resolves.toEqual({ state: "denied" })
    expect(query).toHaveBeenCalledOnce()
  })

  it("does not re-check granted or prompt states", async () => {
    const { readCameraPermissionState } = await import("./camera-permission-read")
    const granted = vi.fn().mockResolvedValue({ state: "granted" })
    const prompt = vi.fn().mockResolvedValue({ state: "prompt" })

    await expect(readCameraPermissionState(granted)).resolves.toEqual({ state: "granted" })
    await expect(readCameraPermissionState(prompt)).resolves.toEqual({ state: "prompt" })
    expect(granted).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledOnce()
  })
})
