// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { normalizeExecution, harnessBundle, reconcileHistoricalDiagnostics, selectPublicationBundle, writePublicationBundle, refreshSelectedGuards, canonicalActionsTimestamp } from "./workflow-publication"
import type { PublicationBundle, PublicRunRecord } from "./run-record"
import type { SlotResult } from "../result"

const run = JSON.parse(readFileSync(new URL("./fixtures/nightly-pass.json", import.meta.url), "utf8")) as PublicRunRecord
const source: PublicationBundle = { version: 1, runs: [run], suites: [] }
const metadata = {
  runId: 9, attempt: 1, repository: "paritytech/individuality-apps", ref: "refs/heads/main", commit: "a".repeat(40), actor: "tester",
  event: "workflow_dispatch", workflowPath: ".github/workflows/e2e-live.yml", defaultBranch: "main",
  startedAt: "2026-10-18T20:00:00.000Z", finishedAt: "2026-10-18T20:10:00.000Z",
}

describe("workflow publication I/O", () => {
  it("canonicalizes second-only Actions dates and rejects invalid timestamps", () => {
    expect(canonicalActionsTimestamp("2026-10-18T20:00:00Z")).toBe("2026-10-18T20:00:00.000Z")
    expect(canonicalActionsTimestamp("2026-10-18T20:00:00.123Z")).toBe("2026-10-18T20:00:00.123Z")
    expect(() => canonicalActionsTimestamp("invalid")).toThrow()
  })
  it("keeps native booleans and normalizes manual, called, and PR execution tuples", () => {
    expect(normalizeExecution("workflow_dispatch", { boot_only: false })).toMatchObject({ executionKey: "manual", classification: "manual", bootOnly: false, network: "previewnet" })
    expect(normalizeExecution("workflow_dispatch", { boot_only: true })).toMatchObject({ classification: "harness-check", bootOnly: true })
    expect(normalizeExecution("schedule", { execution_key: "wave-1", classification: "nightly", suite_id: "suite-9", suite_wave: "wave-1", roles: true })).toMatchObject({ executionKey: "wave-1", classification: "nightly", suiteId: "suite-9", wave: "wave-1" })
    expect(normalizeExecution("pull_request", {})).toMatchObject({ executionKey: "pr-boot", bootOnly: true, publish: false })
    expect(normalizeExecution("workflow_dispatch", { network: "paseo-next-v2" }).publish).toBe(false)
    for (const bad of [{ boot_only: "false" }, { roles: "true" }, { network: "unknown" }, { share: "bad" }, { execution_key: "../x" }, { execution_key: "wave-1" }, { execution_key: "wave-1", classification: "nightly", suite_id: "../bad" }])
      expect(() => normalizeExecution("workflow_dispatch", bad)).toThrow()
  })

  it("represents boot success/failure and missing gameplay as identity-free harness evidence", () => {
    const execution = normalizeExecution("workflow_dispatch", { boot_only: true })
    const passed = harnessBundle(metadata, execution, "success").runs[0]!
    expect(passed).toMatchObject({ identity: null, bot: null, classification: "harness-check", result: "passed", productResult: "missing", infrastructure: "complete" })
    expect(harnessBundle(metadata, execution, "failure").runs[0]).toMatchObject({ result: "failed", productResult: "missing" })
    expect(harnessBundle(metadata, normalizeExecution("workflow_dispatch", {}), "success").runs[0]).toMatchObject({ result: "missing", productResult: "missing", infrastructure: "missing" })
    expect(harnessBundle(metadata, execution, "cancelled").runs[0]).toMatchObject({ result: "inconclusive", productResult: "missing", infrastructure: "missing" })
  })

  it.each([
    { input: undefined, app: "deployed" },
    { input: "", app: "deployed" },
    { input: "dim2.testnet", app: "deployed" },
    { input: "local", app: "local" },
    { input: " LOCAL ", app: "local" },
  ])("preserves normalized app=$app for input $input in boot and early-failure fallback", ({ input, app }) => {
    const execution = normalizeExecution("workflow_dispatch", { app: input, boot_only: true, boot_profile: "check-stale-build" })
    expect(execution).toMatchObject({ app })
    expect(harnessBundle(metadata, execution, "success").runs[0]).toMatchObject({ app, result: "passed", productResult: "missing" })
    expect(harnessBundle(metadata, execution, "failure").runs[0]).toMatchObject({ app, result: "failed", productResult: "missing" })
    const gameplay = normalizeExecution("workflow_dispatch", { app: input })
    expect(harnessBundle(metadata, gameplay, "failure").runs[0]).toMatchObject({ app, result: "missing", productResult: "missing" })
  })

  it("rejects malformed app inputs before reporting an execution environment", () => {
    for (const app of [false, 1, null, "invalid", "dim2.paseo"])
      expect(() => normalizeExecution("workflow_dispatch", { app })).toThrow()
  })

  it("prefers a valid released recording without allowing it to rewrite product evidence or waves", () => {
    const released = structuredClone(source)
    released.runs[0]!.recording = { state: "missing", artifactUrl: null, uploadedAt: null, expiresAt: null, visibility: "organization" }
    expect(selectPublicationBundle(source, released)).toEqual(released)
    expect(selectPublicationBundle(source)).toEqual(source)
    const failed = structuredClone(source)
    failed.runs[0]!.result = "failed"
    failed.runs[0]!.productResult = "failed"
    expect(() => selectPublicationBundle(failed, source)).toThrow(/evidence/)
    for (const mutation of [ { productResult: "passed", result: "passed", failures: ["changed"] }, { executionKey: "another-wave" } ]) {
      const bad = structuredClone(released)
      Object.assign(bad.runs[0]!, mutation)
      expect(() => selectPublicationBundle(source, bad)).toThrow(/recording|evidence/)
    }
    expect(() => selectPublicationBundle(source, { version: 99 })).toThrow()
  })

  it("writes only a validated bundle plus referenced portrait bytes", () => {
    const out = mkdtempSync(join(tmpdir(), "crew-workflow-bundle-"))
    const harness = harnessBundle(metadata, normalizeExecution("workflow_dispatch", { boot_only: true }), "success")
    writePublicationBundle(out, harness)
    expect(JSON.parse(readFileSync(join(out, "publication-bundle.json"), "utf8"))).toEqual(harness)
    expect(existsSync(join(out, "assets"))).toBe(false)
  })

  it("reconciles legacy criteria from the exact result artifact without publishing raw evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "crew-historical-diagnostics-"))
    const legacyRun = structuredClone(run)
    legacyRun.scenario = { ...legacyRun.scenario! }
    delete legacyRun.scenario.criteria
    delete legacyRun.diagnostics
    const artifactDir = join(root, String(legacyRun.source.artifactId))
    mkdirSync(artifactDir)
    const result = {
      version: 1,
      stages: {},
      slot: legacyRun.bot,
      profile: legacyRun.scenario.profile,
      run: { id: String(legacyRun.runId), attempt: legacyRun.attempt },
      game: { index: legacyRun.game },
      provenance: { commit: legacyRun.commit },
      username: legacyRun.identity!.username,
      guards: [
        ...Array.from({ length: 6 }, (_, index) => ({ kind: "devlog", description: `log criterion ${index + 1}`, status: "not-evaluated", evidence: "SECRET raw log failure" })),
        ...Array.from({ length: 4 }, (_, index) => ({ kind: "text", description: `warning criterion ${index + 1}`, status: "pass", evidence: "never appeared (observer on every mutation)" })),
      ],
    }
    writeFileSync(join(artifactDir, `result-${legacyRun.bot}.json`), JSON.stringify(result))
    const reconciled = reconcileHistoricalDiagnostics({ version: 1, runs: [legacyRun], suites: [] }, root)
    expect(reconciled.runs[0]!.diagnostics).toHaveLength(10)
    expect(reconciled.runs[0]!.diagnostics?.filter(({ status }) => status === "not-met")).toHaveLength(6)
    expect(reconciled.runs[0]!.diagnostics?.filter(({ status }) => status === "met")).toHaveLength(4)
    expect(reconciled.runs[0]!.diagnostics?.[0]).toEqual({ criterion: "log criterion 1", status: "not-met", detail: "No devLog lines were available, so this criterion was not met." })
    expect(reconciled.runs[0]!.diagnostics?.[9]).toEqual({ criterion: "warning criterion 4", status: "met", detail: "The prohibited text did not appear during page observation." })
    expect(reconciled.runs[0]!.scenario?.criteria).toEqual(result.guards.map(({ description }) => description))
    expect(JSON.stringify(reconciled)).not.toContain("SECRET raw log failure")

    const current = structuredClone(reconciled)
    writeFileSync(join(artifactDir, `result-${legacyRun.bot}.json`), "not JSON")
    expect(reconcileHistoricalDiagnostics(current, root)).toEqual(current)
  })

  it("leaves missing historical result evidence unresolved and rejects mismatched evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "crew-historical-diagnostics-mismatch-"))
    const legacyRun = structuredClone(run)
    legacyRun.scenario = { ...legacyRun.scenario!, criteria: ["criterion"] }
    delete legacyRun.diagnostics
    const legacyBundle = { version: 1 as const, runs: [legacyRun], suites: [] }
    expect(reconcileHistoricalDiagnostics(legacyBundle, root).runs[0]!.diagnostics).toBeUndefined()

    const artifactDir = join(root, String(legacyRun.source.artifactId))
    mkdirSync(artifactDir)
    expect(() => reconcileHistoricalDiagnostics(legacyBundle, root)).toThrow(/missing result-/)
    const exact = {
      version: 1,
      stages: {},
      slot: legacyRun.bot, profile: legacyRun.scenario.profile,
      run: { id: String(legacyRun.runId), attempt: legacyRun.attempt }, game: { index: legacyRun.game },
      provenance: { commit: legacyRun.commit }, username: legacyRun.identity!.username,
      guards: [{ kind: "text", description: "criterion", status: "pass", evidence: "never appeared" }],
    }
    for (const bad of [
      { ...exact, slot: 99 },
      { ...exact, profile: "other" },
      { ...exact, run: { ...exact.run, id: "99" } },
      { ...exact, run: { ...exact.run, attempt: 99 } },
      { ...exact, game: { index: 99 } },
      { ...exact, provenance: { commit: "b".repeat(40) } },
      { ...exact, username: "another-player" },
      { ...exact, guards: [{ ...exact.guards[0], description: "other" }] },
    ]) {
      writeFileSync(join(artifactDir, `result-${legacyRun.bot}.json`), JSON.stringify(bad))
      expect(() => reconcileHistoricalDiagnostics(legacyBundle, root)).toThrow(/does not match/)
    }

    for (const malformed of [
      { ...exact, version: 3 },
      { ...exact, guards: [{ ...exact.guards[0], kind: "unknown" }] },
      { ...exact, guards: [{ ...exact.guards[0], status: "unknown" }] },
      { ...exact, guards: [{ ...exact.guards[0], evidence: 7 }] },
      { ...exact, guards: [{ ...exact.guards[0], evidence: "x".repeat(65_537) }] },
      { ...exact, guards: [{ ...exact.guards[0], raw: "not public" }] },
    ]) {
      writeFileSync(join(artifactDir, `result-${legacyRun.bot}.json`), JSON.stringify(malformed))
      expect(() => reconcileHistoricalDiagnostics(legacyBundle, root)).toThrow()
    }

    const withoutDeclaredCriteria = structuredClone(legacyRun)
    delete withoutDeclaredCriteria.scenario!.criteria
    writeFileSync(join(artifactDir, `result-${legacyRun.bot}.json`), JSON.stringify({ ...exact, guards: [] }))
    expect(reconcileHistoricalDiagnostics({ version: 1, runs: [withoutDeclaredCriteria], suites: [] }, root).runs[0]!.diagnostics).toBeUndefined()
  })

  it("emits an identity-free missing leaf when a non-harness suite wave has no gather bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "crew-missing-wave-"))
    const source = join(root, "source")
    const output = join(root, "output")
    mkdirSync(source)
    const result = spawnSync(process.execPath, ["--import", resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs"), resolve(__dirname, "workflow-publication-cli.mts"), "prepare", source, output], { encoding: "utf8", env: {
      ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch", CREW_INPUTS: JSON.stringify({ execution_key: "wave-02", classification: "manual", suite_id: "manual-suite-run-9", suite_wave: "wave-02" }),
      GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "2", GITHUB_REPOSITORY: "paritytech/individuality-apps", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40), GITHUB_ACTOR: "tester",
      E2E_PUBLIC_WORKFLOW_PATH: ".github/workflows/e2e-live-nightly.yml", E2E_DEFAULT_BRANCH: "main", E2E_PUBLIC_STARTED_AT: "2026-10-18T20:00:00Z", E2E_PUBLIC_FINISHED_AT: "2026-10-18T20:10:00Z", CREW_PLAY_CONCLUSION: "missing",
    } })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(output, "publication-bundle.json"), "utf8")).runs).toMatchObject([{ executionKey: "wave-02", suiteId: "manual-suite-run-9", result: "missing", infrastructure: "missing" }])
  })

  it("refreshes only exact selected guards and never upgrades an existing failed guard", () => {
    const original = { slot: 1, profile: "baseline", run: { attempt: 1 }, guards: [{ kind: "metric", description: "fps", status: "fail", evidence: "low" }] } as unknown as SlotResult
    const selected = { ...original, guards: [{ ...original.guards![0], status: "pass" }] } as SlotResult
    expect(refreshSelectedGuards(original, selected).guards![0]!.status).toBe("fail")
    const pending = { ...original, guards: [{ ...original.guards![0], status: "not-evaluated" }] } as SlotResult
    expect(refreshSelectedGuards(pending, original).guards![0]!.status).toBe("fail")
    expect(refreshSelectedGuards(pending, { ...original, run: { attempt: 2 } } as SlotResult)).toEqual(pending)
    expect(refreshSelectedGuards(pending, { ...original, profile: "other" })).toEqual(pending)
    expect(refreshSelectedGuards(pending, { ...original, slot: 2 })).toEqual(pending)
    expect(refreshSelectedGuards(pending, { ...original, run: { id: "other-run", attempt: 1 } })).toEqual(pending)
  })
})
