#!/usr/bin/env npx tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { renderAnnotatedBot } from "./recording-render"
import { normalizeSlotResult, type SlotResult } from "./result"

const [resultsDirectoryArg, recordingsDirectoryArg, outputDirectoryArg, ...flags] = process.argv.slice(2)
if (!resultsDirectoryArg || !recordingsDirectoryArg || !outputDirectoryArg) {
  console.error("usage: recording-annotate-cli.mts <selected-results> <recordings> <output> --run-id <id> --bots <n,n,...>")
  process.exit(2)
}
const flag = (name: string): string | undefined => {
  const index = flags.indexOf(name)
  return index >= 0 ? flags[index + 1] : undefined
}
const runId = flag("--run-id")
const bots = (flag("--bots") ?? "").split(/[,-]/).filter(Boolean).map(Number)
if (!runId || !/^\d+$/.test(runId) || bots.length === 0 || bots.some((bot) => !Number.isSafeInteger(bot) || bot < 1)) {
  console.error("--run-id must be numeric and --bots must contain positive slot numbers")
  process.exit(2)
}

const resultsDirectory = resolve(resultsDirectoryArg)
const recordingsDirectory = resolve(recordingsDirectoryArg)
const outputDirectory = resolve(outputDirectoryArg)
const results: SlotResult[] = readdirSync(resultsDirectory)
  .filter((file) => /^result-\d+\.json$/.test(file))
  .sort()
  .map((file) => normalizeSlotResult(JSON.parse(readFileSync(join(resultsDirectory, file), "utf8"))))
const bySlot = new Map(results.map((result) => [result.slot, result]))
const summary: { version: 1; runId: string; bots: { slot: number; status: "annotated" | "unavailable"; detail: string }[] } = { version: 1, runId, bots: [] }
let failed = false
mkdirSync(outputDirectory, { recursive: true })

for (const slot of bots) {
  const receiver = bySlot.get(slot)
  const input = join(recordingsDirectory, `bot-${slot}`)
  const output = join(outputDirectory, `bot-${slot}`)
  try {
    if (!receiver) throw new Error("selected result is unavailable")
    if (!existsSync(input)) throw new Error("original recording artifact is unavailable")
    const manifest = await renderAnnotatedBot({ runId, receiver, results, inputDirectory: input, outputDirectory: output })
    summary.bots.push({
      slot,
      status: "annotated",
      detail: `${manifest.segments.length} recording segment(s)${manifest.unavailableSegments.length ? `; ${manifest.unavailableSegments.length} unavailable segment(s)` : ""}`,
    })
  } catch (error) {
    failed = true
    const detail = String((error as Error)?.message ?? error).split("\n")[0]
    summary.bots.push({ slot, status: "unavailable", detail })
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, "annotation-unavailable.json"), JSON.stringify({ version: 1, runId, slot, detail }, null, 2) + "\n")
  }
}
writeFileSync(join(outputDirectory, "annotation-summary.json"), JSON.stringify(summary, null, 2) + "\n")
if (failed) process.exitCode = 1
