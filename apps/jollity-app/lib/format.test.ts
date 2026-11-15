// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { formatClock, formatGameAt } from "./format"

describe("formatGameAt", () => {
  let previousZone: string | undefined

  beforeEach(() => {
    previousZone = process.env.TZ
    process.env.TZ = "Europe/Berlin"
  })

  afterEach(() => {
    if (previousZone === undefined) delete process.env.TZ
    else process.env.TZ = previousZone
  })

  // 12:00 in Berlin, so a few hours either way stay on the same day
  const noon = Date.UTC(2026, 9, 30, 11) / 1000

  it("shows only the clock of the chat for a game later today", () => {
    // Given
    const gameAt = noon + 3 * 3600

    // When
    const text = formatGameAt(gameAt, noon, "en-US")

    // Then
    expect(text).toBe(formatClock(gameAt, "en-US"))
    expect(text).toBe("3:00 PM")
  })

  it("shows a game later today in 24-hour time on a 24-hour phone", () => {
    // Given
    const gameAt = noon + 3 * 3600

    // When
    const text = formatGameAt(gameAt, noon, "de-DE")

    // Then
    expect(text).toBe("15:00")
  })

  it("shows the day as the chat does for a game tomorrow", () => {
    // Given
    const gameAt = noon + 24 * 3600

    // When
    const text = formatGameAt(gameAt, noon, "en-US")

    // Then
    expect(text).toBe("Oct 31 at 12:00 PM")
  })

  it("shows the day in 24-hour time for a game tomorrow", () => {
    // Given
    const gameAt = noon + 24 * 3600

    // When
    const text = formatGameAt(gameAt, noon, "de-DE")

    // Then
    expect(text).toBe("Oct 31 at 12:00")
  })
})
