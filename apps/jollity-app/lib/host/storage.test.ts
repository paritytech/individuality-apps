// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => ({
  inside: true,
  values: new Map<string, string>(),
  broken: false,
  slowMs: 0,
  failRead: false,
  interruptionReads: 0,
  connectionListeners: new Set<(status: "connecting" | "connected" | "disconnected") => void>(),
}))

vi.mock("@parity/product-sdk-host", () => ({
  isInsideContainerSync: () => host.inside,
  getHostLocalStorage: async () => {
    if (host.broken) throw new Error("bridge gone")
    return {
      readJSON: async (key: string) => {
        if (host.slowMs < 0) await new Promise(() => {})
        if (host.slowMs > 0) await new Promise((resolve) => setTimeout(resolve, host.slowMs))
        if (host.failRead) throw new Error("read refused")
        const raw = host.values.get(key)
        return raw === undefined ? null : JSON.parse(raw)
      },
      readString: async (key: string) => {
        if (host.interruptionReads > 0) {
          host.interruptionReads -= 1
          throw new Error("TrUAPI host connection interrupted")
        }
        if (host.slowMs < 0) await new Promise(() => {})
        if (host.slowMs > 0) await new Promise((resolve) => setTimeout(resolve, host.slowMs))
        return host.values.get(key) ?? null
      },
      writeString: async (key: string, value: string) => void host.values.set(key, value),
    }
  },
  subscribeConnectionStatus: (listener: (status: "connecting" | "connected" | "disconnected") => void) => {
    host.connectionListeners.add(listener)
    return () => host.connectionListeners.delete(listener)
  },
}))

const web = new Map<string, string>()

beforeEach(() => {
  host.inside = true
  host.broken = false
  host.slowMs = 0
  host.failRead = false
  host.interruptionReads = 0
  host.connectionListeners.clear()
  host.values.clear()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => web.get(key) ?? null,
    setItem: (key: string, value: string) => void web.set(key, value),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  web.clear()
})

describe("the shared string storage", () => {
  it("uses host storage inside a container", async () => {
    const { readStoredString, writeStoredString } = await import("./storage")
    await writeStoredString("k", "1")
    expect(host.values.get("k")).toBe("1")
    expect(web.has("k")).toBe(false)
    await expect(readStoredString("k")).resolves.toBe("1")
  })

  it("retries a read once when the resumed host reconnects", async () => {
    const { readStoredString } = await import("./storage")
    host.values.set("k", "restored")
    host.interruptionReads = 1

    const pending = readStoredString("k")
    await vi.waitFor(() => expect(host.connectionListeners.size).toBe(1))
    for (const listener of host.connectionListeners) listener("connected")

    await expect(pending).resolves.toBe("restored")
    expect(host.interruptionReads).toBe(0)
  })

  it("uses localStorage outside a container", async () => {
    host.inside = false
    const { readStoredString, writeStoredString } = await import("./storage")
    await writeStoredString("k", "v")
    expect(web.get("k")).toBe("v")
    await expect(readStoredString("k")).resolves.toBe("v")
  })

  it("falls back to localStorage when host storage throws, and never throws", async () => {
    host.broken = true
    const { readStoredString, writeStoredString } = await import("./storage")
    await writeStoredString("k", "v")
    await expect(readStoredString("k")).resolves.toBe("v")
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked") },
      setItem: () => { throw new Error("blocked") },
    })
    await expect(writeStoredString("k", "x")).resolves.toBeUndefined()
    await expect(readStoredString("k")).resolves.toBeNull()
  })
})

const slowRecord = vi.hoisted(() => vi.fn())
vi.mock("../telemetry", () => ({ storageSlowRecord: slowRecord }))

