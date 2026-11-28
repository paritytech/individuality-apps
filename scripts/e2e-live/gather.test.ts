// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { botsOfJobName, adaptiveUploadProof, classifyGroup, mergeResults, parseResult, renderSummary, videoLink, type RunEvidence, type RunJobEvidence, type VideoLinks } from "./gather"
import { artifactName, attemptArtifactName, attemptResultArtifactName, emptyResult, parseResultArtifactName, resultArtifactName, type AdaptiveUploadResult, type SlotResult } from "./result"

const links: VideoLinks = { runUrl: "https://github.com/o/r/actions/runs/9", runId: "9", executionKey: "manual" }
const USERS = ["jollityeea.09", "jollityeeb.29", "jollityeec.81"]

function played(slot: number, over: Partial<SlotResult> = {}): SlotResult {
  const r = emptyResult(slot, `acct${slot}`, USERS[slot - 1] ?? `user${slot}`)
  r.game = { index: 170, gameAt: 1000, registrationEnds: 900, reportEnds: 1180 }
  for (const s of ["a", "b", "c", "d"] as const) r.stages[s].status = "pass"
  r.signedUp = true
  r.taps = 12
  r.confirmed = true
  r.reportSeen = true
  r.settled = true
  return { ...r, ...over }
}
const raw = (r: SlotResult) => ({ source: `bot${r.slot}/result-${r.slot}.json`, text: JSON.stringify(r) })
const ids = (users: readonly string[]) => Object.fromEntries(users.map((u, i) => [i + 1, u]))
const run = (results: SlotResult[], o: { bots?: number[]; expected?: Record<number, string> } = {}) =>
  mergeResults({ bots: o.bots ?? [1, 2, 3], raws: results.map(raw), identities: o.expected ?? ids(USERS), links })

const RUNNER_LOST = "The self-hosted runner lost communication with the server. Verify the machine is running and has a healthy network connection."
const lostJob = (bot: number, over: Partial<RunJobEvidence> = {}): RunJobEvidence => ({
  id: 100 + bot,
  run_attempt: 1,
  name: `play [manual] (bot ${bot}, profile-${bot})`,
  status: "completed",
  conclusion: "failure",
  runner_name: `parity-int-ubuntu-runner-${bot}`,
  runner_group_name: "internal",
  labels: ["parity-int-ubuntu"],
  steps: [],
  ...over,
})
const evidence = (jobs: RunJobEvidence[], annotations: Record<string, { available: boolean; messages: string[] }>) => ({ jobs, annotations })
const historicalGame57 = JSON.parse(readFileSync(join(__dirname, "fixtures", "runner-preemption.json"), "utf8")) as RunEvidence & { runId: number; game: number }

const game57 = { ...historicalGame57, jobs: historicalGame57.jobs.map((job) => ({ ...job, name: job.name.replace(/^play /, "play [manual] ") })) }

describe("execution isolation", () => {
  it("selects the furthest attempt only within its execution and preserves its failure", () => {
    const original = played(1, { run: { attempt: 1 } })
    original.stages.d.status = "fail"
    original.stages.d.notes = ["real product failure"]
    const restart = emptyResult(1, "acct1", USERS[0])
    restart.run = { attempt: 2, superseded: true }
    const other = played(1, { run: { attempt: 3 } })
    const records = [original, restart, other].map((result, index) => ({
      ...raw(result),
      artifact: { id: 100 + index, name: attemptResultArtifactName("9", 1, index + 1, index === 2 ? "wave-2" : "wave-1"), bot: 1, attempt: index + 1 },
    }))
    const merged = mergeResults({ bots: [1], identities: ids(USERS), raws: records, links: {
      ...links, executionKey: "wave-1", artifacts: [
        { id: 301, name: attemptArtifactName("9", 1, 1, "wave-1") },
        { id: 303, name: attemptArtifactName("9", 1, 3, "wave-2") },
      ],
    } })
    expect(merged.attempts.map(({ attempt }) => attempt)).toEqual([1, 2])
    expect(merged.rows[0].result?.run?.attempt).toBe(1)
    expect(merged.rows[0].videoLink).toBe(`${links.runUrl}/artifacts/301`)
    expect(merged.stageFailures).toEqual([expect.stringContaining("real product failure")])
  })

  it("accepts reusable caller prefixes but requires the exact execution key", () => {
    expect(botsOfJobName("specialists (1) / play [wave-1] (group g1, bots 1-2)", "wave-1")).toEqual([1, 2])
    expect(botsOfJobName("specialists (2) / play [wave-2] (group g1, bots 1-2)", "wave-1")).toEqual([])
    expect(botsOfJobName("play [wave-10] (group g1, bots 1-2)", "wave-1")).toEqual([])
    expect(botsOfJobName("play (group g1, bots 1-2)", "wave-1")).toEqual([])
  })
  it("ignores another wave's valid results and retains only current-wave runner loss", () => {
    const current = lostJob(1, { name: "caller / play [wave-1] (group g1, bots 1-2)" })
    const other = lostJob(3, { name: "caller / play [wave-2] (group g1, bots 1-2-3)" })
    const m = mergeResults({
      bots: [1, 2, 3], identities: ids(USERS), links: { ...links, executionKey: "wave-1" },
      raws: [{ ...raw(played(1)), artifact: { id: 201, name: "e2e-live-9-attempt-1-wave-2-bot1-result", bot: 1, attempt: 1 } }],
      runEvidence: evidence([current, other], { [current.id]: { available: true, messages: [RUNNER_LOST] }, [other.id]: { available: true, messages: [RUNNER_LOST] } }),
    })
    expect(m.attempts).toEqual([])
    expect(m.rows.slice(0, 2).every((row) => row.preemption !== null)).toBe(true)
    expect(m.rows[2].preemption).toBeNull()
    expect(m.problems).toHaveLength(1)
    expect(m.problems[0]).toContain("bot 3: no result")
  })
})

describe("cross-job app-clock agreement", () => {
  const sameGroup = [
    { index: 0, account: "acct1" },
    { index: 1, account: "acct2" },
  ]
  const clockEvidence = (atMs: number) => ({
    toleranceMs: 750,
    turnEntries: [{ round: 0, turn: 1, atMs }],
    samples: [{ label: "turn-1", readAtMs: atMs, nowMs: atMs, offsetMs: 0, method: "peer", peers: 3 }],
    timeline: [
      { ts: atMs - 3, message: "clock chain check", data: { check: "first-value", gapMs: 0 } },
      { ts: atMs - 2, message: "clock peers", data: { window: "pregame", peers: 3, medianMs: 0, agree: 3, result: "dead-band" } },
      { ts: atMs - 1, message: "clock peer check done", data: { window: "pregame", peers: 3, medianMs: 0, result: "dead-band", method: "peer", offsetMs: 0 } },
    ],
  })

  it("fails a skewed persona that each job's old single-slot check could not compare", () => {
    const one = played(1, {
      groups: [{ round: 0, ownIndex: 0, members: sameGroup }],
      appClockEvidence: clockEvidence(10_000),
    })
    const skewed = played(2, {
      groups: [{ round: 0, ownIndex: 1, members: sameGroup }],
      appClockEvidence: clockEvidence(11_601),
    })

    const merged = run([one, skewed], { bots: [1, 2], expected: { 1: USERS[0], 2: USERS[1] } })
    expect(merged.guardFailures).toEqual([
      expect.stringContaining("group app clocks disagree at turn 1: 1601 ms spread (limit 1600 ms"),
    ])
    expect(merged.verdict).toMatchObject({ product: "failed", reasons: expect.arrayContaining(["run-guard-failed"]) })
  })

  it("passes matching same-group readings and fails closed when one new result omits them", () => {
    const one = played(1, {
      groups: [{ round: 0, ownIndex: 0, members: sameGroup }],
      appClockEvidence: clockEvidence(10_000),
    })
    const two = played(2, {
      groups: [{ round: 0, ownIndex: 1, members: sameGroup }],
      appClockEvidence: clockEvidence(10_750),
    })
    expect(run([one, two], { bots: [1, 2], expected: { 1: USERS[0], 2: USERS[1] } }).guardFailures).toEqual([])

    delete two.appClockEvidence
    expect(run([one, two], { bots: [1, 2], expected: { 1: USERS[0], 2: USERS[1] } }).guardFailures).toEqual([
      "group app clocks have no persisted turn-entry evidence for bot 2 in round 1",
    ])
  })
})

