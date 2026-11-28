// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { CLOCK_CONVERGENCE_BOUND_MS, CLOCK_GROUP_SPREAD_BOUND_MS, CLOCK_PROTOCOL, clockEvidenceFailures } from "./clock-proof"
import { emptyResult } from "./result"

const result = (profile = "clock-wrong-then-corrected") => {
  const value = emptyResult(1, "acct", "alice", new Date(0), profile)
  value.signedUp = true
  value.appClockEvidence = {
    toleranceMs: 750,
    turnEntries: [{ round: 0, turn: 1, atMs: 10_000 }],
    samples: [{ label: "turn-1", readAtMs: 10_000, nowMs: 20_000, offsetMs: -5_000, method: "peer", peers: 3 }],
    timeline: [
      { ts: 1_000, sessionId: "page-a", message: "clock chain check", data: { check: "first-value", gapMs: -5_000 } },
      { ts: 2_000, sessionId: "page-a", message: "clock peers", data: { window: "pregame", peers: 3, medianMs: -5_000, agree: 3, result: "applied" } },
      { ts: 3_000, sessionId: "page-a", message: "clock chain check", data: { check: "first-change", gapMs: -5_000 } },
      { ts: 4_000, sessionId: "page-a", message: "clock peer check done", data: { window: "pregame", peers: 3, medianMs: -5_000, result: "applied", method: "peer", offsetMs: -5_000 } },
    ],
  }
  return value
}

describe("#1060 live clock evidence", () => {
  it("derives the same-group bound from the dead band and half the accepted RTT", () => {
    expect(CLOCK_PROTOCOL).toMatchObject({ peerPingMs: 2_000, peerRttMaxMs: 1_000, peerMin: 3, peerAgreeMs: 1_000, deadBandMs: 250 })
    expect(CLOCK_CONVERGENCE_BOUND_MS).toBe(750)
    expect(CLOCK_PROTOCOL.groupMeasurementAllowanceMs).toBe(100)
    expect(CLOCK_GROUP_SPREAD_BOUND_MS).toBe(1_600)
  })

  it("accepts complete peer and metric evidence, and chain checks that only measure", () => {
    expect(clockEvidenceFailures(result())).toEqual([])
  })

  it.each([
    ["too few peers", (r: ReturnType<typeof result>) => { r.appClockEvidence!.timeline[1].data!.peers = 2 }],
    ["no strict majority", (r: ReturnType<typeof result>) => { r.appClockEvidence!.timeline[1].data!.agree = 1 }],
    ["dead-band mutation", (r: ReturnType<typeof result>) => { r.appClockEvidence!.toleranceMs = 751 }],
    ["metric evidence removal", (r: ReturnType<typeof result>) => { delete r.appClockEvidence!.timeline[3].data!.method }],
    ["timer-only completion", (r: ReturnType<typeof result>) => { r.appClockEvidence!.timeline[3].data!.result = "few" }],
    ["non-converged completion", (r: ReturnType<typeof result>) => { r.appClockEvidence!.timeline[3].data!.offsetMs = -299_249 }],
    ["displayed clock still skewed at T-0", (r: ReturnType<typeof result>) => { r.appClockEvidence!.samples[0].offsetMs = -299_249 }],
  ])("catches %s", (_name, mutate) => {
    const r = result()
    mutate(r)
    expect(clockEvidenceFailures(r)).not.toEqual([])
  })

  it("accepts a resume or late-join verdict after 20 s, because a peer window stays open until a quorum", () => {
    for (const [profile, role, window] of [["clock-step-while-hidden", "hidden-step", "resume"], ["late-join-turn-5", "late-join", "late"]] as const) {
      const r = result(profile)
      r.role.kind = role
      r.appClockEvidence!.timeline.push(
        { ts: 10_000, sessionId: "page-b", message: "clock peer check", data: { window } },
        { ts: 60_000, sessionId: "page-b", message: "clock peers", data: { window, peers: 3, medianMs: 0, agree: 3, result: "dead-band" } },
        { ts: 60_100, sessionId: "page-b", message: "clock peer check done", data: { window, peers: 3, medianMs: 0, result: "dead-band", method: "peer", offsetMs: 0 } },
      )
      expect(clockEvidenceFailures(r)).toEqual([])
    }
  })

  it("does not evaluate resume or late windows when roles are off", () => {
    for (const profile of ["clock-step-while-hidden", "late-join-turn-5"]) {
      const r = result(profile)
      expect(r.role).toMatchObject({ kind: "baseline", actions: [] })
      expect(clockEvidenceFailures(r)).toEqual([])
    }
  })

  it("still requires resume and late windows when the role is on", () => {
    for (const [profile, role, window] of [["clock-step-while-hidden", "hidden-step", "resume"], ["late-join-turn-5", "late-join", "late"]] as const) {
      const r = result(profile)
      r.role.kind = role
      expect(r.role.actions).toEqual([])
      expect(clockEvidenceFailures(r)).toContain(`clock ${window} peer check did not start`)
    }
  })

  it("keeps the pregame window required when roles are off", () => {
    const r = result("clock-wrong-then-corrected")
    r.appClockEvidence!.timeline = r.appClockEvidence!.timeline.filter((line) => !line.message.startsWith("clock peer"))
    expect(r.role.kind).toBe("baseline")
    expect(clockEvidenceFailures(r)).toContain("clock pregame peer check never reached an applied or dead-band verdict")
  })

  it("fails a clock persona that never reaches turn-entry evidence", () => {
    const r = result()
    r.appClockEvidence!.turnEntries = []
    expect(clockEvidenceFailures(r)).toEqual(["clock persona never reached turn-entry convergence evidence"])
  })

  it("does not require quorum convergence when the evidence proves fewer than three peers were reachable", () => {
    const r = result("baseline-enus")
    r.appClockEvidence!.timeline.splice(1, 3,
      { ts: 2_000, sessionId: "page-a", message: "clock peers", data: { window: "pregame", peers: 1, result: "few" } },
      { ts: 4_000, sessionId: "page-a", message: "clock peer check done", data: { window: "pregame", peers: 1, medianMs: 0, result: "few", method: "none", offsetMs: 0 } },
    )
    expect(clockEvidenceFailures(r)).toEqual([])
  })

  it("requires successful convergence when three reachable peers are observed", () => {
    const r = result("baseline-enus")
    r.appClockEvidence!.timeline[1].data!.result = "split"
    r.appClockEvidence!.timeline[3].data!.result = "split"
    expect(clockEvidenceFailures(r)).toContain("clock has no successfully converged peer-check completion")
  })

  it("rejects every backward jump", () => {
    const r = result()
    r.appClockEvidence!.timeline.push({ ts: 5_000, message: "clock jumped", data: { reason: "game", fromMs: 1_000, toMs: 0 } })
    expect(clockEvidenceFailures(r)).toContain("clock moved backward in a game jump")
  })

  it("passes without chain checks", () => {
    const r = result()
    r.appClockEvidence!.timeline = r.appClockEvidence!.timeline.filter((line) => line.message !== "clock chain check")
    expect(clockEvidenceFailures(r)).toEqual([])
  })
})
