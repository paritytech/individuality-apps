// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { botsOfJobName, runnerUnavailable, type BotAttemptEvidence, type GatherVerdictReason, type Merged } from "../gather"
import type { GuardResult } from "../guards"
import { isNarrationTransportFailure } from "../narration"
import { attemptArtifactName, parseResultArtifactName, validateExecutionKey, type SlotResult } from "../result"
import type { CrewCatalogue, CrewIdentity, ScenarioPresentation } from "./catalogue"
import {
  recordingAt,
  validatePublicationBundle,
  validatePublicRunRecord,
  type CrewIdentitySnapshot,
  type PublicationBundle,
  type PublicRecording,
  type PublicRunRecord,
  type PublicTimelineEntry,
  type RunClassification,
  type ScenarioSnapshot,
} from "./run-record"

export interface PlannedPublicBot {
  bot: number
  profile: string
  identity: string
}

/** Heavy diagnostic artifact containing the receiver-side recording. */
export interface PublicArtifactMetadata {
  id: number
  name: string
  bot: number
  attempt: number
  uploadedAt: string | null
  expiresAt: string | null
  expired: boolean
}

export interface PublicJobMetadata {
  id: number
  bot: number
  attempt: number
  startedAt: string
  finishedAt: string
}

export interface ActionsArtifactMetadata {
  id: number
  name: string
  created_at?: string | null
  expires_at?: string | null
  expired?: boolean
}

export interface ActionsJobMetadata {
  id: number
  run_attempt: number
  name: string
  started_at?: string | null
  completed_at?: string | null
}

export interface PublicConversionMetadata {
  runId: number
  attempt: number
  executionKey: string
  suiteId: string | null
  wave: string | null
  classification: RunClassification
  repository: string
  ref: string
  commit: string
  actor: string
  workflowPath: string
  event: string
  defaultBranch: string
  startedAt: string
  finishedAt: string
  planned: PlannedPublicBot[]
  artifacts: PublicArtifactMetadata[]
  jobs: PublicJobMetadata[]
}

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")
const keyDigest = (value: string): string => createHash("sha256").update(value).digest("hex").match(/.{1,16}/g)!.join("-")

export function publicArtifactsFromActions(runId: number, artifacts: readonly ActionsArtifactMetadata[], executionKey: string): PublicArtifactMetadata[] {
  validateExecutionKey(executionKey)
  return artifacts.flatMap((artifact) => {
    const parsed = parseResultArtifactName(String(runId), `${artifact.name}-result`, executionKey)
    if (!parsed?.attempt || artifact.name !== attemptArtifactName(String(runId), parsed.bot, parsed.attempt, executionKey)) return []
    return [{
      id: artifact.id,
      name: artifact.name,
      bot: parsed.bot,
      attempt: parsed.attempt,
      uploadedAt: artifact.created_at ?? null,
      expiresAt: artifact.expires_at ?? null,
      expired: artifact.expired === true,
    }]
  })
}

export function publicJobsFromActions(jobs: readonly ActionsJobMetadata[], executionKey: string): PublicJobMetadata[] {
  validateExecutionKey(executionKey)
  return jobs.flatMap((job) => {
    if (!job.started_at || !job.completed_at) return []
    return botsOfJobName(job.name, executionKey).map((bot) => ({
      id: job.id,
      bot,
      attempt: job.run_attempt,
      startedAt: job.started_at!,
      finishedAt: job.completed_at!,
    }))
  })
}

export function runKey(
  runId: number,
  attempt: number,
  artifactAttempt: number | null,
  executionKey: string,
  identityKey: string,
  bot: number | null,
): string {
  const discriminator = keyDigest([executionKey, identityKey, bot ?? "harness"].join("\0"))
  return `r-${runId}-a-${attempt}-artifact-${artifactAttempt ?? "none"}-${discriminator}`
}

export function suiteKey(suiteId: string, runId: number): string {
  return `s-${runId}-${keyDigest(suiteId)}`
}

