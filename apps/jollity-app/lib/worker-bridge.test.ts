// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Tests how the app reports to the chat worker what the player has seen.
 *
 * The host storage is a map, so the tests read back exactly what the worker
 * would read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  return {
    values,
    readJSON: vi.fn(async (key: string) => values.get(key) ?? null),
    writeJSON: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value)
    }),
  }
})
vi.mock("@parity/product-sdk-host", () => ({
  getHostLocalStorage: async () => ({ readJSON: host.readJSON, writeJSON: host.writeJSON }),
}))

beforeEach(() => {
  host.values.clear()
})

describe("seen reporting works", () => {
  it("keeps the half another screen already reported", async () => {
    // Given
    const { markSeen } = await import("./worker-bridge")
    await markSeen(7, "draw")

    // When
    await markSeen(7, "chest")

    // Then
    expect(host.values.get("jollity.seen:7")).toEqual({ chest: true, draw: true })
  })

  it("keeps the landed report when the payoff screens report after it", async () => {
    // Given
    const { markSeen } = await import("./worker-bridge")
    await markSeen(7, "report")

    // When
    await markSeen(7, "draw")
    await markSeen(7, "chest")

    // Then
    expect(host.values.get("jollity.seen:7")).toEqual({ chest: true, draw: true, report: true })
  })

  it("keeps both parts of two reports that overlap", async () => {
    // Given
    const { markSeen } = await import("./worker-bridge")
    const slowRead = async (key: string) => {
      const value = host.values.get(key) ?? null
      await new Promise((resolve) => setTimeout(resolve, 0))
      return value
    }
    host.readJSON.mockImplementationOnce(slowRead).mockImplementationOnce(slowRead)

    // When
    await Promise.all([markSeen(7, "report"), markSeen(7, "draw")])

    // Then
    expect(host.values.get("jollity.seen:7")).toEqual({ chest: false, draw: true, report: true })
  })

  it("keeps each game under its own key", async () => {
    // Given
    const { markSeen } = await import("./worker-bridge")

    // When
    await markSeen(7, "chest")
    await markSeen(8, "draw")

    // Then
    expect(host.values.get("jollity.seen:7")).toEqual({ chest: true, draw: false })
    expect(host.values.get("jollity.seen:8")).toEqual({ chest: false, draw: true })
  })
})
