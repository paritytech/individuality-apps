// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { HEALTHY, LOST, TIMED_OUT } from "./chain-health-fixtures"
import { runChainHealthProbe } from "./chain-health"

const stored = vi.hoisted(() => new Map<string, unknown>())
const slow = vi.hoisted(() => ({ read: false }))

vi.mock("./host/storage", async () => {
  const { memoryHostStorage } = await import("./chain-health-fixtures")
  const storage = memoryHostStorage(stored)
  return {
    ...storage,
    // a dead host: the read never answers
    readStoredJSON: (key: string) => (slow.read ? new Promise(() => {}) : storage.readStoredJSON(key)),
  }
})

const KEY = "jollity.chain-lost-streak"
const T = 1_000_000_000

/** one app open: a fresh module, the host storage kept */
async function open() {
  vi.resetModules()
  return import("./chain-lost-streak")
}

describe("consecutive app opens that hit host-chain-lost", () => {
  beforeEach(() => {
    stored.clear()
    slow.read = false
  })

  it("counts one per app open, however many probes in it lose", async () => {
    const first = await open()
    expect(await first.noteChainLostStreak(LOST, T)).toBe(1)
    expect(await first.noteChainLostStreak(LOST, T + 5_000)).toBe(1)
    const second = await open()
    expect(await second.noteChainLostStreak(LOST, T + 60_000)).toBe(2)
    const third = await open()
    expect(await third.noteChainLostStreak(LOST, T + 90_000)).toBe(3)
    expect(stored.get(KEY)).toEqual({ count: 3, at: T + 90_000 })
  })

  it("resets on a healthy probe, and a later loss starts again at 1", async () => {
    await (await open()).noteChainLostStreak(LOST, T)
    const second = await open()
    expect(await second.noteChainLostStreak(LOST, T + 1)).toBe(2)
    expect(await second.noteChainLostStreak(HEALTHY, T + 2)).toBe(0)
    expect(await second.noteChainLostStreak(LOST, T + 3)).toBe(1)
    const third = await open()
    expect(await third.noteChainLostStreak(HEALTHY, T + 4)).toBe(0)
    expect(await (await open()).noteChainLostStreak(LOST, T + 5)).toBe(1)
  })

  it("leaves the count alone on an unknown or declined probe", async () => {
    await (await open()).noteChainLostStreak(LOST, T)
    const second = await open()
    expect(await second.noteChainLostStreak(TIMED_OUT, T + 1)).toBeUndefined()
    const interrupted = await runChainHealthProbe(async () => {
      throw new Error("TrUAPI host connection interrupted")
    })
    expect(await second.noteChainLostStreak(interrupted, T + 1)).toBeUndefined()
    expect(await second.noteChainLostStreak(LOST, T + 2)).toBe(2)
    expect(await second.noteChainLostStreak({ outcome: "declined", latencyMs: 1, error: "no" }, T + 3)).toBe(2)
  })

  it("does not count a loss older than half an hour as in a row", async () => {
    const first = await open()
    await first.noteChainLostStreak(LOST, T)
    const { noteChainLostStreak, STREAK_STALE_MS } = await open()
    expect(await noteChainLostStreak(LOST, T + STREAK_STALE_MS + 1)).toBe(1)
  })

  it("reads a garbled stored value as no streak", async () => {
    stored.set(KEY, "garbage")
    expect(await (await open()).noteChainLostStreak(LOST, T)).toBe(1)
  })

  it("never hangs the probe on a host storage that does not answer", async () => {
    vi.useFakeTimers()
    try {
      slow.read = true
      const { noteChainLostStreak, STREAK_READ_BOUND_MS } = await open()
      const counted = noteChainLostStreak(LOST, T)
      await vi.advanceTimersByTimeAsync(STREAK_READ_BOUND_MS)
      expect(await counted).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
