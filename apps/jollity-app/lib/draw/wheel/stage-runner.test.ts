// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WheelDraw, WheelOptions } from "./mount"
import { startStage, type StageEvents } from "./stage-runner"

const h = vi.hoisted(() => ({
  /** what the stage and the coins were asked to do, in order */
  calls: [] as string[],
  /** what the mounted stage calls back */
  stage: {} as Pick<WheelOptions, "onEnded" | "onDone">,
  mountThrows: false,
  baked: () => Promise.resolve(),
  prize: () => Promise.resolve(),
}))

vi.mock("./mount", () => ({
  WHEEL_PROGRESS_TIMEOUT_MS: 40_000,
  mountWheel: (_host: HTMLElement, draw: WheelDraw, { held, onEnded, onDone }: WheelOptions) => {
    h.calls.push(`mount ${draw.mine || "spectator"} held=${held}`)
    if (h.mountThrows) throw new Error("no WebGL")
    h.stage = { onEnded, onDone }
    return {
      release: () => void h.calls.push("release"),
      progress: () => ({ step: "spin" }),
      destroy: () => void h.calls.push("destroy"),
    }
  },
}))
vi.mock("./baked-coin", () => ({
  loadBakedCoins: () => {
    h.calls.push("coins")
    return h.baked()
  },
  loadPrizeCoin: (amount: string, unit: string) => {
    h.calls.push(`prize coin ${amount} ${unit}`)
    return h.prize()
  },
}))

/** a stage started on a two-ticket draw, `mine` the player's ticket ("" for a spectator) */
function start(draw: Partial<WheelDraw> = {}, held = false) {
  const events: string[] = []
  const on: StageEvents = {
    mounted: ({ held, progressMs }) => void events.push(`mounted held=${held} ${progressMs}`),
    failed: (reason, error) => void events.push(`failed ${reason}: ${(error as Error).message}`),
    ended: () => void events.push("ended"),
    done: () => void events.push("done"),
  }
  const runner = startStage(
    {} as HTMLElement,
    { tickets: ["aa", "bb"], mine: "aa", target: "cc", won: false, winners: 1, prize: { amount: "200", unit: "CASH", prefix: "$" }, ...draw },
    { held },
    on,
  )
  return { runner, events }
}

/** let the stage's chunk and coins resolve, and `ms` pass */
const pass = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
  h.calls = []
  h.stage = {}
  h.mountThrows = false
  h.baked = () => Promise.resolve()
  h.prize = () => Promise.resolve()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("the stage runner", () => {
  it("mounts a player's stage once the coin is in, then passes on ended and done as the stage says them, each once", async () => {
    const { events } = start()
    await pass()
    expect(h.calls).toEqual(["coins", "mount aa held=false"])
    expect(events).toEqual(["mounted held=false 40000"])
    h.stage.onEnded!()
    h.stage.onEnded!()
    expect(events).toEqual(["mounted held=false 40000", "ended"])
    h.stage.onDone!()
    h.stage.onDone!()
    expect(events).toEqual(["mounted held=false 40000", "ended", "done"])
  })

  it("tells ended before done when the stage says only done", async () => {
    const { events } = start()
    await pass()
    h.stage.onDone!()
    expect(events).toEqual(["mounted held=false 40000", "ended", "done"])
  })

  it("holds a spectator's stage until released, with no coin to load", async () => {
    const { runner, events } = start({ mine: "" }, true)
    await pass()
    expect(events).toEqual(["mounted held=true 40000"])
    runner.release()
    expect(h.calls).toEqual(["mount spectator held=true", "release"])
  })

  it("mounts unheld a stage released before it is up", async () => {
    const { runner, events } = start({ mine: "" }, true)
    runner.release()
    await pass()
    expect(h.calls).toEqual(["mount spectator held=false"])
    expect(events).toEqual(["mounted held=false 40000"])
  })

  it("waits for a winner's prize coin only so long", async () => {
    h.prize = () => new Promise(() => {})
    const { events } = start({ won: true })
    await pass(1_499)
    expect(events).toEqual([])
    await pass(1)
    expect(h.calls).toEqual(["coins", "prize coin 200 CASH", "mount aa held=false"])
    expect(events).toEqual(["mounted held=false 40000"])
  })

  it("says which failed: the load or the mount", async () => {
    h.baked = () => Promise.reject(new Error("offline"))
    const load = start()
    await pass(1_000)
    expect(load.events).toEqual(["failed load: offline"])

    h.baked = () => Promise.resolve()
    h.mountThrows = true
    const mount = start()
    await pass(1_000)
    expect(mount.events).toEqual(["failed mount: no WebGL"])
  })

  it("tells nothing after destroy, and takes a mounted stage down", async () => {
    const early = start()
    early.runner.destroy()
    await pass(1_000)
    expect(early.events).toEqual([])
    expect(h.calls).toEqual(["coins"])

    h.calls = []
    const late = start()
    await pass()
    expect(late.runner.progress()).toEqual({ step: "spin" })
    late.runner.destroy()
    h.stage.onEnded!()
    h.stage.onDone!()
    expect(late.events).toEqual(["mounted held=false 40000"])
    expect(h.calls).toEqual(["coins", "mount aa held=false", "destroy"])
    expect(late.runner.progress()).toBeUndefined()
  })
})
