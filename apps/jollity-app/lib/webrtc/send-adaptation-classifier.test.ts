// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  FULL_VIDEO_RUNG,
  VIDEO_RUNGS,
  classifySendWindow,
  fitRung,
  rungAbove,
  rungBelow,
  summarizeSendWindow,
  type SendAdaptationWindow,
  type SendLinkWindow,
  type SendWindowSummary,
} from "./send-adaptation-classifier"

const link = (id: string, fields: Partial<SendLinkWindow> = {}): SendLinkWindow => ({
  id,
  active: true,
  valid: true,
  durationMs: 3_000,
  outKbps: 40,
  route: "direct",
  ...fields,
})

const window = (links: SendLinkWindow[], fields: Partial<SendAdaptationWindow> = {}): SendAdaptationWindow => ({
  atMs: 3_000,
  durationMs: 3_000,
  hidden: false,
  effects: { windowMs: 3_000 },
  links,
  ...fields,
})

const summary = (fields: Partial<SendWindowSummary>): SendWindowSummary => ({
  atMs: 3_000,
  durationMs: 3_000,
  hidden: false,
  effects: { windowMs: 3_000 },
  activeSenders: 2,
  validSenders: 2,
  targetBitrateCoverage: 0,
  targetNearCapShare: 0,
  bandwidthLowTargetShare: 0,
  bandwidthShare: 0,
  cpuShare: 0,
  noneShare: 0,
  stalledShare: 0,
  encoderImplementations: [],
  route: "direct",
  pressure: "unknown",
  severe: false,
  ...fields,
})

describe("video rung ladder", () => {
  it("keeps the approved visual floor and never defines a video-off rung", () => {
    expect(VIDEO_RUNGS).toHaveLength(5)
    expect(VIDEO_RUNGS[4]).toEqual({ index: 4, name: "survival", maxBitrate: 45_000, maxFramerate: 8, targetShortSide: 120 })
    expect(VIDEO_RUNGS.every((rung) => rung.maxBitrate > 0 && rung.maxFramerate > 0 && rung.targetShortSide > 0)).toBe(true)
  })

  it("starts at the rung named full and fits aggregate caps with 25 percent headroom", () => {
    expect(FULL_VIDEO_RUNG.name).toBe("full")
    expect(fitRung(300, 5, 0.75)).toBe(4)
    expect(fitRung(1_000, 5, 0.75)).toBe(2)
  })

  it("uses ordered adjacency rather than numeric index arithmetic", () => {
    const future = [
      { index: 99, name: "hero", maxBitrate: 500_000, maxFramerate: 30, targetShortSide: 540 },
      ...VIDEO_RUNGS,
    ]
    expect(rungAbove(0, future)?.index).toBe(99)
    expect(rungBelow(99, future)?.index).toBe(0)
  })
})

