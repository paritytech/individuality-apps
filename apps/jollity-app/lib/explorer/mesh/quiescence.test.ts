// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { AsyncLocalStorage } from "node:async_hooks"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installFakeClock } from "./quiescence"

describe("the explorer fake clock fingerprint metadata", () => {
  afterEach(() => vi.useRealTimers())

  it("restores the real-timer trap when the fake clock is uninstalled", () => {
    const trapped = globalThis.setTimeout
    installFakeClock()
    vi.useRealTimers()
    expect(globalThis.setTimeout).toBe(trapped)
    expect(globalThis.clearTimeout).toBeTypeOf("function")
    expect(globalThis.setInterval).toBeTypeOf("function")
    expect(globalThis.clearInterval).toBeTypeOf("function")
  })

  it("keeps an owner through a promise continuation and re-enters it for its timer", async () => {
    const owners = new AsyncLocalStorage<"a" | "b">()
    const fired: Array<{ owner: "a" | "b" | null; kind: string }> = []
    const clock = installFakeClock({
      owner: () => owners.getStore() ?? null,
      fire: (timer, run) => {
        fired.push({ owner: timer.owner, kind: timer.isInterval ? "interval" : "timeout" })
        if (timer.owner === null) run()
        else owners.run(timer.owner, run)
      },
    })

    await owners.run("b", async () => {
      await Promise.resolve()
      expect(owners.getStore()).toBe("b")
      setInterval(() => expect(owners.getStore()).toBe("b"), 30)
    })

    expect(clock.timers().map(({ due, rank, periodMs, owner }) => ({ due, rank, periodMs, owner }))).toEqual([
      { due: 30, rank: 0, periodMs: 30, owner: "b" },
    ])
    clock.next()
    expect(fired).toEqual([{ owner: "b", kind: "interval" }])
  })

  it("orders tied timers by numeric handle", () => {
    const clock = installFakeClock()
    setTimeout(() => {}, 100)
    setTimeout(() => {}, 100)
    const timers = clock.timers()
    expect(timers.map(({ rank }) => rank)).toEqual([0, 1])
    expect(Number(timers[0]!.handle)).toBeLessThan(Number(timers[1]!.handle))
  })

  it("reports each tied timer's identity, original rank and due time before firing it", () => {
    const fired: Array<{ handle: number | string; identity: number; rank: number; due: number }> = []
    const clock = installFakeClock({
      owner: () => "a",
      fire: (timer, run) => {
        fired.push({ handle: timer.handle, identity: timer.identity, rank: timer.rank, due: timer.due })
        run()
      },
    })
    setTimeout(() => {}, 100)
    setTimeout(() => {}, 100)

    clock.next()
    clock.next()

    expect(fired).toHaveLength(2)
    expect(fired[0]!.handle).not.toBe(fired[1]!.handle)
    expect(fired.map(({ identity }) => identity)).toEqual([0, 1])
    expect(fired.map(({ rank, due }) => ({ rank, due }))).toEqual([
      { rank: 0, due: 100 },
      { rank: 0, due: 100 },
    ])
  })
})
