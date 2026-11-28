// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import catastrophicFixture from "./fixtures/suite-catastrophic.json"
import completedFixture from "./fixtures/suite-completed.json"
import runFixture from "./fixtures/nightly-pass.json"
import startedFixture from "./fixtures/suite-started.json"
import {
  recordingAt,
  scanPublicValue,
  validatePublicationBundle,
  validatePublicRunRecord,
  validatePublicSuiteRecord,
  type PublicRunRecord,
  type PublicSuiteRecord,
} from "./run-record"

const clone = <T>(value: T): T => structuredClone(value)
const run = (): PublicRunRecord => clone(runFixture) as PublicRunRecord
const suite = (value: unknown = completedFixture): PublicSuiteRecord => clone(value) as PublicSuiteRecord

const runVariants = (): Array<[string, PublicRunRecord]> => {
  const manualFailure = run()
  manualFailure.key = "run-39147986065-a1-art1-manual-captain-baseline-b1"
  manualFailure.executionKey = "manual"
  manualFailure.suiteId = null
  manualFailure.wave = null
  manualFailure.classification = "manual"
  manualFailure.result = "failed"
  manualFailure.productResult = "failed"
  manualFailure.failures = ["The report guard failed."]
  manualFailure.timeline.at(-1)!.state = "failed"

  const branch = run()
  branch.key = "run-39147986066-a1-art1-branch-captain-baseline-b1"
  branch.runId += 1
  branch.executionKey = "branch"
  branch.suiteId = null
  branch.wave = null
  branch.classification = "branch"
  branch.ref = "refs/heads/codex/example"

  const harness = run()
  harness.key = "run-39147986067-a1-art1-harness-harness-b0"
  harness.runId += 2
  harness.executionKey = "harness"
  harness.suiteId = null
  harness.wave = null
  harness.classification = "harness-check"
  harness.bot = null
  harness.identity = null
  harness.game = null
  harness.scenario = null
  harness.expected = ["The harness boot check completes."]

  const rerun = run()
  rerun.key = "run-39147986065-a2-art2-wave-all-captain-baseline-b1"
  rerun.attempt = 2
  rerun.artifactAttempt = 2

  const late = clone(rerun)
  late.key = "run-39147986065-a2-art2-wave-all-late-captain-baseline-b1"
  late.executionKey = "wave-all-late"
  late.result = "skipped"
  late.productResult = "missing"
  late.infrastructure = "superseded"
  late.supersededBy = runFixture.key
  late.failures = ["Attempt started after the chain-derived report window."]

  const partial = run()
  partial.key = "run-39147986068-a1-art1-wave-all-packet-jack-b2"
  partial.runId += 3
  partial.result = "inconclusive"
  partial.productResult = "inconclusive"
  partial.infrastructure = "partial"
  partial.recording = { state: "missing", artifactUrl: null, visibility: "organization", uploadedAt: null, expiresAt: null }
  partial.failures = ["Runner was preempted after meaningful evidence was saved."]

  const missing = run()
  missing.key = "run-39147986069-a1-noartifact-wave-all-null-nancy-b3"
  missing.runId += 4
  missing.artifactAttempt = null
  missing.source.artifactId = null
  missing.result = "missing"
  missing.productResult = "missing"
  missing.infrastructure = "missing"
  missing.timeline = []
  missing.recording = { state: "missing", artifactUrl: null, visibility: "organization", uploadedAt: null, expiresAt: null }
  missing.failures = ["No result artifact arrived for the planned player."]

  return [
    ["nightly pass", run()],
    ["manual failure", manualFailure],
    ["branch run", branch],
    ["harness check", harness],
    ["rerun attempt 2", rerun],
    ["late superseded rerun", late],
    ["partial runner", partial],
    ["missing runner", missing],
  ]
}

