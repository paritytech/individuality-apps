// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The gather job's I/O shell around gather.ts: read every runner's artifact,
// write ONE summary, say whether the game counts as played.
//
//   npx tsx scripts/e2e-live/gather-cli.mts <dir of downloaded artifacts>
//
// Env: BOTS (the dispatch input: a count, six-roles or a JSON list of profile names / {bot, profile}),
// E2E_NETWORK (previewnet default) and E2E_IDENTITIES (that network's pool, JSON {username: account}: botMatrix resolves each bot's profile to its
// identity, and the paired username is checked against it), RUN_URL, RUN_ID, ARTIFACTS_JSON (optional: the
// `gh api …/runs/<id>/artifacts` listing, for direct video links), JOBS_JSON and JOB_ANNOTATIONS_JSON (optional:
// read-only GitHub job/check evidence used to distinguish a lost self-hosted runner from an ordinary missing result),
// GITHUB_OUTPUT / GITHUB_STEP_SUMMARY. Prints the summary too.
// Workflow layout: <dir>/artifact-<immutable-id>/result-<n>.json, bound to the
// encoded bot/attempt in RESULT_ACQUISITION_JSON. Desk runs without that report
// retain recursive compatibility with download-artifact layouts. Only the small
// result artifacts are downloaded; the selected attempt's heavy artifact holds
// the video linked by the summary (names: result.ts).
// Writes `all_played=true|false`; exits 1 unless every bot played and settled with no failed stage or guard.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, join, relative } from "node:path"
import { mergeResults, renderSummary, type RawResult, type RunEvidence, type RunJobEvidence } from "./gather"
import { parseResultArtifactIdentity, parseResultArtifactName, validateExecutionKey, resultFile } from "./result"
import { identityFor, loadProfiles } from "./profile"
import { DEFAULT_PROFILE, personaSchedule } from "./profiles"
import { parseFreshPool } from "./fresh-pool"
import { parseIdentities } from "./players"
import { botMatrix } from "./timing"
import { parseNamedProofs } from "./proof-preflight"
import type { RunnerGroupManifestEntry } from "./runner-group"
import { networkFromEnv } from "../lib/host-slot.mjs"
import { loadCrewCatalogue } from "./crew/catalogue"
import { publicationBundleFromMerged, publicArtifactsFromActions, publicJobsFromActions, type ActionsArtifactMetadata, type PublicConversionMetadata } from "./crew/publication"
import { RUN_CLASSIFICATIONS, type RunClassification } from "./crew/run-record"
import { canonicalActionsTimestamp, refreshSelectedGuardText, seatPreparingBundle } from "./crew/workflow-publication"

const dir = process.argv[2]
const selectedDir = process.argv[3]
if (!dir) {
  console.error("usage: gather-cli.mts <dir of downloaded artifacts> [selected-results-dir]")
  process.exit(2)
}
const runId = process.env.RUN_ID ?? "0"
const executionKey = validateExecutionKey(process.env.E2E_EXECUTION_KEY ?? "manual")
// The artifact boundary and public record must describe the same execution.
if (process.env.E2E_PUBLIC_EXECUTION_KEY && process.env.E2E_PUBLIC_EXECUTION_KEY !== executionKey)
  throw new Error("E2E_PUBLIC_EXECUTION_KEY disagrees with E2E_EXECUTION_KEY")
const suiteId = process.env.E2E_PUBLIC_SUITE_ID?.trim() || null
const wave = process.env.E2E_PUBLIC_WAVE?.trim() || null
if (suiteId) validateExecutionKey(suiteId)
if (wave) validateExecutionKey(wave)
const runUrl = process.env.RUN_URL ?? ""
const network = networkFromEnv()
const rawBots = (process.env.BOTS ?? "").trim()
const rotationRun = rawBots === "rotate" ? Number(process.env.E2E_ROTATION_RUN) : undefined
const rotationHalf = rawBots === "rotate" ? process.env.E2E_ROTATION_HALF as "A" | "B" | undefined : undefined
if (rawBots === "rotate" && rotationHalf !== "A" && rotationHalf !== "B") throw new Error(`rotate needs E2E_ROTATION_HALF=A or B (got ${String(rotationHalf)})`)
// the fresh persons the probe drew (a run binds them, so they are no longer "unbound" on the chain): resolved like pool identities
const drawnFresh = parseFreshPool(process.env.E2E_FRESH_DRAWN)
const matrix = botMatrix(process.env.BOTS, undefined, undefined, parseIdentities(process.env.E2E_IDENTITIES), network, rotationRun, rotationHalf, Object.keys(drawnFresh))
const rotation = rawBots === "rotate" ? personaSchedule(network, rotationRun, undefined, rotationHalf) : undefined
const bots = matrix.map((e) => e.bot)
let runnerGroups: RunnerGroupManifestEntry[] | undefined
if (process.env.E2E_RUNNER_GROUPS) {
  const parsed = JSON.parse(process.env.E2E_RUNNER_GROUPS) as unknown
  if (!Array.isArray(parsed)) throw new Error("E2E_RUNNER_GROUPS must be the probe's JSON group manifest")
  runnerGroups = parsed as RunnerGroupManifestEntry[]
}

