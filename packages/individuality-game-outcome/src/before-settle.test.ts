// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { BEFORE_SETTLE_REREAD_MS, readBeforeSettle, readUntilSettle, UNTIL_SETTLE_BACKSTOP_MS } from "./before-settle"

afterEach(() => {
  vi.useRealTimers()
})

const never = () => new Promise<void>(() => {})

describe("a read before the settle", () => {
  it("answers the first read that found something, with its attempt", async () => {
    vi.useFakeTimers()
    const answers = [[], [], ["credit"]]
    const read = vi.fn(async () => answers.shift() ?? null)
    const found = readBeforeSettle({ read, arrived: (items: string[]) => items.length > 0, settles: never() })
    await vi.advanceTimersByTimeAsync(2 * BEFORE_SETTLE_REREAD_MS)
    await expect(found).resolves.toEqual({ value: ["credit"], attempt: 3 })
  })

  it("stops once the game settles with nothing found", async () => {
    let settle!: () => void
    const settles = new Promise<void>((resolve) => (settle = resolve))
    const read = vi.fn(async () => [] as string[])
    const found = readBeforeSettle({ read, arrived: (items) => items.length > 0, settles })
    settle()
    await expect(found).resolves.toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("reports a read that threw and reads again", async () => {
    vi.useFakeTimers()
    const onReadError = vi.fn()
    const read = vi.fn<() => Promise<string[] | null>>().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(["credit"])
    const found = readBeforeSettle({ read, arrived: (items) => items.length > 0, settles: never(), onReadError })
    await vi.advanceTimersByTimeAsync(BEFORE_SETTLE_REREAD_MS)
    await expect(found).resolves.toMatchObject({ attempt: 2 })
    expect(onReadError).toHaveBeenCalledWith(expect.any(Error), 1)
  })

  it("leaves no listener on the signal behind its pauses", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const added = vi.spyOn(controller.signal, "addEventListener")
    const removed = vi.spyOn(controller.signal, "removeEventListener")
    const answers = [[], [], [], ["credit"]]
    const found = readBeforeSettle({
      read: async () => answers.shift() ?? null,
      arrived: (items: string[]) => items.length > 0,
      settles: never(),
      signal: controller.signal,
    })
    await vi.advanceTimersByTimeAsync(3 * BEFORE_SETTLE_REREAD_MS)
    await expect(found).resolves.toMatchObject({ attempt: 4 })
    expect(added).toHaveBeenCalledTimes(3)
    expect(removed).toHaveBeenCalledTimes(3)
  })

  it("answers on the change that brought the first claim, not a block later", async () => {
    vi.useFakeTimers()
    let changed!: () => void
    const answers = [[], ["credit"]]
    const read = vi.fn(async () => answers.shift() ?? null)
    const found = readBeforeSettle({
      read,
      arrived: (items: string[]) => items.length > 0,
      settles: never(),
      watch: (onChange) => {
        changed = onChange
        return () => {}
      },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    changed()
    await vi.advanceTimersByTimeAsync(0)
    await expect(found).resolves.toEqual({ value: ["credit"], attempt: 2 })
  })

  it("throws the product's reason once aborted", async () => {
    const controller = new AbortController()
    const read = vi.fn(async () => {
      controller.abort()
      return [] as string[]
    })
    const found = readBeforeSettle({
      read,
      arrived: (items) => items.length > 0,
      settles: never(),
      signal: controller.signal,
      abortReason: () => new Error("left the page"),
    })
    await expect(found).rejects.toThrow("left the page")
  })
})

describe("reads until the settle", () => {
  it("hands every read over, and stops once the game settles", async () => {
    vi.useFakeTimers()
    let settle!: () => void
    const settles = new Promise<void>((resolve) => (settle = resolve))
    const answers = [["a"], null, ["a", "b"]]
    const onRead = vi.fn()
    const read = vi.fn(async (attempt: number) => (attempt <= answers.length ? (answers[attempt - 1] as string[] | null) : ["a", "b"]))
    const done = readUntilSettle({ read, onRead, settles })
    await vi.advanceTimersByTimeAsync(2 * BEFORE_SETTLE_REREAD_MS)
    expect(onRead.mock.calls).toEqual([
      [["a"], 1],
      [["a", "b"], 3],
    ])
    settle()
    await expect(done).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(3 * BEFORE_SETTLE_REREAD_MS)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it("stops when the settle's wait gives up", async () => {
    const read = vi.fn(async () => ["a"])
    const done = readUntilSettle({ read, onRead: () => {}, settles: Promise.reject(new Error("not settled in time")) })
    await expect(done).resolves.toBeUndefined()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("reports a read that threw and reads again", async () => {
    vi.useFakeTimers()
    const onReadError = vi.fn()
    const onRead = vi.fn()
    const read = vi.fn<() => Promise<string[] | null>>().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(["a"])
    void readUntilSettle({ read, onRead, settles: never(), onReadError })
    await vi.advanceTimersByTimeAsync(BEFORE_SETTLE_REREAD_MS)
    expect(onReadError).toHaveBeenCalledWith(expect.any(Error), 1)
    expect(onRead).toHaveBeenCalledWith(["a"], 2)
  })

  it("throws the product's reason once aborted", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const done = readUntilSettle({
      read: async () => ["a"],
      onRead: () => {},
      settles: never(),
      signal: controller.signal,
      abortReason: () => new Error("left the page"),
    })
    const failed = expect(done).rejects.toThrow("left the page")
    await vi.advanceTimersByTimeAsync(BEFORE_SETTLE_REREAD_MS / 2)
    controller.abort()
    await failed
  })
})

describe("reads until the settle, on the chain's word", () => {
  const watched = () => {
    const w: { changed: () => void; failed: (error: unknown) => void; stopped: boolean } = { changed: () => {}, failed: () => {}, stopped: false }
    const watch = (changed: () => void, failed: (error: unknown) => void) => {
      w.changed = changed
      w.failed = failed
      return () => (w.stopped = true)
    }
    return { w, watch }
  }

  it("reads on each change, not on a timer", async () => {
    vi.useFakeTimers()
    const { w, watch } = watched()
    const read = vi.fn(async () => ["a"])
    void readUntilSettle({ read, onRead: () => {}, settles: never(), watch })
    await vi.advanceTimersByTimeAsync(3 * BEFORE_SETTLE_REREAD_MS)
    expect(read).toHaveBeenCalledTimes(1)
    w.changed()
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("makes one more read for changes during a read, not one each", async () => {
    vi.useFakeTimers()
    const { w, watch } = watched()
    let answer!: (value: string[]) => void
    const read = vi.fn(() => new Promise<string[]>((resolve) => (answer = resolve)))
    void readUntilSettle({ read, onRead: () => {}, settles: never(), watch })
    w.changed()
    w.changed()
    answer(["a"])
    await vi.advanceTimersByTimeAsync(0)
    answer(["a"])
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("reads anyway every backstop, in case the watch went quiet", async () => {
    vi.useFakeTimers()
    const { watch } = watched()
    const read = vi.fn(async () => ["a"])
    void readUntilSettle({ read, onRead: () => {}, settles: never(), watch })
    await vi.advanceTimersByTimeAsync(UNTIL_SETTLE_BACKSTOP_MS)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("reads every block once the watch fails", async () => {
    vi.useFakeTimers()
    const { w, watch } = watched()
    const onWatchError = vi.fn()
    const read = vi.fn(async () => ["a"])
    void readUntilSettle({ read, onRead: () => {}, settles: never(), watch, onWatchError })
    // it dies during the first read: the reads go back to one a block
    w.failed(new Error("subscription dropped"))
    await vi.advanceTimersByTimeAsync(2 * BEFORE_SETTLE_REREAD_MS)
    expect(onWatchError).toHaveBeenCalledWith(expect.any(Error))
    expect(read).toHaveBeenCalledTimes(3)
  })

  it("stops the watch once the game settles", async () => {
    vi.useFakeTimers()
    const { w, watch } = watched()
    let settle!: () => void
    const settles = new Promise<void>((resolve) => (settle = resolve))
    const done = readUntilSettle({ read: async () => ["a"], onRead: () => {}, settles, watch })
    await vi.advanceTimersByTimeAsync(0)
    settle()
    await expect(done).resolves.toBeUndefined()
    expect(w.stopped).toBe(true)
  })
})
