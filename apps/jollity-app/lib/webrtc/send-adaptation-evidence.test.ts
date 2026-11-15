// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { SendAdaptationEvidenceRecorder } from "./send-adaptation-evidence"
import { captureMeasurementTransaction } from "../telemetry/measurements"
import type { SendTransition } from "./send-adaptation"
import type { SendWindowSummary } from "./send-adaptation-classifier"

vi.mock("../telemetry/measurements", () => ({ captureMeasurementTransaction: vi.fn(() => "sent") }))

const summary = (atMs: number, pressure: SendWindowSummary["pressure"] = "healthy"): SendWindowSummary => ({
  atMs,
  durationMs: 3_000,
  hidden: false,
  effects: { windowMs: 3_000, frameP95Ms: 18, slowFrameShare: 0.1 },
  activeSenders: 2,
  validSenders: 2,
  targetBitrateCoverage: 1,
  targetNearCapShare: 1,
  bandwidthLowTargetShare: pressure === "bandwidth" ? 1 : 0,
  actualKbps: 250,
  transportBytes: 110_000,
  transportAllowanceBytes: 12_000,
  transportCoveredPayloadBytes: 90_000,
  transportCoveredHeaderBytes: 8_000,
  transportCoveredSenderSeconds: 6,
  transportExpectedSenderSeconds: 6,
  availableKbps: 300,
  queueMsPerPacket: 12,
  rttMs: 90,
  bandwidthShare: pressure === "bandwidth" ? 1 : 0,
  cpuShare: pressure === "cpu" ? 1 : 0,
  noneShare: pressure === "healthy" ? 1 : 0,
  stalledShare: 0,
  encodeMsPerFrame: 8,
  encodeShare: 0.3,
  encoderImplementations: ["VideoToolbox"],
  powerEfficientEncoder: true,
  route: "direct",
  pressure,
  severe: false,
})

const transition = (id: string, atMs: number): SendTransition => ({
  id,
  atMs,
  direction: "down",
  cause: "bandwidth",
  from: 0,
  to: 2,
  probe: "none",
  before: summary(atMs, "bandwidth"),
})

