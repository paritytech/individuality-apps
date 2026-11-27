// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  captureLegacyDecisions,
  LEGACY_CALIBRATION_RELEASE_REASONS,
  legacyDecisionCaptureActive,
  observeLegacyDecision,
  PARSER_VISIBLE_RTC_LOG_CONTRACT,
  type LegacyDecisionObservation,
} from "./legacy-decision-capture"

afterEach(() => vi.restoreAllMocks())

describe("legacy WebRTC decision capture", () => {
  it("exposes only release reasons that the legacy calibration path records", () => {
    expect(LEGACY_CALIBRATION_RELEASE_REASONS).toEqual(["no-calibrator", "settled", "timeout"])
  })

  it("normalizes volatile identities and time while retaining ordered semantics", () => {
    const firstConnection = {}
    const secondConnection = {}
    const capture = captureLegacyDecisions()
    const observations: LegacyDecisionObservation[] = [
      {
        kind: "connection-identity",
        at: 10_000,
        event: "connection-created",
        scope: { room: "g842", peer: "5Fvolatile", round: 3 },
        decision: "create",
        landingState: "new",
        connection: firstConnection,
      },
      {
        kind: "decision",
        at: 10_037,
        event: "supervisor-recovery",
        scope: { room: "g842", peer: "5Fvolatile", round: 3 },
        decision: "rebuild",
        landingState: "rebuilding",
        connection: firstConnection,
        budget: { failCount: 2, roundGeneration: 4 },
        facts: {
          signalingState: "stable",
          connectionState: "failed",
          channelState: "closed",
          localDescription: "offer",
          remoteDescription: null,
          pageHidden: false,
          online: true,
          cameraLive: true,
          standby: false,
          roomEpoch: 5,
          connectionEpoch: 2,
          commandEpoch: 9,
          attemptEpoch: 2,
          descriptionSessionEpoch: 3,
          remoteSignallingSessionEpoch: 1,
        },
      },
      {
        kind: "connection-identity",
        at: 10_038,
        event: "connection-created",
        scope: { room: "g842", peer: "5Fvolatile", round: 3 },
        decision: "replace",
        landingState: "new",
        connection: secondConnection,
      },
    ]

    for (const observation of observations) observeLegacyDecision(observation)
    capture.stop()

    expect(capture.records).toEqual([
      expect.objectContaining({ order: 1, at: "time-1", kind: "connection-identity", scope: { room: "room-1", peer: "peer-1", round: 3 }, connectionIdentity: "connection-1" }),
      expect.objectContaining({
        order: 2,
        at: "time-2",
        kind: "decision",
        decision: "rebuild",
        connectionIdentity: "connection-1",
        budget: { failCount: 2, roundGeneration: 4 },
        facts: expect.objectContaining({
          roomEpoch: 5,
          connectionEpoch: 2,
          commandEpoch: 9,
          attemptEpoch: 2,
          descriptionSessionEpoch: 3,
          remoteSignallingSessionEpoch: 1,
        }),
      }),
      expect.objectContaining({ order: 3, at: "time-3", kind: "connection-identity", connectionIdentity: "connection-2" }),
    ])
  })

  it("captures all approved record families without exposing SDP or credentials", () => {
    const capture = captureLegacyDecisions()
    const families: LegacyDecisionObservation["kind"][] = [
      "decision",
      "stamped-browser-fact",
      "setup",
      "calibration-release",
      "roster",
      "connection-identity",
      "clock-ping",
      "await-completion",
      "isolation-commit",
    ]
    for (const kind of families) {
      observeLegacyDecision({
        kind,
        at: 123,
        event: `${kind}-event`,
        scope: { room: "secret-room", peer: "secret-peer" },
        decision: "observe",
        landingState: "unchanged",
        setup: kind === "setup" ? { phase: "camera-ready" } : undefined,
        calibrationRelease: kind === "calibration-release" ? { reason: "settled" } : undefined,
        roster: kind === "roster" ? { active: ["secret-peer"], standby: [] } : undefined,
        clockPing: kind === "clock-ping" ? { eligible: true } : undefined,
        awaitCompletion: kind === "await-completion" ? { command: "set-local-description", outcome: "resolved" } : undefined,
      })
    }
    capture.stop()

    expect(capture.records.map((record) => record.kind)).toEqual(families)
    expect(JSON.stringify(capture.records)).not.toContain("secret-room")
    expect(JSON.stringify(capture.records)).not.toContain("secret-peer")
    expect(JSON.stringify(capture.records)).not.toMatch(/candidate:|fingerprint|credential|sdp/i)
  })

  it("contains observer failures and preserves registration order", () => {
    const first = captureLegacyDecisions()
    const stopThrowing = captureLegacyDecisions(() => {
      throw new Error("observer failed")
    })
    const third = captureLegacyDecisions()

    expect(() => observeLegacyDecision({ kind: "decision", at: 1, event: "offer", decision: "offer", landingState: "negotiating-statement" })).not.toThrow()
    stopThrowing.stop()
    first.stop()
    third.stop()

    expect(first.records.map((record) => record.order)).toEqual([1])
    expect(third.records.map((record) => record.order)).toEqual([1])
  })

  it("reports whether command paths can skip snapshot work", () => {
    expect(legacyDecisionCaptureActive()).toBe(false)
    const capture = captureLegacyDecisions()
    expect(legacyDecisionCaptureActive()).toBe(true)
    capture.stop()
    expect(legacyDecisionCaptureActive()).toBe(false)
  })

  it("lists the parseable rtc log lines", () => {
    expect(PARSER_VISIBLE_RTC_LOG_CONTRACT).toEqual(expect.arrayContaining([
      expect.stringContaining("pc <peer> <state>"),
      expect.stringContaining("peer away"),
      expect.stringContaining("peer back"),
      expect.stringContaining("round-link"),
      expect.stringContaining("self-heal"),
      expect.stringContaining("media-stall"),
      expect.stringContaining("no-video-rebuild"),
      expect.stringContaining("stats pair"),
      expect.stringContaining("relay candidate"),
      expect.stringContaining("standby (camera held back)"),
      expect.stringContaining("no round left with"),
      expect.stringContaining("view from"),
    ]))
    expect(PARSER_VISIBLE_RTC_LOG_CONTRACT).toContain("[jollity-rtc] peer away <peer> said")
  })

  it("covers the recovery lines mesh-log-contract.test.ts pins word for word", () => {
    const template = (line: string) => new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/<[a-z]+>/g, "(.+)")}$`)
    const selfHeal = template("[jollity-rtc] self-heal: <action> <peer> (attempt <n>)")
    const mediaStall = template("[jollity-rtc] media-stall: <reason>")
    expect(PARSER_VISIBLE_RTC_LOG_CONTRACT).toContain("[jollity-rtc] self-heal: <action> <peer> (attempt <n>)")
    expect(PARSER_VISIBLE_RTC_LOG_CONTRACT).toContain("[jollity-rtc] media-stall: <reason>")
    for (const line of [
      "[jollity-rtc] self-heal: ICE restart b (attempt 1)",
      "[jollity-rtc] self-heal: rebuild b (attempt 2)",
      "[jollity-rtc] self-heal: rebuild responder-only b (attempt 1)",
    ]) expect(line).toMatch(selfHeal)
    for (const line of [
      "[jollity-rtc] media-stall: connected but no inbound video → ICE restart (heal 1) b",
      "[jollity-rtc] media-stall: connected but no inbound video → rebuild (heal 2) b",
    ]) expect(line).toMatch(mediaStall)
  })
})
