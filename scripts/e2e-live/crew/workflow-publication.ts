// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { normalizeSlotResult, validateExecutionKey, type SlotResult } from "../result"
import { LOCAL_APP, runTarget } from "../deployed-app"
import { GUARD_KINDS } from "../profile"
import { publicDiagnosticsFor, runKey } from "./publication"
import { RUN_CLASSIFICATIONS, validatePublicationBundle, type PublicationBundle, type RunClassification } from "./run-record"
import { portraitBytesFor } from "./site"
import type { Merged } from "../gather"
import type { PublicConversionMetadata } from "./publication"

/** Fresh people intentionally have no permanent public persona. */
export function seatPreparingBundle(merged: Merged, metadata: PublicConversionMetadata): PublicationBundle {
  if (metadata.planned.length !== 1 || metadata.planned[0].profile !== "check-seat-preparing") throw new Error("seat harness requires the isolated fresh-person check")
  const bundle = harnessBundle(metadata, { network: "previewnet", app: "deployed", bootOnly: false, executionKey: metadata.executionKey, classification: "harness-check", suiteId: metadata.suiteId, wave: metadata.wave, publish: true }, "missing")
  const record = bundle.runs[0]
  const selected = merged.attempts.filter((attempt) => attempt.selected && attempt.result.profile === "check-seat-preparing" && attempt.attempt === metadata.attempt)
  if (selected.length > 1) throw new Error("duplicate seat check evidence")
  const evidence = selected[0]
  if (evidence && evidence.verdict.product !== "missing" && evidence.verdict.product !== "skipped") {
    record.result = evidence.verdict.product === "failed" || merged.verdict.product === "failed" ? "failed"
      : evidence.verdict.product === "passed" && merged.verdict.product === "passed" ? "passed" : "inconclusive"
    record.infrastructure = "complete"
    record.game = evidence.result.game?.index ?? null
    record.appCid = evidence.result.app?.cid ?? null
    record.failures = record.result === "passed" ? [] : ["The isolated fresh-person seat check did not pass; inspect its workflow evidence."]
    const job = metadata.jobs.find((job) => job.bot === evidence.bot && job.attempt === evidence.attempt)
    record.source.jobId = job?.id ?? null
    record.startedAt = canonicalActionsTimestamp(job?.startedAt ?? evidence.result.startedAt)
    record.finishedAt = canonicalActionsTimestamp(job?.finishedAt ?? evidence.result.finishedAt ?? metadata.finishedAt)
    if (!job) record.infrastructure = "missing"
  }
  record.expected = ["A fresh person prepares its seat and completes the isolated game check."]
  return validatePublicationBundle(bundle)
}

export interface Execution {
  network: "previewnet" | "paseo-next-v2"
  app: "local" | "deployed"
  bootOnly: boolean
  executionKey: string
  classification: RunClassification
  suiteId: string | null
  wave: string | null
  publish: boolean
}

export function normalizeExecution(event: string, inputs: Record<string, unknown>): Execution {
  for (const key of ["boot_only", "roles", "flip_verdict", "aggregate_only", "diagnose", "clock_watch_fault", "telemetry", "game_log_to_sentry"])
    if (inputs[key] !== undefined && typeof inputs[key] !== "boolean") throw new Error(`${key} must be a native Boolean`)
  const network = inputs.network || "previewnet"
  if (network !== "previewnet" && network !== "paseo-next-v2") throw new Error("invalid network")
  if (inputs.app !== undefined && typeof inputs.app !== "string") throw new Error("app must be a string")
  const app = runTarget({ E2E_NETWORK: network, E2E_APP: inputs.app }).app === LOCAL_APP ? "local" : "deployed"
  if (inputs.share && !["off", "measure", "on"].includes(String(inputs.share))) throw new Error("invalid share mode")
  const bootOnly = event === "pull_request" || inputs.boot_only === true
  const executionKey = validateExecutionKey(event === "pull_request" ? "pr-boot" : String(inputs.execution_key || "manual"))
  const classification = inputs.execution_key ? inputs.classification : bootOnly ? "harness-check" : "manual"
  if (!RUN_CLASSIFICATIONS.includes(classification as RunClassification)) throw new Error("invalid classification")
  const identifier = (value: unknown): string | null => value ? validateExecutionKey(String(value)) : null
  return { network, app, bootOnly, executionKey, classification: classification as RunClassification, suiteId: identifier(inputs.suite_id), wave: identifier(inputs.suite_wave), publish: event !== "pull_request" && network === "previewnet" }
}

