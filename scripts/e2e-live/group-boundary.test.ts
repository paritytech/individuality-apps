// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { awaitSharedNetwork, type GroupChildMessage } from "./group-boundary"

describe("shared network child boundary", () => {
  it("is a no-op for dedicated runners", async () => {
    await expect(awaitSharedNetwork({ E2E_SLOT: "1" })).resolves.toBe(false)
  })

  it("announces readiness and waits for its own supervisor release", async () => {
    let receive!: (message: unknown) => void
    const sent: GroupChildMessage[] = []
    const waiting = awaitSharedNetwork({ E2E_SHARED_NETWORK: "1", E2E_SLOT: "7", E2E_GROUP_RELEASE_BY_MS: String(Date.now() + 1_000) }, {
      send: (message) => sent.push(message),
      listen: (handler) => { receive = handler; return () => undefined },
    })
    expect(sent).toEqual([{ type: "e2e-group-ready", slot: 7, releaseByMs: expect.any(Number) }])
    receive({ type: "e2e-group-release", slot: 8 })
    receive({ type: "e2e-group-release", slot: 7 })
    await expect(waiting).resolves.toBe(true)
  })

  it("surfaces supervisor aborts", async () => {
    let receive!: (message: unknown) => void
    const waiting = awaitSharedNetwork({ E2E_SHARED_NETWORK: "1", E2E_SLOT: "2" }, {
      send: () => undefined,
      listen: (handler) => { receive = handler; return () => undefined },
    })
    receive({ type: "e2e-group-abort", slot: 2, reason: "netem failed" })
    await expect(waiting).rejects.toThrow(/netem failed/)
  })

  it("fails promptly when the supervisor IPC channel is unavailable", async () => {
    await expect(awaitSharedNetwork({ E2E_SHARED_NETWORK: "1", E2E_SLOT: "2" }, {
      send: () => { throw new Error("channel closed") },
      listen: () => () => undefined,
    })).rejects.toThrow(/channel closed/)
  })

  it("does not accept a release after the registration budget expires", async () => {
    vi.useFakeTimers()
    try {
      const waiting = awaitSharedNetwork({ E2E_SHARED_NETWORK: "1", E2E_SLOT: "2", E2E_GROUP_RELEASE_BY_MS: "20" }, {
        send: () => undefined,
        listen: () => () => undefined,
        now: () => 20,
      })
      const rejected = expect(waiting).rejects.toThrow(/registration budget expired/)
      await vi.runAllTimersAsync()
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it("checks the deadline again when release races the timeout callback", async () => {
    let receive!: (message: unknown) => void
    let now = 0
    const sent: GroupChildMessage[] = []
    const waiting = awaitSharedNetwork({ E2E_SHARED_NETWORK: "1", E2E_SLOT: "2", E2E_GROUP_RELEASE_BY_MS: "20" }, {
      send: (message) => sent.push(message),
      listen: (handler) => { receive = handler; return () => undefined },
      now: () => now,
    })
    now = 20
    receive({ type: "e2e-group-release", slot: 2 })
    await expect(waiting).rejects.toThrow(/registration budget expired/)
    expect(sent.at(-1)).toEqual({ type: "e2e-group-expired", slot: 2, reason: expect.stringMatching(/registration budget expired/) })
  })

  it("hands boot network ownership to the supervisor after the registration wait", () => {
    const boot = readFileSync(new URL("./boot.mts", import.meta.url), "utf8")
    const registrationWait = boot.indexOf("// 4. wait for the registration")
    const boundary = boot.indexOf("await awaitSharedNetwork({")
    const journey = boot.indexOf("// 5. the journey")
    expect(registrationWait).toBeGreaterThan(-1)
    expect(boundary).toBeGreaterThan(registrationWait)
    expect(boundary).toBeLessThan(journey)
    expect(boot).toContain("shared: externallyShaped")
  })
})