// A missing dir is not an error: every bot then reads "no result-<n>.json
// arrived" in the merge, which is the per-bot answer a desk run wants.
const filesNamed = (root: string, wanted: string): string[] =>
  !existsSync(root) ? [] : readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    return statSync(path).isDirectory()
      ? filesNamed(path, wanted)
      : basename(path) === wanted
        ? [path]
        : []
  })

let artifacts: ActionsArtifactMetadata[] | undefined
if (process.env.ARTIFACTS_JSON && existsSync(process.env.ARTIFACTS_JSON)) {
  try {
    const list = JSON.parse(readFileSync(process.env.ARTIFACTS_JSON, "utf8")) as { artifacts?: ActionsArtifactMetadata[] }
    artifacts = list.artifacts
  } catch {
    /* links fall back to the run page */
  }
}

const acquisitionProblems: string[] = []
let acquiredResults: { id: number; name: string; downloaded: boolean }[] | undefined
if (process.env.RESULT_ACQUISITION_JSON) {
  if (!existsSync(process.env.RESULT_ACQUISITION_JSON)) {
    acquisitionProblems.push("result artifact acquisition report is missing")
  } else {
    try {
      const report = JSON.parse(readFileSync(process.env.RESULT_ACQUISITION_JSON, "utf8")) as {
        artifactListingComplete?: boolean
        results?: { id: number; name: string; downloaded: boolean }[]
      }
      if (report.artifactListingComplete !== true)
        acquisitionProblems.push("result artifact listing was incomplete")
      if (!Array.isArray(report.results) || !report.results.every((result) =>
        Number.isSafeInteger(result.id) && typeof result.name === "string" && typeof result.downloaded === "boolean"))
        throw new Error("invalid result acquisition schema")
      acquiredResults = report.results.filter((result) => {
        const identity = parseResultArtifactIdentity(runId, result.name)
        return !identity || identity.executionKey === executionKey
      })
      for (const result of acquiredResults)
        if (result.downloaded !== true)
          acquisitionProblems.push(`result artifact ${result.name} (${result.id}) could not be downloaded completely`)
    } catch {
      acquisitionProblems.push("result artifact acquisition report is not valid JSON")
    }
  }
}

const raws: RawResult[] = []
if (process.env.RESULT_ACQUISITION_JSON) {
  for (const artifact of acquiredResults ?? []) {
    if (!artifact.downloaded) continue
    const provenance = parseResultArtifactName(runId, artifact.name, executionKey)
    if (!provenance) {
      acquisitionProblems.push(`result artifact ${artifact.name} (${artifact.id}) has an invalid provenance name`)
      continue
    }
    const file = join(dir, `artifact-${artifact.id}`, resultFile(provenance.bot))
    if (!existsSync(file)) {
      acquisitionProblems.push(`result artifact ${artifact.name} (${artifact.id}) did not contain ${resultFile(provenance.bot)}`)
      continue
    }
    raws.push({
      source: relative(dir, file),
      text: readFileSync(file, "utf8"),
      artifact: { id: artifact.id, name: artifact.name, bot: provenance.bot, attempt: provenance.attempt },
    })
  }
} else {
  // Desk/local compatibility: there is no immutable GitHub acquisition
  // report, so read the old download-artifact layout recursively.
  for (const bot of bots) {
    for (const file of filesNamed(dir, resultFile(bot)))
      raws.push({ source: relative(dir, file), text: readFileSync(file, "utf8") })
  }
}

let runEvidence: RunEvidence | undefined
if (process.env.JOBS_JSON && existsSync(process.env.JOBS_JSON)) {
  try {
    const parsed = JSON.parse(readFileSync(process.env.JOBS_JSON, "utf8")) as { jobs?: RunJobEvidence[] }
    const annotations = process.env.JOB_ANNOTATIONS_JSON && existsSync(process.env.JOB_ANNOTATIONS_JSON) ? (JSON.parse(readFileSync(process.env.JOB_ANNOTATIONS_JSON, "utf8")) as RunEvidence["annotations"]) : {}
    runEvidence = { jobs: parsed.jobs ?? [], annotations }
  } catch {
    // Without trustworthy job evidence, a missing result remains a problem.
  }
}

