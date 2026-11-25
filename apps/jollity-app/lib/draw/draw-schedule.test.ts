// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import type { GameSource } from "../game-source"
import { drawEntryPath, peekDrawSchedule, preloadDrawSchedule } from "./draw-schedule"

let gameIndex = 4000
afterEach(() => vi.useRealTimers())

describe("the waiting-room draw schedule", () => {
  it("keeps failures unknown and recovers a scheduled draw after four failed reads", async () => {
    vi.useFakeTimers()
    const index = gameIndex++
    const gameAt = 1_800_000_000 + index
    const drawSchedule = vi
      .fn<GameSource["drawSchedule"]>()
      .mockRejectedValueOnce(new Error("rpc 1"))
      .mockRejectedValueOnce(new Error("rpc 2"))
      .mockRejectedValueOnce(new Error("rpc 3"))
      .mockRejectedValueOnce(new Error("rpc 4"))
      .mockResolvedValue({ gameIndex: index, gameAt, scheduled: 1 })
    const source = { drawSchedule } as unknown as GameSource

    const load = preloadDrawSchedule(source, gameAt)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(drawSchedule).toHaveBeenCalledTimes(4)
    expect(peekDrawSchedule(index)).toBeUndefined()
    expect(drawEntryPath(peekDrawSchedule(index))).toBe("/prize-draw")

    await vi.advanceTimersByTimeAsync(2_000)
    await expect(load).resolves.toEqual({ gameIndex: index, gameAt, scheduled: 1 })
    expect(drawSchedule).toHaveBeenCalledTimes(5)
    expect(drawEntryPath(peekDrawSchedule(index))).toBe("/prize-draw")
  })

  it("uses the collectables screen only for a successful authoritative zero", async () => {
    const index = gameIndex++
    const gameAt = 1_800_000_000 + index
    const source = {
      drawSchedule: vi.fn(async () => ({ gameIndex: index, gameAt, scheduled: 0 })),
    } as unknown as GameSource

    await preloadDrawSchedule(source, gameAt)
    expect(peekDrawSchedule(index)).toBe(0)
    expect(drawEntryPath(0)).toBe("/collectables")
    expect(drawEntryPath(undefined)).toBe("/prize-draw")
    expect(drawEntryPath(2)).toBe("/prize-draw")
  })
})
