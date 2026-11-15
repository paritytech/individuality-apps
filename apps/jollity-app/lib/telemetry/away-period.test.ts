// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { awayPeriodAttributes } from "./away-period"

describe("away period Logs attributes", () => {
  it("keeps the attempt count and duration numeric", () => {
    const attributes = awayPeriodAttributes({
      reason: "timeout",
      return: "statement_description",
      lastAttempt: "rebuild",
      attempts: 2,
      offerer: "peer",
      offererRole: "answerer",
      ms: 12_345,
    })

    expect(attributes).toEqual({
      "rtc.away_reason": "timeout",
      "rtc.away_return": "statement_description",
      "rtc.away_last_attempt": "rebuild",
      "rtc.away_attempts": 2,
      "rtc.away_offerer": "peer",
      "rtc.away_offerer_role": "answerer",
      "rtc.away_ms": 12_345,
    })
    expect(typeof attributes["rtc.away_attempts"]).toBe("number")
    expect(typeof attributes["rtc.away_ms"]).toBe("number")
  })
})
