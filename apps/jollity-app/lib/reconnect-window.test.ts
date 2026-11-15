// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { RECONNECTING_BEFORE_RESTART_MS } from "./chain-health"
import { armReconnectWindow } from "./reconnect-window"
import { finishReconnectWindow } from "./use-reconnect-window"

describe("the silent-host reconnecting window", () => {
  afterEach(() => vi.useRealTimers())

  it("recovers inside the minute without escalating", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const onEscalate = vi.fn()
    const onRecover = vi.fn()
    const window = armReconnectWindow({ onEscalate, onRecover })
    await vi.advanceTimersByTimeAsync(17_000)
    window.recover()
    expect(onRecover).toHaveBeenCalledWith(17_000)
    await vi.advanceTimersByTimeAsync(RECONNECTING_BEFORE_RESTART_MS)
    expect(onEscalate).not.toHaveBeenCalled()
  })

  it("escalates once when silence reaches the full minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const onEscalate = vi.fn()
    const onRecover = vi.fn()
    const window = armReconnectWindow({ onEscalate, onRecover })
    await vi.advanceTimersByTimeAsync(RECONNECTING_BEFORE_RESTART_MS - 1)
    expect(onEscalate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onEscalate).toHaveBeenCalledWith(RECONNECTING_BEFORE_RESTART_MS)
    window.recover()
    expect(onRecover).not.toHaveBeenCalled()
  })

  it("cancels the timer and keeps recovery/cancel one-shot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const nowMs = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125)
    const onEscalate = vi.fn()
    const onRecover = vi.fn()
    const recovered = armReconnectWindow({ nowMs, onEscalate, onRecover })
    recovered.recover()
    recovered.recover()
    recovered.cancel()
    expect(onRecover).toHaveBeenCalledOnce()
    expect(nowMs).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)

    onRecover.mockClear()
    onEscalate.mockClear()
    const cancelled = armReconnectWindow({ nowMs: () => 200, onEscalate, onRecover })
    cancelled.cancel()
    expect(onRecover).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(RECONNECTING_BEFORE_RESTART_MS)
    expect(onEscalate).not.toHaveBeenCalled()
  })

  it("records recovery only for healthy evidence and cancels other exits", () => {
    const recover = vi.fn()
    const cancel = vi.fn()
    finishReconnectWindow({ recover, cancel }, false)
    expect(cancel).toHaveBeenCalledOnce()
    expect(recover).not.toHaveBeenCalled()

    recover.mockClear()
    cancel.mockClear()
    finishReconnectWindow({ recover, cancel }, true)
    expect(recover).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe("a window that began before it was armed", () => {
  afterEach(() => vi.useRealTimers())

  it("escalates a minute after its start, not after the arming", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const startedAtMs = performance.now()
    await vi.advanceTimersByTimeAsync(15_000)
    const onEscalate = vi.fn()
    armReconnectWindow({ startedAtMs, onEscalate, onRecover: vi.fn() })
    await vi.advanceTimersByTimeAsync(RECONNECTING_BEFORE_RESTART_MS - 15_000 - 1)
    expect(onEscalate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onEscalate).toHaveBeenCalledWith(RECONNECTING_BEFORE_RESTART_MS)
  })
})
