// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import {
  CHAIN_READ_MARGIN_MS,
  CHAIN_READ_PARENT_TIMEOUT_MS,
  chainReadChildTimeoutMs,
  chainReadExitError,
  formatSignUpPoll,
  medianObservedBlockMs,
  withChainReadTimeout,
} from "./chain-read-runtime"

describe("chain-read command deadlines", () => {
  it("starts the real child loader and exercises SDK-backed group overlap", () => {
    const root = resolve(__dirname, "../..")
    const child = spawnSync(process.execPath, ["--import", "tsx", resolve(__dirname, "chain-read.mts"), "loader-smoke"], {
      cwd: root,
      env: { ...process.env, E2E_NETWORK: "previewnet" },
      encoding: "utf8",
      timeout: 20_000,
    })
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({ sharedRounds: [0] })
  })

  it("keeps child stderr in the parent failure", () => {
    expect(chainReadExitError("state", 1, "loader detail\n").message).toBe("chain-read state exited 1: loader detail")
  })

  it("derives one-shot child deadlines from the parent bounds", () => {
    expect(CHAIN_READ_MARGIN_MS).toBe(10_000)
    expect(chainReadChildTimeoutMs("players")).toBe(CHAIN_READ_PARENT_TIMEOUT_MS.default - CHAIN_READ_MARGIN_MS)
    expect(chainReadChildTimeoutMs("votes")).toBe(CHAIN_READ_PARENT_TIMEOUT_MS.votes - CHAIN_READ_MARGIN_MS)
    expect(chainReadChildTimeoutMs("watch")).toBeNull()
  })

  it("fails with the command, duration and endpoint before the parent kills it", async () => {
    vi.useFakeTimers()
    try {
      const pending = new Promise<never>(() => {})
      const result = withChainReadTimeout(pending, { command: "players", endpoint: "wss://people.example", timeoutMs: 10_000 })
      const assertion = expect(result).rejects.toThrow('chain-read "players" timed out after 10 s against wss://people.example')
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("observed block duration", () => {
  it("uses the median of several positive consecutive observations", () => {
    expect(medianObservedBlockMs([6_000, 12_000, 6_001, 5_999, 6_000])).toBe(6_000)
    expect(medianObservedBlockMs([0, Number.NaN, -1])).toBeNull()
  })
})

describe("sign-up poll progress", () => {
  it("prints every account compactly and caps failure detail", () => {
    const line = formatSignUpPoll(3, 12_345, [
      { name: "alice", status: "pass", detail: "registered" },
      { name: "bob", status: "fail", detail: "x".repeat(200) },
    ])
    expect(line).toContain("sign-up poll 3 (12 s): 1/2 registered")
    expect(line).toContain("bob: ")
    expect(line.length).toBeLessThan(220)
  })

  it("still emits the successful final poll", () => {
    expect(formatSignUpPoll(4, 18_000, [{ name: "alice", status: "pass", detail: "registered" }])).toBe("sign-up poll 4 (18 s): 1/1 registered")
  })
})