describe("adaptive upload proof", () => {
  it("is fail-closed when the target page or qdisc evidence is missing", () => {
    const target = played(1, { profile: "uplink-lift-pixel6a" })
    expect(adaptiveUploadProof([target])).toMatchObject({
      status: "inconclusive",
      targetBot: 1,
      reasons: expect.arrayContaining(["target page adaptation evidence missing"]),
    })
  })

  it("does not mistake the old rotating uplink persona for the acceptance target", () => {
    expect(adaptiveUploadProof([played(1, { profile: "uplink-limited-pixel6a" })])).toMatchObject({ status: "inconclusive", targetBot: 0 })
  })

  it("requires the proof when the uplink persona was requested but returned no result", () => {
    const observer = played(2)
    const merged = mergeResults({
      bots: [1, 2],
      raws: [raw(observer)],
      identities: { 1: "missing.01", 2: observer.username! },
      profiles: { 1: "uplink-lift-pixel6a", 2: "baseline-enus" },
      links,
    })
    expect(merged.adaptiveUpload).toMatchObject({ status: "inconclusive", reasons: ["uplink-lift-pixel6a result missing"] })
    expect(merged.guardFailures).toEqual(expect.arrayContaining(["adaptive upload proof: uplink-lift-pixel6a result missing"]))
    expect(merged.verdict).toMatchObject({ product: "failed", reasons: expect.arrayContaining(["run-guard-failed"]) })
  })

  it("passes only with the live lift, receiver decode growth, safe votes, attendance and reserve", () => {
    const page: NonNullable<AdaptiveUploadResult["page"]> = {
      gameIndex: 170,
      rung: 2,
      currentRung: 2,
      lowPower: false,
      lowPowerReason: "none",
      transitions: [
        { id: "down", direction: "down" as const, cause: "bandwidth" as const, from: 0, to: 4, probe: "none" as const, applied: 5, refused: 0, before: { activeSenders: 5, actualKbps: 290, availableKbps: 300 }, after: { activeSenders: 5 } },
        { id: "up1", direction: "up" as const, cause: "recovery" as const, from: 4, to: 3, probe: "start" as const, applied: 5, refused: 0, before: { activeSenders: 5 }, after: { activeSenders: 5 } },
        { id: "up2", direction: "up" as const, cause: "recovery" as const, from: 3, to: 2, probe: "start" as const, applied: 5, refused: 0, before: { activeSenders: 5 }, after: { activeSenders: 5 } },
      ],
      roundSecondsByRung: { survival: 10 },
      roundPayloadBytesByRung: { survival: 20_000 },
      roundHeaderBytesByRung: { survival: 2_000 },
      roundTransportBytesByRung: { survival: 30_000 },
      roundTransportAllowanceBytesByRung: { survival: 5_000 },
      roundTransportSecondsByRung: { survival: 10 },
      roundTransportCoveredPayloadBytesByRung: { survival: 20_000 },
      roundTransportCoveredHeaderBytesByRung: { survival: 2_000 },
      roundTransportCoveredSenderSecondsByRung: { survival: 20 },
      roundTransportExpectedSenderSecondsByRung: { survival: 20 },
      droppedChangeTransactions: 0,
      peers: [],
    }
    const output = (bytes: number) => `qdisc netem 8001: root\n Sent ${bytes} bytes 100 pkt`
    const network = {
      live: true,
      planned: 1,
      fired: 1,
      problems: [],
      runs: [{ step: 1, call: ["swap", "lte-good"] as ["swap", string], startMs: 1, endMs: 2, ok: true, inconclusive: false }],
      qdiscSnapshots: [
        { label: "shaped-start", atMs: 0, output: output(10_000) },
        {
          label: "survival-start",
          requestStartedAtMs: 1_000,
          requestEndedAtMs: 1_000,
          atMs: 1_000,
          output: output(20_000),
          adaptation: {
            currentRung: 4,
            roundSecondsByRung: { survival: 0 },
            roundPayloadBytesByRung: { survival: 0 },
            roundHeaderBytesByRung: { survival: 0 },
            roundTransportBytesByRung: { survival: 0 },
            roundTransportAllowanceBytesByRung: { survival: 0 },
            roundTransportSecondsByRung: { survival: 0 },
            roundTransportCoveredPayloadBytesByRung: { survival: 0 },
            roundTransportCoveredHeaderBytesByRung: { survival: 0 },
            roundTransportCoveredSenderSecondsByRung: { survival: 0 },
            roundTransportExpectedSenderSecondsByRung: { survival: 0 },
            lastWindow: { activeSenders: 1, validSenders: 1 },
          },
        },
        {
          label: "step-1-before",
          requestStartedAtMs: 11_000,
          requestEndedAtMs: 11_000,
          atMs: 11_000,
          output: output(100_000),
          adaptation: {
            currentRung: 4,
            roundSecondsByRung: { survival: 10 },
            roundPayloadBytesByRung: { survival: 20_000 },
            roundHeaderBytesByRung: { survival: 2_000 },
            roundTransportBytesByRung: { survival: 30_000 },
            roundTransportAllowanceBytesByRung: { survival: 5_000 },
            roundTransportSecondsByRung: { survival: 10 },
            roundTransportCoveredPayloadBytesByRung: { survival: 20_000 },
            roundTransportCoveredHeaderBytesByRung: { survival: 2_000 },
            roundTransportCoveredSenderSecondsByRung: { survival: 20 },
            roundTransportExpectedSenderSecondsByRung: { survival: 20 },
            lastWindow: { activeSenders: 2, validSenders: 2 },
          },
        },
        { label: "step-1-after", atMs: 11_100, output: output(101_000) },
        { label: "end", atMs: 12_000, output: output(120_000) },
      ],
    }
    const groupMembers = Array.from({ length: 6 }, (_, index) => ({ index, account: `acct${index + 1}` }))
    const target = played(1, {
      profile: "uplink-lift-pixel6a",
      lastAttendedGame: 170,
      groups: [{ round: 0, ownIndex: 0, members: groupMembers }],
      adaptiveUpload: { page, network },
    })
    const decodedSamples = (offsetMs = 0) => [
      { turn: 0, firstElapsedMs: 1_000 + offsetMs, lastElapsedMs: 20_000 + offsetMs, firstFramesDecoded: 1, lastFramesDecoded: 3 },
      { turn: 3, firstElapsedMs: 110_000 + offsetMs, lastElapsedMs: 120_000 + offsetMs, firstFramesDecoded: 8, lastFramesDecoded: 10 },
      { turn: 4, firstElapsedMs: 130_000 + offsetMs, lastElapsedMs: 140_000 + offsetMs, firstFramesDecoded: 11, lastFramesDecoded: 13 },
      { turn: 11, firstElapsedMs: 175_000 + offsetMs, lastElapsedMs: 180_000 + offsetMs, firstFramesDecoded: 18, lastFramesDecoded: 20 },
    ]
    const observers = Array.from({ length: 5 }, (_, index) => {
      const result = played(index + 2)
      result.adaptiveUpload = { page: { ...page, transitions: [], peers: [{
        account: target.account!,
        connected: true,
        away: false,
        firstFramesDecoded: 1,
        lastFramesDecoded: 20,
        decodedSamples: decodedSamples(index * 75_000),
      }] } }
      result.videoRoleProof = {
        turns: [{ turn: 1, at: "2026-10-12T00:00:00+02:00", roles: { [target.account!]: "coplayer" }, verdicts: { [target.account!]: "approved" } }],
        markers: [], recap: [],
      }
      return result
    })
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({ status: "pass", decodedObservers: [2, 3, 4, 5, 6] })
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      webRtcTransportBytes: 30_000,
      webRtcProtocolAllowanceBytes: 5_000,
      webRtcCoverageChargeBytes: 0,
      appWebRtcBytes: 35_000,
      webRtcOverheadBytes: 15_000,
      otherRunnerEgressBytes: 45_000,
      transportCoverageGapSeconds: 0,
      transportCoverageRatio: 1,
      qdiscBoundaryLagSeconds: 0,
      qdiscBoundaryChargeBytes: 0,
      qdiscSnapshotLatencySeconds: 0,
      qdiscSnapshotChargeBytes: 0,
    })

    const requestStartedAtMs = network.qdiscSnapshots[2]!.requestStartedAtMs
    delete (network.qdiscSnapshots[2] as { requestStartedAtMs?: number }).requestStartedAtMs
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "inconclusive",
      reasons: expect.arrayContaining(["qdisc snapshot request timing evidence missing or invalid"]),
    })
    network.qdiscSnapshots[2]!.requestStartedAtMs = requestStartedAtMs

    const endTransportSeconds = network.qdiscSnapshots[2]!.adaptation!.roundTransportSecondsByRung
    ;(network.qdiscSnapshots[2]!.adaptation as { roundTransportSecondsByRung?: Record<string, number> }).roundTransportSecondsByRung = undefined
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "inconclusive",
      reasons: expect.arrayContaining(["aligned WebRTC transport-byte/allowance evidence missing"]),
    })
    network.qdiscSnapshots[2]!.adaptation!.roundTransportSecondsByRung = endTransportSeconds

    // A sender set can grow while the shaped game is starting. The controller
    // may therefore fit once for the first sender, then fit again for the
    // complete sender set. That ordered convergence is the same proof as a
    // direct Full -> Survival fit, and the terminal transition owns the sender
    // count used by the reserve calculation.
    const directDown = page.transitions[0]!
    page.transitions.splice(
      0,
      1,
      { ...directDown, id: "down-1", from: 0, to: 2, applied: 1, before: { ...directDown.before, activeSenders: 1 } },
      { ...directDown, id: "down-2", from: 2, to: 4, applied: 5, before: { ...directDown.before, activeSenders: 5 } },
    )
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({ status: "pass", cappedMediaBytes: 281_250 })

    page.transitions[1]!.before.activeSenders = 6
    network.qdiscSnapshots[1]!.adaptation!.lastWindow!.activeSenders = 6
    network.qdiscSnapshots[2]!.adaptation!.lastWindow!.activeSenders = 6
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "fail",
      cappedMediaBytes: 337_500,
      reasons: expect.arrayContaining(["capped Survival media 270000 bit/s exceeds 75% capacity 225000 bit/s"]),
    })
    page.transitions[1]!.before.activeSenders = 5
    network.qdiscSnapshots[1]!.adaptation!.lastWindow!.activeSenders = 1
    network.qdiscSnapshots[2]!.adaptation!.lastWindow!.activeSenders = 2

    const stagedDown = page.transitions.slice(0, 2)
    const recoveries = page.transitions.slice(2)
    const noConvergence = "no initial Full-to-Survival bandwidth convergence"
    const invalidConvergences: [string, NonNullable<AdaptiveUploadResult["page"]>["transitions"]][] = [
      ["stops before Survival", [stagedDown[0]!]],
      ["uses a recovery step to reach Survival", [stagedDown[0]!, { ...stagedDown[1]!, direction: "up", cause: "recovery" }]],
      ["does not apply the final step", [stagedDown[0]!, { ...stagedDown[1]!, applied: 0 }]],
      ["has a rung gap", [stagedDown[0]!, { ...stagedDown[1]!, from: 3 }]],
      [
        "steps upward in the middle",
        [
          stagedDown[0]!,
          { ...stagedDown[1]!, id: "up-middle", direction: "up", cause: "recovery", from: 2, to: 1 },
          { ...stagedDown[1]!, id: "down-after-up", from: 1 },
        ],
      ],
    ]
    for (const [name, transitions] of invalidConvergences) {
      page.transitions = [...transitions, ...recoveries]
      const proof = adaptiveUploadProof([target, ...observers])
      expect(proof.status, name).not.toBe("pass")
      expect(proof.reasons.filter((reason) => reason.includes("Full-to-Survival")), name).toEqual([noConvergence])
    }
    page.transitions = [...stagedDown, ...recoveries]

    // A failed attempt is correct bounded recovery when its applied downstep
    // immediately restores the rung from the preceding upward probe.
    const up = recoveries.at(-1)!
    page.transitions.push(
      { ...up, id: "up3", from: 2, to: 1, after: { activeSenders: 5 }, before: { ...up.before, activeSenders: 5 } },
      { ...up, id: "backoff", direction: "down", cause: "bandwidth", from: 1, to: 2, probe: "failed", applied: 5, before: { ...up.before, activeSenders: 5, bandwidthShare: 0.75 } },
    )
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({ status: "pass" })
    page.transitions.at(-1)!.applied = 0
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "fail",
      reasons: expect.arrayContaining(["a recovery probe failed without an applied return to its prior rung"]),
    })
    page.transitions = [...stagedDown, ...recoveries]

    // Saturation is the classifier's other authoritative bandwidth signal.
    // It repairs a failed probe even when no encoder reports bandwidth.
    page.transitions.push(
      { ...up, id: "saturated-up", from: 2, to: 1, after: { activeSenders: 5 } },
      { ...up, id: "saturated-backoff", direction: "down", cause: "bandwidth", from: 1, to: 2, probe: "failed", applied: 5, before: { activeSenders: 5, bandwidthShare: 0, actualKbps: 255, availableKbps: 300, queueMsPerPacket: 20 } },
    )
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({ status: "pass" })
    page.transitions = [
      ...stagedDown,
      { ...up, id: "failed-up-1", from: 4, to: 3, after: { activeSenders: 5 } },
      { ...up, id: "failed-backoff-1", direction: "down", cause: "bandwidth", from: 3, to: 4, probe: "failed", applied: 5, before: { activeSenders: 5, bandwidthShare: 1 } },
      { ...up, id: "failed-up-2", from: 4, to: 3, after: { activeSenders: 5 } },
      { ...up, id: "failed-backoff-2", direction: "down", cause: "bandwidth", from: 3, to: 4, probe: "failed", applied: 5, before: { activeSenders: 5, bandwidthShare: 1 } },
    ]
    page.rung = 4
    page.currentRung = 4
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "fail",
      reasons: expect.arrayContaining(["only 0 completed post-lift upward probes; need 2", "closing rung did not recover above Survival"]),
    })
    page.transitions = [...stagedDown, ...recoveries]
    page.rung = 2
    page.currentRung = 2

    // Device-probe economy is independent evidence, not an upload-triggered
    // economy change. Unknown/manual economy still fails the upload contract.
    page.lowPower = true
    page.lowPowerReason = "probe-weak"
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({ status: "pass" })
    page.lowPowerReason = "probe-weak-confirmed"
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({ status: "pass" })
    page.lowPowerReason = "probe-no-verdict"
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({ status: "pass" })
    page.lowPowerReason = "manual"
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "fail",
      reasons: expect.arrayContaining(["unexpected economy reason during upload proof (manual)"]),
    })
    page.lowPower = false
    page.lowPowerReason = "encode-cpu"
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "fail",
      reasons: expect.arrayContaining(["unexpected economy reason during upload proof (encode-cpu)"]),
    })
    page.lowPowerReason = "none"

    // The ordinary five-sender Survival ceiling is exactly 75% of shaped
    // capacity. Its result must not depend on an awkward fractional interval.
    network.qdiscSnapshots[2]!.atMs = 2_100
    network.qdiscSnapshots[2]!.requestStartedAtMs = 2_100
    network.qdiscSnapshots[2]!.requestEndedAtMs = 2_100
    network.qdiscSnapshots[2]!.adaptation!.roundSecondsByRung.survival = 1.1
    network.qdiscSnapshots[2]!.adaptation!.roundTransportSecondsByRung!.survival = 1.1
    const fractionalIntervalProof = adaptiveUploadProof([target, ...observers])
    expect(fractionalIntervalProof.status).toBe("pass")
    expect(fractionalIntervalProof.cappedMediaBytes).toBeCloseTo(30_937.5)
    network.qdiscSnapshots[2]!.atMs = 11_000
    network.qdiscSnapshots[2]!.requestStartedAtMs = 11_000
    network.qdiscSnapshots[2]!.requestEndedAtMs = 11_000
    network.qdiscSnapshots[2]!.adaptation!.roundSecondsByRung.survival = 10
    network.qdiscSnapshots[2]!.adaptation!.roundTransportSecondsByRung!.survival = 10

    // Qdisc snapshots bracket page observations. A realistic 4.5 s boundary
    // lag is charged separately and must not masquerade as missing transport.
    network.qdiscSnapshots[2]!.atMs = 15_500
    network.qdiscSnapshots[2]!.requestStartedAtMs = 15_500
    network.qdiscSnapshots[2]!.requestEndedAtMs = 15_500
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "pass",
      transportCoverageGapSeconds: 0,
      qdiscBoundaryLagSeconds: 4.5,
      qdiscBoundaryChargeBytes: 168_750,
      appWebRtcBytes: 203_750,
    })
    network.qdiscSnapshots[2]!.atMs = 17_100
    network.qdiscSnapshots[2]!.requestStartedAtMs = 17_100
    network.qdiscSnapshots[2]!.requestEndedAtMs = 17_100
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "inconclusive",
      reasons: expect.arrayContaining(["qdisc boundary lag 6.100 s exceeds two observe windows"]),
    })
    network.qdiscSnapshots[2]!.atMs = 11_000
    network.qdiscSnapshots[2]!.requestStartedAtMs = 11_000
    network.qdiscSnapshots[2]!.requestEndedAtMs = 11_000

    // Busy runners can delay a local tc command. Counter boundaries use the
    // request starts on one controller clock, while the full command intervals
    // are conservatively charged and individually bounded.
    network.qdiscSnapshots[1]!.requestStartedAtMs = 1_000
    network.qdiscSnapshots[1]!.requestEndedAtMs = 3_000
    network.qdiscSnapshots[2]!.atMs = 76_000
    network.qdiscSnapshots[2]!.requestStartedAtMs = 76_000
    network.qdiscSnapshots[2]!.requestEndedAtMs = 88_000
    network.qdiscSnapshots[2]!.adaptation!.roundSecondsByRung.survival = 75
    network.qdiscSnapshots[2]!.adaptation!.roundTransportSecondsByRung!.survival = 45
    network.qdiscSnapshots[2]!.adaptation!.roundTransportCoveredSenderSecondsByRung!.survival = 279
    network.qdiscSnapshots[2]!.adaptation!.roundTransportExpectedSenderSecondsByRung!.survival = 333
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "pass",
      transportCoverageRatio: 279 / 333,
      transportCoverageGapSeconds: 30,
      webRtcCoverageChargeBytes: 1_125_000,
      qdiscBoundaryLagSeconds: 0,
      qdiscSnapshotLatencySeconds: 14,
      qdiscSnapshotChargeBytes: 525_000,
    })
    network.qdiscSnapshots[2]!.requestEndedAtMs = 92_000
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "inconclusive",
      reasons: expect.arrayContaining(["qdisc snapshot request latency 16.000 s exceeds five observe windows"]),
    })
    network.qdiscSnapshots[1]!.requestEndedAtMs = 1_000
    network.qdiscSnapshots[2]!.atMs = 11_000
    network.qdiscSnapshots[2]!.requestStartedAtMs = 11_000
    network.qdiscSnapshots[2]!.requestEndedAtMs = 11_000
    network.qdiscSnapshots[2]!.adaptation!.roundSecondsByRung.survival = 10
    network.qdiscSnapshots[2]!.adaptation!.roundTransportSecondsByRung!.survival = 10
    network.qdiscSnapshots[2]!.adaptation!.roundTransportCoveredSenderSecondsByRung!.survival = 20
    network.qdiscSnapshots[2]!.adaptation!.roundTransportExpectedSenderSecondsByRung!.survival = 20

    // Qdisc counts wall time, while the page records completed 3 s observe
    // windows. One incomplete boundary window must not turn its media into
    // apparent non-media and fail the reserve proof.
    network.qdiscSnapshots[2]!.output = output(170_000)
    network.qdiscSnapshots[2]!.adaptation!.roundTransportSecondsByRung!.survival = 7
    // One churned peer still contributes RTP to the all-links total, but its
    // selected transport is intentionally absent. Compare transport only to
    // the 50 kB covered RTP subset, never to this 100 kB total.
    network.qdiscSnapshots[2]!.adaptation!.roundPayloadBytesByRung.survival = 100_000
    network.qdiscSnapshots[2]!.adaptation!.roundTransportBytesByRung!.survival = 60_000
    network.qdiscSnapshots[2]!.adaptation!.roundTransportAllowanceBytesByRung!.survival = 8_000
    network.qdiscSnapshots[2]!.adaptation!.roundTransportCoveredPayloadBytesByRung!.survival = 50_000
    network.qdiscSnapshots[2]!.adaptation!.roundTransportCoveredHeaderBytesByRung!.survival = 4_000
    network.qdiscSnapshots[2]!.adaptation!.roundTransportCoveredSenderSecondsByRung!.survival = 16
    network.qdiscSnapshots[2]!.adaptation!.roundTransportExpectedSenderSecondsByRung!.survival = 20
    const partialCoverageProof = adaptiveUploadProof([target, ...observers])
    expect(partialCoverageProof).toMatchObject({
      status: "pass",
      transportCoverageRatio: 0.8,
      appWebRtcBytes: 180_500,
    })
    expect(partialCoverageProof.transportCoverageGapSeconds).toBeCloseTo(3)
    expect(partialCoverageProof.webRtcCoverageChargeBytes).toBeCloseTo(112_500)

    // Pooled 80% coverage cannot hide one of five links being dark for the
    // entire interval. Every wall second without complete link coverage is
    // charged at the full shaped rate, never averaged down by sender count.
    network.qdiscSnapshots[2]!.adaptation!.roundTransportSecondsByRung!.survival = 0
    network.qdiscSnapshots[2]!.adaptation!.roundTransportCoveredSenderSecondsByRung!.survival = 40
    network.qdiscSnapshots[2]!.adaptation!.roundTransportExpectedSenderSecondsByRung!.survival = 50
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "fail",
      transportCoverageRatio: 0.8,
      transportCoverageGapSeconds: 10,
      webRtcCoverageChargeBytes: 375_000,
      reasons: expect.arrayContaining(["app WebRTC 443000 B exceeds shaped capacity 375000 B"]),
    })
    network.qdiscSnapshots[2]!.adaptation!.roundTransportExpectedSenderSecondsByRung!.survival = 20
    network.qdiscSnapshots[2]!.adaptation!.roundTransportSecondsByRung!.survival = 6
    network.qdiscSnapshots[2]!.adaptation!.roundTransportCoveredSenderSecondsByRung!.survival = 14
    const insufficientCoverageProof = adaptiveUploadProof([target, ...observers])
    expect(insufficientCoverageProof).toMatchObject({
      status: "inconclusive",
      transportCoverageRatio: 0.7,
      reasons: expect.arrayContaining(["WebRTC transport coverage 70.0% is below 75%"]),
    })
    expect(insufficientCoverageProof.transportCoverageGapSeconds).toBeCloseTo(4)
    network.qdiscSnapshots[2]!.adaptation!.roundTransportCoveredSenderSecondsByRung!.survival = 20
    network.qdiscSnapshots[2]!.output = output(100_000)
    network.qdiscSnapshots[2]!.adaptation!.roundTransportSecondsByRung!.survival = 10
    network.qdiscSnapshots[2]!.adaptation!.roundPayloadBytesByRung.survival = 20_000
    network.qdiscSnapshots[2]!.adaptation!.roundTransportBytesByRung!.survival = 30_000
    network.qdiscSnapshots[2]!.adaptation!.roundTransportAllowanceBytesByRung!.survival = 5_000
    network.qdiscSnapshots[2]!.adaptation!.roundTransportCoveredPayloadBytesByRung!.survival = 20_000
    network.qdiscSnapshots[2]!.adaptation!.roundTransportCoveredHeaderBytesByRung!.survival = 2_000
    network.qdiscSnapshots[2]!.adaptation!.roundTransportCoveredSenderSecondsByRung!.survival = 20

    // Whole-runner noise is diagnostic. Only the app WebRTC budget gates.
    network.qdiscSnapshots[2]!.output = output(2_000_000)
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({ status: "pass", otherRunnerEgressBytes: 1_945_000 })
    network.qdiscSnapshots[2]!.output = output(100_000)
    network.qdiscSnapshots[2]!.adaptation!.roundTransportBytesByRung!.survival = 380_000
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "fail",
      reasons: expect.arrayContaining(["app WebRTC 385000 B exceeds shaped capacity 375000 B"]),
    })
    network.qdiscSnapshots[2]!.adaptation!.roundTransportBytesByRung!.survival = 30_000

    ;(network.qdiscSnapshots[2]!.adaptation!.roundSecondsByRung as Record<string, number>).lean = 1
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "inconclusive",
      reasons: expect.arrayContaining(["survival reserve interval includes another video rung"]),
    })
    delete (network.qdiscSnapshots[2]!.adaptation!.roundSecondsByRung as Record<string, number>).lean

    const otherGroup = played(7)
    expect(adaptiveUploadProof([target, ...observers, otherGroup])).toMatchObject({ status: "pass", eligibleObservers: [2, 3, 4, 5, 6] })

    observers[4].profile = "storm-pixel6a-timeline"
    observers[4].adaptiveUpload!.page!.peers = []
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({ status: "pass", eligibleObservers: [2, 3, 4, 5], decodedObservers: [2, 3, 4, 5] })
    observers[4].profile = "baseline"
    observers[4].adaptiveUpload!.page!.peers = [{
      account: target.account!,
      connected: true,
      away: false,
      firstFramesDecoded: 1,
      lastFramesDecoded: 20,
      decodedSamples: decodedSamples(4 * 75_000),
    }]

    // The real switcher uses legacy switchAtTurn sugar rather than an
    // explicit network.timeline array. It is still a network-timeline persona
    // and cannot be required as a stable decode observer.
    observers[4].profile = "switcher-pixel6a-wifi-to-cell"
    observers[4].adaptiveUpload!.page!.peers = []
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({ status: "pass", eligibleObservers: [2, 3, 4, 5] })
    observers[4].profile = "baseline"
    observers[4].adaptiveUpload!.page!.peers = [{
      account: target.account!,
      connected: true,
      away: false,
      firstFramesDecoded: 1,
      lastFramesDecoded: 20,
      decodedSamples: decodedSamples(4 * 75_000),
    }]

    // Filtering network-plan personas cannot reduce the proof to one vote.
    // Small groups still require two independent observers; ordinary games
    // require three after target/network personas are removed.
    for (const observer of observers.slice(1)) observer.profile = "switcher-pixel6a-wifi-to-cell"
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "inconclusive",
      eligibleObservers: [2],
      decodedObservers: [2],
      reasons: expect.arrayContaining([
        "only 1 eligible observer; need 2",
        "only 1 decoded observer; need 2",
      ]),
    })
    for (const observer of observers.slice(1)) observer.profile = "baseline"

    // Missing result artifacts are not allowed to lower a six-player game's
    // ordinary three-observer quorum.
    expect(adaptiveUploadProof([target, ...observers.slice(0, 2)])).toMatchObject({
      status: "inconclusive",
      eligibleObservers: [2, 3],
      decodedObservers: [2, 3],
      reasons: expect.arrayContaining([
        "only 2 eligible observers; need 3",
        "only 2 decoded observers; need 3",
      ]),
    })

    observers[2].adaptiveUpload!.page!.peers[0].decodedSamples = decodedSamples().map((sample) =>
      sample.turn < 4 ? { ...sample, firstFramesDecoded: 1, lastFramesDecoded: 1 } : sample,
    )
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "inconclusive",
      reasons: expect.arrayContaining(["observer 4 has no shaped-interval decoded-video growth"]),
    })
    observers[2].adaptiveUpload!.page!.peers[0].decodedSamples = decodedSamples().map((sample) =>
      sample.turn >= 4 ? { ...sample, firstFramesDecoded: 10, lastFramesDecoded: 10 } : sample,
    )
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({
      status: "inconclusive",
      reasons: expect.arrayContaining(["observer 4 has no post-lift decoded-video growth"]),
    })
    observers[2].adaptiveUpload!.page!.peers[0].decodedSamples = decodedSamples(75_000)
    observers[2].adaptiveUpload!.page!.peers[0].connected = false
    observers[2].adaptiveUpload!.page!.peers[0].away = true
    expect(adaptiveUploadProof([target, ...observers])).toMatchObject({ status: "pass", decodedObservers: [2, 3, 4, 5, 6] })

    // This persona's proof is authoritative: incomplete evidence must turn
    // gather red rather than merely appear in the informational section.
    observers[2].adaptiveUpload!.page!.peers[0].decodedSamples = []
    const merged = mergeResults({
      bots: [1, 2, 3, 4, 5, 6],
      raws: [target, ...observers].map(raw),
      identities: Object.fromEntries([target, ...observers].map((result) => [result.slot, result.username!])),
      links,
    })
    expect(merged.adaptiveUpload?.status).toBe("inconclusive")
    expect(merged.guardFailures).toEqual(expect.arrayContaining([expect.stringMatching(/adaptive upload proof: observer 4 has no shaped-interval decoded-video growth/)]))
  })
})