describe("public run records", () => {
  it.each(runVariants())("accepts the complete %s fixture", (_name, value) => {
    expect(validatePublicRunRecord(value)).toEqual(value)
  })

  it("rejects every missing top-level required field", () => {
    for (const field of Object.keys(run())) {
      const value = run() as unknown as Record<string, unknown>
      delete value[field]
      expect(() => validatePublicRunRecord(value), field).toThrow(/field|needs|required/i)
    }
  })

  it("rejects unknown nested fields and invalid enums", () => {
    const unknown = run() as unknown as { identity: Record<string, unknown> }
    unknown.identity.secretAlias = "ordinary"
    expect(() => validatePublicRunRecord(unknown)).toThrow(/field|secret/i)

    const wrongResult = run() as unknown as { result: string }
    wrongResult.result = "green"
    expect(() => validatePublicRunRecord(wrongResult)).toThrow(/result/i)

    const wrongNetwork = run() as unknown as { network: string }
    wrongNetwork.network = "paseo-next-v2"
    expect(() => validatePublicRunRecord(wrongNetwork)).toThrow(/network|previewnet/i)
  })

  it("rejects invalid chronology and unsafe links", () => {
    const invalidIso = run()
    invalidIso.startedAt = "18 October"
    expect(() => validatePublicRunRecord(invalidIso)).toThrow(/timestamp|ISO|started/i)

    const reversed = run()
    reversed.finishedAt = "2026-10-18T17:19:59.999Z"
    expect(() => validatePublicRunRecord(reversed)).toThrow(/before|chronology|finished/i)

    const unsafe = run()
    unsafe.links[0]!.url = "javascript:alert(1)"
    expect(() => validatePublicRunRecord(unsafe)).toThrow(/URL|https/i)

    const caseMismatch = run()
    caseMismatch.links[0] = {
      label: "Workflow",
      url: "https://github.com/ParityTech/Individuality-Apps/actions/runs/39147986065",
      visibility: "public",
    }
    expect(() => validatePublicRunRecord(caseMismatch)).toThrow(/private repository|organization/i)

    const externalRecording = run()
    externalRecording.recording.artifactUrl = "https://example.com/recording.webm"
    expect(() => validatePublicRunRecord(externalRecording)).toThrow(/recording|GitHub|artifact/i)
  })

  it("retains the truthful not-applied narration state", () => {
    const value = run()
    value.timeline.splice(1, 0, {
      at: "2026-10-18T17:25:00.000Z",
      state: "not-applied",
      source: "network",
      action: "network.1",
      text: "This network challenge was not applied on this run.",
    })
    expect(validatePublicRunRecord(value).timeline[1]?.state).toBe("not-applied")
  })

  it.each(["scenario.expected", "run.expected"])("bounds %s at 2048 characters and scans the entire text", (field) => {
    const withExpectation = (text: string): PublicRunRecord => {
      const value = run()
      if (field === "scenario.expected") value.scenario!.expected = text
      else value.expected = [text]
      return value
    }
    const boundary = withExpectation("z".repeat(2_048))
    expect(validatePublicRunRecord(boundary)).toEqual(boundary)
    expect(() => validatePublicRunRecord(withExpectation("z".repeat(2_049)))).toThrow(/at most 2048 characters/)
    expect(() => validatePublicRunRecord(withExpectation(`${"z".repeat(1_400)} E2E_PRIVATE_VALUE`))).toThrow(/forbidden/)
  })

  it("accepts legacy records and validates criterion diagnostics by position", () => {
    const legacy = run()
    expect(legacy.scenario?.criteria).toBeUndefined()
    expect(legacy.diagnostics).toBeUndefined()
    expect(validatePublicRunRecord(legacy)).toEqual(legacy)

    const current = run()
    current.scenario!.criteria = ["first criterion", "second criterion"]
    current.diagnostics = [
      { criterion: "first criterion", status: "met", detail: "1 matching log line." },
      { criterion: "second criterion", status: "not-met", detail: "0 matching log lines." },
    ]
    expect(validatePublicRunRecord(current)).toEqual(current)
    current.diagnostics[1]!.criterion = "different criterion"
    expect(() => validatePublicRunRecord(current)).toThrow(/same index/)
  })

  it("keeps sibling prose, key, URL and entry-count limits unchanged", () => {
    const tooLong: Array<(value: PublicRunRecord) => void> = [
      (value) => { value.scenario!.purpose = "z".repeat(1_001) },
      (value) => { value.scenario!.phases.failed = "z".repeat(1_001) },
      (value) => { value.scenario!.actions.example = { active: "z".repeat(1_001), failed: "Failed." } },
      (value) => { value.timeline[0]!.text = "z".repeat(1_001) },
      (value) => { value.timeline[0]!.detail = "z".repeat(1_001) },
      (value) => { value.failures = ["z".repeat(501)] },
      (value) => { value.key = "z".repeat(181) },
      (value) => { value.links[0]!.url = `https://example.com/${"z".repeat(2_048)}` },
      (value) => { value.expected = Array.from({ length: 1_001 }, () => "Expected.") },
    ]
    for (const mutate of tooLong) {
      const value = run()
      mutate(value)
      expect(() => validatePublicRunRecord(value)).toThrow(/at most/)
    }
  })
})