const identitySnapshot = (identity: CrewIdentity): CrewIdentitySnapshot => {
  const bytes = readFileSync(new URL(`./portraits/${identity.portrait}`, import.meta.url))
  const portraitSha256 = digest(bytes)
  return {
    key: identity.key,
    username: identity.username,
    displayName: identity.displayName,
    portraitFile: identity.portrait,
    portraitSha256,
    portraitPath: `assets/portraits/by-sha256/${portraitSha256}.webp`,
    tagline: identity.tagline,
    backstory: identity.backstory,
    speciality: identity.speciality,
    palette: {
      primary: identity.palette.primary,
      secondary: identity.palette.secondary,
      ink: identity.palette.ink,
    },
  }
}

const scenarioSnapshot = (scenario: ScenarioPresentation): ScenarioSnapshot => ({
  profile: scenario.profile,
  title: scenario.title,
  purpose: scenario.purpose,
  expected: scenario.expected,
  criteria: [...scenario.criteria],
  parameters: Object.fromEntries(Object.entries(scenario.parameters).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])),
  phases: {
    preparing: scenario.phases.preparing,
    verifying: scenario.phases.verifying,
    passed: scenario.phases.passed,
    failed: scenario.phases.failed,
  },
  actions: Object.fromEntries(Object.entries(scenario.actions).map(([key, action]) => [key, {
    active: action.active,
    ...(action.recovered === undefined ? {} : { recovered: action.recovered }),
    failed: action.failed,
  }])),
})

const diagnosticStatus = (status: GuardResult["status"]): "met" | "not-met" | "pending" => {
  if (status === "pass") return "met"
  if (status === "pending") return "pending"
  return "not-met"
}

const diagnosticDetail = (guard: GuardResult): string => {
  if (guard.status === "pending") return "This criterion is pending and was not evaluated."
  if (guard.status === "not-evaluated") {
    if (guard.kind === "devlog") return "No devLog lines were available, so this criterion was not met."
    if (guard.kind === "metric") return "No metric evidence was available, so this criterion was not met."
    if (guard.kind === "event") return "No event evidence was available, so this criterion was not met."
    if (guard.kind === "text" || guard.kind === "text-cleared-any") return "The page state could not be observed, so this criterion was not met."
    if (guard.kind === "chain-report") return "No complete chain evidence was available, so this criterion was not met."
    return "The evidence source was unavailable, so this criterion was not met."
  }
  const counts = guard.evidence.match(/^(\d+) matching of (\d+) (line\(s\)|point\(s\)|[^;]+ span\(s\))/)
  if (counts) {
    const matches = Number(counts[1])
    const total = Number(counts[2])
    if (guard.kind === "devlog") return `Observed ${matches} matching log ${matches === 1 ? "line" : "lines"} among ${total} captured ${total === 1 ? "line" : "lines"}.`
    if (guard.kind === "metric") return `Observed ${matches} matching metric ${matches === 1 ? "point" : "points"} among ${total} captured ${total === 1 ? "point" : "points"}.`
    return `Observed ${matches} matching ${matches === 1 ? "span" : "spans"} among ${total} captured ${total === 1 ? "span" : "spans"}.`
  }
  if (guard.kind === "text") {
    if (guard.status === "pass") return guard.evidence.startsWith("never appeared")
      ? "The prohibited text did not appear during page observation."
      : "The required page state was observed."
    return guard.evidence.includes("appeared on the page")
      ? "The prohibited text appeared during page observation."
      : "The required page state was not observed."
  }
  return guard.status === "pass"
    ? "The recorded evidence satisfied this criterion."
    : "The recorded evidence did not satisfy this criterion."
}

export const publicDiagnosticsFor = (result: SlotResult, scenario: ScenarioSnapshot): NonNullable<PublicRunRecord["diagnostics"]> => {
  const criteria = scenario.criteria ?? []
  const guards = result.guards ?? []
  if (guards.length > criteria.length) throw new Error(`${scenario.profile}: ${guards.length} guard results exceed ${criteria.length} public criteria`)
  return criteria.map((criterion, index) => {
    const guard = guards[index]
    return guard
      ? { criterion, status: diagnosticStatus(guard.status), detail: diagnosticDetail(guard) }
      : { criterion, status: "not-met", detail: "No criterion-level diagnostic was recorded." }
  })
}