describe("the network in the summary", () => {
  it("the headline names the network the bots played on", () => {
    const m = run([played(1, { network: "previewnet" }), played(2, { network: "previewnet" }), played(3, { network: "previewnet" })])
    expect(m.network).toBe("previewnet")
    expect(renderSummary(m, links.runUrl)).toContain("## E2E live (previewnet): game 170")
  })
  it("a result written before the field ran on paseo-next-v2", () => {
    const old = (n: number) => {
      const r = played(n)
      delete r.network
      return r
    }
    expect(run([old(1), old(2), old(3)]).network).toBe("paseo-next-v2")
  })
  it("bots on different networks are a problem", () => {
    const m = run([played(1, { network: "previewnet" }), played(2, { network: "paseo-next-v2" }), played(3, { network: "previewnet" })])
    expect(m.network).toBe("mixed")
    expect(m.problems.join("\n")).toMatch(/different networks/)
  })
  it("with no result at all it falls back to the dispatched network", () => {
    expect(mergeResults({ bots: [1], raws: [], identities: { 1: "a.1" }, links, network: "previewnet" }).network).toBe("previewnet")
  })
})

describe("mergeResults", () => {
  it("marks the game played only when all three played and settled", () => {
    const m = run([played(1), played(2), played(3)])
    expect(m.allPlayed).toBe(true)
    expect(m.problems).toEqual([])
    expect(m.game).toEqual({ index: 170, gameAt: 1000 })
    expect(m.rows.map((r) => r.result?.slot)).toEqual([1, 2, 3])
  })
  it("stamps physical runner metadata from the probe manifest", () => {
    const m = mergeResults({
      bots: [1, 2], raws: [raw(played(1)), raw(played(2))], identities: ids(USERS), links,
      runnerGroups: [{ group: "g01", bots: [1, 2], shared: true, measure: true }],
    })
    expect(m.rows.map(({ result }) => result?.runner)).toEqual([
      { group: "g01", size: 2, shared: true, measure: true },
      { group: "g01", size: 2, shared: true, measure: true },
    ])
  })
  it("one unsettled bot keeps the game unplayed", () => {
    const m = run([played(1), played(2, { settled: false }), played(3)])
    expect(m.allPlayed).toBe(false)
    expect(m.rows[1].result?.settled).toBe(false)
  })
  it("camera help shown with no handover is an expected pass, not an unplayed bot", () => {
    const camera = played(2, {
      profile: "camera-denied",
      reportSeen: false,
      settled: false,
      expectedOutcome: { kind: "camera-unavailable", reason: "denied", helpShown: true, handedOver: false },
    })
    camera.game = null
    camera.signedUp = false
    camera.stages.a.status = "pass"
    for (const stage of ["b", "c", "d"] as const) camera.stages[stage].status = "skip"
    const m = run([played(1), camera, played(3)])
    expect(m.allPlayed).toBe(true)
    expect(m.problems).not.toContain("bot 2: saw no game in Registration (it joined nothing)")
    expect(renderSummary(m, links.runUrl)).toContain("expected: camera denied, help shown, not handed over")
  })
  it("T9 isolation after its declared 120 s blackout is an expected pass only after fault recovery", () => {
    const isolated = played(2, {
      profile: "telemetry-t9-blackout",
      reportSeen: false,
      settled: false,
      expectedOutcome: { kind: "network-isolation", isolated: true, faultRecovered: true },
    })
    isolated.stages.d.status = "skip"
    const complete = run([played(1), isolated, played(3)])
    expect(complete.allPlayed).toBe(true)
    expect(renderSummary(complete, links.runUrl)).toContain("expected: network isolation, help shown, fault recovered")
    isolated.guards = [{ kind: "text", description: "never shows the stuck bar", status: "fail", evidence: "the stuck bar appeared" }]
    expect(run([played(1), isolated, played(3)]).guardFailures).toEqual([expect.stringContaining("never shows the stuck bar")])
    isolated.guards = []
    isolated.expectedOutcome = { kind: "network-isolation", isolated: true, faultRecovered: false }
    expect(run([played(1), isolated, played(3)]).allPlayed).toBe(false)
  })
  it("a report the chain's early close made moot (game 327, bot 13) counts the game played, renders as closed early and lists the inconclusive", () => {
    const detail = "GameEnded in #331602 at chain 20:02:48.000 UTC, 432 s before report_ends, with no report from this account"
    const moot = played(2, { profile: "uplink-limited-pixel6a", reportSeen: false, reportClosedEarly: detail, inconclusive: [{ name: "player 2 filed each co-player verdict", detail }] })
    const m = run([played(1), moot, played(3)])
    expect(m.allPlayed).toBe(true)
    expect(m.inconclusive).toEqual([`bot 2 (uplink-limited-pixel6a): player 2 filed each co-player verdict - ${detail}`])
    expect(renderSummary(m, links.runUrl)).toContain("| closed early (inconclusive) |")
    const missing = played(2, { profile: "uplink-limited-pixel6a", reportSeen: false })
    expect(run([played(1), missing, played(3)]).allPlayed).toBe(false)
  })
  it("a camera persona handed over or missing its help is not an expected pass", () => {
    for (const expectedOutcome of [
      { kind: "camera-unavailable" as const, reason: "no-camera" as const, helpShown: false, handedOver: false },
      { kind: "camera-unavailable" as const, reason: "no-camera" as const, helpShown: true, handedOver: true },
    ]) {
      const camera = played(2, { profile: "camera-missing", reportSeen: false, expectedOutcome })
      camera.signedUp = false
      camera.stages.a.status = "pass"
      for (const stage of ["b", "c", "d"] as const) camera.stages[stage].status = "skip"
      expect(run([played(1), camera, played(3)]).allPlayed).toBe(false)
    }
  })
  it("a bot with no report is not played either", () => {
    expect(run([played(1), played(2), played(3, { reportSeen: false })]).allPlayed).toBe(false)
  })
  it("a missing result is a problem and an empty row", () => {
    const m = run([played(1), played(3)])
    expect(m.allPlayed).toBe(false)
    expect(m.problems.join("\n")).toMatch(/bot 2: no result-2\.json/)
    expect(m.rows[1].result).toBeNull()
  })
  it("makes a supervisor deadline miss explicitly red without inventing identity failures", () => {
    const late = emptyResult(2, null, null, new Date(), "locale-la-enus")
    late.runnerOutcomes = [{ kind: "shared-registration-deadline-missed", detail: "bot 1 was ready" }]
    const m = run([played(1), late, played(3)])
    expect(m.allPlayed).toBe(false)
    expect(m.problems).toEqual([expect.stringMatching(/bot 2.*shared-registration-deadline-missed/)])
    expect(m.inconclusive).toEqual([])
    const summary = renderSummary(m, links.runUrl)
    expect(summary).toContain("NOT every bot played and settled")
    expect(summary).toContain("shared runner unavailable | FAILED")
  })
  it("retains a completed bot verdict when shared network cleanup later fails", () => {
    const cleanup = played(2, {
      runnerOutcomes: [{ kind: "shared-network-cleanup-failed", detail: "clear failed" }],
    })
    const m = run([played(1), cleanup, played(3)])
    expect(m.allPlayed).toBe(false)
    expect(m.problems).toEqual([expect.stringMatching(/bot 2.*shared-network-cleanup-failed/)])
    expect(m.inconclusive).toEqual([])
  })
  it("never marks a game played when every bot has only a shared setup outcome", () => {
    const setup = (slot: number) => {
      const result = emptyResult(slot, null, null)
      result.runnerOutcomes = [{ kind: "shared-network-setup-failed", detail: "apply failed" }]
      return result
    }
    const m = run([setup(1), setup(2), setup(3)])
    expect(m.allPlayed).toBe(false)
    expect(m.problems).toHaveLength(3)
    expect(m.inconclusive).toEqual([])
  })
  it("fails a username that is not the expected one, naming the secret", () => {
    const m = run([played(1), played(2, { username: "someone.else" }), played(3)])
    expect(m.allPlayed).toBe(false)
    expect(m.problems.join("\n")).toMatch(/bot 2: paired as "someone\.else", expected "jollityeeb\.29".*E2E_ID_JOLLITYEEB_29/)
    expect(m.verdict.reasons).toEqual(["run-problem"])
    expect(m.attempts.find(({ bot, selected }) => bot === 2 && selected)?.verdict.reasons).toContain("identity-mismatch")
  })
  it("a bot whose profile names no identity can not pass", () => {
    const m = run([played(1), played(2), played(3)], { expected: ids(USERS.slice(0, 2)) })
    expect(m.allPlayed).toBe(false)
    expect(m.problems.join("\n")).toMatch(/bot 3: no identity to check/)
  })
  it("the identity is per bot, not positional: six bots on any six usernames", () => {
    const six = [1, 2, 3, 4, 5, 6]
    const users = [...USERS, "d.1", "e.2", "f.3"]
    const results = six.map((n) => played(n, { username: users[n - 1] }))
    expect(run(results, { bots: six, expected: ids(users) }).allPlayed).toBe(true)
    // bots 1 and 2 swapped their profiles: expected follows the bot's profile
    expect(run(results.slice(0, 2), { bots: [1, 2], expected: { 1: "d.1", 2: "e.2" } }).problems.join("\n")).toMatch(/bot 1: paired as "jollityeea\.09", expected "d\.1"/)
  })
  it("flags bots that played different games, and a result nobody dispatched", () => {
    const other = played(2)
    other.game = { index: 171, gameAt: 2000, registrationEnds: 1900, reportEnds: 2180 }
    const differentGames = run([played(1), other, played(3)])
    expect(differentGames.problems.join("\n")).toMatch(/different games/)
    expect(differentGames.verdict).toMatchObject({ product: "inconclusive", reasons: expect.arrayContaining(["run-problem"]) })
    expect(run([played(1), played(2), played(3), played(4)]).problems.join("\n")).toMatch(/bot 4, which was not dispatched/)
  })
  it("a bot that found no game in Registration is a problem", () => {
    expect(run([played(1), played(2), played(3, { game: null })]).problems.join("\n")).toMatch(/bot 3: saw no game/)
  })
  it("keeps the played attempt when a scheduler rerun only reaches the expired-game skip", () => {
    const original = played(2)
    original.run = { attempt: 1 }
    original.stages.d.status = "fail"
    original.stages.d.notes.push("real stage-d guard failed")
    const restarted = emptyResult(2, "acct2", USERS[1])
    restarted.stages.a.status = "pass"
    restarted.stages.b.status = "skip"
    restarted.stages.b.notes.push("the probe's game is over")
    restarted.run = {
      attempt: 2,
      superseded: true,
      skipped: {
        kind: "restarted-after-probed-game",
        expected: { index: 170, registrationEnds: 900 },
        current: { index: 171, registrationEnds: 1900 },
      },
    }
    const m = mergeResults({
      bots: [1, 2, 3],
      raws: [
        raw(played(1)),
        { source: "attempt-1/result-2.json", text: JSON.stringify(original), artifact: { id: 301, name: attemptResultArtifactName("9", 2, 1, "manual"), bot: 2, attempt: 1 } },
        { source: "attempt-2/result-2.json", text: JSON.stringify(restarted), artifact: { id: 302, name: attemptResultArtifactName("9", 2, 2, "manual"), bot: 2, attempt: 2 } },
        raw(played(3)),
      ],
      identities: ids(USERS),
      links: {
        ...links,
        artifacts: [
          { name: attemptArtifactName("9", 2, 1, "manual"), id: 201 },
          { name: attemptArtifactName("9", 2, 2, "manual"), id: 202 },
        ],
      },
    })

    expect(m.rows[1].result?.run?.attempt).toBe(1)
    expect(m.rows[1].videoLink).toBe("https://github.com/o/r/actions/runs/9/artifacts/201")
    expect(m.problems).not.toEqual(expect.arrayContaining([expect.stringMatching(/saw no game/)]))
    expect(m.stageFailures.join("\n")).toContain("real stage-d guard failed")
    expect(m.attempts.filter(({ bot }) => bot === 2).map(({ attempt, artifact, selected }) => ({ attempt, artifactId: artifact?.id, selected }))).toEqual([
      { attempt: 1, artifactId: 301, selected: true },
      { attempt: 2, artifactId: 302, selected: false },
    ])
  })
  it("selects the furthest stage, with the earlier attempt winning an equal stage", () => {
    const atB = emptyResult(1, "acct1", USERS[0])
    atB.run = { attempt: 1 }
    atB.stages.a.status = "pass"
    atB.stages.b.status = "fail"
    const sameDepth = emptyResult(1, "acct1", USERS[0])
    sameDepth.run = { attempt: 2, superseded: true }
    sameDepth.stages.a.status = "pass"
    sameDepth.stages.b.status = "skip"
    const equal = mergeResults({
      bots: [1],
      raws: [raw(atB), { source: "attempt-2/result-1.json", text: JSON.stringify(sameDepth) }],
      identities: { 1: USERS[0] },
      links,
    })
    expect(equal.rows[0].result?.run?.attempt).toBe(1)

    atB.stages.b.status = "not-run"
    const replayed = emptyResult(1, "acct1", USERS[0])
    replayed.run = { attempt: 2 }
    replayed.stages.a.status = "pass"
    replayed.stages.b.status = "fail"
    const farther = mergeResults({
      bots: [1],
      raws: [raw(atB), { source: "attempt-2/result-1.json", text: JSON.stringify(replayed) }],
      identities: { 1: USERS[0] },
      links,
    })
    expect(farther.rows[0].result?.run?.attempt).toBe(2)
  })
  describe("the probe's game after Re-run all jobs", () => {
    const X = { index: 170, gameAt: 1000, registrationEnds: 900, reportEnds: 1180 }
    const Y = { index: 171, gameAt: 2000, registrationEnds: 1900, reportEnds: 2180 }
    const attemptOfGame = (slot: number, attempt: number, game: SlotResult["game"]) => {
      const r = played(slot, { game })
      r.run = { attempt }
      return { source: `attempt-${attempt}/result-${slot}.json`, text: JSON.stringify(r) }
    }
    const merge = (raws: { source: string; text: string }[], gameAt: number | undefined, bots = [1]) =>
      mergeResults({ bots, raws, identities: ids(USERS), links, probedGame: gameAt === undefined ? undefined : { gameAt } })

    it("selects the attempt that played the probe's game over an earlier attempt that played another", () => {
      const m = merge([attemptOfGame(1, 1, X), attemptOfGame(1, 2, Y)], Y.gameAt)
      expect(m.rows[0].result?.run?.attempt).toBe(2)
      expect(m.rows[0].result?.game?.index).toBe(171)
    })
    it("still lets the earlier attempt win a same-game tie", () => {
      const m = merge([attemptOfGame(1, 1, Y), attemptOfGame(1, 2, Y)], Y.gameAt)
      expect(m.rows[0].result?.run?.attempt).toBe(1)
    })
    it("keeps a game-less (a)-failure eligible", () => {
      const failed = emptyResult(1, "acct1", USERS[0])
      failed.run = { attempt: 2 }
      failed.stages.a.status = "fail"
      const m = merge([attemptOfGame(1, 1, X), { source: "attempt-2/result-1.json", text: JSON.stringify(failed) }], Y.gameAt)
      expect(m.rows[0].result?.run?.attempt).toBe(2)
      expect(m.rows[0].result?.game).toBeNull()
    })
    it("resolves bots split across attempts to the probe's game", () => {
      const m = merge(
        [attemptOfGame(1, 1, X), attemptOfGame(1, 2, Y), attemptOfGame(2, 1, X), attemptOfGame(2, 2, Y), attemptOfGame(3, 1, X), attemptOfGame(3, 2, Y)].filter((r) => !r.source.startsWith("attempt-1/result-3")),
        Y.gameAt,
        [1, 2, 3],
      )
      expect(m.rows.map((r) => r.result?.game?.index)).toEqual([171, 171, 171])
      expect(m.problems.some((p) => p.includes("different games"))).toBe(false)
    })
    it("keeps every candidate when none played the probe's game", () => {
      const m = merge([attemptOfGame(1, 1, X)], Y.gameAt)
      expect(m.rows[0].result?.game?.index).toBe(170)
    })
  })
  it("never lets a superseded restart outrank an earlier attempt that stopped in (a)", () => {
    const failedAtA = emptyResult(1, "acct1", USERS[0])
    failedAtA.run = { attempt: 1 }
    failedAtA.stages.a.status = "fail"
    failedAtA.stages.a.notes.push("host never came up")
    const restarted = emptyResult(1, "acct1", USERS[0])
    restarted.stages.a.status = "pass"
    restarted.stages.b.status = "skip"
    restarted.run = {
      attempt: 2,
      superseded: true,
      skipped: { kind: "restarted-after-probed-game", expected: { index: 7, registrationEnds: 1 }, current: null },
    }
    const m = mergeResults({
      bots: [1],
      raws: [raw(failedAtA), { source: "attempt-2/result-1.json", text: JSON.stringify(restarted) }],
      identities: { 1: USERS[0] },
      links,
    })
    expect(m.rows[0].result?.run?.attempt).toBe(1)
    expect(m.stageFailures.join("\n")).toMatch(/stage \(a\) failed: host never came up/)
  })
  it("keeps a supervisor's synthetic late-child row over a superseded restart", () => {
    const late = emptyResult(2, null, null, new Date(), "locale-la-enus")
    late.run = { attempt: 1 }
    late.runnerOutcomes = [{ kind: "shared-registration-deadline-missed", detail: "bot 1 was ready" }]
    const restarted = emptyResult(2, "acct2", USERS[1], new Date(), "locale-la-enus")
    restarted.stages.a.status = "pass"
    restarted.stages.b.status = "skip"
    restarted.run = {
      attempt: 2,
      superseded: true,
      skipped: { kind: "restarted-after-probed-game", expected: { index: 7, registrationEnds: 1 }, current: null },
    }
    const m = mergeResults({
      bots: [1, 2, 3],
      raws: [raw(played(1)), raw(late), { source: "attempt-2/result-2.json", text: JSON.stringify(restarted) }, raw(played(3))],
      identities: ids(USERS),
      links,
    })
    expect(m.rows[1].result?.run?.attempt).toBe(1)
    expect(m.problems).toEqual([expect.stringMatching(/bot 2.*shared-registration-deadline-missed/)])
    expect(renderSummary(m, links.runUrl)).toContain("shared runner unavailable | FAILED")
  })
  it("still rejects duplicate files from the same attempt", () => {
    const first = played(1)
    const duplicate = played(1)
    first.run = { attempt: 1 }
    duplicate.run = { attempt: 1 }
    const m = mergeResults({
      bots: [1],
      raws: [raw(first), { source: "duplicate/result-1.json", text: JSON.stringify(duplicate) }],
      identities: { 1: USERS[0] },
      links,
    })
    expect(m.problems.join("\n")).toMatch(/two result files for attempt 1/)
    expect(m.verdict).toMatchObject({ product: "inconclusive", reasons: expect.arrayContaining(["run-problem"]) })
  })
  it("fails closed when immutable result acquisition was incomplete", () => {
    const m = mergeResults({
      bots: [1],
      raws: [raw(played(1))],
      identities: { 1: USERS[0] },
      links,
      acquisitionProblems: ["result artifact attempt 2 could not be downloaded completely"],
    })
    expect(m.allPlayed).toBe(false)
    expect(m.problems).toContain("result artifact attempt 2 could not be downloaded completely")
  })
  it("rejects stale cross-bot evidence carried by another bot's immutable artifact", () => {
    const staleBot2 = played(2)
    staleBot2.run = { attempt: 1 }
    const m = mergeResults({
      bots: [1, 2],
      raws: [{
        ...raw(staleBot2),
        source: "artifact-101/result-2.json",
        artifact: { id: 101, name: attemptResultArtifactName("9", 1, 1, "manual"), bot: 1, attempt: 1 },
      }],
      identities: { 1: USERS[0], 2: USERS[1] },
      links,
    })
    expect(m.allPlayed).toBe(false)
    expect(m.rows.every((row) => row.result === null)).toBe(true)
    expect(m.problems.join("\n")).toMatch(/result says bot 2.*belongs to bot 1/)
  })
  it("rejects a payload whose attempt disagrees with its immutable artifact", () => {
    const staleAttempt = played(1)
    staleAttempt.run = { attempt: 1 }
    const m = mergeResults({
      bots: [1],
      raws: [{
        ...raw(staleAttempt),
        source: "artifact-102/result-1.json",
        artifact: { id: 102, name: attemptResultArtifactName("9", 1, 2, "manual"), bot: 1, attempt: 2 },
      }],
      identities: { 1: USERS[0] },
      links,
    })
    expect(m.allPlayed).toBe(false)
    expect(m.rows[0].result).toBeNull()
    expect(m.problems.join("\n")).toMatch(/result says attempt 1.*belongs to attempt 2/)
  })
  it("reports unreadable and unknown-version files", () => {
    const m = mergeResults({ bots: [1], raws: [{ source: "x", text: "{" }, { source: "y", text: '{"version":2}' }], identities: { 1: "a" }, links })
    expect(m.problems.join("\n")).toMatch(/x: not valid JSON/)
    expect(m.problems.join("\n")).toMatch(/y: version 2 result needs slot and stages/)
    expect(m.allPlayed).toBe(false)
  })
  it("an empty dispatch never counts as played", () => {
    expect(mergeResults({ bots: [], raws: [], identities: ids(USERS), links }).allPlayed).toBe(false)
  })
  const videoProfiles = {
    1: "reload-mid-game",
    2: "video-role-late-flip",
    3: "video-role-late-never",
    4: "baseline",
    5: "baseline",
    6: "baseline",
  }
  const videoIdentities = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index + 1, `video${index + 1}.test`]))
  const videoResults = (): SlotResult[] => {
    const viewer = played(1, { profile: videoProfiles[1], account: "viewer", username: videoIdentities[1] })
    const flip = played(2, { profile: videoProfiles[2], account: "flip", username: videoIdentities[2] })
    const never = played(3, { profile: videoProfiles[3], account: "never", username: videoIdentities[3] })
    viewer.role.actions = [{ id: "reloaded", at: "2026-10-07T01:00:05Z", detail: "reload" }]
    flip.role.actions = [
      { id: "video-enabled", at: "2026-10-07T01:00:02Z", detail: "on" },
      { id: "video-disabled", at: "2026-10-07T01:00:04Z", detail: "off" },
    ]
    viewer.videoRoleProof = {
      turns: [{ turn: 1, at: "2026-10-07T01:00:01Z", roles: { flip: "unseen", never: "unseen" }, verdicts: { flip: "unseen", never: "unseen" } }],
      markers: [{ at: "2026-10-07T01:00:03Z", id: "flip", role: "coplayer" }],
      recap: [{ at: "2026-10-07T01:00:06Z", id: "flip", role: "coplayer", text: "Seen earlier", verdict: "approve", votable: true }],
      report: { never: { verdict: "notperson", source: "unseen", unseenChoice: "default-notperson" } },
    }
    const baselines = [4, 5, 6].map((slot) => played(slot, { profile: "baseline", username: videoIdentities[slot] }))
    baselines[0].videoRoleProof = {
      turns: [],
      markers: [],
      recap: [{ at: "2026-10-07T01:00:06Z", id: "flip", role: "coplayer", text: "Seen earlier", verdict: "approve", votable: true }],
      report: { never: { verdict: "notperson", source: "unseen", unseenChoice: "default-notperson" } },
    }
    return [viewer, flip, never, ...baselines]
  }
  const mergeVideo = (results: SlotResult[], runEvidence?: RunEvidence) =>
    mergeResults({
      bots: [1, 2, 3, 4, 5, 6],
      raws: results.map(raw),
      identities: videoIdentities,
      profiles: videoProfiles,
      links,
      runEvidence,
    })

  it("makes the requested six-slot video-role journey proof a gather-level gate", () => {
    const results = videoResults()
    const viewer = results[0]
    const complete = mergeVideo(results)
    expect(complete.allPlayed).toBe(true)
    expect(complete.guardFailures).not.toEqual(expect.arrayContaining([expect.stringMatching(/video-role-proof/)]))
    viewer.role.actions[0].at = "2026-10-07T01:00:03.500Z"
    expect(mergeVideo(results).guardFailures).toEqual(expect.arrayContaining([expect.stringMatching(/video-role-proof.*disable.*reload/i)]))
    viewer.role.actions[0].at = "2026-10-07T01:00:05Z"
    viewer.videoRoleProof!.report!.never.unseenChoice = "flipped-person"
    expect(mergeVideo(results).guardFailures).toEqual(expect.arrayContaining([expect.stringMatching(/video-role-proof.*viewer did not file.*default NotPerson/i)]))
  })

  it("fails the requested video-role cohort when any required original persona was preempted", () => {
    for (const missing of [1, 2, 3, 4]) {
      const job = lostJob(missing, { name: `play [manual] (bot ${missing}, ${videoProfiles[missing as keyof typeof videoProfiles]})` })
      const merged = mergeVideo(
        videoResults().filter((result) => result.slot !== missing),
        evidence([job], { [String(job.id)]: { available: true, messages: [RUNNER_LOST] } }),
      )
      expect(merged.allPlayed, `missing bot ${missing}`).toBe(false)
      expect(merged.problems.join("\n"), `missing bot ${missing}`).toMatch(/video-role-proof.*requested persona/i)
      if (missing <= 3) expect(merged.guardFailures.join("\n"), `missing role bot ${missing}`).toMatch(/video-role-proof.*missing/i)
    }
  })

  it("does not let a stale retry result substitute for the preempted requested persona", () => {
    const results = videoResults()
    const restarted = results[2]
    restarted.run = {
      attempt: 2,
      skipped: {
        kind: "restarted-after-probed-game",
        expected: { index: 170, registrationEnds: 900 },
        current: { index: 171, registrationEnds: 1900 },
      },
    }
    const job = lostJob(3, { name: "play [manual] (bot 3, video-role-late-never)" })
    const merged = mergeVideo(results, evidence([job], { [String(job.id)]: { available: true, messages: [RUNNER_LOST] } }))
    expect(merged.allPlayed).toBe(false)
    expect(merged.problems.join("\n")).toMatch(/video-role-proof requested persona bot 3.*runner preempted/i)
    expect(merged.guardFailures.join("\n")).toMatch(/video-role-proof.*missing.*never-video/i)
  })

  it("rejects a stale result whose received profile does not match the requested video-role persona", () => {
    const results = videoResults()
    results[2].profile = "baseline"
    const merged = mergeVideo(results)
    expect(merged.allPlayed).toBe(false)
    expect(merged.problems.join("\n")).toMatch(/bot 3.*video-role-late-never.*baseline/i)
  })
})

