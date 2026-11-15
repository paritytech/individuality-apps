// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { createDeviceClock, STEP_SLACK_MS } from "./device-clock"

/** a wall clock and a monotonic one the test moves by hand */
function clocks() {
  let wall = 1_700_000_000_000
  let mono = 0
  let hidden = false
  const clock = createDeviceClock({
    wallMs: () => wall,
    monoMs: () => mono,
    hiddenSinceLastRead: () => {
      const was = hidden
      hidden = false
      return was
    },
  })
  return {
    clock,
    /** real time passes: both clocks move */
    pass: (ms: number) => {
      wall += ms
      mono += ms
    },
    /** the OS steps the wall clock */
    step: (ms: number) => (wall += ms),
    /** the page was hidden (and nothing else) */
    hide: () => (hidden = true),
    /** the page is hidden and frozen for `ms`: the monotonic clock stops */
    freeze: (ms: number) => {
      hidden = true
      wall += ms
    },
    start: wall,
  }
}

describe("the step-free device clock (#331)", () => {
  it("reads the wall clock while nothing steps it", () => {
    const { clock, pass, start } = clocks()
    pass(12_345)
    expect(clock.nowMs()).toBe(start + 12_345)
    expect(clock.stepMs()).toBe(0)
  })

  it("takes a +30 s and a -75 s step out", () => {
    const { clock, pass, step, start } = clocks()
    pass(1000)
    step(30_000)
    pass(1000)
    expect(clock.nowMs()).toBe(start + 2000)
    step(-75_000)
    pass(1000)
    expect(clock.nowMs()).toBe(start + 3000)
    expect(clock.stepMs()).toBe(-45_000)
  })

  it("sees a step whenever it is next read, however long after", () => {
    const { clock, pass, step, start } = clocks()
    clock.nowMs()
    pass(60_000)
    step(-75_000)
    pass(60_000)
    expect(clock.nowMs()).toBe(start + 120_000)
  })

  it("leaves timer jitter within the slack alone", () => {
    const { clock, step, start } = clocks()
    step(STEP_SLACK_MS - 1)
    expect(clock.nowMs()).toBe(start + STEP_SLACK_MS - 1)
  })

  it("trusts the wall across a hidden page: a freeze stops the monotonic clock, it is no step", () => {
    const { clock, pass, freeze, start } = clocks()
    pass(1000)
    clock.nowMs()
    freeze(90_000)
    expect(clock.nowMs()).toBe(start + 91_000)
    pass(1000)
    expect(clock.nowMs()).toBe(start + 92_000)
  })

  it("corrects a BACKWARD step even across a hidden page: a freeze only ever moves the wall forward", () => {
    const { clock, pass, step, hide, start } = clocks()
    pass(1000)
    clock.nowMs()
    hide()
    step(-75_000)
    pass(1000)
    expect(clock.nowMs()).toBe(start + 2000)
  })
})