describe("SendAdaptationEvidenceRecorder", () => {
  beforeEach(() => vi.clearAllMocks())

  it("pairs a transition with the next completed window and counts apply outcomes", () => {
    const evidence = new SendAdaptationEvidenceRecorder(0)
    evidence.startRound(0)
    evidence.transition(transition("a", 3_000))
    evidence.apply({
      requested: 2,
      uniform: false,
      senders: [
        { id: "a", status: "applied", appliedFields: ["maxBitrate"], refusedFields: [] },
        { id: "b", status: "refused", appliedFields: [], refusedFields: ["maxFramerate"] },
      ],
    })
    evidence.observe(summary(6_000))
    expect(evidence.snapshot().transitions[0]).toMatchObject({ applied: 1, refused: 1, after: { atMs: 6_000 } })
  })

  it("captures after only from the next valid window after an applied rung", () => {
    const evidence = new SendAdaptationEvidenceRecorder(0)
    evidence.startRound(0)
    evidence.transition(transition("a", 3_000))
    evidence.observe(summary(4_000))
    expect(evidence.snapshot().transitions[0].after).toBeUndefined()
    evidence.apply({
      requested: 2,
      uniform: true,
      senders: [{ id: "a", status: "applied", appliedFields: ["maxBitrate"], refusedFields: [] }],
    })
    evidence.observe({ ...summary(5_000), baselineOnly: true })
    evidence.observe({ ...summary(6_000), hidden: true })
    expect(evidence.snapshot().transitions[0].after).toBeUndefined()
    evidence.observe(summary(7_000))
    expect(evidence.snapshot().transitions[0].after?.atMs).toBe(7_000)
  })

  it("keeps only 64 transitions and accounts seconds by rung", () => {
    const evidence = new SendAdaptationEvidenceRecorder(0)
    evidence.startRound(1)
    for (let index = 0; index < 70; index++) evidence.transition(transition(String(index), index * 3_000))
    evidence.observe({ ...summary(297_000), transportBytes: undefined })
    evidence.observe(summary(300_000))
    const snapshot = evidence.snapshot()
    expect(snapshot.transitions).toHaveLength(64)
    expect(snapshot.transitions[0].id).toBe("6")
    expect(snapshot.roundSecondsByRung.low).toBe(6)
    expect(snapshot.roundTransportBytesByRung.low).toBe(110_000)
    expect(snapshot.roundTransportAllowanceBytesByRung.low).toBe(12_000)
    expect(snapshot.roundTransportSecondsByRung.low).toBe(3)
    expect(snapshot.roundTransportCoveredPayloadBytesByRung.low).toBe(90_000)
    expect(snapshot.roundTransportCoveredHeaderBytesByRung.low).toBe(8_000)
    expect(snapshot.roundTransportCoveredSenderSecondsByRung.low).toBe(6)
    expect(snapshot.roundTransportExpectedSenderSecondsByRung.low).toBe(12)
  })

  it("retains partial per-link transport coverage without counting uncovered RTP", () => {
    const evidence = new SendAdaptationEvidenceRecorder(4)
    evidence.observe({
      ...summary(3_000),
      payloadBytes: 150_000,
      headerBytes: 15_000,
      transportBytes: 100_000,
      transportAllowanceBytes: 10_000,
      transportCoveredPayloadBytes: 80_000,
      transportCoveredHeaderBytes: 8_000,
      transportCoveredSenderSeconds: 3,
      transportExpectedSenderSeconds: 6,
    })
    expect(evidence.snapshot()).toMatchObject({
      roundPayloadBytesByRung: { survival: 150_000 },
      roundTransportBytesByRung: { survival: 100_000 },
      roundTransportCoveredPayloadBytesByRung: { survival: 80_000 },
      roundTransportCoveredHeaderBytesByRung: { survival: 8_000 },
      roundTransportCoveredSenderSecondsByRung: { survival: 3 },
      roundTransportExpectedSenderSecondsByRung: { survival: 6 },
      roundTransportSecondsByRung: { survival: 0 },
    })
  })

  it("resets every game to Full without retaining a prior capacity seed", () => {
    const evidence = new SendAdaptationEvidenceRecorder(0)
    evidence.transition(transition("old", 3_000))
    evidence.reset(0)
    expect(evidence.snapshot()).toMatchObject({ currentRung: 0, transitions: [], round: null })
  })

  it("emits both exact capped round sets even without a rung transition", () => {
    const evidence = new SendAdaptationEvidenceRecorder(0)
    evidence.startRound(0)
    evidence.observe(summary(3_000, "cpu"))
    evidence.startRound(1)
    const calls = vi.mocked(captureMeasurementTransaction).mock.calls.filter(([name]) => name === "rtc.send_adaptation.round")
    expect(calls).toHaveLength(2)
    expect(Object.keys(calls[0][2])).toEqual([
      "rtc.send.rung_full_s",
      "rtc.send.rung_lean_s",
      "rtc.send.rung_low_s",
      "rtc.send.rung_minimum_s",
      "rtc.send.rung_survival_s",
      "rtc.send.bandwidth_limited_s",
      "rtc.send.healthy_s",
      "rtc.send.step_up_count",
      "rtc.send.failed_probe_count",
      "rtc.send.dropped_change_transitions",
    ])
    expect(Object.keys(calls[1][2])).toEqual([
      "rtc.send.cpu_limited_s",
      "rtc.send.encode_share_p50",
      "rtc.send.encode_share_p95",
      "rtc.send.encode_ms_p95",
      "rtc.send.effects_frame_p95_ms",
      "rtc.send.effects_slow_share",
      "rtc.send.effects_loaf_p95_ms",
      "rtc.send.effects_loaf_max_ms",
    ])
    expect(calls[1][1]).toMatchObject({ opening_rung: "0", closing_rung: "0", encoder: "VideoToolbox", encoder_kind: "hardware" })
  })
})