describe("video links", () => {
  it("links the selected attempt's heavy artifact by immutable id", () => {
    expect(artifactName("9", 2, "manual")).toBe("e2e-live-9-attempt-1-manual-bot2")
    expect(resultArtifactName("9", 2, "manual")).toBe("e2e-live-9-attempt-1-manual-bot2-result")
    expect(attemptArtifactName("9", 2, 3, "manual")).toBe("e2e-live-9-attempt-3-manual-bot2")
    expect(attemptResultArtifactName("9", 2, 3, "manual")).toBe("e2e-live-9-attempt-3-manual-bot2-result")
    const attempts = {
      ...links,
      artifacts: [
        { name: "e2e-live-9-attempt-1-manual-bot2", id: 71 },
        { name: "e2e-live-9-attempt-2-manual-bot2", id: 72 },
      ],
    }
    expect(videoLink(attempts, 2, 1)).toBe("https://github.com/o/r/actions/runs/9/artifacts/71")
    expect(videoLink(attempts, 2, 2)).toBe("https://github.com/o/r/actions/runs/9/artifacts/72")
  })
  it("never links unscoped or attemptless artifacts to a current execution", () => {
    expect(videoLink({ ...links, artifacts: [{ name: "e2e-live-9-manual-bot2", id: 77 }] }, 2, 1)).toBeNull()
    expect(videoLink({ ...links, artifacts: [{ name: "e2e-live-9-manual-bot2", id: 77 }, { name: "e2e-live-9-manual-bot2", id: 78 }] }, 2, 1)).toBeNull()
    expect(videoLink(links, 2)).toBe("https://github.com/o/r/actions/runs/9#artifacts")
    expect(videoLink({ ...links, artifacts: [] }, 2)).toBeNull()
  })
  it("parses only anchored result artifact provenance", () => {
    expect(parseResultArtifactName("9", "e2e-live-9-attempt-3-manual-bot2-result", "manual")).toEqual({ bot: 2, attempt: 3 })
    expect(parseResultArtifactName("9", "e2e-live-9-manual-bot2-result", "manual")).toBeNull()
    expect(parseResultArtifactName("9", "e2e-live-90-attempt-3-manual-bot2-result", "manual")).toBeNull()
    expect(parseResultArtifactName("9", "prefix-e2e-live-9-attempt-3-manual-bot2-result", "manual")).toBeNull()
  })
  it("parseResult accepts a real result", () => {
    expect("result" in parseResult(raw(played(1)))).toBe(true)
  })
  it("parseResult upgrades schema-v1 narration and rejects schema-v2 without it", () => {
    const current = played(1)
    const legacy = { ...current, version: 1 }
    delete (legacy as { narration?: unknown }).narration
    const parsed = parseResult({ source: "legacy/result-1.json", text: JSON.stringify(legacy) })
    expect(parsed).toMatchObject({ result: { version: 1, narration: [] } })

    const missing = { ...current } as { narration?: unknown }
    delete missing.narration
    expect(parseResult({ source: "current/result-1.json", text: JSON.stringify(missing) })).toMatchObject({ error: expect.stringMatching(/version 2.*narration/i) })
  })
})