describe("public suite records", () => {
  it.each([
    ["trusted started", suite(startedFixture)],
    ["completed", suite(completedFixture)],
    ["catastrophic before planning", suite(catastrophicFixture)],
  ])("accepts the %s fixture", (_name, value) => {
    expect(validatePublicSuiteRecord(value)).toEqual(value)
  })

  it("enforces started, normal-completed, and catastrophic-completed shapes", () => {
    const started = suite(startedFixture)
    started.finishedAt = "2026-10-18T01:18:00.000Z"
    expect(() => validatePublicSuiteRecord(started)).toThrow(/started|finished/i)

    const completed = suite(completedFixture)
    completed.planStatus = "provisional"
    expect(() => validatePublicSuiteRecord(completed)).toThrow(/completed|plan/i)

    const catastrophic = suite(catastrophicFixture)
    catastrophic.failures = []
    expect(() => validatePublicSuiteRecord(catastrophic)).toThrow(/failure|catastrophic|unavailable/i)
  })

  it("validates a complete publication bundle and rejects unknown fields", () => {
    const bundle = { version: 1 as const, runs: runVariants().map(([, value]) => value), suites: [suite(completedFixture), suite(catastrophicFixture)] }
    expect(validatePublicationBundle(bundle)).toEqual(bundle)
    expect(() => validatePublicationBundle({ ...bundle, environment: {} })).toThrow(/field/i)
  })
})

describe("recording expiry", () => {
  const uploadedAt = "2026-10-18T17:34:00.000Z"
  const expiresAt = "2026-11-01T17:34:00.000Z"
  const available = (): PublicRunRecord["recording"] => ({
    state: "available",
    artifactUrl: "https://github.com/paritytech/individuality-apps/actions/runs/39147986065/artifacts/424242",
    visibility: "organization",
    uploadedAt,
    expiresAt,
  })

  it("expires at the exact API timestamp", () => {
    expect(recordingAt(available(), new Date("2026-11-01T17:33:59.999Z")).state).toBe("available")
    expect(recordingAt(available(), new Date(expiresAt)).state).toBe("expired")
    expect(recordingAt(available(), new Date("2026-11-01T17:34:00.001Z")).state).toBe("expired")
  })

  it("keeps a missing upload distinct forever and rejects invented availability", () => {
    const missing = { state: "missing", artifactUrl: null, visibility: "organization", uploadedAt: null, expiresAt: null } as const
    expect(recordingAt(missing, new Date("2036-01-01T00:00:00.000Z"))).toEqual(missing)
    expect(() => validatePublicRunRecord({ ...run(), recording: { ...available(), artifactUrl: null } })).toThrow(/recording|artifact/i)
  })
})

describe("public-value safety", () => {
  it.each([
    { mnemonic: "abandon ability able about above absent absorb abstract absurd abuse access accident" },
    { seed: "0x0123456789abcdef" },
    { private_key: "ordinary" },
    { authorization: "Bearer abcdefghijklmnop" },
    { cookie: "session=ordinary" },
    { token: "ordinary" },
    { password: "ordinary" },
    { sentry_dsn: "https://example.invalid/1" },
    { turn_username: "ordinary" },
    { turn_credential: "ordinary" },
    "-----BEGIN PRIVATE KEY-----\nnot-public\n-----END PRIVATE KEY-----",
  ])("rejects credential-shaped public data", (value) => {
    expect(() => scanPublicValue(value)).toThrow(/forbidden|secret|credential|mnemonic|private/i)
  })

  it("allows ordinary public identifiers and the approved TURN-token wording", () => {
    expect(() => scanPublicValue({
      username: "jollityeea.09",
      commit: "9159e61d4baf4f6f5bac1a1764f25930f65f2aea",
      workflow: "https://github.com/paritytech/individuality-apps/actions/runs/39147986065",
      failure: "The player did not settle before the report window ended.",
      title: "TURN token lifetime recovery",
    })).not.toThrow()
  })
})