const missingDiagnostics = (scenario: ScenarioSnapshot): NonNullable<PublicRunRecord["diagnostics"]> =>
  (scenario.criteria ?? []).map((criterion) => ({
    criterion,
    status: "not-met",
    detail: "No validated result artifact was available for this criterion.",
  }))

const jobFor = (metadata: PublicConversionMetadata, bot: number, attempt: number): PublicJobMetadata | null =>
  metadata.jobs.find((job) => job.bot === bot && job.attempt === attempt) ?? null

const heavyArtifactFor = (metadata: PublicConversionMetadata, bot: number, attempt: number): PublicArtifactMetadata | null =>
  metadata.artifacts.find((artifact) => artifact.bot === bot && artifact.attempt === attempt) ?? null

const recordingFor = (metadata: PublicConversionMetadata, bot: number, attempt: number, now: Date): PublicRecording => {
  const artifact = heavyArtifactFor(metadata, bot, attempt)
  if (!artifact || !artifact.uploadedAt || !artifact.expiresAt) {
    return { state: "missing", artifactUrl: null, visibility: "organization", uploadedAt: null, expiresAt: null }
  }
  const available: PublicRecording = {
    state: artifact.expired ? "expired" : "available",
    artifactUrl: `https://github.com/${metadata.repository}/actions/runs/${metadata.runId}/artifacts/${artifact.id}`,
    visibility: "organization",
    uploadedAt: artifact.uploadedAt,
    expiresAt: artifact.expiresAt,
  }
  return recordingAt(available, now)
}

const resultArtifactId = (attempt: BotAttemptEvidence): number | null => attempt.artifact?.id ?? null

const sourceFor = (
  metadata: PublicConversionMetadata,
  attempt: BotAttemptEvidence | null,
  job: PublicJobMetadata | null,
): PublicRunRecord["source"] => ({
  workflowPath: metadata.workflowPath,
  event: metadata.event,
  defaultBranch: metadata.defaultBranch,
  artifactId: attempt ? resultArtifactId(attempt) : null,
  jobId: job?.id ?? null,
})

const timelineText = (scenario: ScenarioSnapshot, state: PublicTimelineEntry["state"], action: string | null): string => {
  const presentation = action && Object.hasOwn(scenario.actions, action) ? scenario.actions[action] : undefined
  if (state === "preparing") return scenario.phases.preparing
  if (state === "active") return presentation?.active ?? scenario.purpose
  if (state === "recovered") return presentation?.recovered ?? scenario.phases.verifying
  if (state === "not-applied") return "This network challenge was not applied on this run."
  if (state === "verifying") return scenario.phases.verifying
  if (state === "passed") return scenario.phases.passed
  return presentation?.failed ?? scenario.phases.failed
}

const timelineFor = (result: SlotResult, scenario: ScenarioSnapshot): PublicTimelineEntry[] => {
  if (result.version === 1) return []
  return result.narration
    .filter((transition) => !isNarrationTransportFailure(transition))
    .map(({ at, state, source, action }) => {
      const safeAction = action && Object.hasOwn(scenario.actions, action) ? action : null
      return { at, state, source, action: safeAction, text: timelineText(scenario, state, safeAction) }
    })
    .sort((one, two) => Date.parse(one.at) - Date.parse(two.at))
}

const recoveryFor = (result: SlotResult): PublicRunRecord["recovery"] => {
  const recovery = (result.buildReloads ?? []).map(({ seconds }) => ({ name: "build reload", milliseconds: seconds * 1_000 }))
  const blackout = result.expectedOutcome?.kind === "network-isolation" ? result.expectedOutcome.blackout : undefined
  if (blackout) {
    const milliseconds = Date.parse(blackout.recoveredAt) - Date.parse(blackout.startedAt)
    if (Number.isFinite(milliseconds) && milliseconds >= 0) recovery.push({ name: "network isolation recovery", milliseconds })
  }
  return recovery
}

