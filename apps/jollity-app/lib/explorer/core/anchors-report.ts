// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The one merged report over the anchors: one row per anchor (its closed
 * depth, states or leaves, cuts, violations, witnesses, and for peer-actor
 * the memory it took and what one level deeper would take), the anchors'
 * reports added up by mergeReports, and the run's exit code: the worst of
 * the anchors' (exitCode's order: 4, 1, 2, 3, 0).
 */
import type { SearchResult } from "./search"

export interface AnchorReport extends SearchResult {
  source?: Record<string, unknown>
}

export interface AnchorRow {
  anchor: string
  exit: number
  closedAtDepth: number
  inconclusive: boolean
  frontierClosed: boolean
  /** peer-actor: distinct states; mesh-pair: the deepest level's leaves */
  states: number
  cuts: Record<string, number>
  violations: number
  witnesses: string[]
  elapsedMs: number
  sizing?: Record<string, number | null>
}

export function anchorRow(anchor: string, report: AnchorReport, exit: number, witnesses: string[] = []): AnchorRow {
  const cuts: Record<string, number> = {}
  for (const level of report.levels) for (const [cut, count] of Object.entries(level.cuts)) cuts[cut] = (cuts[cut] ?? 0) + count
  for (const level of report.levels) for (const [detail, count] of Object.entries(level.details)) cuts[detail] = (cuts[detail] ?? 0) + count
  const source = report.source ?? {}
  const states = typeof source.states === "number" ? source.states : (report.levels[report.levels.length - 1]?.leaves ?? 0)
  return {
    anchor,
    exit,
    closedAtDepth: report.closedAtDepth,
    inconclusive: report.inconclusive,
    frontierClosed: report.frontierClosed === true,
    states,
    cuts,
    violations: report.findings.length,
    witnesses,
    elapsedMs: report.levels.reduce((sum, level) => sum + level.elapsedMs, 0),
    ...(source.sizing ? { sizing: source.sizing as Record<string, number | null> } : {}),
  }
}

/** exitCode's precedence over several runs: a harness error, then a violation, a blind self-test, an inconclusive run. */
export function worstExit(codes: readonly number[]): number {
  for (const code of [4, 1, 2, 3]) if (codes.includes(code)) return code
  return 0
}

const n = (value: number | null | undefined) => (value === null || value === undefined ? "-" : value.toLocaleString("en-US"))

export function anchorsMarkdown(machine: string, bounds: { depth: number; faults: number; horizonMs: number }, rows: readonly AnchorRow[]): string {
  const sized = rows.some((row) => row.sizing)
  const head = ["anchor", "exit", "closed depth", "states", "cuts", "violations", "witnesses", "time"]
  if (sized) head.push("peak RSS MB", "peak heap MB", "bytes/state", "growth", "next level states", "next level heap GB")
  const lines = [
    `# ${machine}: anchors`,
    "",
    `Asked: d = ${bounds.depth}, F = ${bounds.faults} past each anchor, H = ${bounds.horizonMs === 0 ? "n/a" : `${bounds.horizonMs / 1000} s`}. Exit ${worstExit(rows.map((row) => row.exit))} (the worst of the anchors').`,
    "",
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
  ]
  for (const row of rows) {
    const closed = `${row.closedAtDepth}${row.inconclusive ? " (inconclusive)" : row.frontierClosed ? " (frontier closed)" : ""}`
    const cuts = Object.entries(row.cuts).filter(([, count]) => count > 0).map(([cut, count]) => `${cut} ${n(count)}`).join(", ") || "none"
    const cells = [row.anchor, String(row.exit), closed, n(row.states), cuts, String(row.violations), row.witnesses.length === 0 ? "-" : row.witnesses.join(", "), `${Math.round(row.elapsedMs / 1000)} s`]
    if (sized) {
      const s = row.sizing ?? {}
      cells.push(n(s.peakRssMb), n(s.peakHeapMb), n(s.bytesPerState), s.growth === null || s.growth === undefined ? "-" : String(s.growth), n(s.projectedStates), s.projectedHeapGb === null || s.projectedHeapGb === undefined ? "-" : String(s.projectedHeapGb))
    }
    lines.push(`| ${cells.join(" | ")} |`)
  }
  lines.push("", "Bounded evidence, never a proof: each row is clean (or not) to its closed depth from its anchor only.", "")
  if (sized) lines.push("Memory is approximate (no forced GC): peak heap is the largest layer-end heap, bytes/state that heap over the states.", "")
  return lines.join("\n")
}
