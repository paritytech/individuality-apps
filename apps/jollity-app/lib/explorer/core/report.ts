// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { LABEL_SCHEMA } from "./labels"
import type { SearchResult } from "./search"

/** a known-gaps.ts difference the search met: not a violation, reported with its issue */
export interface KnownGapSeen {
  property: string
  issue: number
  detail: string
  /** Schedules it appeared in, or distinct states when stateKeys is present. */
  schedules: number
  /** Dedup runs retain these so the parent report can union states across shards. */
  stateKeys?: string[]
}

interface ReportContext {
  bounds: VerdictBounds
  scenario?: object
  source: object
  knownGaps?: KnownGapSeen[]
  /** Internal: shard reports retain keys so the parent can globally deduplicate them. */
  censusKeys?: boolean
  /** The last whole layer retained after the worker was stopped. */
  interruptedAtDepth?: number
}

/** adds shard parts' known gaps up: one entry per (property, issue, detail) */
export function mergeKnownGaps(parts: readonly (readonly KnownGapSeen[] | undefined)[]): KnownGapSeen[] {
  const merged = new Map<string, KnownGapSeen>()
  for (const gap of parts.flatMap((part) => part ?? [])) {
    const key = `${gap.property}|${gap.issue}|${gap.detail}`
    const entry = merged.get(key) ?? { ...gap, schedules: 0 }
    if (gap.stateKeys !== undefined) {
      const stateKeys = new Set(entry.stateKeys ?? [])
      for (const stateKey of gap.stateKeys) stateKeys.add(stateKey)
      entry.stateKeys = [...stateKeys]
      entry.schedules = stateKeys.size
    } else {
      entry.schedules += gap.schedules
    }
    merged.set(key, entry)
  }
  return [...merged.values()]
}

interface VerdictBounds {
  depth: number
  faults: number
  horizonMs: number
  dedup?: boolean
}

export function verdictLine(
  result: SearchResult,
  bounds: VerdictBounds,
): string {
  const closed = !result.inconclusive && result.closedAtDepth >= bounds.depth
  // "frontier closed": nothing was left to expand; otherwise the depth bound stopped it
  const status = !closed
    ? "inconclusive"
    : result.frontierClosed === true
      ? "frontier closed"
      : "closed at the depth bound"
  const outcome = result.findings.length === 0 ? "clean" : "violations found"
  const reportedDepth = closed ? bounds.depth : result.closedAtDepth
  const qualification = bounds.dedup
    ? `${status}, dedup on the room fingerprint`
    : status
  return `${outcome} at d = ${reportedDepth}, F = ${bounds.faults}, H = ${bounds.horizonMs / 1000} s (${qualification})`
}

const localTimestamp = (): string =>
  new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date())

export async function writeReport(
  dir: string,
  machine: string,
  result: SearchResult,
  context: ReportContext,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  const { censusKeys = false, interruptedAtDepth, ...reportedContext } = context
  const interruption = interruptedAtDepth === undefined ? undefined : `interrupted at d = ${interruptedAtDepth}`
  const report = {
    schema: LABEL_SCHEMA,
    machine,
    ...reportedContext,
    ...result,
    ...(interruption === undefined ? {} : { interruption }),
    levels: result.levels.map(({ _censusKeys, _censusPaths, ...level }) => ({
      ...level,
      ...(censusKeys && _censusKeys ? { _censusKeys } : {}),
      ...(censusKeys && _censusPaths ? { _censusPaths } : {}),
    })),
  }
  const verdict = verdictLine(result, context.bounds)
  const levelLines = result.levels.map(
    (level) =>
      `- d = ${level.depth}: ${level.leaves} leaves${level.expanded === undefined ? "" : `, ${level.expanded} expanded, ${level.seen ?? 0} seen`}${level.census ? `, ${level.census.depthLeaves} depth leaves, ${level.census.distinctFingerprints} distinct fingerprints, ratio ${level.census.ratio.toFixed(2)}x` : ""}, mean enabled ${level.meanEnabled.toFixed(2)}, cuts ${JSON.stringify(level.cuts)}, ${level.elapsedMs.toFixed(1)} ms`,
  )
  const summary = [
    `# Explorer report: ${machine}`,
    "",
    `- Generated: ${localTimestamp()}`,
    `- Verdict: ${verdict}`,
    ...(interruption === undefined ? [] : [`- Run: ${interruption}`]),
    `- Findings: ${result.findings.length}`,
    ...(context.knownGaps === undefined
      ? []
      : context.knownGaps.length === 0
        ? ["- Known gaps met: none"]
        : context.knownGaps.map((gap) => `- Known gap #${gap.issue} (${gap.property}, not a violation): ${gap.detail}; ${gap.schedules} ${context.bounds.dedup ? "distinct states" : "schedules"}`)),
    ...levelLines,
    "",
  ].join("\n")

  await Promise.all([
    writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(join(dir, "summary.md"), summary),
  ])
}
