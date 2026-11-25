// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  armCollectablesRereads,
  COLLECTABLES_REREAD_CAP_MS,
  COLLECTABLES_REREAD_FIRST_MS,
  COLLECTABLES_REREAD_SECOND_MS,
  collectablesRereadDelayMs,
  collectablesRestartVisible,
} from "./collectables-reread"

afterEach(() => vi.useRealTimers())

function harness(answers: Array<boolean | Promise<boolean>>) {
  let hidden = false
  let shown: (() => void) | undefined
  const reread = vi.fn(async () => await (answers.shift() ?? false))
  const stop = armCollectablesRereads({
    reread,
    hidden: () => hidden,
    onShown: (listener) => {
      shown = listener
      return () => (shown = undefined)
    },
  })
  return {
    reread,
    stop,
    hide: () => (hidden = true),
    show: () => {
      hidden = false
      shown?.()
    },
    notifyShown: () => shown?.(),
  }
}

describe("the collectables screen's later reads", () => {
  it("lets only shared host proof replace a collectables screen that is still loading", () => {
    expect(collectablesRestartVisible("loading", true, undefined)).toBe(true)
    expect(collectablesRestartVisible("retrying", false, "host-unanswered")).toBe(true)
    expect(collectablesRestartVisible("retrying", false, "chain-lost")).toBe(true)
    expect(collectablesRestartVisible("retrying", false, "read-unanswered")).toBe(false)
  })

  it("never replaces an already-loaded or settled collectables screen", () => {
    for (const state of ["ready", "settled"] as const) {
      expect(collectablesRestartVisible(state, true, undefined)).toBe(false)
      expect(collectablesRestartVisible(state, false, "host-unanswered")).toBe(false)
    }
  })

  it("waits 30 s, 60 s, then caps at two minutes", async () => {
    vi.useFakeTimers()
    const h = harness([false, false, false, false])
    for (const [elapsed, calls] of [
      [COLLECTABLES_REREAD_FIRST_MS, 1],
      [COLLECTABLES_REREAD_SECOND_MS, 2],
      [COLLECTABLES_REREAD_CAP_MS, 3],
      [COLLECTABLES_REREAD_CAP_MS, 4],
    ] as const) {
      await vi.advanceTimersByTimeAsync(elapsed)
      expect(h.reread).toHaveBeenCalledTimes(calls)
    }
    expect([0, 1, 2, 9].map(collectablesRereadDelayMs)).toEqual([30_000, 60_000, 120_000, 120_000])
    h.stop()
  })

  it("re-reads at once when the page returns, then re-arms after a failure", async () => {
    vi.useFakeTimers()
    const h = harness([false, false])
    h.hide()
    await vi.advanceTimersByTimeAsync(COLLECTABLES_REREAD_FIRST_MS)
    expect(h.reread).not.toHaveBeenCalled()
    h.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.reread).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(COLLECTABLES_REREAD_SECOND_MS)
    expect(h.reread).toHaveBeenCalledTimes(2)
    h.stop()
  })

  it("ignores a foreground notification while the page still reports hidden", async () => {
    vi.useFakeTimers()
    const h = harness([false])
    h.hide()
    h.notifyShown()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.reread).not.toHaveBeenCalled()
    h.stop()
  })

  it("stops after recovery and never overlaps a read already running", async () => {
    vi.useFakeTimers()
    let resolve: (value: boolean) => void = () => {}
    const pending = new Promise<boolean>((done) => (resolve = done))
    const h = harness([pending])
    await vi.advanceTimersByTimeAsync(COLLECTABLES_REREAD_FIRST_MS)
    h.show()
    expect(h.reread).toHaveBeenCalledTimes(1)
    resolve(true)
    await vi.advanceTimersByTimeAsync(COLLECTABLES_REREAD_CAP_MS * 2)
    expect(h.reread).toHaveBeenCalledTimes(1)
    h.stop()
  })

  it("cancels pending work when the stuck-host verdict takes over", async () => {
    vi.useFakeTimers()
    const h = harness([false])
    h.stop()
    await vi.advanceTimersByTimeAsync(COLLECTABLES_REREAD_CAP_MS)
    h.show()
    expect(h.reread).not.toHaveBeenCalled()
  })
})