const REASON_TEXT: Record<GatherVerdictReason, string> = {
  "superseded-attempt": "This attempt was superseded for coverage.",
  "runner-setup-unavailable": "Shared runner setup evidence was unavailable.",
  "profile-mismatch": "Observed profile did not match the planned profile.",
  "identity-mismatch": "Observed identity did not match the planned identity.",
  "identity-unconfigured": "The planned identity was unavailable to gather.",
  "stage-failed": "A required product stage failed.",
  "guard-failed": "A required product guard failed.",
  "guard-incomplete": "A required product guard was not fully evaluated.",
  "typed-inconclusive": "Product checks were inconclusive.",
  "journey-incomplete": "The product journey did not produce complete settlement evidence.",
  "run-stage-failed": "At least one selected run stage failed.",
  "run-guard-failed": "At least one aggregate run guard failed.",
  "run-problem": "The aggregate run evidence had an integrity or coverage problem.",
  "run-inconclusive": "The aggregate run evidence was inconclusive.",
  "no-selected-evidence": "No selected bot evidence was available for the aggregate run.",
}

const namedFailures = (evidence: BotAttemptEvidence): string[] => {
  const failures = [...new Set(evidence.verdict.reasons)].map((reason) => REASON_TEXT[reason])
  for (const outcome of evidence.result.runnerOutcomes ?? []) {
    if (outcome.kind === "shared-registration-deadline-missed") failures.push("Shared runner missed the registration deadline.")
    if (outcome.kind === "shared-network-setup-failed") failures.push("Shared runner network setup failed.")
    if (outcome.kind === "shared-network-cleanup-failed") failures.push("Shared runner network cleanup failed.")
  }
  if (evidence.result.version === 1) failures.push("Recording narration predates the public timeline contract.")
  return [...new Set(failures)]
}

const classifyEvidence = (
  evidence: BotAttemptEvidence,
  hasJob: boolean,
  hasRecording: boolean,
): Pick<PublicRunRecord, "result" | "productResult" | "infrastructure"> => {
  const product = evidence.verdict.product
  if (product === "skipped") {
    return { result: "skipped", productResult: "missing", infrastructure: "superseded" }
  }
  const hasRunnerCleanupFailure = evidence.result.runnerOutcomes?.some(({ kind }) => kind === "shared-network-cleanup-failed") ?? false
  if (runnerUnavailable(evidence.result)) return { result: "missing", productResult: "missing", infrastructure: "missing" }
  const productResult = product
  const infrastructure = !hasJob
    ? "missing"
    : hasRunnerCleanupFailure || !hasRecording
      ? "partial"
      : "complete"
  const runResult = productResult === "failed"
    ? "failed"
    : productResult === "missing"
      ? "missing"
    : infrastructure === "missing"
      ? "missing"
      : productResult === "passed" && infrastructure === "complete"
        ? "passed"
        : "inconclusive"
  return { result: runResult, productResult, infrastructure }
}

const actionLinks = (metadata: PublicConversionMetadata, attempt: number, job: PublicJobMetadata | null): PublicRunRecord["links"] => [
  {
    label: `Workflow run attempt ${attempt}`,
    url: `https://github.com/${metadata.repository}/actions/runs/${metadata.runId}/attempts/${attempt}`,
    visibility: "organization",
  },
  ...(job ? [{
    label: `Bot ${job.bot} job`,
    url: `https://github.com/${metadata.repository}/actions/runs/${metadata.runId}/job/${job.id}`,
    visibility: "organization" as const,
  }] : []),
]

