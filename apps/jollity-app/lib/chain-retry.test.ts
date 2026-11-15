// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeTelemetryModule, recorded, resetRecorded } from "./telemetry/testing"

vi.mock("./telemetry", () => fakeTelemetryModule())

const host = vi.hoisted(() => ({
  listeners: new Set<(status: "connecting" | "connected" | "disconnected") => void>(),
}))
vi.mock("@parity/product-sdk-host", () => ({
  subscribeConnectionStatus: (listener: (status: "connecting" | "connected" | "disconnected") => void) => {
    host.listeners.add(listener)
    return () => host.listeners.delete(listener)
  },
}))

const { blockNotPinnedHash, isBlockNotPinned, retryBlockNotPinned } = await import("./chain-retry")

beforeEach(() => {
  resetRecorded()
  host.listeners.clear()
})

describe("BlockNotPinned recovery", () => {
  it.each([
    new Error("BlockNotPinnedError: stop-storage"),
    "Block 0x123 is not pinned (getRuntimeCtx)",
  ])("recognizes %s", (error) => expect(isBlockNotPinned(error)).toBe(true))

  it("carries the dropped block into the fresh-follow wait", async () => {
    expect(blockNotPinnedHash("Block 0x123abc is not pinned (getRuntimeCtx)")).toBe("0x123abc")
    const waitUntilFollowing = vi.fn()
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("Block 0x123abc is not pinned (stop-storage)"))
      .mockResolvedValueOnce("landed")
    await retryBlockNotPinned({ waitUntilFollowing }, { operation: "signup-seat", run })
    expect(waitUntilFollowing).toHaveBeenCalledWith("0x123abc", undefined)
  })

  it("does not classify an ordinary host failure", () => {
    expect(isBlockNotPinned(new Error("host disconnected"))).toBe(false)
  })

  it("waits for a fresh follow and retries exactly once", async () => {
    const order: string[] = []
    const run = vi.fn(async () => {
      order.push("run")
      if (order.length === 1) throw new Error("Block 0xold is not pinned (stop-storage)")
      return "landed"
    })
    const waitUntilFollowing = vi.fn(async () => {
      order.push("follow")
      return true
    })

    await expect(retryBlockNotPinned({ waitUntilFollowing }, { operation: "report", run })).resolves.toBe("landed")
    expect(order).toEqual(["run", "follow", "run"])
    expect(run).toHaveBeenCalledTimes(2)
    expect(recorded.hostRetries).toEqual([expect.objectContaining({ operation: "report", attempt: 2, reason: "block-not-pinned" })])
    expect(recorded.metrics).toContainEqual({
      type: "count",
      name: "chain.retries",
      value: 1,
      attrs: {
        "chain.retry_reason": "block-not-pinned",
        "chain.retry_operation": "report",
        "chain.retry_succeeded": "true",
      },
    })
  })

  it("does not rebuild a transaction after its broadcast boundary", async () => {
    type Result = { ok: false; error: string }
    const run = vi.fn<() => Promise<Result>>().mockResolvedValue({ ok: false, error: "Block 0x123 is not pinned" })
    const waitUntilFollowing = vi.fn()
    const value = await retryBlockNotPinned(
      { waitUntilFollowing },
      { operation: "signup-tx", run, errorOf: (result) => result.error, retryIf: () => false },
    )
    expect(value).toEqual({ ok: false, error: "Block 0x123 is not pinned" })
    expect(run).toHaveBeenCalledTimes(1)
    expect(waitUntilFollowing).not.toHaveBeenCalled()
    expect(recorded.metrics).toEqual([])
  })

  it("rethrows the original not-pinned error when the fresh-follow wait expires", async () => {
    const failure = new Error("Block 0x123 is not pinned (stop-storage)")
    const run = vi.fn().mockRejectedValueOnce(failure)
    await expect(retryBlockNotPinned(
      { waitUntilFollowing: vi.fn().mockResolvedValue(false) },
      { operation: "signup-route", run },
    )).rejects.toBe(failure)
    expect(run).toHaveBeenCalledTimes(1)
    expect(recorded.hostRetries).toEqual([])
  })

  it("retries a failed dispatch value and records a failed recovery", async () => {
    type Result = { ok: true } | { ok: false; error: string }
    const run = vi
      .fn<() => Promise<Result>>()
      .mockResolvedValueOnce({ ok: false, error: "Block 0x123 is not pinned" })
      .mockResolvedValueOnce({ ok: false, error: "NoReporting" })
    const value = await retryBlockNotPinned(
      { waitUntilFollowing: vi.fn() },
      { operation: "report", run, errorOf: (result) => result.ok ? null : result.error },
    )
    expect(value).toEqual({ ok: false, error: "NoReporting" })
    expect(recorded.metrics[0]?.attrs["chain.retry_succeeded"]).toBe("false")
  })

  it("never retries or records an ordinary failure", async () => {
    const run = vi.fn().mockRejectedValue(new Error("offline"))
    await expect(retryBlockNotPinned({}, { operation: "signup-seat", run })).rejects.toThrow("offline")
    expect(run).toHaveBeenCalledTimes(1)
    expect(recorded.metrics).toEqual([])
  })

  it("retries an interrupted signup read once after the host reconnects", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("TrUAPI host connection interrupted"))
      .mockResolvedValueOnce("landed")

    const pending = retryBlockNotPinned({}, { operation: "signup-route", run })
    await vi.waitFor(() => expect(host.listeners.size).toBe(1))
    for (const listener of host.listeners) listener("connected")

    await expect(pending).resolves.toBe("landed")
    expect(run).toHaveBeenCalledTimes(2)
    expect(recorded.hostRetries).toEqual([expect.objectContaining({ operation: "signup-route", attempt: 2, reason: "host-interrupted" })])
    expect(recorded.metrics[0]?.attrs).toMatchObject({
      "chain.retry_reason": "host-interrupted",
      "chain.retry_operation": "signup-route",
    })
  })

  it.each(["signup-tx", "person-bind", "report"] as const)(
    "never retries an interrupted %s operation",
    async (operation) => {
      const failure = new Error("TrUAPI host connection interrupted")
      const run = vi.fn().mockRejectedValue(failure)

      await expect(retryBlockNotPinned({}, { operation, run })).rejects.toBe(failure)
      expect(run).toHaveBeenCalledOnce()
      expect(host.listeners.size).toBe(0)
      expect(recorded.metrics).toEqual([])
      expect(recorded.hostRetries).toEqual([])
    },
  )
})