describe("renderSummary", () => {
  it("writes one row per bot with the video link and the played verdict", () => {
    const md = renderSummary(run([played(1), played(2), played(3)]), links.runUrl)
    expect(md).toContain("| 1 | baseline | jollityeea.09 | yes | yes | yes | yes | 12 | yes | - | unknown (no roster read) | [video-1.webm](")
    expect(md).toContain("every bot played and settled")
    expect(md).toContain("The game is marked played.")
  })
  it("a failing guard turns the run red but not the game unplayed; pending and not-evaluated are said, not passed", () => {
    const r = played(2)
    r.guards = [
      { kind: "text", description: "page never shows X", status: "fail", evidence: "X appeared" },
      { kind: "metric", description: "metric m is recorded", status: "not-evaluated", evidence: "no SENTRY_AUTH_TOKEN" },
      { kind: "event", description: "event e seen", status: "pending", evidence: "n" },
      { kind: "event", description: "event f seen", status: "pass", evidence: "1" },
    ]
    const m = run([played(1), r, played(3)])
    expect(m.guardFailures).toEqual(["bot 2 (baseline, group unknown (no roster read)): page never shows X - X appeared"])
    expect(m.allPlayed).toBe(true)
    const md = renderSummary(m, links.runUrl)
    expect(md).toContain("1 pass, **1 FAIL**, 1 not evaluated, 1 pending")
    expect(md).toContain("**Guards that FAILED**")
    expect(md).toContain("not-evaluated: metric m is recorded - no SENTRY_AUTH_TOKEN")
  })
  it("keeps pending and not-evaluated guards inconclusive in both attempt and run verdicts", () => {
    const r = played(2)
    r.guards = [
      { kind: "metric", description: "metric m is recorded", status: "not-evaluated", evidence: "no SENTRY_AUTH_TOKEN" },
      { kind: "event", description: "event e seen", status: "pending", evidence: "n" },
    ]
    const m = run([played(1), r, played(3)])
    expect(m.attempts.find(({ bot }) => bot === 2)?.verdict).toEqual({ product: "inconclusive", reasons: ["guard-incomplete"] })
    expect(m.verdict).toMatchObject({ product: "inconclusive", reasons: ["run-inconclusive"] })
  })
  it("prints the commit the runners used, and flags different ones", () => {
    // GITHUB_SHA is set in CI and emptyResult reads it: pin every bot's provenance
    const same = () => ({ commit: "abcdef1234567", runStartedAt: "2026-10-04T10:00:00Z" })
    const [a, b, c] = [played(1), played(2), played(3)]
    ;[a, b, c].forEach((r) => (r.provenance = same()))
    expect(renderSummary(run([a, b, c]), links.runUrl)).toContain("Commit abcdef1, run started 2026-10-04T10:00:00Z.")
    b.provenance = { commit: "1111111aaaa", runStartedAt: null }
    expect(renderSummary(run([a, b, c]), links.runUrl)).toContain("DIFFERENT commits")
  })
  it("lists problems and says the game is not marked played", () => {
    const md = renderSummary(run([played(1), played(3)]), links.runUrl)
    expect(md).toContain("| 2 | ? | ? | no result |")
    expect(md).toContain("**Problems**")
    expect(md).toContain("NOT marked played")
  })
  it("names scheduled and intentionally rotated-out personas without calling them passed", () => {
    const merged = mergeResults({
      bots: [1, 2, 3],
      raws: [played(1), played(2), played(3)].map(raw),
      identities: ids(USERS),
      profiles: { 1: "baseline-iphone14-wifi", 2: "kill-background-iphone13", 3: "late-join-galaxya55-lte-good" },
      personaSchedule: {
        runNumber: 101,
        half: "A",
        scheduled: ["baseline-iphone14-wifi", "kill-background-iphone13", "late-join-galaxya55-lte-good"],
        rotatedOut: ["relay-outage", "visible-freeze"],
      },
      links,
    })
    const md = renderSummary(merged, links.runUrl)
    expect(md).toContain("**Scheduled personas (3; rotation half A, dispatch 101):** baseline-iphone14-wifi, kill-background-iphone13, late-join-galaxya55-lte-good")
    expect(md).toContain("**Rotated out (2; expected in half B):** relay-outage, visible-freeze")
    expect(md).not.toMatch(/relay-outage.*pass|visible-freeze.*pass/)
  })
})

