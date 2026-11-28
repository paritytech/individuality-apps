// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { waitForAppClock, waitForReadyValue, waitingNetworkWarningTimeoutMs } from "./persona-readiness"
import type { AppClockReading } from "./game-clock"

const clock = (nowMs: number, readAtMs = nowMs): AppClockReading => ({
  nowMs,
  nowSeconds: Math.floor(nowMs / 1000),
  offset: 0,
  block: 1,
  readAtMs,
})

describe("nightly persona readiness from the 26 October artifact excerpts", () => {
  it("keeps the T-300 warning assertion alive up to the saved run's handover", () => {
    // The saved run fired the outage at 1_792_988_100_001 and did not log its
    // blocked result until 1_792_988_321_066. The old 30 s wait ended first.
    const outageAtMs = 1_792_988_100_001
    const blockedAtMs = 1_792_988_321_066
    const gameAt = 1_792_988_400
    const timeoutMs = waitingNetworkWarningTimeoutMs(clock(outageAtMs), gameAt - 66, outageAtMs)

    expect(outageAtMs + 30_000).toBeLessThan(blockedAtMs)
    expect(outageAtMs + timeoutMs).toBeGreaterThan(blockedAtMs)
    expect(timeoutMs).toBe(233_999)
  })

  it("waits through the relaunched document's 785 ms clock publication gap", async () => {
    // The saved document started at .711 and logged clock ready at .496 in the
    // next second. Use symbolic reads so no live identity enters the fixture.
    let elapsedMs = 0
    const ready = clock(1_792_987_950_496)
    const read = async () => elapsedMs >= 785 ? ready : null
    const result = await waitForAppClock(read, {
      timeoutMs: 2_000,
      pollMs: 250,
      nowMs: () => elapsedMs,
      sleep: async (ms) => { elapsedMs += ms },
    })

    expect(result).toBe(ready)
    expect(elapsedMs).toBe(1_000)
  })

  it("returns null at the readiness bound", async () => {
    let elapsedMs = 0
    const result = await waitForAppClock(async () => null, {
      timeoutMs: 800,
      pollMs: 250,
      nowMs: () => elapsedMs,
      sleep: async (ms) => { elapsedMs += ms },
    })

    expect(result).toBeNull()
    expect(elapsedMs).toBe(800)
  })

  it("retries an incomplete handover roster until the saved shuffle window settles", async () => {
    // In the 27 October artifact the round-2 roster existed only after the
    // handover transition. Keep the excerpt anonymous: one incomplete read,
    // then the final five co-player accounts.
    let elapsedMs = 0
    let reads = 0
    const roster = await waitForReadyValue(
      () => ({ roundPeers: reads++ === 0 ? [] : [["peer-a"], ["peer-b", "peer-c", "peer-d", "peer-e", "peer-f"]] }),
      (value) => (value.roundPeers.at(-1)?.length ?? 0) > 0,
      {
        deadlineMs: 30_000,
        nowMs: () => elapsedMs,
        sleep: async (ms) => { elapsedMs += ms },
      },
    )

    expect(roster.roundPeers.at(-1)).toHaveLength(5)
    expect(elapsedMs).toBe(1_000)
  })
})