const evidenceRecord = (
  evidence: BotAttemptEvidence,
  planned: PlannedPublicBot,
  metadata: PublicConversionMetadata,
  identity: CrewIdentitySnapshot,
  scenario: ScenarioSnapshot,
  now: Date,
): PublicRunRecord => {
  const job = jobFor(metadata, planned.bot, evidence.attempt)
  const recording = evidence.artifact === null
    ? { state: "missing", artifactUrl: null, visibility: "organization", uploadedAt: null, expiresAt: null } satisfies PublicRecording
    : recordingFor(metadata, planned.bot, evidence.attempt, now)
  const classification = classifyEvidence(evidence, job !== null, recording.state !== "missing")
  const failures = namedFailures(evidence)
  if (evidence.artifact === null) failures.push("Result artifact provenance was unavailable.")
  if (job === null) failures.push("Actions job receipt was unavailable.")
  if (recording.state === "missing") failures.push("Receiver recording artifact metadata was unavailable.")
  const startedAt = job?.startedAt ?? evidence.result.startedAt ?? metadata.startedAt
  const finishedAt = job?.finishedAt ?? evidence.result.finishedAt ?? metadata.finishedAt
  return {
    version: 1,
    key: runKey(metadata.runId, evidence.attempt, evidence.artifact?.attempt ?? evidence.attempt, metadata.executionKey, identity.key, planned.bot),
    runId: metadata.runId,
    attempt: evidence.attempt,
    artifactAttempt: evidence.artifact === null ? null : (evidence.artifact.attempt ?? evidence.attempt),
    executionKey: metadata.executionKey,
    suiteId: metadata.suiteId,
    wave: metadata.wave,
    classification: metadata.classification,
    repository: metadata.repository,
    ref: metadata.ref,
    commit: metadata.commit,
    actor: metadata.actor,
    source: sourceFor(metadata, evidence, job),
    network: "previewnet",
    app: evidence.result.app?.app === "local" ? "local" : "deployed",
    game: evidence.result.game?.index ?? null,
    appCid: evidence.result.app?.cid ?? null,
    bot: planned.bot,
    identity,
    scenario,
    startedAt,
    finishedAt,
    ...classification,
    supersededBy: null,
    expected: [scenario.expected],
    diagnostics: publicDiagnosticsFor(evidence.result, scenario),
    timeline: timelineFor(evidence.result, scenario),
    recovery: recoveryFor(evidence.result),
    failures,
    links: actionLinks(metadata, evidence.attempt, job),
    recording,
  }
}

const missingRecord = (
  planned: PlannedPublicBot,
  metadata: PublicConversionMetadata,
  identity: CrewIdentitySnapshot,
  scenario: ScenarioSnapshot,
  attempt: number,
  preempted: boolean,
): PublicRunRecord => {
  const job = jobFor(metadata, planned.bot, attempt)
  return {
    version: 1,
    key: runKey(metadata.runId, attempt, null, metadata.executionKey, identity.key, planned.bot),
    runId: metadata.runId,
    attempt,
    artifactAttempt: null,
    executionKey: metadata.executionKey,
    suiteId: metadata.suiteId,
    wave: metadata.wave,
    classification: metadata.classification,
    repository: metadata.repository,
    ref: metadata.ref,
    commit: metadata.commit,
    actor: metadata.actor,
    source: sourceFor(metadata, null, job),
    network: "previewnet",
    app: "deployed",
    game: null,
    appCid: null,
    bot: planned.bot,
    identity,
    scenario,
    startedAt: job?.startedAt ?? metadata.startedAt,
    finishedAt: job?.finishedAt ?? metadata.finishedAt,
    result: preempted ? "inconclusive" : "missing",
    productResult: "missing",
    infrastructure: "missing",
    supersededBy: null,
    expected: [scenario.expected],
    diagnostics: missingDiagnostics(scenario),
    timeline: [],
    recovery: [],
    failures: [preempted ? "The runner was preempted before it produced result evidence." : "No validated result artifact was available for this planned bot."],
    links: actionLinks(metadata, attempt, job),
    recording: { state: "missing", artifactUrl: null, visibility: "organization", uploadedAt: null, expiresAt: null },
  }
}

