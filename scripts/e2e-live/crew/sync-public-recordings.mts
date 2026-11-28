#!/usr/bin/env npx tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { validateExecutionKey } from "../result"
import { GH_MAX_BUFFER, publishRecordingRelease } from "./release-recordings"

const positiveInteger = (value: string, label: string): string => {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`)
  return value
}

export function syncRecordingArtifactNames(sourceRunValue: string, attemptValue: string, executionKeyValue = "manual"): { publication: string; annotations: string; bundlePath: string } {
  const sourceRun = positiveInteger(sourceRunValue, "source run")
  const attempt = positiveInteger(attemptValue, "attempt")
  const executionKey = validateExecutionKey(executionKeyValue)
  return {
    publication: executionKey === "manual"
      ? `e2e-live-${sourceRun}-attempt-${attempt}-manual-selected-results`
      : `crew-publication-${sourceRun}-attempt-${attempt}-${executionKey}`,
    annotations: `e2e-live-${sourceRun}-attempt-${attempt}-${executionKey}-crew-hud-*`,
    bundlePath: executionKey === "manual" ? "publication-out/publication-bundle.json" : "publication-bundle.json",
  }
}

export function main(argv = process.argv.slice(2)): void {
  const [sourceRun, attempt, annotationRun, output, executionKey = "manual", ...extra] = argv
  if (!sourceRun || !attempt || !annotationRun || !output || extra.length) throw new Error("usage: sync-public-recordings.mts <source-run> <attempt> <annotation-run> <output-bundle> [execution-key]")
  positiveInteger(annotationRun, "annotation run")
  if (process.env.CREW_PUBLIC_VIDEO_APPROVED !== "true") throw new Error("set CREW_PUBLIC_VIDEO_APPROVED=true only after the frame-by-frame safety review")
  const artifacts = syncRecordingArtifactNames(sourceRun, attempt, executionKey)
  const workspace = mkdtempSync(join(tmpdir(), "crew-recording-sync-"))
  // the repo the runs live in: the workflow's own when run there, else this one
  const repo = process.env.GITHUB_REPOSITORY || "paritytech/individuality-apps"
  const gh = (args: readonly string[]): string => execFileSync("gh", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GH_MAX_BUFFER }).trim()
  try {
    const selected = join(workspace, "selected")
    const annotated = join(workspace, "annotated")
    gh(["run", "download", sourceRun, "--repo", repo, "--name", artifacts.publication, "--dir", selected])
    gh(["run", "download", annotationRun, "--repo", repo, "--pattern", artifacts.annotations, "--dir", annotated])
    const result = publishRecordingRelease({
      bundle: JSON.parse(readFileSync(join(selected, artifacts.bundlePath), "utf8")),
      annotationsDir: annotated,
      gh,
    })
    const serialized = `${JSON.stringify(result.bundle, null, 2)}\n`
    const releasedBundle = join(workspace, "released-publication-bundle.json")
    writeFileSync(output, serialized)
    writeFileSync(releasedBundle, serialized)
    for (const plan of result.plans) gh(["release", "upload", plan.tag, releasedBundle, "--repo", plan.repository, "--clobber"])
    process.stdout.write(`Published ${result.plans.reduce((total, plan) => total + plan.assets.length, 0)} bot recording(s) to ${result.plans.map((plan) => plan.tag).join(", ") || "no release"}.\n`)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
