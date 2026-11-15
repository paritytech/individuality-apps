// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { seatTakesTap, tileTapState } from "./tile-tap"

describe("tileTapState", () => {
  it("keeps stable vote eligibility while instantaneous tap readiness follows the gesture hook", () => {
    expect(tileTapState({ takesGesture: true, flipping: false, resetting: false })).toEqual({ votable: true, ready: true })
    expect(tileTapState({ takesGesture: true, flipping: true, resetting: false })).toEqual({ votable: true, ready: false })
    expect(tileTapState({ takesGesture: true, flipping: false, resetting: true })).toEqual({ votable: true, ready: false })
    expect(tileTapState({ takesGesture: false, flipping: false, resetting: false })).toEqual({ votable: false, ready: false })
  })

  it("wires the same readiness value to the gesture, handler, cursor and harness markers", () => {
    const source = readFileSync(join(process.cwd(), "components/game/tile/final-tile.tsx"), "utf8")
    expect(source).toContain("useTileTap({ enabled: tap.ready")
    expect(source).toContain("onPointerDown={tap.ready ? onPointerDown : undefined}")
    expect(source).toContain('tap.ready && "cursor-pointer"')
    expect(source).toContain("data-tile-votable={tap.votable}")
    expect(source).toContain("data-tile-tap-ready={tap.ready}")
    expect(source).toContain('takesGesture && "touch-pan-y select-none"')
  })
})

describe("seatTakesTap", () => {
  // A tile that shows only static has nobody behind it to judge, so a tap
  // there would cast a verdict on a face nobody saw.
  it("closes the tap on a seat that shows only static, and on no other", () => {
    expect(seatTakesTap("empty")).toBe(false)
    expect(seatTakesTap("no-signal")).toBe(false)
    expect(seatTakesTap("cant-connect")).toBe(false)
    for (const seat of ["connecting", "live", "weak", "away", "camera-off", undefined] as const)
      expect(seatTakesTap(seat)).toBe(true)
  })

  it("gates only the gesture: the page hands the tile tappable, while the turn's seal keeps reading votable", () => {
    const page = readFileSync(join(process.cwd(), "app/game/page.tsx"), "utf8")
    expect(page).toContain('voting={s.phase === "live" && s.tappable(id)}')
    expect(page).toContain("flippable={s.votable(id)}")
    const session = readFileSync(join(process.cwd(), "lib/game-session.ts"), "utf8")
    expect(session).toContain("const tappable = (id: PlayerId): boolean => votable(id) && seatTakesTap(seat(id))")
  })

  it("gives a co-player whose video never came no tile on the confirm grid", () => {
    const page = readFileSync(join(process.cwd(), "app/game/page.tsx"), "utf8")
    expect(page).toContain('const recap = s.display.filter((id) => s.roleFor(id) !== "unseen")')
    expect(page).not.toContain("s.noVideo(")
    expect(page).not.toContain("No video")
  })
})
