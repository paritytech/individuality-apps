// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { cameraRecoveryStep, startCameraRecovery, type CameraRecoveryEvent } from "./camera"

const step = (state: ReturnType<typeof startCameraRecovery>, kind: CameraRecoveryEvent["kind"]) =>
  cameraRecoveryStep(state, { kind } as CameraRecoveryEvent)

describe("camera tap recovery (host bug #174)", () => {
  it("offers after three quick still-muted reopens and live keeps the streak", () => {
    let state = startCameraRecovery()
    state = step(state, "still-muted-quick").state
    state = step(state, "live").state
    state = step(state, "still-muted-quick").state
    state = step(state, "live").state
    const offered = step(state, "still-muted-quick")

    expect(offered.state).toMatchObject({ mutedStreak: 3, tap: "offered" })
    expect(offered.commands.map((command) => command.kind)).toEqual(["offer-tap", "recover"])
  })

  it("a tap that gets frames ends the offer once and permits a later episode", () => {
    let state = startCameraRecovery()
    for (let i = 0; i < 3; i += 1) state = step(state, "still-muted-quick").state
    expect(step(state, "tap").commands).toEqual([])
    state = step(state, "tap").state
    const finished = step(state, "tap-frames")

    expect(finished.state).toMatchObject({ mutedStreak: 0, tap: "none" })
    expect(finished.commands).toEqual([{ kind: "episode-end", reason: "frames" }])
  })

  it("a tap that mutes again is spent, shows no second offer and schedules nothing while tapping", () => {
    let state = startCameraRecovery()
    for (let i = 0; i < 3; i += 1) state = step(state, "still-muted-quick").state
    state = step(state, "tap").state

    const ignored = step(state, "still-muted-quick")
    expect(ignored.state).toBe(state)
    expect(ignored.commands).toEqual([])

    state = step(state, "tap-muted").state
    expect(state).toMatchObject({ tap: "spent" })
    for (let i = 0; i < 4; i += 1) state = step(state, "still-muted-quick").state
    expect(state.tap).toBe("spent")
  })
})
