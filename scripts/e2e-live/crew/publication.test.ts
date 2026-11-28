// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { attemptVerdict, type BotAttemptEvidence, type Merged } from "../gather"
import { identityFor, loadProfiles } from "../profile"
import { NARRATION_STATES, scenarioNarration } from "../narration"
import { emptyResult, type SlotResult } from "../result"
import { loadCrewCatalogue } from "./catalogue"
import { publicationBundleFromMerged, publicArtifactsFromActions, publicJobsFromActions, publicRunsFromMerged, runKey, suiteKey, type PublicConversionMetadata } from "./publication"

const catalogue = loadCrewCatalogue()
const planned = { bot: 1, profile: "baseline-iphone14-wifi", identity: "jollitypv.12" }

const metadata = (over: Partial<PublicConversionMetadata> = {}): PublicConversionMetadata => ({
  runId: 39147986065,
  attempt: 1,
  executionKey: "nightly-wave-one",
  suiteId: "nightly-2026-10-18",
  wave: "core-connectivity",
  classification: "nightly",
  repository: "paritytech/individuality-apps",
  ref: "refs/heads/main",
  commit: "a".repeat(40),
  actor: "github-actions",
  workflowPath: ".github/workflows/e2e-live.yml",
  event: "workflow_dispatch",
  defaultBranch: "main",
  startedAt: "2026-10-18T17:20:00.000Z",
  finishedAt: "2026-10-18T17:25:00.000Z",
  planned: [planned],
  artifacts: [{
    id: 9001,
    name: "e2e-live-39147986065-attempt-1-manual-bot1",
    bot: 1,
    attempt: 1,
    uploadedAt: "2026-10-18T17:25:00.000Z",
    expiresAt: "2026-11-01T17:25:00.000Z",
    expired: false,
  }],
  jobs: [{ id: 8001, bot: 1, attempt: 1, startedAt: "2026-10-18T17:20:00.000Z", finishedAt: "2026-10-18T17:25:00.000Z" }],
  ...over,
})

function played(attempt = 1, over: Partial<SlotResult> = {}): SlotResult {
  const result = emptyResult(1, "account-one", planned.identity, new Date("2026-10-18T17:20:01.000Z"), planned.profile, {
    E2E_NETWORK: "previewnet",
    GITHUB_RUN_ATTEMPT: String(attempt),
    GITHUB_SHA: "a".repeat(40),
  })
  result.app = { app: "jollity.testnet", product: "jollity", cid: "bafy-public", version: "version-one" }
  result.game = { index: 895, gameAt: 1_760_809_200, registrationEnds: 1_760_809_000, reportEnds: 1_760_809_380 }
  for (const stage of ["a", "b", "c", "d"] as const) result.stages[stage].status = "pass"
  result.signedUp = true
  result.confirmed = true
  result.reportSeen = true
  result.settled = true
  result.finishedAt = "2026-10-18T17:24:59.000Z"
  result.narration = [
    { at: "2026-10-18T17:20:02.000Z", state: "preparing", source: "journey", action: null, title: "Baseline", text: "Captain Baseline is preparing." },
    { at: "2026-10-18T17:24:58.000Z", state: "passed", source: "outcome", action: null, title: "Baseline", text: "Captain Baseline passed." },
  ]
  return { ...result, ...over }
}

const evidence = (result: SlotResult, artifactId: number, selected = true, expectedPlan = planned): BotAttemptEvidence => ({
  bot: expectedPlan.bot,
  attempt: result.run?.attempt ?? 1,
  source: `/private/results/result-${expectedPlan.bot}.json`,
  result,
  artifact: { id: artifactId, name: `e2e-live-39147986065-attempt-${result.run?.attempt ?? 1}-manual-bot${expectedPlan.bot}-result`, bot: expectedPlan.bot, attempt: result.run?.attempt ?? 1 },
  selected,
  verdict: attemptVerdict(result, expectedPlan.profile, expectedPlan.identity),
})

