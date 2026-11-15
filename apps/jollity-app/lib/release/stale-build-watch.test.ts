// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BACKOFF_MS, FOREGROUND_RECHECK_MS, watchBuild, type WatchBuildDeps } from "./stale-build-watch"
import type { BuildCheck } from "./stale-build"

let hidden = false
let onHidden: () => void = () => {}
let onShown: (() => void) | undefined
let clock = 0

function setup(answers: BuildCheck[], over: Partial<WatchBuildDeps> = {}) {
  const queue = [...answers]
  const check = vi.fn(async () => queue.shift() ?? ("unknown" as BuildCheck))
  const results: [string, number, string?][] = []
  const stop = watchBuild({
    check,
    onResult: (state, attempts, reason) => results.push(reason ? [state, attempts, reason] : [state, attempts]),
    isHidden: () => hidden,
    watchHidden: (h, s) => {
      onHidden = h
      onShown = s
      return () => {}
    },
    now: () => clock,
    ...over,
  })
  return { check, results, stop }
}
const hide = () => {
  hidden = true
  onHidden()
}
const show = () => {
  hidden = false
  onShown?.()
}
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  clock = 0
})
afterEach(() => vi.useRealTimers())

describe("watchBuild", () => {
  it("asks at once; a definite answer ends it", async () => {
    const { check, results } = setup(["stale"])
    await tick(0)
    expect(results).toEqual([["stale", 1]])
    await tick(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it("unknown is retried with backoff until a definite answer, then stops", async () => {
    const { check, results } = setup(["unknown", "unknown", "unknown", "stale"])
    await tick(0)
    expect(check).toHaveBeenCalledTimes(1)
    await tick(BACKOFF_MS[0] - 1)
    expect(check).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(check).toHaveBeenCalledTimes(2)
    await tick(BACKOFF_MS[1])
    expect(check).toHaveBeenCalledTimes(3)
    await tick(BACKOFF_MS[2])
    expect(check).toHaveBeenCalledTimes(4)
    expect(results.at(-1)).toEqual(["stale", 4])
    await tick(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(4)
  })

  it("backs off 5, 10, 20, 40 s, then every 60 s", () => {
    expect(BACKOFF_MS).toEqual([5000, 10_000, 20_000, 40_000, 60_000])
  })

  it("keeps asking every 60 s while the answer stays unknown", async () => {
    const { check } = setup([])
    await tick(0)
    await tick(5000 + 10_000 + 20_000 + 40_000)
    expect(check).toHaveBeenCalledTimes(5)
    await tick(60_000)
    await tick(60_000)
    expect(check).toHaveBeenCalledTimes(7)
  })

  it("a hidden page asks nothing, and asks again on return", async () => {
    const { check } = setup(["unknown", "stale"])
    await tick(0)
    hide()
    await tick(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(1)
    show()
    await tick(0)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it("does not start while the page is hidden", async () => {
    hidden = true
    const { check } = setup(["stale"])
    await tick(60_000)
    expect(check).not.toHaveBeenCalled()
    show()
    await tick(0)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it("hiding aborts the attempt in flight", async () => {
    let seen: AbortSignal | undefined
    const { results } = setup([], {
      check: (signal) => {
        seen = signal
        return new Promise<BuildCheck>(() => {})
      },
    })
    await tick(0)
    hide()
    expect(seen?.aborted).toBe(true)
    expect(results).toEqual([])
  })

  it("stopping ends the schedule and aborts", async () => {
    const { check, stop } = setup([])
    await tick(0)
    stop()
    await tick(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it("a current answer is asked once more after the app was hidden over five minutes", async () => {
    const { check, results } = setup(["current", "stale"])
    await tick(0)
    clock = 1000
    hide()
    clock = 1000 + FOREGROUND_RECHECK_MS + 1
    show()
    await tick(0)
    expect(check).toHaveBeenCalledTimes(2)
    expect(results.at(-1)).toEqual(["stale", 1])
  })

  it("a short absence does not re-ask a current answer", async () => {
    const { check } = setup(["current"])
    await tick(0)
    clock = 1000
    hide()
    clock = 1000 + FOREGROUND_RECHECK_MS - 1
    show()
    await tick(0)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it("a failed foreground re-check goes through the same backoff until it is definite", async () => {
    const { check, results } = setup(["current", "unknown", "unknown", "stale"])
    await tick(0)
    hide()
    clock = FOREGROUND_RECHECK_MS + 1
    show()
    await tick(0)
    expect(check).toHaveBeenCalledTimes(2)
    await tick(BACKOFF_MS[0])
    expect(check).toHaveBeenCalledTimes(3)
    await tick(BACKOFF_MS[1])
    expect(check).toHaveBeenCalledTimes(4)
    // "current" stood meanwhile: no "unknown" was reported over it
    expect(results).toEqual([["current", 1], ["stale", 3]])
    await tick(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(4)
  })

  it("stale is final: a return from the background asks nothing", async () => {
    const { check } = setup(["stale"])
    await tick(0)
    hide()
    clock = 60 * 60_000
    show()
    await tick(0)
    expect(check).toHaveBeenCalledTimes(1)
  })
  it("a failure is reported as failed, a denial as denied", async () => {
    const { results } = setup(["unknown"])
    await tick(0)
    expect(results).toEqual([["unknown", 1, "failed"]])
    const second = setup(["denied"])
    await tick(0)
    expect(second.results).toEqual([["unknown", 1, "denied"]])
  })

  it("a denial stops the backoff: no re-prompt every minute, only once per return", async () => {
    const { check } = setup(["denied", "denied", "stale"])
    await tick(0)
    await tick(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(1)
    hide()
    await tick(60_000)
    show()
    await tick(0)
    expect(check).toHaveBeenCalledTimes(2)
    await tick(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(2)
    hide()
    show()
    await tick(0)
    expect(check).toHaveBeenCalledTimes(3)
  })

  it("a denied recheck of a current build is silent and waits for the next return", async () => {
    const { check, results } = setup(["current", "denied"])
    await tick(0)
    hide()
    clock = FOREGROUND_RECHECK_MS + 1
    show()
    await tick(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(2)
    expect(results).toEqual([["current", 1]])
  })
})
