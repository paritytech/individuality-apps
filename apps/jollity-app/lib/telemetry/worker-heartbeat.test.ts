// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const storage = vi.hoisted(() => ({
  inside: true,
  portParked: false,
  available: true,
  hangs: false,
  value: null as string | null,
}))

vi.mock("../host/container", () => ({
  insideContainer: async () => storage.inside,
  hostPortParked: () => storage.portParked,
}))

vi.mock("../host/storage", () => ({
  hostStorage: async () =>
    storage.available
      ? { readString: async () => (storage.hangs ? new Promise<string | null>(() => {}) : storage.value) }
      : null,
}))

import {
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_READ_DEADLINE_MS,
  observeWorkerHeartbeat,
} from "./worker-heartbeat"

beforeEach(() => {
  storage.inside = true
  storage.portParked = false
  storage.available = true
  storage.hangs = false
  storage.value = null
})

describe("chat worker heartbeat observation", () => {
  const now = 1_000_000
  const expected = "jollity@current"

  it("distinguishes unavailable host storage, an absent heartbeat, and malformed evidence", async () => {
    storage.available = false
    await expect(observeWorkerHeartbeat(expected, now)).resolves.toEqual({ status: "unavailable" })

    storage.available = true
    await expect(observeWorkerHeartbeat(expected, now)).resolves.toEqual({ status: "missing" })

    storage.value = JSON.stringify({ at: "yesterday", release: expected })
    await expect(observeWorkerHeartbeat(expected, now)).resolves.toEqual({ status: "malformed" })

    storage.value = "null"
    await expect(observeWorkerHeartbeat(expected, now)).resolves.toEqual({ status: "malformed" })
  })

  it("treats the SDK's empty-string result for an absent key as missing", async () => {
    storage.value = ""

    await expect(observeWorkerHeartbeat(expected, now)).resolves.toEqual({ status: "missing" })
  })

  it("is not applicable outside the host instead of reporting a false missing worker", async () => {
    storage.inside = false

    await expect(observeWorkerHeartbeat(expected, now)).resolves.toEqual({ status: "not-applicable" })
  })

  it("reports unavailable when the host port exists but the container SDK cannot answer", async () => {
    storage.inside = false
    storage.portParked = true

    await expect(observeWorkerHeartbeat(expected, now)).resolves.toEqual({ status: "unavailable" })
  })

  it("bounds a hung host read and reports it unavailable", async () => {
    vi.useFakeTimers()
    try {
      storage.hangs = true
      const observation = observeWorkerHeartbeat(expected, now)

      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_READ_DEADLINE_MS)

      await expect(observation).resolves.toEqual({ status: "unavailable" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("accepts only a fresh heartbeat from this exact app release", async () => {
    storage.value = JSON.stringify({ at: now - 30_000, release: expected })

    await expect(observeWorkerHeartbeat(expected, now)).resolves.toEqual({
      status: "fresh",
      ageMs: 30_000,
      release: expected,
    })
  })

  it("reports stale and mismatched releases separately, including both together", async () => {
    storage.value = JSON.stringify({ at: now - 120_000, release: expected })
    await expect(observeWorkerHeartbeat(expected, now)).resolves.toMatchObject({ status: "stale", ageMs: 120_000 })

    storage.value = JSON.stringify({ at: now - 30_000, release: "jollity@old" })
    await expect(observeWorkerHeartbeat(expected, now)).resolves.toMatchObject({ status: "release-mismatch", ageMs: 30_000 })

    storage.value = JSON.stringify({ at: now - 120_000, release: "jollity@old" })
    await expect(observeWorkerHeartbeat(expected, now)).resolves.toMatchObject({ status: "stale-release-mismatch", ageMs: 120_000 })
  })

  it("treats a heartbeat implausibly ahead of this same device clock as malformed", async () => {
    storage.value = JSON.stringify({ at: now + 60_001, release: expected })

    await expect(observeWorkerHeartbeat(expected, now)).resolves.toEqual({ status: "malformed" })
  })

  it("uses the shared host-storage key", () => {
    expect(WORKER_HEARTBEAT_KEY).toBe("jollity.wg.workerHeartbeat")
  })
})
