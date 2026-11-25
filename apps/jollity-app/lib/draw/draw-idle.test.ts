// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { DRAW_IDLE_MS, createDrawIdle, touchOnPointerDown } from "./draw-idle"

/** a page with a monotonic clock that stops while hidden, a device clock that keeps going, and a store that outlives the page */
function world(store = new Map<string, string>(), unloading = false) {
  let device = 5_000_000
  let mono = 0
  let hidden = false
  let timers: { at: number; fn: () => void }[] = []
  const onVisible: (() => void)[] = []
  const advance = vi.fn()
  const idle = createDrawIdle({
    key: "game-9",
    onAdvance: advance,
    deviceNowMs: () => device,
    monoNowMs: () => mono,
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v), remove: (k) => void store.delete(k) },
    setTimer: (fn, ms) => {
      const t = { at: mono + ms, fn }
      timers.push(t)
      return () => void (timers = timers.filter((x) => x !== t))
    },
    unloading: () => unloading,
    onVisible: (fn) => {
      onVisible.push(fn)
      return () => void onVisible.splice(onVisible.indexOf(fn), 1)
    },
  })
  return {
    idle,
    advance,
    store,
    /** time passes with the page visible: both clocks and the timers move */
    visible(ms: number) {
      for (const step of [ms]) {
        device += step
        mono += step
        for (const t of [...timers]) if (t.at <= mono) { timers = timers.filter((x) => x !== t); t.fn() }
      }
    },
    /** the page is hidden and frozen: the device clock moves, the monotonic one and the timers do not */
    frozen(ms: number) {
      hidden = true
      device += ms
    },
    show() {
      hidden = false
      for (const fn of [...onVisible]) fn()
    },
    isHidden: () => hidden,
  }
}

describe("draw idle advance", () => {
  it("advances after 60 s without a tap while the page is visible", () => {
    const w = world()
    w.idle.start()
    w.visible(DRAW_IDLE_MS - 1)
    expect(w.advance).not.toHaveBeenCalled()
    w.visible(1)
    expect(w.advance).toHaveBeenCalledTimes(1)
  })

  it("does not advance under 60 s, including on a return", () => {
    const w = world()
    w.idle.start()
    w.visible(10_000)
    w.frozen(30_000)
    w.show()
    expect(w.advance).not.toHaveBeenCalled()
  })

  it("advances on return when the page was hidden 60 s or more, though its timer froze", () => {
    const w = world()
    w.idle.start()
    w.visible(5_000)
    w.frozen(DRAW_IDLE_MS)
    expect(w.advance).not.toHaveBeenCalled()
    w.show()
    expect(w.advance).toHaveBeenCalledTimes(1)
  })

  it("a reload past 60 s lands on the collectables screen at once, from the stored start", () => {
    const store = new Map<string, string>()
    const first = world(store, true)
    first.idle.start()
    first.visible(1_000)
    first.idle.detach() // a reload: the page goes; the stored start stays
    expect(store.size).toBe(1)
    // a new page, 70 s after the first one began (device 5_000_000 in every world, so move the stamp back)
    const reloaded = world(new Map([["jollity.draw-idle.game-9", String(5_000_000 - 70_000)]]))
    reloaded.idle.start()
    expect(reloaded.advance).toHaveBeenCalledTimes(1)
  })

  it("a normal unmount forgets the start: the next open is a fresh 60 s", () => {
    const store = new Map<string, string>()
    const first = world(store)
    first.idle.start()
    first.visible(50_000)
    first.idle.detach()
    expect(store.size).toBe(0)
    const again = world(store)
    again.idle.start()
    again.visible(50_000)
    expect(again.advance).not.toHaveBeenCalled()
  })

  it("a reload under 60 s keeps counting from the stored start", () => {
    const reloaded = world(new Map([["jollity.draw-idle.game-9", String(5_000_000 - 40_000)]]))
    reloaded.idle.start()
    expect(reloaded.advance).not.toHaveBeenCalled()
    reloaded.visible(20_000)
    expect(reloaded.advance).toHaveBeenCalledTimes(1)
  })

  it("a tap restarts the 60 s", () => {
    const w = world()
    w.idle.start()
    w.visible(50_000)
    w.idle.touch()
    w.visible(50_000)
    expect(w.advance).not.toHaveBeenCalled()
    w.visible(10_000)
    expect(w.advance).toHaveBeenCalledTimes(1)
  })

  it("advances once, and stop() clears the stored start and the timers", () => {
    const w = world()
    w.idle.start()
    w.visible(DRAW_IDLE_MS)
    w.show()
    w.visible(DRAW_IDLE_MS)
    expect(w.advance).toHaveBeenCalledTimes(1)
    const w2 = world()
    w2.idle.start()
    w2.idle.stop()
    w2.visible(DRAW_IDLE_MS * 2)
    expect(w2.advance).not.toHaveBeenCalled()
    expect(w2.store.size).toBe(0)
  })

  it("the container listener restarts the 60 s on a pointerdown, in capture, and is removable", () => {
    const calls: [string, boolean][] = []
    let handler: (() => void) | undefined
    const host = {
      addEventListener: (type: string, fn: () => void, capture?: boolean | AddEventListenerOptions) => {
        calls.push([type, capture === true])
        handler = fn
      },
      removeEventListener: vi.fn(),
    }
    const idle = { touch: vi.fn() }
    const off = touchOnPointerDown(host, idle)
    expect(calls).toEqual([["pointerdown", true]])
    handler?.()
    expect(idle.touch).toHaveBeenCalledTimes(1)
    off()
    expect(host.removeEventListener).toHaveBeenCalledTimes(1)
  })
})
