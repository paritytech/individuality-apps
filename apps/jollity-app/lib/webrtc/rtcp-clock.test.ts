// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { readRtcpClockEvidence, RtcpClockObserver, type RtcpClockEvidence } from "./rtcp-clock"

function stats(entries: Record<string, unknown>[]): RTCStatsReport {
  return new Map(entries.map((entry) => [entry.id as string, entry])) as unknown as RTCStatsReport
}

function clockStats(remoteTimestamp: number, timestamp: number, roundTripTime = 0.08): RTCStatsReport {
  return stats([
    { id: "inbound-video", type: "inbound-rtp", kind: "video", remoteId: "sender-report" },
    { id: "sender-report", type: "remote-outbound-rtp", remoteTimestamp, timestamp, roundTripTime },
  ])
}

describe("RTCP sender-report clock samples", () => {
  it("computes the receiver-minus-sender offset with half the RTT removed", () => {
    expect(readRtcpClockEvidence(clockStats(10_000, 14_800))).toEqual({
      samples: [{
        senderReportId: "sender-report",
        remoteTimestampMs: 10_000,
        receiptTimestampMs: 14_800,
        rttMs: 80,
        offsetMs: 4_760,
        source: "remote-outbound-rtp",
      }],
    })
  })

  it("explains a missing matching remote-outbound report", () => {
    expect(readRtcpClockEvidence(stats([
      { id: "inbound-video", type: "inbound-rtp", kind: "video", remoteId: "missing" },
    ]))).toEqual({ samples: [], unavailableReason: "no-remote-outbound-report" })
  })

  it("explains a missing sender or receiver timestamp", () => {
    expect(readRtcpClockEvidence(stats([
      { id: "inbound-video", type: "inbound-rtp", kind: "video", remoteId: "sender-report" },
      { id: "sender-report", type: "remote-outbound-rtp", timestamp: 14_800, roundTripTime: 0.08 },
    ]))).toEqual({ samples: [], unavailableReason: "no-remote-timestamp" })
  })

  it("explains a missing round trip time", () => {
    expect(readRtcpClockEvidence(clockStats(10_000, 14_800, Number.NaN))).toEqual({ samples: [], unavailableReason: "no-round-trip-time" })
  })

  it("contains malformed and throwing stats reports", () => {
    const broken = { forEach: () => { throw new Error("stats disappeared") } } as unknown as RTCStatsReport
    expect(() => readRtcpClockEvidence(broken)).not.toThrow()
    expect(readRtcpClockEvidence(broken)).toEqual({ samples: [], unavailableReason: "stats-threw" })
  })
})

describe("RTCP clock aggregation", () => {
  const scope = {
    roomKey: "game-260:group-2", groupId: "group-2", selfId: "phone-a", meshGeneration: 4,
    browserBuild: "webkit/620.1", hostBuild: "73",
  }
  const evidence = (remoteTimestamp: number, timestamp: number, roundTripTime = 0.08) =>
    readRtcpClockEvidence(clockStats(remoteTimestamp, timestamp, roundTripTime))
  const row = (rtcpClock: RtcpClockEvidence) => [{ id: "phone-b", statsLink: 7, rtcpClock }]

  it("writes one numeric aggregate per link and round and deduplicates an unchanged sender report", () => {
    const emit = vi.fn()
    const observer = new RtcpClockObserver(scope, emit)

    observer.observe(row(evidence(10_000, 14_800)), 260, 3)
    observer.observe(row(evidence(10_000, 14_800)), 260, 3)
    observer.observe(row(evidence(11_000, 15_820)), 260, 3)
    observer.observe(row(evidence(12_000, 16_790)), 260, 3)
    expect(emit).not.toHaveBeenCalled()

    observer.observe(row(evidence(12_000, 16_790)), 260, 4)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      roomKey: "game-260:group-2",
      groupId: "group-2",
      selfId: "phone-a",
      meshGeneration: 4,
      peerId: "phone-b",
      gameIndex: 260,
      round: 3,
      link: 7,
      sampleCount: 3,
      browserBuild: "webkit/620.1",
      hostBuild: "73",
      status: "ok",
      medianOffsetMs: 4_760,
      minOffsetMs: 4_750,
      maxOffsetMs: 4_780,
      medianRttMs: 80,
      source: "remote-outbound-rtp",
    })
  })

  it.each([
    "no-remote-outbound-report",
    "no-remote-timestamp",
    "no-round-trip-time",
    "stats-threw",
  ] as const)("emits an unavailable record for %s", (reason) => {
    const emit = vi.fn()
    const observer = new RtcpClockObserver(scope, emit)
    observer.observe(row({ samples: [], unavailableReason: reason }), 260, 3)
    observer.flush()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      status: "unavailable", reason, sampleCount: 0,
      browserBuild: "webkit/620.1", hostBuild: "73",
    }))
    expect(emit.mock.calls[0]?.[0]).not.toHaveProperty("medianOffsetMs")
  })

  it("reports when a sender timestamp never advances", () => {
    const emit = vi.fn()
    const observer = new RtcpClockObserver(scope, emit)
    observer.observe(row(evidence(10_000, 14_800)), 260, 3)
    observer.observe(row(evidence(10_000, 14_800)), 260, 3)
    observer.flush()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      status: "unavailable", reason: "remote-timestamp-never-advanced", sampleCount: 1,
    }))
  })

  it("requires three fresh sender reports", () => {
    const emit = vi.fn()
    const observer = new RtcpClockObserver(scope, emit)
    observer.observe(row(evidence(10_000, 14_800)), 260, 3)
    observer.observe(row(evidence(11_000, 15_820)), 260, 3)
    observer.flush()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      status: "unavailable", reason: "not-enough-samples", sampleCount: 2,
    }))
  })

  it("contains sink exceptions during a round transition and cleanup", () => {
    const observer = new RtcpClockObserver(scope, () => { throw new Error("log full") })
    observer.observe(row(evidence(10_000, 14_800)), 260, 3)
    expect(() => observer.observe([], 260, 4)).not.toThrow()
    expect(() => observer.flush()).not.toThrow()
  })
})
