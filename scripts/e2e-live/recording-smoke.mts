#!/usr/bin/env npx tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ffmpegMediaTools, renderAnnotatedBot } from "./recording-render"
import { emptyResult } from "./result"

const root = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "jollity-recording-smoke-")))
const inputDirectory = join(root, "original")
const outputDirectory = join(root, "annotated")
mkdirSync(inputDirectory, { recursive: true })
const sourceFile = join(inputDirectory, "video-1.webm")
const requestedAt = new Date().toISOString()

execFileSync("ffmpeg", [
  "-y", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=0x203050:s=320x568:d=1:r=10",
  "-metadata", `creation_time=${requestedAt}`,
  "-c:v", "libvpx-vp9", "-an",
  sourceFile,
], { stdio: "inherit" })

const probe = ffmpegMediaTools.probe(sourceFile)
const receiver = emptyResult(1, "smoke-account", "jollitypv.12", new Date(probe.createdAt), "baseline-iphone14-wifi", {
  GITHUB_RUN_ID: "1",
  GITHUB_RUN_ATTEMPT: "1",
})
receiver.game = { index: 1, gameAt: 1, registrationEnds: 1, reportEnds: 1 }
receiver.groups = [{ round: 0, ownIndex: 0, members: [{ index: 0, account: "smoke-account" }] }]
receiver.recordings = [{
  file: "video-1.webm",
  pageOrdinal: 0,
  startedAt: probe.createdAt,
  finishedAt: new Date(Date.parse(probe.createdAt) + probe.durationSeconds * 1000).toISOString(),
}]
receiver.narration = [{
  at: probe.createdAt,
  state: "preparing",
  source: "journey",
  action: null,
  title: "Renderer smoke",
  text: "Captain Baseline is visible in the real annotation renderer.",
}]
writeFileSync(join(root, "result-1.json"), JSON.stringify(receiver, null, 2) + "\n")

const manifest = await renderAnnotatedBot({
  runId: "1",
  receiver,
  results: [receiver],
  inputDirectory,
  outputDirectory,
})
if (manifest.segments.length !== 1) throw new Error("recording annotation smoke produced no derived video")
console.log(`recording annotation smoke wrote ${join(outputDirectory, manifest.segments[0].annotatedFile)}`)