describe("the app the bots loaded", () => {
  const app = (bot: number, cid: string, version = "8bd8ae98e98e3d9f4896abde424d9ff6ab06975431ac98a9378d0dc5537d9d8e") =>
    played(bot, { app: { app: "dim2next.paseo", product: "dim2.paseo", cid, version } })
  it("heads the summary with the name, product, build and CID", () => {
    const m = run([app(1, "bafyA"), app(2, "bafyA"), app(3, "bafyA")])
    const text = renderSummary(m, "https://run")
    expect(text).toMatch(/\*\*App:\*\* dim2next\.paseo \(product dim2\.paseo\), build 8bd8ae98e98e, CID bafyA\n/)
    expect(text.indexOf("**App:**")).toBeLessThan(text.indexOf("| bot |"))
  })
  it("records an explicit series pin", () => {
    const pinned = app(1, "bafyA")
    pinned.app!.pinSource = "input"
    expect(renderSummary(run([pinned, app(2, "bafyA"), app(3, "bafyA")]), "https://run")).toContain("CID bafyA, pinned by input")
  })
  it("names each bot when a deploy landed mid-run", () => {
    const text = renderSummary(run([app(1, "bafyA"), app(2, "bafyB"), app(3, "bafyB")]), "https://run")
    expect(text).toMatch(/DIFFERENT builds/)
    expect(text).toMatch(/- bot 1: .*CID bafyA/)
    expect(text).toMatch(/- bot 2, 3: .*CID bafyB/)
  })
  it("records the user-like reload with its elapsed time and both builds", () => {
    const reloaded = app(2, "bafyB")
    reloaded.buildReloads = [{ from: { cid: "bafyA", version: "a".repeat(64) }, to: { cid: "bafyB", version: "b".repeat(64) }, seconds: 2.34 }]
    const text = renderSummary(run([app(1, "bafyA"), reloaded, app(3, "bafyB")]), "https://run")
    expect(text).toContain("bot 2 reloaded for a newer build in 2.3 s: bafyA (aaaaaaaaaaaa) -> bafyB (bbbbbbbbbbbb)")
  })
  it("says nothing for a result written before the app was recorded", () => {
    expect(renderSummary(run([played(1), played(2), played(3)]), "https://run")).not.toMatch(/\*\*App/)
  })

  it("fails a named proof after the run when any proof bot ended on an old build", () => {
    const requested = "a".repeat(40)
    const fresh = app(1, "bafyNew")
    fresh.app!.app = "dim2-pr961-sandbox00.testnet"
    fresh.app = { ...fresh.app!, commit: requested }
    const stale = app(2, "bafyOld")
    stale.app!.app = "dim2-pr961-sandbox00.testnet"
    stale.app = { ...stale.app!, commit: "b".repeat(40) }
    const merged = mergeResults({
      bots: [1, 2],
      raws: [fresh, stale].map(raw),
      identities: ids(USERS),
      profiles: { 1: "baseline-iphone14-wifi", 2: "locale-la-enus" },
      proofs: ["flip-verdict"],
      proofHead: requested,
      links,
    })
    expect(merged.problems).toContain(`bot 2 (locale-la-enus) ran on old build ${"b".repeat(12)}; named proof requires requested head ${requested}`)
    expect(merged.allPlayed).toBe(false)
  })

  it("accepts named-proof bots that all ended on the requested build", () => {
    const requested = "a".repeat(40)
    const results = [1, 2].map((slot) => {
      const result = app(slot, "bafyNew")
      result.app!.app = "dim2-pr961-sandbox00.testnet"
      result.app = { ...result.app!, commit: requested }
      return result
    })
    expect(mergeResults({ bots: [1, 2], raws: results.map(raw), identities: ids(USERS), profiles: { 1: "baseline-iphone14-wifi", 2: "locale-la-enus" }, proofs: ["flip-verdict"], proofHead: requested, links }).problems).toEqual([])
  })
})

