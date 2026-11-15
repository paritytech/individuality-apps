// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { armLaunchStall, LAUNCH_STALL_GRACE_MS, LAUNCH_STALL_MS } from "./launch-stall"
import type { ChainHealthResult } from "./chain-health"

const healthy: ChainHealthResult = { outcome: "healthy", latencyMs: 40 }
const unanswered: ChainHealthResult = { outcome: "unknown", latencyMs: 5000, errorClass: "unknown", error: "timed out" }
const lost: ChainHealthResult = { outcome: "host-chain-lost", latencyMs: 20, errorClass: "subscription-dropped", error: "dropped" }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("the launch stall (#530)", () => {
  it("stalls as host-unanswered when the source never resolved", async () => {
    const onStall = vi.fn()
    armLaunchStall({ hasSource: () => false, probe: async () => undefined, onStall })
    await vi.advanceTimersByTimeAsync(LAUNCH_STALL_MS - 1)
    expect(onStall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onStall).toHaveBeenCalledWith("host-unanswered")
  })

  it("re-probes the chain after 15 s and stalls at once only when the host says the chain is lost", async () => {
    const onStall = vi.fn()
    const probe = vi.fn(async () => lost)
    armLaunchStall({ hasSource: () => true, probe, onStall })
    await vi.advanceTimersByTimeAsync(LAUNCH_STALL_MS)
    expect(probe).toHaveBeenCalledOnce()
    expect(onStall).toHaveBeenCalledWith("chain-lost")
  })

  it("gives no probe, an unknown probe and a thrown probe the same grace as a healthy one", async () => {
    const probes: Array<() => Promise<ChainHealthResult | undefined>> = [
      async () => undefined,
      async () => unanswered,
      async () => {
        throw new Error("boom")
      },
    ]
    for (const probe of probes) {
      const onStall = vi.fn()
      armLaunchStall({ hasSource: () => true, probe, onStall })
      await vi.advanceTimersByTimeAsync(LAUNCH_STALL_MS)
      expect(onStall).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(LAUNCH_STALL_GRACE_MS)
      expect(onStall).toHaveBeenCalledWith("read-unanswered")
    }
  })

  it("still stalls, later, when the probe is healthy but the read never landed", async () => {
    const onStall = vi.fn()
    armLaunchStall({ hasSource: () => true, probe: async () => healthy, onStall })
    await vi.advanceTimersByTimeAsync(LAUNCH_STALL_MS)
    expect(onStall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(LAUNCH_STALL_GRACE_MS)
    expect(onStall).toHaveBeenCalledWith("read-unanswered")
  })

  it("says nothing once cancelled (the first status arrived)", async () => {
    const onStall = vi.fn()
    const probe = vi.fn(async () => healthy)
    const cancel = armLaunchStall({ hasSource: () => true, probe, onStall })
    await vi.advanceTimersByTimeAsync(LAUNCH_STALL_MS - 1)
    cancel()
    await vi.advanceTimersByTimeAsync(LAUNCH_STALL_MS + LAUNCH_STALL_GRACE_MS)
    expect(probe).not.toHaveBeenCalled()
    expect(onStall).not.toHaveBeenCalled()
  })

  it("drops a probe answer that lands after the cancel", async () => {
    const onStall = vi.fn()
    let answer: (result: ChainHealthResult) => void = () => {}
    const cancel = armLaunchStall({ hasSource: () => true, probe: () => new Promise((resolve) => (answer = resolve)), onStall })
    await vi.advanceTimersByTimeAsync(LAUNCH_STALL_MS)
    cancel()
    answer(lost)
    await vi.advanceTimersByTimeAsync(0)
    expect(onStall).not.toHaveBeenCalled()
  })
})
