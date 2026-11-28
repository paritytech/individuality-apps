// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateExecutionKey } from "../result"

interface SourceRun { id: number; run_attempt: number; status: string; event: string; path: string }
interface Artifact { id: number; name: string; expired: boolean }
interface SelectedResult {
  slot: number
  run?: {
    id?: string
    attempt: number
    superseded?: true
    skipped?: { kind?: string }
  }
  runner?: { group?: string }
}
interface Entry { execution_key: string; source_attempt: number; artifact_name: string; group: string; bots_label: string; directory: string }
interface PublicationEntry { execution_key: string; source_attempt: number; artifact_name: string }

const gh = <T,>(...args: string[]): T => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })) as T
const artifacts = (endpoint: string): Artifact[] => gh<Array<{ artifacts: Artifact[] }>>("--paginate", "--slurp", endpoint).flatMap((page) => page.artifacts)
const download = (repository: string, artifact: Artifact, directory: string): void => {
  const temporary = mkdtempSync(join(tmpdir(), "crew-artifact-"))
  try {
    const archive = join(temporary, `${artifact.id}.zip`)
    writeFileSync(archive, execFileSync("gh", ["api", `repos/${repository}/actions/artifacts/${artifact.id}/zip`], { maxBuffer: 128 * 1024 * 1024 }))
    mkdirSync(directory, { recursive: true })
    execFileSync("unzip", ["-q", archive, "-d", directory])
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Results written before the superseded-run provenance fix may have lost the
 * run id while replacing their run envelope. Recover only that exact shape,
 * from the selected artifact's own attempt; every ordinary result still needs
 * the exact workflow-run boundary. */
const matchesSource = (result: SelectedResult, runId: number, sourceAttempt: number): boolean => {
  const run = result.run
  if (!Number.isSafeInteger(result.slot) || result.slot < 1 || !run || !Number.isSafeInteger(run.attempt) || run.attempt < 1) return false
  if (run.id === String(runId)) return true
  return run.id === undefined && run.attempt === sourceAttempt && run.superseded === true && run.skipped?.kind === "restarted-after-probed-game"
}

const repository = process.env.GITHUB_REPOSITORY!
const runId = Number(process.env.SOURCE_RUN_ID)
const sourceAttempt = Number(process.env.SOURCE_ATTEMPT)
if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(sourceAttempt) || sourceAttempt < 1) throw new Error("invalid annotation source")
const run = gh<SourceRun>(`repos/${repository}/actions/runs/${runId}/attempts/${sourceAttempt}`)
const workflow = run.path.split("@")[0]
const supportedSource = (workflow === ".github/workflows/e2e-live.yml" && run.event === "workflow_dispatch") ||
  (workflow === ".github/workflows/e2e-live-nightly.yml" && ["workflow_dispatch", "schedule"].includes(run.event))
if (run.id !== runId || run.run_attempt !== sourceAttempt || run.status !== "completed" || !supportedSource) throw new Error("unsupported annotation source")

const pattern = new RegExp(`^e2e-live-${runId}-attempt-${run.run_attempt}-([a-z0-9][a-z0-9-]{0,63})-selected-results$`)
const entries: Entry[] = []
const publications: PublicationEntry[] = []
const seen = new Set<string>()
for (const artifact of artifacts(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`)) {
  const match = pattern.exec(artifact.name)
  if (!match || artifact.expired) continue
  const execution = validateExecutionKey(match[1])
  if (seen.has(execution)) throw new Error(`duplicate selected-results execution ${execution}`)
  const directory = join("selected-executions", String(artifact.id))
  try {
    download(repository, artifact, directory)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    process.stderr.write(`Skipping unreadable selected-results artifact ${artifact.name}: ${error instanceof Error ? error.message : String(error)}\n`)
    continue
  }
  seen.add(execution)
  if (existsSync(join(directory, "publication-out", "publication-bundle.json"))) publications.push({
    execution_key: execution, source_attempt: run.run_attempt, artifact_name: artifact.name,
  })
  const groups = new Map<string, number[]>()
  for (const name of readdirSync(directory).filter((name) => /^result-[1-9][0-9]*\.json$/.test(name))) {
    const result = JSON.parse(readFileSync(join(directory, name), "utf8")) as SelectedResult
    if (!matchesSource(result, runId, run.run_attempt)) throw new Error("selected result source mismatch")
    const group = validateExecutionKey(result.runner?.group ?? `bot-${result.slot}`)
    groups.set(group, [...(groups.get(group) ?? []), result.slot])
  }
  for (const [group, bots] of groups) {
    if (new Set(bots).size !== bots.length) throw new Error(`duplicate selected bot in ${execution}/${group}`)
    entries.push({
      execution_key: execution, source_attempt: run.run_attempt, artifact_name: artifact.name, group,
      bots_label: bots.sort((left, right) => left - right).join("-"), directory: `${execution}/${group}`,
    })
  }
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
  `has_results=${entries.length > 0}\nhas_publication=${publications.length > 0}\nmatrix=${JSON.stringify({ include: entries })}\npublication_matrix=${JSON.stringify({ include: publications })}\n`)