describe("classifyGroup", () => {
  const CORE = new Set(["baseline", "core-a", "core-b"])
  const by = new Map([["A1", "core-a"], ["B2", "core-b"], ["C3", "chaos-x"]])
  const mine = (accounts: string[], over: Partial<SlotResult> = {}) => {
    const r = played(1, { account: "A1", ...over })
    r.groups = [{ round: 0, ownIndex: 0, members: accounts.map((account, index) => ({ index, account })) }]
    return r
  }
  it("clean: only core bots (itself included)", () => {
    expect(classifyGroup(mine(["A1", "B2"]), by, CORE)).toEqual({ kind: "clean", label: "clean", with: [] })
  })
  it("mixed: names a non-core bot's profile and real players, once each, over every round", () => {
    const r = mine(["A1", "B2", "C3"])
    r.groups?.push({ round: 1, ownIndex: 1, members: [{ index: 0, account: "A1" }, { index: 1, account: "Z9" }, { index: 2, account: "Y8" }] })
    expect(classifyGroup(r, by, CORE)).toEqual({ kind: "mixed", label: "mixed (with: chaos-x, real player)", with: ["chaos-x", "real player"] })
  })
  it("unknown when no roster was read", () => {
    expect(classifyGroup(played(1), by, CORE).kind).toBe("unknown")
    expect(classifyGroup(null, by, CORE).kind).toBe("unknown")
  })
  it("a bot with no result still counts as ours: the pool seeds account -> profile", () => {
    const a = mine(["A1", "B2"], { account: "A1", profile: "core-a" })
    // bot 2 died: no result, but B2 is in the pool as core-b; C3 is a non-core bot of ours
    const known = new Map([["B2", "core-b"], ["C3", "chaos-x"]])
    const m = mergeResults({ bots: [1, 2], raws: [raw(a)], identities: ids(USERS), knownAccounts: known, coreProfiles: CORE, links })
    expect(m.rows[0].group).toEqual({ kind: "clean", label: "clean", with: [] })
    const mixed = mine(["A1", "B2", "C3", "Z9"], { account: "A1", profile: "core-a" })
    expect(mergeResults({ bots: [1], raws: [raw(mixed)], identities: ids(USERS), knownAccounts: known, coreProfiles: CORE, links }).rows[0].group.label).toBe("mixed (with: chaos-x, real player)")
  })
  it("rows carry the verdict, resolved from every dispatched bot's account", () => {
    const a = mine(["A1", "B2"], { account: "A1", profile: "core-a" })
    const b = played(2, { account: "B2", profile: "core-b" })
    b.groups = [{ round: 0, ownIndex: 1, members: [{ index: 0, account: "A1" }, { index: 1, account: "B2" }, { index: 2, account: "R" }] }]
    const m = mergeResults({ bots: [1, 2], raws: [raw(a), raw(b)], identities: ids(USERS), coreProfiles: CORE, links })
    expect(m.rows.map((r) => r.group.kind)).toEqual(["clean", "mixed"])
    expect(renderSummary(m, links.runUrl)).toContain("| mixed (with: real player) |")
  })
})

describe("game 190 (a live run): the six real result files", () => {
  // every bot signed up, reported 10/10 Person and settled; bot 5's ROLE proof failed in (d) (hidden / visible never fired).
  // The summary said "NOT every bot played and settled" with six all-yes rows and no reason anywhere.
  const results = JSON.parse(readFileSync(join(__dirname, "fixtures", "results.json"), "utf8")) as SlotResult[]
  const m = mergeResults({
    bots: [1, 2, 3, 4, 5, 6],
    raws: results.map((r) => ({ source: `e2e-live-37214440962-bot${r.slot}-result/result-${r.slot}.json`, text: JSON.stringify(r) })),
    identities: Object.fromEntries(results.map((r) => [r.slot, r.username as string])),
    links,
  })
  it("has a row per bot and counts the game as played: the chain says every bot reported and the game settled", () => {
    expect(m.rows.map((r) => r.result?.slot)).toEqual([1, 2, 3, 4, 5, 6])
    expect(m.problems).toEqual([])
    expect(m.allPlayed).toBe(true)
  })
  it("still turns the run red, naming bot 5's failed stage and why", () => {
    expect(m.stageFailures).toHaveLength(1)
    expect(m.stageFailures[0]).toMatch(/^bot 5 \(kill-background-iphone13\): stage \(d\) failed: .*hidden: the role was due to act \(hidden\) and never did/)
    const md = renderSummary(m, links.runUrl)
    expect(md).toMatch(/every bot played and settled, but 1 bot failed a stage/)
    expect(md).toMatch(/\*\*Stages that FAILED\*\*/)
    expect(md.split("\n").filter((l) => /^\| [1-6] \|/.test(l))).toHaveLength(6)
  })
})

describe("inconclusive acts (#341)", () => {
  const freeze = { name: "player 1 role baseline: confirm-tap", detail: "INCONCLUSIVE, not failed: the bot's page froze for 15.7 s in turn 3 (ended 21:25:27 CEST) ... runner overload, see #341" }
  it("are listed under their own heading with the freeze, counted apart, and never turn the run red or the game unplayed", () => {
    const m = run([played(1, { inconclusive: [freeze] }), played(2), played(3)])
    expect(m.inconclusive).toEqual([`bot 1 (baseline): ${freeze.name} - ${freeze.detail}`])
    expect(m.stageFailures).toEqual([])
    expect(m.guardFailures).toEqual([])
    expect(m.allPlayed).toBe(true)
    const md = renderSummary(m, links.runUrl)
    expect(md).toContain("**Inconclusive acts: 1**")
    expect(md).toContain("froze for 15.7 s in turn 3")
  })
  it("a run without any says nothing about them", () => {
    const m = run([played(1), played(2), played(3)])
    expect(m.inconclusive).toEqual([])
    expect(renderSummary(m, links.runUrl)).not.toContain("Inconclusive")
  })
})

describe("spot-runner preemption (#350)", () => {
  const merge = (results: SlotResult[], runEvidence: ReturnType<typeof evidence>, bots = [1, 2, 3]) =>
    mergeResults({
      bots,
      raws: results.map(raw),
      identities: ids(USERS),
      profiles: { 1: "baseline", 2: "chain-outage", 3: "relay-outage" },
      links,
      runEvidence,
    })

  it("game 57: an annotated runner loss is inconclusive even after the journey had started", () => {
    const m = mergeResults({
      bots: [1, 3, 12],
      raws: [raw(played(1)), raw(played(3))],
      identities: { 1: USERS[0], 3: USERS[2], 12: "jollityeea.09" },
      profiles: { 1: "baseline", 3: "relay-outage", 12: "host-crash-long" },
      links,
      runEvidence: game57,
    })

    expect(m.problems).toEqual([])
    expect(m.allPlayed).toBe(true)
    expect(m.inconclusive).toEqual([expect.stringMatching(/bot 12 \(host-crash-long\): runner preempted.*runner-lost annotation/)])
    const summary = renderSummary(m, links.runUrl)
    expect(summary).toContain("every evaluated bot played and settled, 1 bot inconclusive")
    expect(summary).toMatch(/\| 12 \| host-crash-long \| runner preempted \| INCONCLUSIVE/)
  })

  it("uses a zero-step self-hosted failure only when annotation retrieval was unavailable", () => {
    const m = merge([played(1), played(3)], evidence([lostJob(2)], { "102": { available: false, messages: [] } }))
    expect(m.problems).toEqual([])
    expect(m.allPlayed).toBe(true)
    expect(m.inconclusive.join("\n")).toMatch(/annotation unavailable/)
  })

  it("does not hide an ordinary stepped failure, a GitHub-hosted failure, or a missing result with an answered non-loss annotation", () => {
    const stepped = merge([played(1), played(3)], evidence([lostJob(2, { steps: [{ name: "Boot", status: "completed", conclusion: "failure" }] })], { "102": { available: false, messages: [] } }))
    expect(stepped.allPlayed).toBe(false)
    expect(stepped.problems.join("\n")).toMatch(/no result-2\.json/)

    const hosted = merge(
      [played(1), played(3)],
      evidence([lostJob(2, { runner_name: "GitHub Actions 123", runner_group_name: "GitHub Actions", labels: ["ubuntu-latest"] })], { "102": { available: true, messages: [RUNNER_LOST] } }),
    )
    expect(hosted.allPlayed).toBe(false)

    const otherAnnotation = merge([played(1), played(3)], evidence([lostJob(2)], { "102": { available: true, messages: ["Process completed with exit code 1."] } }))
    expect(otherAnnotation.allPlayed).toBe(false)
  })

  it("never replaces a real result with earlier runner-loss evidence", () => {
    const m = merge([played(1), played(2), played(3)], evidence([lostJob(2)], { "102": { available: true, messages: [RUNNER_LOST] } }))
    expect(m.allPlayed).toBe(true)
    expect(m.inconclusive).toEqual([])
    expect(m.rows[1].result?.slot).toBe(2)
  })

  it("keeps attempt-1 preemption when attempt 2 records that the probed game is already over", () => {
    const restarted = played(2, { game: null, signedUp: false, reportSeen: null, settled: null })
    restarted.stages.b.status = "skip"
    restarted.run = {
      attempt: 2,
      skipped: {
        kind: "restarted-after-probed-game",
        expected: { index: 57, registrationEnds: 1000 },
        current: { index: 58, registrationEnds: 2000 },
      },
    }
    const bot3 = game57.jobs.filter((job) => /bot 3,/.test(job.name))
    const bot3Annotations = Object.fromEntries(bot3.map((job) => [String(job.id), game57.annotations[String(job.id)]]))
    const m = merge([played(1), restarted, played(3)], evidence(bot3.map((job) => ({ ...job, name: job.name.replace("bot 3,", "bot 2,") })), bot3Annotations))

    expect(m.problems).toEqual([])
    expect(m.allPlayed).toBe(true)
    expect(m.inconclusive.join("\n")).toMatch(/runner preempted.*attempt 1.*restart attempt 2 refused game 58/i)
  })

  it("does not mark a game played when every dispatched bot was preempted", () => {
    const m = merge([], evidence([lostJob(1)], { "101": { available: true, messages: [RUNNER_LOST] } }), [1])
    expect(m.problems).toEqual([])
    expect(m.allPlayed).toBe(false)
  })

  it("maps one lost shared runner to one inconclusive row per missing logical bot", () => {
    const job = lostJob(1, { id: 909, name: "play [manual] (group g01, bots 1-2-3)", labels: ["parity-int-ubuntu-xl"] })
    const m = mergeResults({
      bots: [1, 2, 3],
      raws: [],
      identities: ids(USERS),
      profiles: { 1: "baseline-iphone14-wifi", 2: "locale-la-enus", 3: "locale-tokyo-jajp" },
      links,
      runnerGroups: [{ group: "g01", bots: [1, 2, 3], shared: true, measure: false }],
      runEvidence: evidence([job], { "909": { available: true, messages: [RUNNER_LOST] } }),
    })
    expect(m.problems).toEqual([])
    expect(m.inconclusive).toHaveLength(3)
    expect(m.rows.every(({ preemption }) => preemption?.attempt === 1)).toBe(true)
    expect(m.allPlayed).toBe(false)
  })

  it("lets each real result win when a shared runner later reports lost", () => {
    const job = lostJob(1, { id: 910, name: "play [manual] (group g01, bots 1-2-3)", labels: ["parity-int-ubuntu-xl"] })
    const m = mergeResults({
      bots: [1, 2, 3],
      raws: [raw(played(1))],
      identities: ids(USERS),
      profiles: { 1: "baseline-iphone14-wifi", 2: "locale-la-enus", 3: "locale-tokyo-jajp" },
      links,
      runnerGroups: [{ group: "g01", bots: [1, 2, 3], shared: true, measure: false }],
      runEvidence: evidence([job], { "910": { available: true, messages: [RUNNER_LOST] } }),
    })
    expect(m.rows[0].preemption).toBeNull()
    expect(m.rows[1].preemption).not.toBeNull()
    expect(m.rows[2].preemption).not.toBeNull()
  })
})

