// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { artifactName, attemptArtifactName, attemptResultArtifactName, parseResultArtifactName, emptyResult, normalizeSlotResult, othersReported, playedAndSettled, resultFile, stageOfTitle, stageStatus, supersededRun, validateRecordingProvenance } from "./result"

describe("execution-scoped artifact names", () => {
  it("isolates repeated bots by wave and keeps the workflow attempt before the suffix", () => {
    expect(artifactName("9", 2, "game-ready")).toBe("e2e-live-9-attempt-1-game-ready-bot2")
    expect(attemptArtifactName("9", 2, 3, "game-ready")).toBe("e2e-live-9-attempt-3-game-ready-bot2")
    expect(attemptResultArtifactName("9", 2, 3, "game-ready")).toBe("e2e-live-9-attempt-3-game-ready-bot2-result")
    expect(parseResultArtifactName("9", "e2e-live-9-attempt-3-game-ready-bot2-result", "game-ready")).toEqual({ bot: 2, attempt: 3 })
    expect(parseResultArtifactName("9", "e2e-live-9-attempt-3-specialist-1-bot2-result", "game-ready")).toBeNull()
    expect(parseResultArtifactName("9", "e2e-live-9-bot2-attempt-3-result", "game-ready")).toBeNull()
  })
  it("does not confuse attempt-like keys or accept unqualified artifacts", () => {
    expect(parseResultArtifactName("9", "e2e-live-9-attempt-1-attempt-2-wave-bot2-result", "attempt-2-wave")).toEqual({ bot: 2, attempt: 1 })
    expect(parseResultArtifactName("9", "e2e-live-9-game-ready-bot2-result", "game-ready")).toBeNull()
    expect(parseResultArtifactName("9", "e2e-live-9-attempt-0-game-ready-bot2-result", "game-ready")).toBeNull()
    const longest = "a".repeat(64)
    expect(parseResultArtifactName("9", attemptResultArtifactName("9", 2, 3, longest), longest)).toEqual({ bot: 2, attempt: 3 })
  })
  it.each(["", "A", "unsafe/key", "two_words", "-start", "a".repeat(65)])("rejects invalid execution key %j", (key) => {
    expect(() => attemptResultArtifactName("9", 2, 1, key)).toThrow(/execution key/i)
    expect(() => parseResultArtifactName("9", "anything", key)).toThrow(/execution key/i)
  })
})