export interface WorkflowMetadata {
  runId: number
  attempt: number
  repository: string
  ref: string
  commit: string
  actor: string
  workflowPath: string
  event: string
  defaultBranch: string
  startedAt: string
  finishedAt: string
}

export function canonicalActionsTimestamp(value: string): string {
  const time = new Date(value)
  if (!Number.isFinite(time.getTime())) throw new Error("invalid Actions timestamp")
  return time.toISOString()
}

/** A harness record describes the run machinery, never an invented player result. */
export function harnessBundle(metadata: WorkflowMetadata, execution: Execution, playConclusion: string): PublicationBundle {
  const completedBoot = execution.bootOnly && ["success", "failure"].includes(playConclusion)
  const result = completedBoot ? playConclusion === "success" ? "passed" : "failed" : playConclusion === "cancelled" ? "inconclusive" : "missing"
  return validatePublicationBundle({ version: 1, suites: [], runs: [{
    version: 1, key: runKey(metadata.runId, metadata.attempt, null, execution.executionKey, "harness", null),
    runId: metadata.runId, attempt: metadata.attempt, artifactAttempt: null,
    executionKey: execution.executionKey, suiteId: execution.suiteId, wave: execution.wave,
    classification: "harness-check", repository: metadata.repository, ref: metadata.ref, commit: metadata.commit, actor: metadata.actor,
    source: { workflowPath: metadata.workflowPath, event: metadata.event, defaultBranch: metadata.defaultBranch, artifactId: null, jobId: null },
    network: "previewnet", app: execution.app, game: null, appCid: null, bot: null, identity: null, scenario: null,
    startedAt: canonicalActionsTimestamp(metadata.startedAt), finishedAt: canonicalActionsTimestamp(metadata.finishedAt), result, productResult: "missing", infrastructure: completedBoot ? "complete" : "missing", supersededBy: null,
    expected: [execution.bootOnly ? "Complete the hosted-player boot check." : "Collect validated player evidence for the requested execution."],
    timeline: [], recovery: [], failures: result === "passed" ? [] : [completedBoot ? "The hosted-player boot check failed." : "No validated player publication bundle was produced; inspect the workflow for the infrastructure outcome."],
    links: [{ label: "Workflow", url: `https://github.com/${metadata.repository}/actions/runs/${metadata.runId}`, visibility: "organization" }],
    recording: { state: "missing", artifactUrl: null, uploadedAt: null, expiresAt: null, visibility: "organization" },
  }] })
}

/** A release may enrich recordings; it cannot change an underlying test verdict. */
export function selectPublicationBundle(source: unknown, released?: unknown): PublicationBundle {
  const original = validatePublicationBundle(source)
  if (released === undefined) return original
  const candidate = validatePublicationBundle(released)
  const evidence = (bundle: PublicationBundle): string => JSON.stringify({
    ...bundle, runs: bundle.runs.map((run) => ({ ...run, recording: null })).sort((a, b) => a.key.localeCompare(b.key)),
  })
  if (evidence(original) !== evidence(candidate)) throw new Error("released bundle changes evidence outside recording fields")
  return candidate
}

/**
 * Older publication bundles predate public per-criterion diagnostics. Rebuild
 * only that public projection from the exact immutable result artifact named
 * by each record. Raw guard evidence never enters the Pages bundle.
 */