describe("a re-run of a failed play job that reuses a drawn fresh person (#614 LOW 2)", () => {
  const withAttempt = (attempt: number) => played(1, { run: { attempt } })
  const merge = (attempt: number, freshBots?: number[]) => mergeResults({ bots: [1], raws: [raw(withAttempt(attempt))], identities: { 1: USERS[0] }, links, freshBots })
  it("is marked not proving the seat-preparing path (inconclusive, never red)", () => {
    const m = merge(2, [1])
    expect(m.inconclusive.join("\n")).toMatch(/bot 1.*attempt 2.*fresh person.*not proven/)
    expect(m.guardFailures).toEqual([])
    expect(m.allPlayed).toBe(true)
  })
  it("a first attempt, or a bot that drew no fresh person, is not marked", () => {
    expect(merge(1, [1]).inconclusive).toEqual([])
    expect(merge(2, []).inconclusive).toEqual([])
    expect(merge(2).inconclusive).toEqual([])
  })
})

describe("hostLine", () => {
  const row = (hostVersion?: string) => ({ result: { provenance: { commit: null, runStartedAt: null, hostVersion } } }) as never
  it("names the host the bots ran on, flags a mix, and says when it was not recorded", async () => {
    const { hostLine } = await import("./gather")
    expect(hostLine([row("truapi-host 0.24.0"), row("truapi-host 0.24.0")])).toBe("Host truapi-host 0.24.0.")
    expect(hostLine([row("truapi-host 0.24.0"), row("truapi-host 0.23.0")])).toMatch(/DIFFERENT hosts/)
    expect(hostLine([row(undefined)])).toBe("Host version not recorded.")
  })
})

describe("public-record gather integration", () => {
  const source = readFileSync(join(__dirname, "gather-cli.mts"), "utf8")

  it("writes a valid bundle before deciding the gather exit status", () => {
    const write = source.indexOf("writeFileSync(publicationPath")
    const exit = source.indexOf("process.exit(merged.allPlayed")
    expect(write).toBeGreaterThan(-1)
    expect(exit).toBeGreaterThan(write)
    expect(source).toContain("publicationBundleFromMerged(merged, metadata, loadCrewCatalogue(), new Date())")
    expect(source).toContain("seatPreparingBundle(merged, metadata)")
  })

  it("keeps publication failure separate from the product exit contract", () => {
    expect(source).toContain("publicationFailed = true")
    expect(source).toContain("publication_bundle=${publicationPath}")
    expect(source).not.toContain("!publicationFailed && merged.allPlayed")
    expect(source).toContain("process.exit(merged.allPlayed")
  })

  it("uses immutable Actions artifact metadata without estimating expiry", () => {
    expect(source).toContain("publicArtifactsFromActions(integer(\"RUN_ID\", runId), artifacts ?? [], executionKey)")
    expect(source).toContain("publicJobsFromActions")
    expect(source).not.toMatch(/14\s*\*\s*24|addDays|fourteen/i)
  })

  it.each([
    { failedGuard: false, profile: "baseline-iphone14-wifi", identity: "jollitypv.12", publicationFails: false, exit: 0 },
    { failedGuard: true, profile: "baseline-iphone14-wifi", identity: "jollitypv.12", publicationFails: false, exit: 1 },
    { failedGuard: false, profile: "check-seat-preparing", identity: "outside.01", publicationFails: false, exit: 0 },
    { failedGuard: false, selectedGuard: "fail", selectedAttempt: 1, profile: "baseline-iphone14-wifi", identity: "jollitypv.12", publicationFails: false, exit: 1 },
    { failedGuard: true, selectedGuard: "pass", selectedAttempt: 1, profile: "baseline-iphone14-wifi", identity: "jollitypv.12", publicationFails: false, exit: 1 },
    { failedGuard: false, selectedGuard: "fail", selectedAttempt: 2, profile: "baseline-iphone14-wifi", identity: "jollitypv.12", publicationFails: false, exit: 0 },
  ])("separates product and publication outcomes before a $exit gather exit", ({ failedGuard, selectedGuard, selectedAttempt, profile, identity, publicationFails, exit }) => {
    const root = mkdtempSync(join(tmpdir(), "crew-publication-cli-"))
    try {
      const input = join(root, "in")
      const artifact = join(input, "artifact-7001")
      const output = join(root, "public")
      const result = played(1, {
        profile,
        network: "previewnet",
        username: identity,
        account: "account-one",
        app: { app: "jollity.testnet", product: "jollity", cid: "bafy-public", version: "version-one" },
        run: { attempt: 1 },
        startedAt: "2026-10-18T17:20:01.000Z",
        finishedAt: "2026-10-18T17:24:59.000Z",
        guards: [{ kind: "text", description: "recording overlay acknowledged", status: failedGuard ? "fail" : "pass", evidence: "observed" }],
      })
      mkdirSync(artifact, { recursive: true })
      writeFileSync(join(artifact, "result-1.json"), JSON.stringify(result))
      const selected = join(root, "selected")
      mkdirSync(selected)
      if (selectedGuard) writeFileSync(join(selected, "result-1.json"), JSON.stringify({ ...result, run: { attempt: selectedAttempt }, guards: [{ ...result.guards![0], status: selectedGuard }] }))
      const acquisition = join(root, "acquisition.json")
      writeFileSync(acquisition, JSON.stringify({ artifactListingComplete: true, results: [
        { id: 7001, name: "e2e-live-39147986065-attempt-1-manual-bot1-result", downloaded: true },
        // Other waves are valid evidence, including an acquisition failure, but
        // neither their contents nor their failures belong to this execution.
        { id: 7002, name: "e2e-live-39147986065-attempt-1-wave-2-bot1-result", downloaded: true },
        { id: 7003, name: "e2e-live-39147986065-attempt-2-wave-2-bot1-result", downloaded: false },
      ] }))
      const artifacts = join(root, "artifacts.json")
      writeFileSync(artifacts, JSON.stringify({ artifacts: [
        { id: 7001, name: "e2e-live-39147986065-attempt-1-manual-bot1-result", created_at: "2026-10-18T17:25:00.000Z", expires_at: "2026-11-01T17:25:00.000Z", expired: false },
        { id: 9002, name: "e2e-live-39147986065-attempt-1-wave-2-bot1", created_at: "2026-10-18T17:25:00.000Z", expires_at: "2026-11-01T17:25:00.000Z", expired: false },
        { id: 9001, name: "e2e-live-39147986065-attempt-1-manual-bot1", created_at: "2026-10-18T17:25:00Z", expires_at: "2026-11-01T17:25:00Z", expired: false },
      ] }))
      const jobs = join(root, "jobs.json")
      writeFileSync(jobs, JSON.stringify({ jobs: [{ id: 8001, run_attempt: 1, name: "play [manual] (bot 1, baseline-iphone14-wifi)", status: "completed", conclusion: "success", runner_name: null, runner_group_name: null, labels: [], steps: [], started_at: "2026-10-18T17:20:00Z", completed_at: "2026-10-18T17:25:00Z" }] }))
      const githubOutput = join(root, "github-output.txt")
      const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/e2e-live/gather-cli.mts", input], {
        cwd: join(__dirname, "../.."),
        encoding: "utf8",
        env: {
          ...process.env,
          BOTS: JSON.stringify([{ bot: 1, profile }]),
          E2E_NETWORK: "previewnet",
          E2E_IDENTITIES: JSON.stringify({ [identity]: "account-one" }),
          E2E_FRESH_DRAWN: profile === "check-seat-preparing" ? JSON.stringify({ [identity]: "account-one" }) : "{}",
          RUN_ID: "39147986065",
          RUN_URL: "https://github.com/paritytech/individuality-apps/actions/runs/39147986065",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_REPOSITORY: "paritytech/individuality-apps",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_ACTOR: "github-actions",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          E2E_DEFAULT_BRANCH: "main",
          E2E_PUBLIC_CLASSIFICATION: "manual",
          E2E_PUBLIC_EXECUTION_KEY: "manual",
          E2E_EXECUTION_KEY: "manual",
          E2E_PUBLIC_SUITE_ID: "suite-39147986065",
          E2E_PUBLIC_WAVE: "game-ready",
          E2E_PUBLIC_WORKFLOW_PATH: ".github/workflows/e2e-live.yml",
          E2E_PUBLIC_STARTED_AT: "2026-10-18T17:20:00Z",
          E2E_PUBLIC_FINISHED_AT: "2026-10-18T17:25:00.000Z",
          ARTIFACTS_JSON: artifacts,
          RESULT_ACQUISITION_JSON: acquisition,
          JOBS_JSON: jobs,
          PUBLICATION_OUT: output,
          SELECTED_GUARDS_DIR: selected,
          GITHUB_OUTPUT: githubOutput,
        },
      })
      expect(child.status, child.stderr).toBe(exit)
      const bundlePath = join(output, "publication-bundle.json")
      if (publicationFails) {
        expect(existsSync(bundlePath)).toBe(false)
        expect(child.stderr).toMatch(/publication bundle failed:/i)
        expect(readFileSync(githubOutput, "utf8")).not.toContain("publication_bundle=")
      } else {
        expect(existsSync(bundlePath)).toBe(true)
        const publication = JSON.parse(readFileSync(bundlePath, "utf8"))
        if (profile === "check-seat-preparing") {
          expect(publication).toMatchObject({ version: 1, runs: [{ identity: null, scenario: null, bot: null, classification: "harness-check", productResult: "missing", result: "passed", infrastructure: "complete", source: { jobId: 8001 } }] })
          expect(JSON.stringify(publication)).not.toContain(identity)
        } else {
          expect(publication).toMatchObject({ version: 1, runs: [{ source: { jobId: 8001, artifactId: 7001 }, recording: { artifactUrl: "https://github.com/paritytech/individuality-apps/actions/runs/39147986065/artifacts/9001", uploadedAt: "2026-10-18T17:25:00.000Z" }, productResult: failedGuard || (selectedGuard === "fail" && selectedAttempt === 1) ? "failed" : "passed", executionKey: "manual", suiteId: "suite-39147986065", wave: "game-ready" }] })
        }
        expect(readFileSync(githubOutput, "utf8")).toContain(`publication_bundle=${bundlePath}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
