// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formatClock, formatGameDate, formatGameTime } from "./format"

describe("game times across a daylight saving switch", () => {
  let previousZone: string | undefined

  beforeEach(() => {
    previousZone = process.env.TZ
  })

  afterEach(() => {
    if (previousZone === undefined) delete process.env.TZ
    else process.env.TZ = previousZone
  })

  it("shows a 15:00 Berlin game as 15:00 on both sides of the switch to CET", () => {
    // Given
    process.env.TZ = "Europe/Berlin"
    const beforeSwitch = Date.UTC(2026, 9, 24, 13) / 1000
    const afterSwitch = Date.UTC(2026, 9, 26, 14) / 1000

    // When
    const times = [formatGameTime(beforeSwitch, "en-US"), formatGameTime(afterSwitch, "en-US")]
    const clocks = [formatClock(beforeSwitch, "en-US-u-hc-h23"), formatClock(afterSwitch, "en-US-u-hc-h23")]
    const date = formatGameDate(afterSwitch, "en-US-u-hc-h23")

    // Then
    expect(times).toEqual(["Oct 24 at 3:00 PM", "Oct 26 at 3:00 PM"])
    expect(clocks).toEqual(["15:00", "15:00"])
    expect(date).toBe("Oct 26th, 15:00")
  })

  it("shows a 15:00 New York game as 15:00 on both sides of the switch to EST", () => {
    // Given
    process.env.TZ = "America/New_York"
    const beforeSwitch = Date.UTC(2026, 9, 31, 19) / 1000
    const afterSwitch = Date.UTC(2026, 10, 2, 20) / 1000

    // When
    const times = [formatGameTime(beforeSwitch, "en-US"), formatGameTime(afterSwitch, "en-US")]
    const clocks = [formatClock(beforeSwitch, "en-US-u-hc-h23"), formatClock(afterSwitch, "en-US-u-hc-h23")]

    // Then
    expect(times).toEqual(["Oct 31 at 3:00 PM", "Nov 2 at 3:00 PM"])
    expect(clocks).toEqual(["15:00", "15:00"])
  })

  it("dates a game just past midnight in Berlin by the Berlin day", () => {
    // Given
    process.env.TZ = "Europe/Berlin"
    const pastMidnight = Date.UTC(2026, 9, 25, 23, 30) / 1000

    // When
    const time = formatGameTime(pastMidnight, "en-US")
    const date = formatGameDate(pastMidnight, "en-US-u-hc-h23")

    // Then
    expect(time).toBe("Oct 26 at 12:30 AM")
    expect(date).toBe("Oct 26th, 00:30")
  })
})

describe("the clock of the game card works", () => {
  let previousZone: string | undefined

  beforeEach(() => {
    previousZone = process.env.TZ
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (previousZone === undefined) delete process.env.TZ
    else process.env.TZ = previousZone
  })

  it("writes an ended game and a game ahead in the same clock", () => {
    // Given
    process.env.TZ = "Europe/Berlin"
    const at = Date.UTC(2026, 10, 3, 14) / 1000

    // When
    const ended = formatGameDate(at)
    const ahead = formatGameTime(at)

    // Then
    expect(ended.endsWith(" PM")).toBe(ahead.endsWith(" PM"))
  })

  it("writes the clock as the phone does, 12 hour with AM or PM or 24 hour", () => {
    // Given
    process.env.TZ = "Europe/Berlin"
    const afternoon = Date.UTC(2026, 10, 3, 14) / 1000
    const noon = Date.UTC(2026, 10, 3, 11, 30) / 1000
    const pastMidnight = Date.UTC(2026, 9, 25, 23, 30) / 1000

    // When
    const twelve = [formatGameTime(afternoon, "en-US"), formatGameTime(noon, "en-US"), formatGameDate(pastMidnight, "en-US")]
    const twentyFour = [formatGameTime(afternoon, "en-US-u-hc-h23"), formatGameTime(noon, "en-US-u-hc-h23"), formatGameDate(pastMidnight, "en-US-u-hc-h23")]

    // Then
    expect(twelve).toEqual(["Nov 3 at 3:00 PM", "Nov 3 at 12:30 PM", "Oct 26th, 12:30 AM"])
    expect(twentyFour).toEqual(["Nov 3 at 15:00", "Nov 3 at 12:30", "Oct 26th, 00:30"])
  })

  it("pads the hour of a 24 hour clock as the phone does", () => {
    // Given
    process.env.TZ = "Europe/Berlin"
    const morning = Date.UTC(2026, 10, 3, 8, 5) / 1000
    const pastMidnight = Date.UTC(2026, 9, 25, 23, 30) / 1000

    // When
    const german = [formatGameTime(morning, "de-DE"), formatGameDate(pastMidnight, "de-DE")]
    const british = [formatGameTime(morning, "en-GB"), formatGameDate(pastMidnight, "en-GB")]

    // Then
    expect(german).toEqual(["Nov 3 at 09:05", "Oct 26th, 00:30"])
    expect(british).toEqual(["Nov 3 at 09:05", "Oct 26th, 00:30"])
  })

  it("writes the clock in Latin digits with AM or PM whatever the language of the phone", () => {
    // Given
    process.env.TZ = "Europe/Berlin"
    const afternoon = Date.UTC(2026, 10, 3, 14) / 1000

    // When
    const clocks = [formatGameTime(afternoon, "ar-EG"), formatGameTime(afternoon, "ko-KR"), formatGameTime(afternoon, "en-AU")]

    // Then
    expect(clocks).toEqual(["Nov 3 at 3:00 PM", "Nov 3 at 3:00 PM", "Nov 3 at 3:00 PM"])
  })

  it("leaves the clock to the phone when the caller names no locale", () => {
    // Given
    process.env.TZ = "Europe/Berlin"
    const at = Date.UTC(2026, 10, 3, 14) / 1000
    const phone = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () { return { resolvedOptions: () => ({ hour12: false }) } } as never)

    // When
    const ended = formatGameDate(at)
    const ahead = formatGameTime(at)

    // Then
    expect([ended, ahead]).toEqual(["Nov 3rd, 15:00", "Nov 3 at 15:00"])
    expect(phone.mock.calls.map(([locale]) => locale)).toEqual([undefined, undefined])
  })
})
