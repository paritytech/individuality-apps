#!/usr/bin/env npx tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs"
import { publishRecordingRelease } from "./release-recordings"
const [bundlePath, annotationsDir, outputPath, ...flags] = process.argv.slice(2)
if (!bundlePath || !annotationsDir || !outputPath) throw new Error("usage: release-recordings-cli.mts <bundle> <annotations-dir> <output-bundle> [--repository owner/name] [--dry-run]")
const repositoryAt = flags.indexOf("--repository")
const result = publishRecordingRelease({
  bundle: JSON.parse(readFileSync(bundlePath, "utf8")), annotationsDir,
  repository: repositoryAt < 0 ? undefined : flags[repositoryAt + 1], dryRun: flags.includes("--dry-run"),
})
writeFileSync(outputPath, `${JSON.stringify(result.bundle, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ tags: result.plans.map((plan) => plan.tag), assets: result.plans.reduce((total, plan) => total + plan.assets.length, 0), dryRun: flags.includes("--dry-run") })}\n`)