describe("page-wide upload classification", () => {
  it("uses the lowest complete per-PC estimate as conservative page capacity", () => {
    expect(summarizeSendWindow(window([link("a", { availableKbps: 100 }), link("b", { availableKbps: 120 })])).availableKbps).toBe(100)
    expect(summarizeSendWindow(window([link("a", { availableKbps: 100 }), link("b")])).availableKbps).toBeUndefined()
  })

  it("forms transport bytes only when every active valid link reports them", () => {
    const complete = summarizeSendWindow(window([
      link("a", { payloadBytes: 8_000, headerBytes: 800, transportBytes: 10_000, transportAllowanceBytes: 1_000 }),
      link("b", { payloadBytes: 16_000, headerBytes: 1_600, transportBytes: 20_000, transportAllowanceBytes: 2_000 }),
    ]))
    expect(complete).toMatchObject({ transportBytes: 30_000, transportAllowanceBytes: 3_000 })
    expect(summarizeSendWindow(window([link("a", { transportBytes: 10_000 }), link("b")])).transportBytes).toBeUndefined()
  })

  it("keeps transport and RTP evidence aligned per link across selected-pair churn", () => {
    const got = summarizeSendWindow(window([
      link("stable", { payloadBytes: 8_000, headerBytes: 800, transportBytes: 10_000, transportAllowanceBytes: 1_000 }),
      link("switched", { payloadBytes: 7_000, headerBytes: 700 }),
    ]))
    expect(got).toMatchObject({
      payloadBytes: 15_000,
      headerBytes: 1_500,
      transportBytes: 10_000,
      transportAllowanceBytes: 1_000,
      transportCoveredPayloadBytes: 8_000,
      transportCoveredHeaderBytes: 800,
      transportCoveredSenderSeconds: 3,
      transportExpectedSenderSeconds: 6,
    })
  })

  it("keeps a regroup baseline-only until every active sender has a completed window", () => {
    const got = summarizeSendWindow(window([link("a", { availableKbps: 100 }), link("b", { valid: false, availableKbps: 120 })]))
    expect(got).toMatchObject({ activeSenders: 2, validSenders: 1, baselineOnly: true })
  })

  it("correlates each bandwidth label with that sender's target against the rung cap", () => {
    const got = summarizeSendWindow(window([
      link("limited", { reason: "bandwidth", targetKbps: 60, queueMsPerPacket: 1, rttMs: 80 }),
      link("capped", { reason: "bandwidth", targetKbps: 140, queueMsPerPacket: 1, rttMs: 80 }),
    ], { rungMaxBitrate: 140_000 }))
    expect(got).toMatchObject({ targetBitrateCoverage: 1, targetNearCapShare: 0.5, bandwidthLowTargetShare: 0.5, pressure: "bandwidth" })
  })

  it("classifies majority bandwidth before CPU", () => {
    const got = summarizeSendWindow(window([
      link("a", { reason: "bandwidth", queueMsPerPacket: 10 }),
      link("b", { reason: "cpu", queueMsPerPacket: 10 }),
    ]))
    expect(got.pressure).toBe("bandwidth")
  })

  it("replays recorded target-less run-2/3/4 summaries without inventing target evidence", () => {
    const recorded = [
      // Run 2: a real constrained window and its healthy recovery window.
      ["run 2 constrained", { queueMsPerPacket: 15.1489, rttMs: 990, bandwidthShare: 1, noneShare: 0 }, "bandwidth"],
      ["run 2 recovered", { queueMsPerPacket: 4.2898, rttMs: 85, baselineRttMs: 74, bandwidthShare: 0.2, noneShare: 0.8 }, "healthy"],
      // Run 3: the 2 -> 1 probe was incorrectly reversed only because three
      // capped encoders kept reporting the instantaneous bandwidth reason.
      ["run 3 false probe pressure", { queueMsPerPacket: 3.0354, rttMs: 94, baselineRttMs: 78, bandwidthShare: 0.75, noneShare: 0.25 }, "unknown"],
      // Run 4: the 467.6 s downshift remains real. Its tied post-lift reasons
      // stay neutral without target evidence rather than becoming false healthy.
      ["run 4 downshift", { queueMsPerPacket: 11.4351, rttMs: 4_144.5, baselineRttMs: 2_450.5, bandwidthShare: 0.5, noneShare: 0.5 }, "bandwidth"],
      ["run 4 post-lift", { queueMsPerPacket: 1.1615, rttMs: 85.5, baselineRttMs: 77, bandwidthShare: 0.5, noneShare: 0.5 }, "unknown"],
      // The plain-wifi sender in runs 2/3 had the same browser reason at
      // multi-megabit spare capacity. Without targets its label is neutral.
      ["plain wifi capped", { queueMsPerPacket: 0.2, rttMs: 82, baselineRttMs: 75, bandwidthShare: 1, noneShare: 0 }, "unknown"],
    ] as const
    for (const [name, fields, pressure] of recorded)
      expect(classifySendWindow(summary(fields)), name).toMatchObject({ pressure })
  })

  it("uses synthetic complete target coverage only to prove self-cap classification", () => {
    for (const [name, fields] of [
      ["run 3 false probe pressure", { queueMsPerPacket: 3.0354, rttMs: 94, baselineRttMs: 78, bandwidthShare: 0.75, noneShare: 0.25 }],
      ["plain wifi capped", { queueMsPerPacket: 0.2, rttMs: 82, baselineRttMs: 75, bandwidthShare: 1, noneShare: 0 }],
    ] as const)
      expect(classifySendWindow(summary({ ...fields, targetBitrateCoverage: 1, targetNearCapShare: 1 })), name).toMatchObject({ pressure: "healthy" })
  })

  it("keeps an uncorroborated bandwidth reason neutral, including when target is missing", () => {
    expect(classifySendWindow(summary({ bandwidthShare: 1, queueMsPerPacket: 1, rttMs: 80 }))).toMatchObject({ pressure: "unknown" })
    expect(classifySendWindow(summary({ bandwidthShare: 1, queueMsPerPacket: 1, rttMs: 80, targetBitrateCoverage: 1, targetNearCapShare: 0, bandwidthLowTargetShare: 1 }))).toMatchObject({ pressure: "bandwidth" })
  })

  it("treats absolute 250 ms RTT as pressure even after a bloated baseline", () => {
    expect(classifySendWindow(summary({ bandwidthShare: 1, queueMsPerPacket: 4.9, rttMs: 2_942, baselineRttMs: 2_507 }))).toMatchObject({ pressure: "bandwidth" })
  })

  it("keeps a benign Wi-Fi-to-cell RTT step below the relative-pressure floor", () => {
    expect(classifySendWindow(summary({ noneShare: 1, queueMsPerPacket: 0, rttMs: 65, baselineRttMs: 21 }))).toMatchObject({ pressure: "healthy" })
    expect(classifySendWindow(summary({ bandwidthShare: 1, queueMsPerPacket: 0, rttMs: 65, baselineRttMs: 21 }))).toMatchObject({ pressure: "unknown" })
  })

  it("allows target-less recovery only from majority none plus healthy queue and RTT", () => {
    expect(classifySendWindow(summary({ noneShare: 0.8, bandwidthShare: 0.2, queueMsPerPacket: 1, rttMs: 80, baselineRttMs: 75 }))).toMatchObject({ pressure: "healthy" })
    expect(classifySendWindow(summary({ noneShare: 0.5, bandwidthShare: 0.5, queueMsPerPacket: 1, rttMs: 80, baselineRttMs: 75 }))).toMatchObject({ pressure: "unknown" })
    expect(classifySendWindow(summary({ noneShare: 0.8, bandwidthShare: 0.2, queueMsPerPacket: 10, rttMs: 80, baselineRttMs: 75 }))).toMatchObject({ pressure: "unknown" })
    expect(classifySendWindow(summary({ noneShare: 0.8, bandwidthShare: 0.2, queueMsPerPacket: 1, rttMs: 250, baselineRttMs: 75 }))).toMatchObject({ pressure: "unknown" })
  })

  it("requires complete near-cap target evidence when targets are only partially available", () => {
    expect(classifySendWindow(summary({ noneShare: 1, queueMsPerPacket: 1, rttMs: 80, targetBitrateCoverage: 0.5, targetNearCapShare: 0.5 }))).toMatchObject({ pressure: "unknown" })
    expect(classifySendWindow(summary({ noneShare: 1, queueMsPerPacket: 1, rttMs: 80, targetBitrateCoverage: 1, targetNearCapShare: 1 }))).toMatchObject({ pressure: "healthy" })
  })

  it("does not treat absolute RTT alone as bandwidth pressure with complete near-cap targets", () => {
    expect(classifySendWindow(summary({ bandwidthShare: 1, queueMsPerPacket: 2, rttMs: 300, baselineRttMs: 280, targetBitrateCoverage: 1, targetNearCapShare: 1 }))).toMatchObject({ pressure: "unknown" })
    expect(classifySendWindow(summary({ bandwidthShare: 1, queueMsPerPacket: 10, rttMs: 300, baselineRttMs: 280, targetBitrateCoverage: 1, targetNearCapShare: 1 }))).toMatchObject({ pressure: "bandwidth" })
  })

  it("requires a bandwidth reason before queue or target can corroborate pressure", () => {
    expect(classifySendWindow(summary({ bandwidthShare: 1, bandwidthLowTargetShare: 1, queueMsPerPacket: 1 })).pressure).toBe("bandwidth")
    expect(classifySendWindow(summary({ bandwidthShare: 1, bandwidthLowTargetShare: 0, queueMsPerPacket: 10 })).pressure).toBe("bandwidth")
    expect(classifySendWindow(summary({ bandwidthShare: 0, bandwidthLowTargetShare: 1, queueMsPerPacket: 20 })).pressure).toBe("unknown")
  })

  it("uses absolute or baseline-relative RTT only to corroborate a bandwidth reason", () => {
    expect(classifySendWindow(summary({ bandwidthShare: 1, rttMs: 250, baselineRttMs: 100 })).pressure).toBe("bandwidth")
    expect(classifySendWindow(summary({ bandwidthShare: 0, rttMs: 400, baselineRttMs: 100 })).pressure).toBe("unknown")
  })

  it("calls a zero-frame low-rate majority severe only with 100 ms packet queue", () => {
    const severe = summarizeSendWindow(
      window([
        link("a", { framesEncoded: 0, outKbps: 5, queueMsPerPacket: 100 }),
        link("b", { framesEncoded: 0, outKbps: 4, queueMsPerPacket: 120 }),
        link("c", { framesEncoded: 10, outKbps: 50, queueMsPerPacket: 90 }),
      ]),
    )
    expect(severe).toMatchObject({ pressure: "bandwidth", severe: true })
    expect(classifySendWindow({ ...severe, queueMsPerPacket: 99 })).toMatchObject({ severe: false })
  })

  it("allows recovery from explicit none plus near-cap targets, healthy queue and RTT", () => {
    const got = summarizeSendWindow(
      window(Array.from({ length: 5 }, (_, i) => link(String(i), { reason: "none", queueMsPerPacket: 2, rttMs: 80, availableKbps: 240, targetKbps: 300 })), { rungMaxBitrate: 300_000 }),
      new Map(Array.from({ length: 5 }, (_, i) => [String(i), 80])),
    )
    expect(got.availableKbps).toBe(240)
    expect(got).toMatchObject({ targetBitrateCoverage: 1, targetNearCapShare: 1 })
    expect(got.pressure).toBe("healthy")
  })

  it("requires queue or RTT evidence before calling a window healthy", () => {
    expect(summarizeSendWindow(window([link("a", { reason: "none" }), link("b", { reason: "none" })])).pressure).toBe("unknown")
  })

  it("keeps CPU and effects evidence observational", () => {
    const got = summarizeSendWindow(
      window(
        [link("a", { reason: "cpu", encodeSeconds: 0.6, encodeMsPerFrame: 20, encoderImplementation: "software" })],
        { effects: { windowMs: 3_000, frameP95Ms: 30, slowFrameShare: 0.2 } },
      ),
    )
    expect(got).toMatchObject({ pressure: "cpu", cpuShare: 1, encodeMsPerFrame: 20 })
    expect(got.encodeShare).toBeCloseTo(0.2)
    expect(got.effects).toMatchObject({ frameP95Ms: 30, slowFrameShare: 0.2 })
  })
})
