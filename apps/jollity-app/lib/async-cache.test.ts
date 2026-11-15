// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { AsyncCache, once } from "./async-cache"

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("AsyncCache", () => {
  it("builds a key once for every caller", async () => {
    const cache = new AsyncCache<number>()
    const build = vi.fn(async () => 7)
    const [a, b] = await Promise.all([cache.ensure("k", build), cache.ensure("k", build)])
    expect([a, b]).toEqual([7, 7])
    expect(build).toHaveBeenCalledTimes(1)
  })

  it("forgets a failed build, so the next ask retries", async () => {
    const cache = new AsyncCache<number>()
    await expect(cache.ensure("k", async () => Promise.reject(new Error("no")))).rejects.toThrow("no")
    await tick()
    expect(await cache.ensure("k", async () => 3)).toBe(3)
  })

  it("forgets a value `keep` turns down", async () => {
    const cache = new AsyncCache<string>({ keep: (v) => v !== "" })
    expect(await cache.ensure("k", async () => "")).toBe("")
    await tick()
    expect(await cache.ensure("k", async () => "url")).toBe("url")
  })

  it("evicts the key asked for least recently", async () => {
    const cache = new AsyncCache<string>({ max: 2 })
    await cache.ensure("a", async () => "a")
    await cache.ensure("b", async () => "b")
    await cache.ensure("a", async () => "rebuilt") // touches a
    await cache.ensure("c", async () => "c") // evicts b
    await tick()
    const build = vi.fn(async () => "fresh")
    expect(await cache.ensure("a", build)).toBe("a")
    expect(await cache.ensure("b", build)).toBe("fresh")
  })

  it("clears every key, and a build in flight settles for its caller without being kept", async () => {
    const cache = new AsyncCache<string>()
    await cache.ensure("a", async () => "a")
    let finish: (value: string) => void = () => {}
    const inFlight = cache.ensure("b", () => new Promise<string>((resolve) => (finish = resolve)))
    cache.clear()
    finish("b")
    expect(await inFlight).toBe("b")
    await tick()
    expect(cache.peek("a")).toBeUndefined()
    expect(cache.peek("b")).toBeUndefined()
    const build = vi.fn(async () => "fresh")
    expect(await cache.ensure("a", build)).toBe("fresh")
    expect(await cache.ensure("b", build)).toBe("fresh")
    expect(build).toHaveBeenCalledTimes(2)
  })

  it("lets a renderer peek, and tells it when a value is ready", async () => {
    const cache = new AsyncCache<number>()
    const listener = vi.fn()
    const stop = cache.subscribe(listener)
    expect(cache.peek("k")).toBeUndefined()
    await cache.ensure("k", async () => 5)
    await tick()
    expect(cache.peek("k")).toBe(5)
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe("once", () => {
  it("runs once and shares the result", async () => {
    const build = vi.fn(async () => 1)
    const load = once(build)
    expect(await Promise.all([load(), load()])).toEqual([1, 1])
    expect(build).toHaveBeenCalledTimes(1)
  })

  it("runs again after a failure", async () => {
    let n = 0
    const load = once(async () => {
      n++
      if (n === 1) throw new Error("first")
      return n
    })
    await expect(load()).rejects.toThrow("first")
    expect(await load()).toBe(2)
  })
})
