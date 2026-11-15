// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { linkFailedAttributes } from "./link-failed"

describe("link failed Logs attributes", () => {
  it("says how a relayed link died, with its durations numeric", () => {
    const attributes = linkFailedAttributes({
      failKind: "torn-down",
      quietMs: 0,
      upMs: 28_412.6,
      path: "relay",
      relayProtocol: "tcp",
      relayProtocolSource: "url",
      turnEndpointHost: "turn.cloudflare.com",
      pageHidden: false,
      sinceNetChangeMs: 4_000,
    })

    expect(attributes).toEqual({
      "rtc.link.failed.kind": "torn-down",
      "rtc.link.failed.quiet_ms": 0,
      "rtc.link.failed.up_ms": 28_413,
      "rtc.link.failed.path": "relay",
      "rtc.link.failed.relay_protocol": "tcp",
      "rtc.link.failed.relay_protocol_source": "url",
      "rtc.link.failed.turn_host": "turn.cloudflare.com",
      "rtc.link.failed.page_hidden": false,
      "rtc.link.failed.since_net_change_ms": 4_000,
    })
    expect(Object.values(attributes).filter((value) => typeof value === "number")).toEqual([0, 28_413, 4_000])
  })

  it("names no relay off a relay, and no network change when there was none", () => {
    const attributes = linkFailedAttributes({ failKind: "timed-out", quietMs: 21_000, upMs: 90_000, path: "direct", pageHidden: true })
    expect(Object.keys(attributes).sort()).toEqual([
      "rtc.link.failed.kind",
      "rtc.link.failed.page_hidden",
      "rtc.link.failed.path",
      "rtc.link.failed.quiet_ms",
      "rtc.link.failed.up_ms",
    ])
  })

  // the link's own attributes (pair, round) are reportLinkFailed's to add, as for rtc.away_period
  it("carries no credential, and no link identity of its own", () => {
    const json = JSON.stringify(linkFailedAttributes({ failKind: "torn-down", quietMs: 0, upMs: 1, path: "relay", relayProtocol: "tcp", turnEndpointHost: "turn.cloudflare.com", pageHidden: false }))
    expect(json).not.toMatch(/user|secret|credential|password|peer|pair/i)
  })
})
