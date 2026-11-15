// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import type { GameSlot } from "./attendance-rule"
import { SETTLE_POLL_MS, SETTLE_TIMEOUT_MS, isSettled, settleWait } from "./settle"

const game = (index: number): GameSlot => ({ index, state: { type: "Reporting" } })

afterEach(() => {
  vi.useRealTimers()
})

describe("the settle", () => {
  it("counts an empty slot or a later game as settled", () => {
    expect(isSettled(undefined, 7)).toBe(true)
    expect(isSettled(game(8), 7)).toBe(true)
    expect(isSettled(game(7), 7)).toBe(false)
  })

  it("answers a past game with one read, and notes it", async () => {
    const onSettled = vi.fn()
    const wait = settleWait({ readGame: async () => game(8), readGameOnce: async () => game(8), watchGame: () => () => {} }, { onSettled })
    await expect(wait.settledNow(7)).resolves.toBe(true)
    expect(onSettled).toHaveBeenCalledWith(7)
  })

  it("waits on the watch, polls past a silent one, and stops both once settled", async () => {
    vi.useFakeTimers()
    let current: GameSlot | undefined = game(7)
    let unsubscribed = false
    const readGameOnce = vi.fn(async () => current)
    const wait = settleWait({ readGame: async () => current, readGameOnce, watchGame: () => () => (unsubscribed = true) })
    const settled = wait.settled(7)
    await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS)
    expect(readGameOnce).toHaveBeenCalledTimes(1)
    current = undefined
    await vi.advanceTimersByTimeAsync(SETTLE_POLL_MS)
    await expect(settled).resolves.toBeUndefined()
    expect(unsubscribed).toBe(true)
  })

  it("answers the wait when the product's hook throws", async () => {
    let tell!: (game: GameSlot | undefined) => void
    const wait = settleWait(
      {
        readGame: async () => game(7),
        readGameOnce: async () => game(7),
        watchGame: (cb) => {
          tell = cb
          return () => {}
        },
      },
      {
        onSettled: () => {
          throw new Error("journey down")
        },
      },
    )
    const settled = wait.whenSettles(7)
    expect(() => tell(undefined)).not.toThrow()
    await expect(settled).resolves.toBeUndefined()
  })

  it("gives up after the deadline rather than waiting for ever", async () => {
    vi.useFakeTimers()
    const wait = settleWait({ readGame: async () => game(7), readGameOnce: async () => game(7), watchGame: () => () => {} })
    const settled = wait.whenSettles(7)
    const failed = expect(settled).rejects.toThrow(`game 7 has not settled after ${SETTLE_TIMEOUT_MS / 1000} seconds`)
    await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS)
    await failed
  })

  it("rejects with the product's reason once aborted", async () => {
    const controller = new AbortController()
    const wait = settleWait(
      { readGame: async () => game(7), readGameOnce: async () => game(7), watchGame: () => () => {} },
      { abortReason: () => new Error("left the page") },
    )
    const settled = wait.whenSettles(7, controller.signal)
    controller.abort()
    await expect(settled).rejects.toThrow("left the page")
  })
})
