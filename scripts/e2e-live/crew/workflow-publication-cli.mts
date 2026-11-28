// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { harnessBundle, normalizeExecution, reconcileHistoricalDiagnostics, selectPublicationBundle, writePublicationBundle, type WorkflowMetadata } from "./workflow-publication"

const [mode, ...args] = process.argv.slice(2)
const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"))
const required = (key: string): string => {
  const value = process.env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}
if (mode === "validate-inputs" || mode === "prepare") {
  const execution = normalizeExecution(required("GITHUB_EVENT_NAME"), JSON.parse(process.env.CREW_INPUTS || "{}") as Record<string, unknown>)
  if (mode === "validate-inputs") {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `publish=${execution.publish}\n`)
  } else if (execution.publish) {
    const [sourceDir, outputDir] = args
    if (!sourceDir || !outputDir) throw new Error("prepare requires source and output directories")
    const source = join(sourceDir, "publication-bundle.json")
    const metadata: WorkflowMetadata = {
      runId: Number(required("GITHUB_RUN_ID")), attempt: Number(required("GITHUB_RUN_ATTEMPT")),
      repository: required("GITHUB_REPOSITORY"), ref: required("GITHUB_REF"), commit: required("GITHUB_SHA"), actor: required("GITHUB_ACTOR"),
      event: required("GITHUB_EVENT_NAME"), workflowPath: required("E2E_PUBLIC_WORKFLOW_PATH"), defaultBranch: required("E2E_DEFAULT_BRANCH"),
      startedAt: required("E2E_PUBLIC_STARTED_AT"), finishedAt: required("E2E_PUBLIC_FINISHED_AT"),
    }
    const fallback = harnessBundle(metadata, execution, process.env.CREW_PLAY_CONCLUSION || "missing")
    writePublicationBundle(outputDir, existsSync(source) ? read(source) : fallback, sourceDir)
  }
} else if (mode === "select") {
  const [sourcePath, releasePath, outputDir, evidenceDir] = args
  if (!sourcePath || !releasePath || !outputDir) throw new Error("select requires source JSON, optional released JSON path, and output directory")
  const selected = selectPublicationBundle(read(sourcePath), existsSync(releasePath) ? read(releasePath) : undefined)
  writePublicationBundle(outputDir, evidenceDir ? reconcileHistoricalDiagnostics(selected, evidenceDir) : selected, join(sourcePath, ".."))
} else throw new Error("expected validate-inputs, prepare, or select")