describe("result", () => {
  it("names the file by slot", () => expect(resultFile(3)).toBe("result-3.json"))
  it("starts with nothing run and nothing claimed", () => {
    const before = process.env.GITHUB_RUN_ATTEMPT
    try {
      delete process.env.GITHUB_RUN_ATTEMPT
      const r = emptyResult(2, "5Abc", "user.1", new Date("2026-10-03T12:00:00Z"))
      expect(Object.values(r.stages).every((s) => s.status === "not-run")).toBe(true)
      expect(r).toMatchObject({ version: 2, narration: [], slot: 2, profile: "baseline", run: { attempt: 1 }, reportSeen: null, settled: null, othersReported: null, signedUp: false, finishedAt: null })
      expect(playedAndSettled(r)).toBe(false)
    } finally {
      if (before === undefined) delete process.env.GITHUB_RUN_ATTEMPT
      else process.env.GITHUB_RUN_ATTEMPT = before
    }
  })
  it("round-trips through JSON", () => {
    const r = emptyResult(1, null, null)
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })
  it("upgrades a schema-v1 result with an empty narration timeline", () => {
    const current = emptyResult(1, null, null)
    const legacy = { ...current, version: 1 }
    delete (legacy as { narration?: unknown }).narration
    expect(normalizeSlotResult(legacy)).toMatchObject({ version: 1, narration: [] })
  })
  it("requires narration on schema-v2 results and rejects unknown versions", () => {
    const current = emptyResult(1, null, null)
    const missing = { ...current } as { narration?: unknown }
    delete missing.narration
    expect(() => normalizeSlotResult(missing)).toThrow(/version 2.*narration/i)
    expect(() => normalizeSlotResult({ ...current, version: 3 })).toThrow(/version 1 or 2/i)
  })
  it.each([
    null,
    {},
    { at: "not-a-time", state: "active", source: "network", action: null, title: "T", text: "X" },
    { at: "2026-10-18T13:20:00.000Z", state: "unknown", source: "network", action: null, title: "T", text: "X" },
    { at: "2026-10-18T13:20:00.000Z", state: ["active"], source: "network", action: null, title: "T", text: "X" },
    { at: "2026-10-18T13:20:00.000Z", state: { toString: "active" }, source: "network", action: null, title: "T", text: "X" },
    { at: "2026-10-18T13:20:00.000Z", state: "active", source: "stderr", action: null, title: "T", text: "X" },
    { at: "2026-10-18T13:20:00.000Z", state: "active", source: ["network"], action: null, title: "T", text: "X" },
    { at: "2026-10-18T13:20:00.000Z", state: "active", source: { toString: "network" }, action: null, title: "T", text: "X" },
    { at: "2026-10-18T13:20:00.000Z", state: "active", source: "network", action: 1, title: "T", text: "X" },
    { at: "2026-10-18T13:20:00.000Z", state: "active", source: "network", action: null, title: "", text: "X" },
    { at: "2026-10-18T13:20:00.000Z", state: "active", source: "network", action: null, title: "T", text: "" },
    { at: "2026-10-18T13:20:00.000Z", state: "active", source: "network", action: null, title: "T", text: "X", detail: 2 },
  ])("rejects an invalid schema-v2 narration transition: %j", (transition) => {
    const current = emptyResult(1, null, null)
    expect(() => normalizeSlotResult({ ...current, narration: [transition] })).toThrow(/narration/i)
  })
  it("keeps the schema-v1 fallback empty instead of trusting narration-shaped legacy data", () => {
    const current = emptyResult(1, null, null)
    const legacy = { ...current, version: 1, narration: [{ anything: "untrusted" }] }
    expect(normalizeSlotResult(legacy).narration).toEqual([])
  })
  it("accepts the explicit not-applied narration state", () => {
    const current = emptyResult(1, null, null)
    const transition = { at: "2026-10-18T13:20:00.000Z", state: "not-applied", source: "network", action: "network.1", title: "Relay Outage", text: "This network challenge was not applied on this run." }
    expect(normalizeSlotResult({ ...current, narration: [transition] }).narration).toEqual([transition])
  })

  it("carries exact workflow and recording-segment provenance for annotation", () => {
    const current = emptyResult(1, "account", "jollitypv.80", new Date("2026-10-18T18:00:00.000Z"), "baseline-iphone14-wifi", {
      GITHUB_RUN_ID: "39160000000",
      GITHUB_RUN_ATTEMPT: "3",
    })
    current.recordings = [{ file: "video-1.webm", pageOrdinal: 0, startedAt: "2026-10-18T18:00:01.000Z", finishedAt: "2026-10-18T18:10:01.000Z" }]
    expect(normalizeSlotResult(current)).toMatchObject({ run: { id: "39160000000", attempt: 3 }, recordings: current.recordings })
  })

  it.each([
    [{ file: "../video.webm", pageOrdinal: 0, startedAt: "2026-10-18T18:00:01.000Z", finishedAt: "2026-10-18T18:10:01.000Z" }, /recordings\[0\]\.file/],
    [{ file: "video-1.webm", pageOrdinal: -1, startedAt: "2026-10-18T18:00:01.000Z", finishedAt: "2026-10-18T18:10:01.000Z" }, /pageOrdinal/],
    [{ file: "video-1.webm", pageOrdinal: 0, startedAt: "not-a-date", finishedAt: "2026-10-18T18:10:01.000Z" }, /startedAt/],
    [{ file: "video-1.webm", pageOrdinal: 0, startedAt: "2026-10-18T18:10:01.000Z", finishedAt: "2026-10-18T18:00:01.000Z" }, /finishedAt/],
  ])("rejects unsafe or impossible recording provenance: %j", (recording, error) => {
    const current = emptyResult(1, "account", "jollitypv.80")
    current.recordings = [recording]
    expect(normalizeSlotResult(current)).toBe(current)
    expect(() => validateRecordingProvenance(current)).toThrow(error)
  })
  it("defaults the run attempt to one outside GitHub Actions", () => {
    const before = process.env.GITHUB_RUN_ATTEMPT
    const beforeId = process.env.GITHUB_RUN_ID
    try {
      delete process.env.GITHUB_RUN_ATTEMPT
      delete process.env.GITHUB_RUN_ID
      expect(emptyResult(1, null, null).run).toEqual({ attempt: 1 })
    } finally {
      if (before === undefined) delete process.env.GITHUB_RUN_ATTEMPT
      else process.env.GITHUB_RUN_ATTEMPT = before
      if (beforeId === undefined) delete process.env.GITHUB_RUN_ID
      else process.env.GITHUB_RUN_ID = beforeId
    }
  })
  it("records a restarted GitHub run attempt", () => {
    const before = process.env.GITHUB_RUN_ATTEMPT
    const beforeId = process.env.GITHUB_RUN_ID
    try {
      process.env.GITHUB_RUN_ATTEMPT = "2"
      process.env.GITHUB_RUN_ID = "39160000000"
      expect(emptyResult(1, null, null).run).toEqual({ id: "39160000000", attempt: 2 })
    } finally {
      if (before === undefined) delete process.env.GITHUB_RUN_ATTEMPT
      else process.env.GITHUB_RUN_ATTEMPT = before
      if (beforeId === undefined) delete process.env.GITHUB_RUN_ID
      else process.env.GITHUB_RUN_ID = beforeId
    }
  })
  it("retains the exact workflow run when a restarted attempt is superseded", () => {
    expect(supersededRun(
      { id: "39160000000", attempt: 2 },
      { kind: "restarted-after-probed-game", expected: { index: 170, registrationEnds: 900 }, current: null },
    )).toEqual({
      id: "39160000000",
      attempt: 2,
      superseded: true,
      skipped: { kind: "restarted-after-probed-game", expected: { index: 170, registrationEnds: 900 }, current: null },
    })
  })
  it("maps test titles and statuses to stages", () => {
    expect(stageOfTitle("(a) hosted boot: each home")).toBe("a")
    expect(stageOfTitle("(d) settlement: a report")).toBe("d")
    expect(stageOfTitle("(c0) the tap loop on the demo game")).toBeNull()
    expect(stageStatus("passed")).toBe("pass")
    expect(stageStatus("skipped")).toBe("skip")
    expect(stageStatus("timedOut")).toBe("fail")
    expect(stageStatus("failed")).toBe("fail")
  })
  it("counts the other reporters once, in this game only", () => {
    const ev = (who: string, game_index: number) => ({ who: { value: who }, game_index })
    expect(othersReported([ev("me", 5), ev("a", 5), ev("a", 5), ev("b", 5), ev("c", 4)], 5, "me")).toBe(2)
    expect(othersReported([], 5, "me")).toBe(0)
  })
  it("playedAndSettled needs b, c, the report and the settlement; a failed (d) check does not unplay the game", () => {
    const r = emptyResult(1, "x", "u")
    for (const s of ["b", "c", "d"] as const) r.stages[s].status = "pass"
    r.reportSeen = true
    expect(playedAndSettled(r)).toBe(false)
    r.settled = true
    expect(playedAndSettled(r)).toBe(true)
    r.stages.d.status = "fail"
    expect(playedAndSettled(r)).toBe(true)
    r.stages.c.status = "fail"
    expect(playedAndSettled(r)).toBe(false)
  })
  it("a report the chain's early close made moot (game 327, bot 13) still plays and settles the game; an unproven one does not", () => {
    const r = emptyResult(13, "uplink-limited-pixel6a", "jollyuplink.10")
    for (const s of ["b", "c", "d"] as const) r.stages[s].status = "pass"
    r.reportSeen = false
    r.settled = true
    expect(playedAndSettled(r)).toBe(false)
    r.reportClosedEarly = "GameEnded in #331602 at chain 20:02:48.000 UTC, 432 s before report_ends"
    expect(playedAndSettled(r)).toBe(true)
    r.settled = false
    expect(playedAndSettled(r)).toBe(false)
  })
  it("counts the explicit camera-help stage-a pass while gameplay stages stay skipped", () => {
    const r = emptyResult(1, "x", "u", new Date(), "camera-denied")
    r.expectedOutcome = { kind: "camera-unavailable", reason: "denied", helpShown: true, handedOver: false }
    r.stages.a.status = "pass"
    for (const stage of ["b", "c", "d"] as const) r.stages[stage].status = "skip"
    expect(playedAndSettled(r)).toBe(true)
    r.stages.a.status = "fail"
    expect(playedAndSettled(r)).toBe(false)
  })
})