export function reconcileHistoricalDiagnostics(value: unknown, evidenceRoot: string): PublicationBundle {
  const bundle = validatePublicationBundle(value)
  const runs = bundle.runs.map((run) => {
    const declaredCriteria = run.scenario?.criteria
    if (run.diagnostics !== undefined || !run.scenario || declaredCriteria?.length === 0 || run.bot === null || run.source.artifactId === null) return run
    const mismatch = (detail: string): never => { throw new Error(`${run.key}: result artifact ${detail}`) }
    if (run.artifactAttempt === null || run.artifactAttempt !== run.attempt) mismatch("attempt receipt does not match the publication record")
    const artifactDir = join(evidenceRoot, String(run.source.artifactId))
    if (!existsSync(artifactDir)) return run
    const path = join(artifactDir, `result-${run.bot}.json`)
    if (!existsSync(path)) mismatch(`is missing result-${run.bot}.json`)
    const result = normalizeSlotResult(JSON.parse(readFileSync(path, "utf8")))
    if (result.slot !== run.bot) mismatch("slot does not match the publication record")
    if (result.profile !== run.scenario!.profile) mismatch("profile does not match the publication record")
    if (result.run?.id !== String(run.runId)) mismatch("run id does not match the publication record")
    if (result.run?.attempt !== run.attempt) mismatch("attempt does not match the publication record")
    if ((result.game?.index ?? null) !== run.game) mismatch("game does not match the publication record")
    if (result.provenance?.commit !== run.commit) mismatch("commit does not match the publication record")
    if (run.identity && result.username !== run.identity.username) mismatch("username does not match the publication record")
    if (!Array.isArray(result.guards) || result.guards.length > 1_000) mismatch("does not contain a bounded guard list")
    const guardKinds = new Set<string>(GUARD_KINDS)
    const guardStatuses = new Set<string>(["pass", "fail", "pending", "not-evaluated"])
    const bounded = (field: string, value: unknown, max: number): string => {
      if (typeof value !== "string" || !value.trim() || value.length > max) mismatch(`${field} must be a non-empty string of at most ${max} characters`)
      return value as string
    }
    for (const [index, rawGuard] of result.guards.entries()) {
      if (!rawGuard || typeof rawGuard !== "object" || Array.isArray(rawGuard)) mismatch(`guard ${index + 1} must be an object`)
      const guard = rawGuard as unknown as Record<string, unknown>
      if (Object.keys(guard).some((key) => !["kind", "description", "status", "evidence", "note"].includes(key))) mismatch(`guard ${index + 1} has unsupported fields`)
      if (typeof guard.kind !== "string" || !guardKinds.has(guard.kind)) mismatch(`guard ${index + 1} has an unsupported kind`)
      if (typeof guard.status !== "string" || !guardStatuses.has(guard.status)) mismatch(`guard ${index + 1} has an unsupported status`)
      bounded(`guard ${index + 1} description`, guard.description, 2_048)
      bounded(`guard ${index + 1} evidence`, guard.evidence, 65_536)
      if (guard.note !== undefined) bounded(`guard ${index + 1} note`, guard.note, 2_048)
    }
    if (declaredCriteria === undefined && result.guards.length === 0) return run
    const criteria = declaredCriteria ?? result.guards.map((guard) => guard.description)
    if (result.guards.length !== criteria.length) mismatch("guard count does not match the public criteria")
    for (const [index, criterion] of criteria.entries()) {
      if (result.guards[index]?.description !== criterion) mismatch(`guard ${index + 1} does not match the public criterion`)
    }
    const scenario = { ...run.scenario, criteria }
    return { ...run, scenario, diagnostics: publicDiagnosticsFor(result, scenario) }
  })
  return validatePublicationBundle({ ...bundle, runs })
}

export function writePublicationBundle(outputDir: string, value: unknown, portraitSourceDir = outputDir): void {
  const bundle = validatePublicationBundle(value)
  const portraits = bundle.runs.filter((run) => run.identity).map((run) => ({
    path: run.identity!.portraitPath,
    bytes: portraitBytesFor({ stateDir: outputDir, portraitSourceDir, portraitDir: new URL("./portraits/", import.meta.url) }, run),
  }))
  mkdirSync(outputDir, { recursive: true })
  for (const portrait of portraits) {
    const path = join(outputDir, portrait.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, portrait.bytes)
  }
  writeFileSync(join(outputDir, "publication-bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`)
}

/** Only the exact selected artifact receives post-game Sentry guard evidence. */
export function refreshSelectedGuards(original: SlotResult, selected: SlotResult): SlotResult {
  if (original.slot !== selected.slot || original.profile !== selected.profile || original.run?.id !== selected.run?.id || original.run?.attempt !== selected.run?.attempt || !original.run?.attempt) return original
  if (!selected.guards) return original
  const guards = selected.guards.map((guard, index) => {
    const old = original.guards?.[index]
    if (old && (old.kind !== guard.kind || old.description !== guard.description)) throw new Error("selected guard shape changed")
    return old?.status === "fail" ? old : guard
  })
  if (original.guards && original.guards.length !== guards.length) throw new Error("selected guard count changed")
  return { ...original, guards }
}

export function refreshSelectedGuardText(text: string, selectedDir: string): string {
  let original: SlotResult
  try { original = JSON.parse(text) as SlotResult } catch { return text }
  if (!original || typeof original.slot !== "number") return text
  const path = join(selectedDir, `result-${original.slot}.json`)
  if (!existsSync(path)) return text
  return JSON.stringify(refreshSelectedGuards(original, JSON.parse(readFileSync(path, "utf8")) as SlotResult))
}
