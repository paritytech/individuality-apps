// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { cameraRecoveryStep, mutedGraceMs, startCameraRecovery, type CameraRecoveryEvent } from "./camera"

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

  it("paces the still-muted check at 3 s until the tap is offered (~9 s), then 6 s, then the 12 s cap (Ionut, 27 Nov)", () => {
    let state = startCameraRecovery()
    // while no tap is offered the cadence stays at the 3 s grace, so the
    // offer lands on the third check, about 9 s after the first mute
    expect(mutedGraceMs(state)).toBe(3_000)
    state = step(state, "still-muted-quick").state
    expect(mutedGraceMs(state)).toBe(3_000)
    state = step(state, "still-muted-quick").state
    expect(mutedGraceMs(state)).toBe(3_000)
    const offered = step(state, "still-muted-quick")
    expect(offered.state.tap).toBe("offered")
    // after the offer: one 6 s step, then the 12 s cap for as long as the
    // tap is offered or spent
    expect(mutedGraceMs(offered.state)).toBe(6_000)
    const next = step(offered.state, "still-muted-quick")
    expect(mutedGraceMs(next.state)).toBe(12_000)
    expect(mutedGraceMs(step(next.state, "still-muted-slow").state)).toBe(12_000)
    state = step(next.state, "tap").state // tapping
    expect(mutedGraceMs(state)).toBe(12_000)
    const spent = step(state, "tap-muted")
    expect(spent.state.tap).toBe("spent")
    // a spent tap changes nothing about the camera: the backoff stays at the cap
    expect(mutedGraceMs(spent.state)).toBe(12_000)
    expect(mutedGraceMs(step(spent.state, "still-muted-quick").state)).toBe(12_000)
  })

  it("resets the backoff on an unmute, a frame or a page return — but not on a frame while tapping", () => {
    let state = startCameraRecovery()
    for (let i = 0; i < 3; i += 1) state = step(state, "still-muted-quick").state
    expect(state.tap).toBe("offered")
    expect(mutedGraceMs(state)).toBe(6_000) // the 6 s step after the offer
    expect(mutedGraceMs(step(state, "unmuted").state)).toBe(3_000)
    for (let i = 0; i < 4; i += 1) state = step(state, "still-muted-quick").state
    expect(mutedGraceMs(state)).toBe(12_000) // offered at the cap
    expect(mutedGraceMs(step(state, "frame").state)).toBe(3_000)
    for (let i = 0; i < 4; i += 1) state = step(state, "still-muted-quick").state
    expect(mutedGraceMs(state)).toBe(12_000)
    expect(mutedGraceMs(step(state, "hidden").state)).toBe(3_000)
    // a frame while tapping is the tapped stream's own frame, not health:
    // it does not reset the backoff (#1539 review, blocker 2)
    for (let i = 0; i < 3; i += 1) state = step(state, "still-muted-quick").state
    state = step(state, "tap").state
    expect(state.tap).toBe("tapping")
    const duringTap = step(state, "frame")
    expect(duringTap.commands).toEqual([])
    expect(mutedGraceMs(duringTap.state)).toBe(12_000)
  })

  it("a tap that gets frames ends the offer once, resets the backoff, and permits a later episode", () => {
    let state = startCameraRecovery()
    for (let i = 0; i < 3; i += 1) state = step(state, "still-muted-quick").state
    expect(step(state, "tap").commands).toEqual([])
    state = step(state, "tap").state
    const finished = step(state, "tap-frames")

    expect(finished.state).toMatchObject({ mutedStreak: 0, tap: "none", mutedChecks: 0 })
    expect(finished.commands).toEqual([{ kind: "episode-end", reason: "frames" }])
    // a working tap resets the backoff: the next still-muted check reopens
    // at the 3 s grace again, not at the 12 s cap (#1539 review, item 5)
    expect(mutedGraceMs(finished.state)).toBe(3_000)
  })

  it("a tap that mutes again is spent: no second offer, nothing while tapping, the cap reopens after", () => {
    let state = startCameraRecovery()
    for (let i = 0; i < 3; i += 1) state = step(state, "still-muted-quick").state
    state = step(state, "tap").state

    const ignored = step(state, "still-muted-quick")
    expect(ignored.state).toBe(state)
    expect(ignored.commands).toEqual([])

    state = step(state, "tap-muted").state
    expect(state).toMatchObject({ tap: "spent" })
    // after the tap is spent the automatic reopen keeps going (at the 12 s
    // cap on the host), and no second offer is ever made
    for (let i = 0; i < 4; i += 1) {
      const again = step(state, "still-muted-quick")
      expect(again.state).toMatchObject({ tap: "spent" })
      expect(again.commands).toEqual([{ kind: "recover", reason: "still muted", trigger: "force" }])
      state = again.state
    }
  })

  it("keeps the automatic reopen going once the tap is offered, and the offer itself reopens (#1539)", () => {
    let state = startCameraRecovery()
    state = step(state, "still-muted-quick").state
    state = step(state, "still-muted-quick").state
    const offered = step(state, "still-muted-quick")
    expect(offered.state).toMatchObject({ mutedStreak: 3, tap: "offered" })
    expect(offered.commands.map((command) => command.kind)).toEqual(["offer-tap", "recover"])

    // the loop keeps going after the offer: one 6 s step, then the 12 s cap
    // (Ionut, 27 Nov), and the streak keeps counting for telemetry
    const later = step(offered.state, "still-muted-quick")
    expect(later.state).toMatchObject({ mutedStreak: 4, tap: "offered" })
    expect(mutedGraceMs(later.state)).toBe(12_000)
    expect(later.commands).toEqual([{ kind: "recover", reason: "still muted", trigger: "force" }])
  })
})
