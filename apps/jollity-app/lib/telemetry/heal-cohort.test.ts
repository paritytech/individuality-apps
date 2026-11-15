// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { healCohortAttributes } from "./heal-cohort"

describe("heal cohort Logs attributes", () => {
  it("keeps counts and per-link recovery durations numeric", () => {
    const attributes = healCohortAttributes({
      size: 3,
      windowMs: 45,
      relayProtocol: "tcp",
      turnEndpointHost: "turn.cloudflare.com",
      failKind: "torn-down",
      quietMs: [0, null, 3],
      recoveryMs: [2100, null, 2130],
      unrecovered: 1,
      pageHidden: false,
      sinceNetChangeMs: 90_000,
    })

    expect(attributes).toEqual({
      "rtc.heal.cohort.size": 3,
      "rtc.heal.cohort.window_ms": 45,
      "rtc.heal.cohort.relay_protocol": "tcp",
      "rtc.heal.cohort.turn_endpoint_host": "turn.cloudflare.com",
      "rtc.heal.cohort.fail_kind": "torn-down",
      "rtc.heal.cohort.unrecovered": 1,
      "rtc.heal.cohort.page_hidden": false,
      "rtc.heal.cohort.since_net_change_ms": 90_000,
      "rtc.heal.cohort.recovery_ms.1": 2100,
      "rtc.heal.cohort.recovery_ms.3": 2130,
      "rtc.heal.cohort.quiet_ms.1": 0,
      "rtc.heal.cohort.quiet_ms.3": 3,
    })
    expect(Object.values(attributes).filter((value) => typeof value === "number")).toEqual([3, 45, 1, 90_000, 2100, 2130, 0, 3])
    expect(typeof attributes["rtc.heal.cohort.page_hidden"]).toBe("boolean")
  })

  it("leaves out page and network facts it does not have", () => {
    const attributes = healCohortAttributes({
      size: 2,
      windowMs: 1,
      relayProtocol: "unknown",
      turnEndpointHost: "unknown",
      failKind: "unknown",
      quietMs: [null, null],
      recoveryMs: [null, null],
      unrecovered: 2,
    })
    expect(attributes).not.toHaveProperty("rtc.heal.cohort.page_hidden")
    expect(attributes).not.toHaveProperty("rtc.heal.cohort.since_net_change_ms")
    expect(Object.keys(attributes).some((key) => key.startsWith("rtc.heal.cohort.quiet_ms."))).toBe(false)
  })
})