export function publicRunsFromMerged(
  merged: Merged,
  metadata: PublicConversionMetadata,
  catalogue: CrewCatalogue,
  now: Date,
): PublicRunRecord[] {
  if (merged.network !== "previewnet") throw new Error(`public crew records require PreviewNet evidence, got ${merged.network}`)
  const plannedByBot = new Map(metadata.planned.map((planned) => [planned.bot, planned]))
  if (plannedByBot.size !== metadata.planned.length) throw new Error("publication metadata has duplicate planned bot numbers")
  for (const evidence of merged.attempts) if (!plannedByBot.has(evidence.bot)) throw new Error(`bot ${evidence.bot} was not present in the trusted publication plan`)

  const identities = new Map(catalogue.identities.map((identity) => [identity.username, identity]))
  const scenarios = new Map(catalogue.scenarios.map((scenario) => [scenario.profile, scenario]))
  const built: Array<{ record: PublicRunRecord; selected: boolean; explicitLate: boolean }> = []
  for (const planned of metadata.planned) {
    const identity = identities.get(planned.identity)
    const scenario = scenarios.get(planned.profile)
    if (!identity) throw new Error(`planned bot ${planned.bot} names an identity outside the public catalogue`)
    if (!scenario) throw new Error(`planned bot ${planned.bot} names a scenario outside the public catalogue`)
    const identityView = identitySnapshot(identity)
    const scenarioView = scenarioSnapshot(scenario)
    const evidence = merged.attempts.filter((attempt) => attempt.bot === planned.bot)
    const evidenceByAttempt = new Map<number, BotAttemptEvidence[]>()
    for (const item of evidence) evidenceByAttempt.set(item.attempt, [...(evidenceByAttempt.get(item.attempt) ?? []), item])
    const attempts = new Set<number>([
      ...metadata.jobs.filter((job) => job.bot === planned.bot).map((job) => job.attempt),
      ...evidence.map((item) => item.attempt),
    ])
    if (attempts.size === 0) attempts.add(metadata.attempt)
    const preemptedAttempt = merged.rows.find((row) => row.bot === planned.bot)?.preemption?.attempt
    for (const attempt of [...attempts].sort((one, two) => one - two)) {
      const attemptEvidence = evidenceByAttempt.get(attempt) ?? []
      if (attemptEvidence.length > 0) {
        for (const item of attemptEvidence) built.push({
          record: evidenceRecord(item, planned, metadata, identityView, scenarioView, now),
          selected: item.selected,
          explicitLate: item.verdict.product === "skipped",
        })
      } else {
        built.push({ record: missingRecord(planned, metadata, identityView, scenarioView, attempt, preemptedAttempt === attempt), selected: false, explicitLate: false })
      }
    }
  }

  for (const bot of metadata.planned.map(({ bot }) => bot)) {
    const history = built.filter(({ record }) => record.bot === bot).sort((one, two) => one.record.attempt - two.record.attempt || one.record.key.localeCompare(two.record.key))
    for (const item of history.filter(({ explicitLate }) => explicitLate)) {
      const earlier = history.filter((candidate) => !candidate.explicitLate && candidate.record.attempt < item.record.attempt).at(-1)
      if (earlier) {
        item.record.supersededBy = earlier.record.key
      } else {
        item.record.result = "missing"
        item.record.productResult = "missing"
        item.record.infrastructure = "missing"
        item.record.supersededBy = null
        item.record.failures.push("Earlier evidence for this late restart was unavailable.")
      }
    }
    for (const item of history.filter(({ record }) => record.infrastructure === "missing")) {
      const replacement = history.find((candidate) => candidate.selected
        && !candidate.explicitLate
        && candidate.record.attempt > item.record.attempt
        && candidate.record.infrastructure !== "missing"
        && candidate.record.infrastructure !== "superseded")
      if (!replacement) continue
      item.record.infrastructure = "superseded"
      item.record.supersededBy = replacement.record.key
    }
  }

  return built.map(({ record }) => record)
    .map(validatePublicRunRecord)
    .sort((one, two) => one.bot! - two.bot! || one.attempt - two.attempt || one.key.localeCompare(two.key))
}

export function publicationBundleFromMerged(
  merged: Merged,
  metadata: PublicConversionMetadata,
  catalogue: CrewCatalogue,
  now: Date,
): PublicationBundle {
  return validatePublicationBundle({ version: 1, runs: publicRunsFromMerged(merged, metadata, catalogue, now), suites: [] })
}