const publicationMetadata = (): PublicConversionMetadata => {
  const required = (name: string): string => {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`${name} is required when PUBLICATION_OUT is set`)
    return value
  }
  const integer = (name: string, value: string): number => {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
    return parsed
  }
  const classificationText = required("E2E_PUBLIC_CLASSIFICATION")
  if (!RUN_CLASSIFICATIONS.includes(classificationText as RunClassification)) throw new Error(`E2E_PUBLIC_CLASSIFICATION is invalid`)
  const attempt = integer("GITHUB_RUN_ATTEMPT", required("GITHUB_RUN_ATTEMPT"))
  const publicArtifacts = publicArtifactsFromActions(integer("RUN_ID", runId), artifacts ?? [], executionKey).map((artifact) => ({
    ...artifact,
    uploadedAt: artifact.uploadedAt ? canonicalActionsTimestamp(artifact.uploadedAt) : null,
    expiresAt: artifact.expiresAt ? canonicalActionsTimestamp(artifact.expiresAt) : null,
  }))
  const publicJobs = publicJobsFromActions((runEvidence?.jobs ?? []) as Array<RunJobEvidence & { started_at?: string | null; completed_at?: string | null }>, executionKey).map((job) => ({
    ...job, startedAt: canonicalActionsTimestamp(job.startedAt), finishedAt: canonicalActionsTimestamp(job.finishedAt),
  }))
  return {
    runId: integer("RUN_ID", runId),
    attempt,
    executionKey,
    suiteId,
    wave,
    classification: classificationText as RunClassification,
    repository: required("GITHUB_REPOSITORY"),
    ref: required("GITHUB_REF"),
    commit: required("GITHUB_SHA"),
    actor: required("GITHUB_ACTOR"),
    workflowPath: required("E2E_PUBLIC_WORKFLOW_PATH"),
    event: required("GITHUB_EVENT_NAME"),
    defaultBranch: required("E2E_DEFAULT_BRANCH"),
    startedAt: canonicalActionsTimestamp(required("E2E_PUBLIC_STARTED_AT")),
    finishedAt: canonicalActionsTimestamp(required("E2E_PUBLIC_FINISHED_AT")),
    planned: matrix.map(({ bot, profile, identity }) => ({ bot, profile, identity })),
    artifacts: publicArtifacts,
    jobs: publicJobs,
  }
}

// account -> profile for every identity we run: the profiles that name an identity, then this run's dispatched bots on top
const pool = { ...parseIdentities(process.env.E2E_IDENTITIES), ...drawnFresh }
const knownAccounts = new Map<string, string>()
for (const p of loadProfiles()) {
  const id = identityFor(p, network)
  if (id && pool[id] && !knownAccounts.has(pool[id])) knownAccounts.set(pool[id], p.name)
}
for (const e of matrix) knownAccounts.set(pool[e.identity], e.profile)

const merged = mergeResults({
  bots,
  network,
  raws: process.env.SELECTED_GUARDS_DIR
    ? raws.map((raw) => ({ ...raw, text: refreshSelectedGuardText(raw.text, process.env.SELECTED_GUARDS_DIR!) }))
    : raws,
  identities: Object.fromEntries(matrix.map((e) => [e.bot, e.identity])),
  profiles: Object.fromEntries(matrix.map((e) => [e.bot, e.profile])),
  runEvidence,
  freshBots: matrix.filter((e) => e.identity in drawnFresh).map((e) => e.bot),
  proofs: process.env.E2E_PROOFS === "[]" ? [] : parseNamedProofs(process.env.E2E_PROOFS),
  proofHead: process.env.E2E_PROOF_HEAD,
  runnerGroups,
  personaSchedule: rotation,
  acquisitionProblems,
  probedGame: Number.isFinite(Number(process.env.E2E_PROBED_GAME_AT)) && process.env.E2E_PROBED_GAME_AT
    ? { gameAt: Number(process.env.E2E_PROBED_GAME_AT) }
    : undefined,
  // the core six (and the plain baseline, played by a core slot owner): a group of only these is "clean"
  knownAccounts,
  coreProfiles: new Set([DEFAULT_PROFILE, ...loadProfiles().filter((p) => p.bot !== null).map((p) => p.name)]),
  links: { runUrl, runId, artifacts, executionKey },
})
if (selectedDir) {
  mkdirSync(selectedDir, { recursive: true })
  for (const row of merged.rows)
    if (row.result)
      writeFileSync(join(selectedDir, resultFile(row.bot)), JSON.stringify(row.result, null, 2))
  if (merged.adaptiveUpload) writeFileSync(join(selectedDir, "adaptive-upload-proof.json"), JSON.stringify(merged.adaptiveUpload, null, 2))
}
const md = renderSummary(merged, runUrl, process.env.GITHUB_SHA ?? null)
console.log(md)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`)
let publicationPath: string | null = null
let publicationFailed = false
if (process.env.PUBLICATION_OUT) {
  try {
    mkdirSync(process.env.PUBLICATION_OUT, { recursive: true })
    publicationPath = join(process.env.PUBLICATION_OUT, "publication-bundle.json")
    const metadata = publicationMetadata()
    const bundle = metadata.planned.length === 1 && metadata.planned[0].profile === "check-seat-preparing"
      ? seatPreparingBundle(merged, metadata)
      : publicationBundleFromMerged(merged, metadata, loadCrewCatalogue(), new Date())
    writeFileSync(publicationPath, JSON.stringify(bundle, null, 2) + "\n")
  } catch (error) {
    publicationFailed = true
    console.error(`publication bundle failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `all_played=${merged.allPlayed}\n`)
  if (publicationPath && !publicationFailed) appendFileSync(process.env.GITHUB_OUTPUT, `publication_bundle=${publicationPath}\n`)
}
// red on a failed stage or guard too, but all_played above stays about the game alone
process.exit(merged.allPlayed && merged.guardFailures.length === 0 && merged.stageFailures.length === 0 ? 0 : 1)