describe("host storage measurement (#776)", () => {
  const warns = vi.hoisted(() => vi.fn())
  vi.mock("../debug/log-store", () => ({ devLog: warns }))

  beforeEach(async () => {
    warns.mockClear()
    slowRecord.mockClear()
    const { resetStorageStats } = await import("./storage")
    resetStorageStats()
  })
  afterEach(() => vi.useRealTimers())

  it("counts a fast read as ok and warns about nothing", async () => {
    const { readStoredString, storageTelemetry } = await import("./storage")
    host.values.set("k", "v")
    await expect(readStoredString("k")).resolves.toBe("v")
    expect(storageTelemetry()).toMatchObject({ "storage.reads": 1, "storage.failed": 0, "storage.slow_3s": 0, "storage.slow_10s": 0 })
    expect(warns).not.toHaveBeenCalled()
  })

  it("counts a failing read and still falls back to localStorage", async () => {
    const { readStoredString, storageTelemetry } = await import("./storage")
    host.broken = true
    web.set("k", "w")
    await expect(readStoredString("k")).resolves.toBe("w")
    expect(storageTelemetry()["storage.failed"]).toBe(1)
    expect(warns).toHaveBeenCalledWith("storage", expect.stringContaining("failed"), expect.objectContaining({ op: "open" }), "warn")
  })

  it("counts a read that resolves after 4 s as slow, result unchanged, one warn", async () => {
    vi.useFakeTimers()
    const { readStoredString, storageTelemetry } = await import("./storage")
    host.values.set("k", "late")
    const original = host.slowMs
    host.slowMs = 4_000
    const pending = readStoredString("k")
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(pending).resolves.toBe("late")
    host.slowMs = original
    const t = storageTelemetry()
    expect(t).toMatchObject({ "storage.reads": 1, "storage.failed": 0, "storage.slow_3s": 1, "storage.slow_10s": 0 })
    expect(t["storage.max_ms"]).toBeGreaterThanOrEqual(4_000)
    expect(warns).toHaveBeenCalledTimes(1)
    expect(slowRecord).not.toHaveBeenCalled()
    expect(warns).toHaveBeenCalledWith("storage", expect.any(String), expect.objectContaining({ op: "read", key: "k" }), "warn")
  })

  it("counts a read that never resolves as pending at 3 s and 10 s without throwing or settling it", async () => {
    vi.useFakeTimers()
    const { readStoredString, storageTelemetry } = await import("./storage")
    host.slowMs = -1
    let settled = false
    void readStoredString("k").then(() => (settled = true), () => (settled = true))
    await vi.advanceTimersByTimeAsync(11_000)
    host.slowMs = 0
    expect(settled).toBe(false)
    void readStoredString("k2")
    await vi.advanceTimersByTimeAsync(11_000)
    expect(slowRecord).toHaveBeenCalledTimes(1)
    expect(slowRecord).toHaveBeenCalledWith({ op: "read", key: "k", ms: 10_000 })
    expect(storageTelemetry()).toMatchObject({ "storage.slow_3s": 1, "storage.slow_10s": 1, "storage.read_max_ms": 10_000 })
  })

  it("measures a raw readJSON on the handle: slow at 4 s, result unchanged", async () => {
    vi.useFakeTimers()
    const { hostStorage, storageTelemetry } = await import("./storage")
    host.values.set("j", '{"a":1}')
    const store = await hostStorage()
    host.slowMs = 4_000
    const pending = store!.readJSON("j")
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(pending).resolves.toEqual({ a: 1 })
    expect(storageTelemetry()).toMatchObject({ "storage.slow_3s": 1, "storage.slow_10s": 0, "storage.failed": 0 })
  })

  it("measures a raw readJSON that fails and rethrows the same error", async () => {
    const { hostStorage, storageTelemetry } = await import("./storage")
    const store = await hostStorage()
    host.failRead = true
    await expect(store!.readJSON("j")).rejects.toThrow("read refused")
    expect(storageTelemetry()["storage.failed"]).toBe(1)
  })

  it("measures a never-resolving raw read: pending at 3 s and 10 s, one storage-slow event", async () => {
    vi.useFakeTimers()
    const { hostStorage, storageTelemetry } = await import("./storage")
    const store = await hostStorage()
    host.slowMs = -1
    void store!.readJSON("hang")
    void store!.readJSON("hang2")
    await vi.advanceTimersByTimeAsync(11_000)
    expect(storageTelemetry()).toMatchObject({ "storage.slow_3s": 2, "storage.slow_10s": 2 })
    expect(slowRecord).toHaveBeenCalledTimes(1)
    expect(slowRecord).toHaveBeenCalledWith({ op: "read", key: "hang", ms: 10_000 })
  })

  it("counts a readStoredString call exactly once", async () => {
    const { readStoredString, tryReadStoredString, storageTelemetry } = await import("./storage")
    await readStoredString("k")
    await tryReadStoredString("k")
    expect(storageTelemetry()["storage.reads"]).toBe(2)
  })
})