const merged = (attempts: BotAttemptEvidence[]): Merged => ({
  network: "previewnet",
  rows: [],
  attempts,
  verdict: { product: "passed", reasons: [] },
  problems: [],
  game: null,
  allPlayed: false,
  stageFailures: [],
  guardFailures: [],
  inconclusive: [],
  personaSchedule: null,
  adaptiveUpload: null,
})

// built at run time, so the source carries no private address
const PRIVATE_IP = [10, 0, 0, 5].join(".")

describe("public crew record conversion", () => {
  it("requires a valid execution key even when Actions returned no metadata", () => {
    expect(() => publicArtifactsFromActions(9, [], "bad/key")).toThrow(/execution key/)
    expect(() => publicJobsFromActions([], "")).toThrow(/execution key/)
  })
  it("extracts immutable heavy-artifact metadata and ignores result artifacts", () => {
    expect(publicArtifactsFromActions(39147986065, [
      { id: 1, name: "e2e-live-39147986065-attempt-3-manual-bot2", created_at: "2026-10-18T17:20:00.000Z", expires_at: "2026-11-01T17:20:00.000Z", expired: false },
      { id: 2, name: "e2e-live-39147986065-attempt-3-manual-bot2-result", created_at: "2026-10-18T17:20:00.000Z", expires_at: "2026-11-01T17:20:00.000Z", expired: false },
      { id: 3, name: "e2e-live-elsewhere-bot2-attempt-3" },
      { id: 4, name: "e2e-live-39147986065-attempt-3-wave-2-bot2" },
    ], "manual")).toEqual([{ id: 1, name: "e2e-live-39147986065-attempt-3-manual-bot2", bot: 2, attempt: 3, uploadedAt: "2026-10-18T17:20:00.000Z", expiresAt: "2026-11-01T17:20:00.000Z", expired: false }])
  })

  it("expands singleton and shared Actions jobs into logical bot receipts", () => {
    expect(publicJobsFromActions([
      { id: 11, run_attempt: 2, name: "play [manual] (bot 1, baseline-iphone14-wifi)", started_at: "2026-10-18T17:20:00.000Z", completed_at: "2026-10-18T17:25:00.000Z" },
      { id: 12, run_attempt: 2, name: "caller / play [manual] (group g02, bots 2-3-4)", started_at: "2026-10-18T17:20:00.000Z", completed_at: "2026-10-18T17:25:00.000Z" },
      { id: 13, run_attempt: 2, name: "gather", started_at: "2026-10-18T17:25:00.000Z", completed_at: "2026-10-18T17:26:00.000Z" },
      { id: 14, run_attempt: 2, name: "caller / play [wave-2] (group g02, bots 2-3-4)", started_at: "2026-10-18T17:20:00.000Z", completed_at: "2026-10-18T17:25:00.000Z" },
    ], "manual")).toEqual([
      { id: 11, bot: 1, attempt: 2, startedAt: "2026-10-18T17:20:00.000Z", finishedAt: "2026-10-18T17:25:00.000Z" },
      { id: 12, bot: 2, attempt: 2, startedAt: "2026-10-18T17:20:00.000Z", finishedAt: "2026-10-18T17:25:00.000Z" },
      { id: 12, bot: 3, attempt: 2, startedAt: "2026-10-18T17:20:00.000Z", finishedAt: "2026-10-18T17:25:00.000Z" },
      { id: 12, bot: 4, attempt: 2, startedAt: "2026-10-18T17:20:00.000Z", finishedAt: "2026-10-18T17:25:00.000Z" },
    ])
  })

  it("builds stable URL-safe keys without collapsing distinct inputs", () => {
    const one = runKey(9, 1, 1, "wave/a", "captain baseline", 1)
    const two = runKey(9, 1, 1, "wave/b", "captain baseline", 1)
    expect(one).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(two).not.toBe(one)
    expect(suiteKey("nightly/2026-10-18", 9)).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it("maps a played result to an immutable public record and WebP snapshot", () => {
    const [record] = publicRunsFromMerged(merged([evidence(played(), 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(record).toMatchObject({
      result: "passed",
      productResult: "passed",
      infrastructure: "complete",
      artifactAttempt: 1,
      source: { artifactId: 7001, jobId: 8001 },
      identity: { username: planned.identity, portraitFile: expect.stringMatching(/\.webp$/), portraitSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      scenario: { profile: planned.profile },
      recording: { state: "available", artifactUrl: "https://github.com/paritytech/individuality-apps/actions/runs/39147986065/artifacts/9001" },
    })
    expect(record.identity?.portraitPath).toBe(`assets/portraits/by-sha256/${record.identity?.portraitSha256}.webp`)
    expect(record.links.every(({ visibility }) => visibility === "organization")).toBe(true)
  })

  it("does not publish pending or not-evaluated guards as a product pass", () => {
    for (const status of ["pending", "not-evaluated"] as const) {
      const result = played()
      result.guards = [{ kind: "metric", description: "private guard description", status, evidence: "private runner evidence" }]
      const [record] = publicRunsFromMerged(merged([evidence(result, 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
      expect(record).toMatchObject({ result: "inconclusive", productResult: "inconclusive" })
      expect(record.diagnostics?.[0]).toMatchObject({
        criterion: record.scenario?.criteria?.[0],
        status: status === "pending" ? "pending" : "not-met",
      })
      expect(record.diagnostics?.[0]?.detail).toBe(status === "pending"
        ? "This criterion is pending and was not evaluated."
        : "No metric evidence was available, so this criterion was not met.")
      expect(JSON.stringify(record)).not.toContain("private guard description")
      expect(JSON.stringify(record)).not.toContain("private runner evidence")
    }
  })

  it("publishes safe criterion diagnostics without copying raw log evidence", () => {
    const result = played()
    result.guards = [{
      kind: "devlog",
      description: "private evaluator wording",
      status: "pass",
      evidence: "1 matching of 80 line(s), first: secret raw log text",
    }]
    const [record] = publicRunsFromMerged(merged([evidence(result, 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(record.diagnostics?.[0]).toEqual({
      criterion: record.scenario?.criteria?.[0],
      status: "met",
      detail: "Observed 1 matching log line among 80 captured lines.",
    })
    expect(JSON.stringify(record)).not.toContain("private evaluator wording")
    expect(JSON.stringify(record)).not.toContain("secret raw log text")
  })

  it("keeps every clean-video criterion separate with its own truthful result", () => {
    const clean = catalogue.scenarios.find(({ profile }) => profile === "game259-clean-video-control")!
    const expectedPlan = { bot: 1, profile: clean.profile, identity: planned.identity }
    const result = played(1, { profile: clean.profile, username: expectedPlan.identity })
    result.guards = clean.criteria.map((criterion, index) => index < 6
      ? { kind: "devlog", description: criterion, status: "not-evaluated", evidence: "private missing devLog reason" }
      : { kind: "text", description: criterion, status: "pass", evidence: "never appeared (observer on every mutation)" })
    const [record] = publicRunsFromMerged(
      merged([evidence(result, 7001, true, expectedPlan)]),
      metadata({ planned: [expectedPlan] }),
      catalogue,
      new Date("2026-10-18T17:26:00.000Z"),
    )
    expect(record.diagnostics).toHaveLength(10)
    expect(record.diagnostics?.filter(({ status }) => status === "not-met")).toHaveLength(6)
    expect(record.diagnostics?.filter(({ status }) => status === "met")).toHaveLength(4)
    expect(record.diagnostics?.slice(0, 6).every(({ detail }) => detail === "No devLog lines were available, so this criterion was not met.")).toBe(true)
    expect(record.diagnostics?.slice(6).every(({ detail }) => detail === "The prohibited text did not appear during page observation.")).toBe(true)
    expect(JSON.stringify(record)).not.toContain("private missing devLog reason")
  })

  it("keeps a healthy identity green when another identity makes the wave fail", () => {
    const input = merged([evidence(played(), 7001)])
    input.guardFailures = ["private adaptive proof detail"]
    input.verdict = { product: "failed", reasons: ["run-guard-failed"] }
    const [record] = publicRunsFromMerged(input, metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(record).toMatchObject({ result: "passed", productResult: "passed" })
    expect(record.failures).not.toContain("At least one aggregate run guard failed.")
    expect(JSON.stringify(record)).not.toContain("private adaptive proof detail")
  })

  it("publishes only the identity with a failed attempt as failed in a red wave", () => {
    const profile = loadProfiles().find(({ name }) => name === "relay-outage")!
    const relay = { bot: 2, profile: profile.name, identity: identityFor(profile, "previewnet")! }
    const failed = played(1, { slot: relay.bot, profile: relay.profile, username: relay.identity })
    failed.guards = [{ kind: "text", description: "private relay guard", status: "fail", evidence: "private relay evidence" }]
    const input = merged([evidence(played(), 7001), evidence(failed, 7002, true, relay)])
    input.verdict = { product: "failed", reasons: ["run-guard-failed"] }
    const records = publicRunsFromMerged(input, metadata({
      planned: [planned, relay],
      artifacts: [
        ...metadata().artifacts,
        { id: 9002, name: "e2e-live-39147986065-attempt-1-manual-bot2", bot: relay.bot, attempt: 1, uploadedAt: "2026-10-18T17:25:00.000Z", expiresAt: "2026-11-01T17:25:00.000Z", expired: false },
      ],
      jobs: [
        ...metadata().jobs,
        { id: 8002, bot: relay.bot, attempt: 1, startedAt: "2026-10-18T17:20:00.000Z", finishedAt: "2026-10-18T17:25:00.000Z" },
      ],
    }), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(records.map(({ productResult }) => productResult)).toEqual(["passed", "failed"])
    expect(records[0].failures).not.toContain("At least one aggregate run guard failed.")
    expect(records[1].failures).toEqual(["A required product guard failed."])
  })

  it("does not attribute aggregate integrity reasons to healthy selected evidence", () => {
    const input = merged([evidence(played(), 7001)])
    input.verdict = { product: "failed", reasons: ["run-problem", "identity-mismatch", "runner-setup-unavailable", "superseded-attempt"] }
    const [record] = publicRunsFromMerged(input, metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(record).toMatchObject({ result: "passed", productResult: "passed" })
    expect(record.failures).not.toContain("The aggregate run evidence had an integrity or coverage problem.")
    expect(record.failures).not.toContain("Observed identity did not match the planned identity.")
    expect(record.failures).not.toContain("Shared runner setup evidence was unavailable.")
    expect(record.failures).not.toContain("This attempt was superseded for coverage.")
  })

  it("maps narration text from the catalogue and omits free-form detail", () => {
    const result = played()
    result.narration[0].text = "http://runner.internal/private?q=phone"
    result.narration[0].detail = `${PRIVATE_IP} private runtime detail`
    const [record] = publicRunsFromMerged(merged([evidence(result, 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    const scenario = catalogue.scenarios.find(({ profile }) => profile === planned.profile)!
    expect(record.timeline[0]).toMatchObject({ text: scenario.phases.preparing })
    expect(record.timeline[0]).not.toHaveProperty("detail")
    expect(JSON.stringify(record)).not.toContain("runner.internal")
    expect(JSON.stringify(record)).not.toContain(PRIVATE_IP)
  })

  it("keeps in-page HUD transport failures out of the public character timeline", () => {
    const result = played()
    result.narration.splice(1, 0, {
      at: "2026-10-18T17:22:00.000Z",
      state: "failed",
      source: "outcome",
      action: "render.2",
      title: "Recording overlay unavailable",
      text: "The test continued, but this page could not show the recording overlay.",
      detail: "renderer timed out after 2000 ms",
    })

    const [record] = publicRunsFromMerged(merged([evidence(result, 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))

    expect(record.timeline.map(({ state }) => state)).toEqual(["preparing", "passed"])
    expect(JSON.stringify(record.timeline)).not.toContain("Recording overlay unavailable")
    expect(JSON.stringify(record.timeline)).not.toContain("could not show the recording overlay")
  })

  it("rejects inherited object keys as narration actions", () => {
    const result = played()
    result.narration[0].action = "constructor"
    const [record] = publicRunsFromMerged(merged([evidence(result, 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(record.timeline[0]).toMatchObject({ action: null })
  })

  it("preserves every rerun attempt and links an infrastructure-only late attempt", () => {
    const first = played(1)
    const late = played(2, { run: { attempt: 2, superseded: true, skipped: { kind: "restarted-after-probed-game", expected: { index: 895, registrationEnds: 1 }, current: null } } })
    const records = publicRunsFromMerged(
      merged([evidence(first, 7001, true), evidence(late, 7002, false)]),
      metadata({
        attempt: 2,
        artifacts: [
          ...metadata().artifacts,
          { id: 9002, name: "e2e-live-39147986065-attempt-2-manual-bot1", bot: 1, attempt: 2, uploadedAt: "2026-10-18T17:31:00.000Z", expiresAt: "2026-11-01T17:31:00.000Z", expired: false },
        ],
        jobs: [
          ...metadata().jobs,
          { id: 8002, bot: 1, attempt: 2, startedAt: "2026-10-18T17:30:00.000Z", finishedAt: "2026-10-18T17:31:00.000Z" },
        ],
      }),
      catalogue,
      new Date("2026-10-18T17:32:00.000Z"),
    )
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({ result: "skipped", productResult: "missing", infrastructure: "superseded", supersededBy: records[0].key })
  })

  it("retains every job-only attempt and supersedes earlier missing coverage forward", () => {
    const records = publicRunsFromMerged(
      merged([evidence(played(3), 7003)]),
      metadata({
        attempt: 3,
        artifacts: [{ id: 9003, name: "e2e-live-39147986065-attempt-3-manual-bot1", bot: 1, attempt: 3, uploadedAt: "2026-10-18T17:35:00.000Z", expiresAt: "2026-11-01T17:35:00.000Z", expired: false }],
        jobs: [
          { id: 8001, bot: 1, attempt: 1, startedAt: "2026-10-18T17:20:00.000Z", finishedAt: "2026-10-18T17:21:00.000Z" },
          { id: 8002, bot: 1, attempt: 2, startedAt: "2026-10-18T17:25:00.000Z", finishedAt: "2026-10-18T17:26:00.000Z" },
          { id: 8003, bot: 1, attempt: 3, startedAt: "2026-10-18T17:30:00.000Z", finishedAt: "2026-10-18T17:35:00.000Z" },
        ],
      }),
      catalogue,
      new Date("2026-10-18T17:36:00.000Z"),
    )
    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({ attempt: 1, result: "missing", infrastructure: "superseded", supersededBy: records[2].key, source: { jobId: 8001 } })
    expect(records[1]).toMatchObject({ attempt: 2, result: "missing", infrastructure: "superseded", supersededBy: records[2].key, source: { jobId: 8002 } })
    expect(records[2]).toMatchObject({ attempt: 3, result: "passed", infrastructure: "complete", source: { jobId: 8003 } })
  })

  it("retains an earlier preemption when a late restart is superseded", () => {
    const late = played(2, { run: { attempt: 2, superseded: true, skipped: { kind: "restarted-after-probed-game", expected: { index: 895, registrationEnds: 1 }, current: null } } })
    const input = merged([evidence(late, 7002, false)])
    input.rows = [{ bot: 1, result: late, videoLink: null, group: { kind: "unknown", label: "unknown (no roster read)", with: [] }, preemption: { attempt: 1, profile: planned.profile, detail: "private runner annotation" } }]
    const records = publicRunsFromMerged(
      input,
      metadata({
        attempt: 2,
        artifacts: [],
        jobs: [
          { id: 8001, bot: 1, attempt: 1, startedAt: "2026-10-18T17:20:00.000Z", finishedAt: "2026-10-18T17:21:00.000Z" },
          { id: 8002, bot: 1, attempt: 2, startedAt: "2026-10-18T17:25:00.000Z", finishedAt: "2026-10-18T17:26:00.000Z" },
        ],
      }),
      catalogue,
      new Date("2026-10-18T17:32:00.000Z"),
    )
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ attempt: 1, result: "inconclusive", infrastructure: "missing" })
    expect(records[1]).toMatchObject({ attempt: 2, result: "skipped", infrastructure: "superseded", supersededBy: records[0].key })
  })

  it("adds a missing current-attempt record without inventing artifact provenance", () => {
    const records = publicRunsFromMerged(merged([evidence(played(1), 7001)]), metadata({
      attempt: 2,
      artifacts: [],
      jobs: [{ id: 8002, bot: 1, attempt: 2, startedAt: "2026-10-18T17:30:00.000Z", finishedAt: "2026-10-18T17:31:00.000Z" }],
    }), catalogue, new Date("2026-10-18T17:32:00.000Z"))
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({ attempt: 2, artifactAttempt: null, result: "missing", productResult: "missing", infrastructure: "missing", source: { artifactId: null }, recording: { state: "missing" } })
  })

  it("does not invent a missing rerun record for a bot whose job was not rerun", () => {
    const records = publicRunsFromMerged(
      merged([evidence(played(1), 7001)]),
      metadata({ attempt: 2, jobs: metadata().jobs, artifacts: metadata().artifacts }),
      catalogue,
      new Date("2026-10-18T17:32:00.000Z"),
    )
    expect(records.map(({ attempt }) => attempt)).toEqual([1])
  })

  it("keeps an orphan late restart as missing evidence instead of dropping the bundle", () => {
    const late = played(2, { run: { attempt: 2, superseded: true, skipped: { kind: "restarted-after-probed-game", expected: { index: 895, registrationEnds: 1 }, current: null } } })
    const records = publicRunsFromMerged(
      merged([evidence(late, 7002, false)]),
      metadata({ attempt: 2, artifacts: [], jobs: [{ id: 8002, bot: 1, attempt: 2, startedAt: "2026-10-18T17:25:00.000Z", finishedAt: "2026-10-18T17:26:00.000Z" }] }),
      catalogue,
      new Date("2026-10-18T17:32:00.000Z"),
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ result: "missing", productResult: "missing", infrastructure: "missing", supersededBy: null })
  })

  it("distinguishes a proven runner preemption from wholly missing evidence", () => {
    const input = merged([])
    input.rows = [{ bot: 1, result: null, videoLink: null, group: { kind: "unknown", label: "unknown (no roster read)", with: [] }, preemption: { attempt: 1, profile: planned.profile, detail: "private runner annotation" } }]
    const [record] = publicRunsFromMerged(input, metadata({ artifacts: [], jobs: [] }), catalogue, new Date("2026-10-18T17:32:00.000Z"))
    expect(record).toMatchObject({ result: "inconclusive", productResult: "missing", infrastructure: "missing", artifactAttempt: null })
    expect(record.failures).toEqual(["The runner was preempted before it produced result evidence."])
    expect(JSON.stringify(record)).not.toContain("private runner annotation")
  })

  it("does not guess recording availability when upload or expiry metadata is absent", () => {
    const [record] = publicRunsFromMerged(
      merged([evidence(played(), 7001)]),
      metadata({ artifacts: [{ ...metadata().artifacts[0], uploadedAt: null, expiresAt: null }] }),
      catalogue,
      new Date("2026-10-18T17:32:00.000Z"),
    )
    expect(record.recording).toEqual({ state: "missing", artifactUrl: null, visibility: "organization", uploadedAt: null, expiresAt: null })
    expect(record).toMatchObject({ productResult: "passed", infrastructure: "partial", result: "inconclusive" })
  })

  it("keeps runner setup loss separate from the product verdict", () => {
    const result = played()
    result.stages.b.status = "fail"
    result.runnerOutcomes = [{ kind: "shared-network-setup-failed", detail: "private setup detail" }]
    const [record] = publicRunsFromMerged(merged([evidence(result, 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(record).toMatchObject({ result: "missing", productResult: "missing", infrastructure: "missing" })
    expect(record.failures).toContain("Shared runner network setup failed.")
    expect(record.failures).not.toContain("Stage (b) failed.")
  })

  it("never turns an explicit inconclusive product check into a public pass", () => {
    const result = played()
    result.inconclusive = [{ name: "private oracle name", detail: "E2E_SECRET_PRIVATE_DETAIL" }]
    const [record] = publicRunsFromMerged(merged([evidence(result, 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(record).toMatchObject({ result: "inconclusive", productResult: "inconclusive", infrastructure: "complete" })
    expect(record.failures).toContain("Product checks were inconclusive.")
    expect(JSON.stringify(record)).not.toContain("private oracle name")
    expect(JSON.stringify(record)).not.toContain("E2E_SECRET_PRIVATE_DETAIL")
  })

  it("marks a recording expired at the exact expiry boundary", () => {
    const [record] = publicRunsFromMerged(merged([evidence(played(), 7001)]), metadata(), catalogue, new Date("2026-11-01T17:25:00.000Z"))
    expect(record.recording.state).toBe("expired")
  })

  it("keeps legacy schema-v1 evidence explicit without inventing a timeline", () => {
    const legacy = { ...played(), version: 1 as const, narration: [] }
    const [record] = publicRunsFromMerged(merged([evidence(legacy, 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(record.timeline).toEqual([])
    expect(record.failures).toContain("Recording narration predates the public timeline contract.")
  })

  it("preserves an actual not-applied event without turning it into a failure", () => {
    const result = played()
    result.narration.splice(1, 0, {
      at: "2026-10-18T17:21:00.000Z",
      state: "not-applied",
      source: "network",
      action: "network.1",
      title: "Baseline",
      text: "This network challenge was not applied on this run.",
    })
    const [record] = publicRunsFromMerged(merged([evidence(result, 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(record.timeline.map(({ state }) => state)).toEqual(["preparing", "not-applied", "passed"])
    expect(record.productResult).toBe("passed")
  })

  it("publishes a named network-isolation recovery duration", () => {
    const result = played()
    result.expectedOutcome = {
      kind: "network-isolation",
      isolated: true,
      faultRecovered: true,
      isolationAt: "2026-10-18T17:21:00.000Z",
      blackout: { startedAt: "2026-10-18T17:21:00.000Z", recoveredAt: "2026-10-18T17:21:07.250Z" },
    }
    const [record] = publicRunsFromMerged(merged([evidence(result, 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(record.recovery).toContainEqual({ name: "network isolation recovery", milliseconds: 7_250 })
  })

  it("retains camera-unavailable as a successful expected terminal outcome", () => {
    const profile = loadProfiles().find(({ expectedOutcome }) => expectedOutcome?.kind === "camera-unavailable")!
    const scenario = catalogue.scenarios.find(({ profile: name }) => name === profile.name)!
    const identity = catalogue.identities.find(({ username }) => username === identityFor(profile, "previewnet"))!
    const expected = emptyResult(1, "account-one", identity.username, new Date("2026-10-18T17:20:01.000Z"), scenario.profile, { E2E_NETWORK: "previewnet", GITHUB_RUN_ATTEMPT: "1" })
    expected.stages.a.status = "pass"
    expected.stages.b.status = "skip"
    expected.stages.c.status = "skip"
    expected.stages.d.status = "skip"
    expected.expectedOutcome = { kind: "camera-unavailable", reason: "denied", helpShown: true, handedOver: false }
    expected.finishedAt = "2026-10-18T17:24:59.000Z"
    const publicMetadata = metadata({ planned: [{ bot: 1, profile: scenario.profile, identity: identity.username }] })
    const [record] = publicRunsFromMerged(merged([evidence(expected, 7001, true, publicMetadata.planned[0])]), publicMetadata, catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(record.productResult).toBe("passed")
  })

  it("never copies raw stage notes, guard evidence, source paths, or runner details", () => {
    const result = played()
    result.stages.c.status = "fail"
    result.stages.c.notes = ["E2E_SECRET_THAT_MUST_NOT_LEAK"]
    result.guards = [{ kind: "text", description: "expected recovery copy appeared", status: "fail", evidence: "Bearer ghp_ThisMustNotLeak1234567890" }]
    result.runnerOutcomes = [{ kind: "shared-network-cleanup-failed", detail: "/private/runner/path E2E_SECRET" }]
    const [record] = publicRunsFromMerged(merged([evidence(result, 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    const publicText = JSON.stringify(record)
    expect(publicText).not.toContain("E2E_SECRET")
    expect(publicText).not.toContain("Bearer")
    expect(publicText).not.toContain("/private/")
    expect(record.failures).toEqual(expect.arrayContaining(["A required product stage failed.", "A required product guard failed.", "Shared runner network cleanup failed."]))
    expect(record.failures).not.toContain("expected recovery copy appeared")
  })

  it("fails closed when named public data itself is unsafe", () => {
    const unsafeCatalogue = structuredClone(catalogue)
    unsafeCatalogue.scenarios.find(({ profile }) => profile === planned.profile)!.title = "E2E_SECRET_NAME"
    expect(() => publicRunsFromMerged(merged([evidence(played(), 7001)]), metadata(), unsafeCatalogue, new Date("2026-10-18T17:26:00.000Z"))).toThrow(/forbidden/)
  })

  it("emits a validated publication bundle", () => {
    const bundle = publicationBundleFromMerged(merged([evidence(played(), 7001)]), metadata(), catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(bundle).toMatchObject({ version: 1, runs: [{ result: "passed" }], suites: [] })
  })

  it("covers every current profile plus the reserved baseline in the public catalogue", () => {
    expect(catalogue.scenarios.map(({ profile }) => profile).sort()).toEqual(["baseline", ...loadProfiles().map(({ name }) => name)].sort())
  })

  it.each(catalogue.scenarios)("publishes complete and missing evidence for catalogue profile $profile", (scenario) => {
    const profile = loadProfiles().find(({ name }) => name === scenario.profile)
    // Harness-only profiles have no fixed crew identity: this synthetic identity exercises
    // their prose contract, not the runtime policy for attributing harness evidence.
    const identity = (profile && identityFor(profile, "previewnet")) ?? planned.identity
    const expectedPlan = { bot: 1, profile: scenario.profile, identity }
    const result = played(1, { profile: scenario.profile, username: identity })
    result.stages.c.status = "fail"
    result.guards = [{ kind: "text", description: "private guard description", status: "fail", evidence: "private evidence" }]
    result.narration = [null, ...Object.keys(scenario.actions)].flatMap((action) => NARRATION_STATES.map((state) => ({
      at: "2026-10-18T17:21:00.000Z",
      ...scenarioNarration(scenario, state, "journey", action),
    })))
    const publicMetadata = metadata({ planned: [expectedPlan] })
    const bundle = publicationBundleFromMerged(merged([evidence(result, 7001, true, expectedPlan)]), publicMetadata, catalogue, new Date("2026-10-18T17:26:00.000Z"))
    const [record] = bundle.runs
    expect(record.scenario).toEqual(scenario)
    expect(record.expected).toEqual([scenario.expected])
    expect(record.timeline.map(({ text }) => text)).toEqual(result.narration.map(({ text }) => text))
    expect(record).toMatchObject({ result: "failed", productResult: "failed" })
    expect(record.failures).toEqual(["A required product stage failed.", "A required product guard failed."])

    const missing = publicationBundleFromMerged(merged([]), publicMetadata, catalogue, new Date("2026-10-18T17:26:00.000Z"))
    expect(missing.runs[0]).toMatchObject({ scenario, expected: [scenario.expected], result: "missing", productResult: "missing" })
  })
})
