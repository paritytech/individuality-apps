// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isHostChannelInterruption, retrySafeHostRead, safeHostReadWhenConnected, setHostRerunRecord, waitForHostReconnect } from "./safe-call"

const hostRetryRecord = vi.fn()

function connection() {
  let listener: (status: "connecting" | "connected" | "disconnected") => void = () => {}
  const unsubscribe = vi.fn()
  return {
    source: {
      subscribeConnectionStatus(callback: typeof listener) {
        listener = callback
        return unsubscribe
      },
    },
    emit(status: "connecting" | "connected" | "disconnected") {
      listener(status)
    },
    unsubscribe,
  }
}

beforeEach(() => {
  hostRetryRecord.mockReset()
  setHostRerunRecord(hostRetryRecord)
})

afterEach(() => {
  setHostRerunRecord(() => {})
  vi.useRealTimers()
})

describe("safe host reads after resume", () => {
  it("recognises an interruption through the SDK's protocol-skew wrapper", () => {
    const cause = new Error("TrUAPI host connection interrupted")
    expect(isHostChannelInterruption(new Error("usual cause is protocol-version skew", { cause }))).toBe(true)
    expect(isHostChannelInterruption(new Error("Offset is outside the bounds of the DataView"))).toBe(false)
  })

  it.each(["operation timed out", "Transaction signing was rejected.", "cannot get the current block", "WebSocket connection closed"])(
    "is not an interruption for %s",
    (detail) => {
      expect(isHostChannelInterruption(new Error(detail))).toBe(false)
    },
  )

  it("retries a thrown safe read exactly once after connected", async () => {
    const link = connection()
    const interrupted = new Error("TrUAPI host connection interrupted")
    const run = vi.fn().mockRejectedValueOnce(interrupted).mockResolvedValueOnce("ready")
    const pending = retrySafeHostRead(link.source, run, { operation: "storage.read" })
    await Promise.resolve()
    expect(run).toHaveBeenCalledOnce()
    link.emit("connecting")
    expect(run).toHaveBeenCalledOnce()
    link.emit("connected")
    await expect(pending).resolves.toBe("ready")
    expect(run).toHaveBeenCalledTimes(2)
    expect(link.unsubscribe).toHaveBeenCalledOnce()
    expect(hostRetryRecord).toHaveBeenCalledOnce()
    expect(hostRetryRecord).toHaveBeenCalledWith(expect.objectContaining({
      operation: "storage.read",
      attempt: 2,
      reason: "host-interrupted",
      error: interrupted,
    }))
  })

  it("retries an interrupted Result once and returns the second Result unchanged", async () => {
    const link = connection()
    const first = { ok: false as const, error: new Error("TrUAPI host connection interrupted") }
    const second = { ok: false as const, error: new Error("Denied") }
    const run = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const pending = retrySafeHostRead(link.source, run)
    await Promise.resolve()
    link.emit("connected")
    await expect(pending).resolves.toBe(second)
    expect(run).toHaveBeenCalledTimes(2)
    expect(hostRetryRecord).toHaveBeenCalledOnce()
    expect(hostRetryRecord).toHaveBeenCalledWith(expect.objectContaining({
      operation: "host-read",
      attempt: 2,
      reason: "host-interrupted",
      error: first.error,
    }))
  })

  it("preserves the original failure when reconnect does not arrive", async () => {
    vi.useFakeTimers()
    const link = connection()
    const first = { ok: false as const, error: new Error("TrUAPI host connection interrupted") }
    const run = vi.fn(async () => first)
    const pending = retrySafeHostRead(link.source, run)
    await vi.advanceTimersByTimeAsync(2_001)
    await expect(pending).resolves.toBe(first)
    expect(run).toHaveBeenCalledOnce()
    expect(hostRetryRecord).not.toHaveBeenCalled()
  })

  it("holds a safe read until the transport reports connected, then runs it once", async () => {
    const link = connection()
    const run = vi.fn(async () => "ready")
    const pending = safeHostReadWhenConnected(link.source, run)
    link.emit("disconnected")
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
    link.emit("connected")
    await expect(pending).resolves.toBe("ready")
    expect(run).toHaveBeenCalledOnce()
  })

  it("runs the read anyway once the connected wait expires", async () => {
    vi.useFakeTimers()
    const link = connection()
    const run = vi.fn(async () => "ready")
    const pending = safeHostReadWhenConnected(link.source, run)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe("ready")
    expect(run).toHaveBeenCalledOnce()
  })

  it("settles false if subscribing itself fails", async () => {
    await expect(waitForHostReconnect({ subscribeConnectionStatus: () => { throw new Error("no bridge") } })).resolves.toBe(false)
  })
})
