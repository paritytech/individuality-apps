// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  latestGameRegistration,
  liveGameRegistration,
  MAX_CLOCK_SKEW_MS,
  type GameRegistration,
} from "./game-registration"

const record = (
  at: number,
  surface: GameRegistration["surface"],
  phase: GameRegistration["phase"] = "registering",
  gameIndex = 7,
): GameRegistration => ({ gameIndex, phase, surface, at, attempt: at })

describe("latestGameRegistration", () => {
  it("keeps the latest record of either store", () => {
    expect(latestGameRegistration([record(1, "app"), record(2, "humanity")])).toEqual(record(2, "humanity"))
    expect(latestGameRegistration([record(3, "chat"), record(2, "humanity")])).toEqual(record(3, "chat"))
  })

  it("never lets one product's failure hide the other's sign-up still on its way", () => {
    const going = record(1, "app", "registering")
    expect(latestGameRegistration([going, record(2, "humanity", "failed")])).toEqual(going)
    expect(latestGameRegistration([record(2, "humanity", "failed", 8), going])).toEqual(going)
    const sent = record(1, "humanity", "sent")
    expect(latestGameRegistration([record(5, "chat", "failed"), sent])).toEqual(sent)
  })

  it("keeps the latest of the ended ones when none is on its way", () => {
    expect(latestGameRegistration([record(1, "humanity", "registered"), record(2, "chat", "failed", 8)])).toEqual(
      record(2, "chat", "failed", 8),
    )
    expect(latestGameRegistration([record(1, "app", "failed"), record(2, "humanity", "failed")])).toEqual(
      record(2, "humanity", "failed"),
    )
  })

  it("is null when neither store has one", () => {
    expect(latestGameRegistration([null, null])).toBeNull()
  })
})

describe("liveGameRegistration across products", () => {
  it("parses a record Humanity wrote", () => {
    expect(liveGameRegistration(record(10, "humanity"), 11)).toEqual(record(10, "humanity"))
  })

  it("drops a record from further in the future than clocks drift", () => {
    expect(liveGameRegistration(record(1_000 + MAX_CLOCK_SKEW_MS, "humanity"), 1_000)).not.toBeNull()
    expect(liveGameRegistration(record(1_001 + MAX_CLOCK_SKEW_MS, "humanity"), 1_000)).toBeNull()
  })
})
