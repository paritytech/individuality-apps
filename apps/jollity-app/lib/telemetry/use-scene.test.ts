// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const calls = vi.hoisted(() => [] as string[])
const effects = vi.hoisted(() => [] as Array<{ run: () => void | (() => void); deps: unknown[] }>)
vi.mock("./smoothness", () => ({
  enterScene: (scene: string) => calls.push(`enter ${scene}`),
  leaveScene: (scene: string) => calls.push(`leave ${scene}`),
  setMoment: (moment: string | null) => calls.push(`moment ${moment}`),
}))
vi.mock("react", () => ({
  useEffect: (run: () => void | (() => void), deps: unknown[]) => effects.push({ run, deps }),
}))

import { sceneEffect, useMoment, useScene } from "./use-scene"

beforeEach(() => {
  calls.length = 0
  effects.length = 0
})

describe("a screen's scene", () => {
  it("enters on mount and leaves on unmount", () => {
    const cleanup = sceneEffect("chest", true)
    expect(calls).toEqual(["enter chest"])
    cleanup()
    expect(calls).toEqual(["enter chest", "leave chest"])
  })

  it("an inactive screen enters nothing, and turning active enters, inactive leaves", () => {
    const idle = sceneEffect("draw.wheel", false)
    expect(calls).toEqual([])
    idle()
    expect(calls).toEqual([])
    const shown = sceneEffect("draw.wheel", true) // the draw's result is on screen
    shown() // React runs the cleanup before the effect with active = false
    expect(calls).toEqual(["enter draw.wheel", "leave draw.wheel"])
  })

  it("the hook runs that effect, keyed on the scene and whether it is active", () => {
    useScene("waiting", true)
    useScene("chest")
    expect(effects.map((effect) => effect.deps)).toEqual([
      ["waiting", true],
      ["chest", true],
    ])
    const cleanup = effects[0].run()
    expect(calls).toEqual(["enter waiting"])
    if (cleanup) cleanup()
    expect(calls).toEqual(["enter waiting", "leave waiting"])
  })

  it("the moment hook sets the moment, keyed on it, and clears it on unmount", () => {
    useMoment("warn")
    expect(effects.map((effect) => effect.deps)).toEqual([["warn"]])
    const cleanup = effects[0].run()
    expect(calls).toEqual(["moment warn"])
    if (cleanup) cleanup()
    expect(calls).toEqual(["moment warn", "moment null"])
  })
})
