// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The Sentry half of the guard evaluation, around a Sentry evidence reader (none is in this repository yet).
//
//   npx tsx scripts/e2e-live/guards-cli.mts wants    <gather dir>                      > wants.json
//   <a Sentry evidence reader> <gather dir> --wants wants.json --out guard-evidence.json
//   npx tsx scripts/e2e-live/guards-cli.mts evaluate <gather dir> guard-evidence.json
//
// `wants` lists, per bot slot, the metric names and span names (with attribute
// keys) its profile's Sentry-backed guards need. `evaluate` merges the pulled
// evidence into every result-<n>.json's `guards` (only the not-evaluated ones
// change), rewrites the file, prints and appends a section to the job summary,
// and exits 1 if a guard failed. A missing token or pull is "not evaluated",
// said with its reason.
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { evaluateGuard, mergeGuards, tally, type GuardResult, type SentrySource } from "./guards"
import { guardCell } from "./gather"
import { needsTelemetryOracle, profileByName, type Profile } from "./profile"
import type { SlotResult } from "./result"

const [mode, dir, evidenceFile] = process.argv.slice(2)
if (!dir || (mode !== "wants" && mode !== "evaluate")) {
  console.error("usage: guards-cli.mts wants|evaluate <gather dir> [guard-evidence.json]")
  process.exit(2)
}

const resultFiles = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? resultFiles(p) : /^result-\d+\.json$/.test(n) ? [p] : []
  })
const profileOf = (r: SlotResult): Profile | null => {
  try {
    return r.profile === "baseline" ? null : profileByName(r.profile)
  } catch {
    return null
  }
}
if (mode === "wants") {
  const wants: Record<string, { metrics: { key: string; name: string; attrs: Record<string, string> }[]; events: Record<string, string[]> }> = {}
  for (const f of resultFiles(dir)) {
    const r = JSON.parse(readFileSync(f, "utf8")) as SlotResult
    const p = profileOf(r)
    if (!p) continue
    const w = { metrics: [] as { key: string; name: string; attrs: Record<string, string> }[], events: {} as Record<string, string[]> }
    for (const [index, g] of p.expect.entries()) {
      if (g.pending || (g.kind !== "metric" && g.kind !== "event")) continue
      if (g.kind === "metric") w.metrics.push({ key: `g${index}`, name: g.name, attrs: g.attrs ?? {} })
      if (g.kind === "event") w.events[g.name] = [...new Set([...(w.events[g.name] ?? []), ...Object.keys(g.attrs ?? {})])]
    }
    wants[String(r.slot)] = w
  }
  console.log(JSON.stringify(wants, null, 1))
  process.exit(0)
}

const evidence = evidenceFile && existsSync(evidenceFile) ? (JSON.parse(readFileSync(evidenceFile, "utf8")) as Record<string, SentrySource & { metrics?: never }>) : {}
const lines = ["", "### Bot guards (Sentry-backed ones evaluated now)", "", "| bot | profile | guards |", "|---|---|---|"]
let failed = 0
for (const f of resultFiles(dir)) {
  const r = JSON.parse(readFileSync(f, "utf8")) as SlotResult
  const p = profileOf(r)
  const raw = evidence[String(r.slot)] as unknown as { ok: boolean; reason?: string; metrics?: Record<string, number[]>; metricGuards?: Record<string, Array<number | { value: number; attrs: Record<string, string> }>>; events?: Record<string, Record<string, string>[]>; telemetryOracle?: { ok: boolean; reason?: string; missing?: unknown[] } } | undefined
  // a bot that never played a game has no telemetry to judge: not evaluated, never failed
  const played = r.game !== null && r.stages.c.status === "pass"
  const src: SentrySource = !played ? { ok: false, reason: "the bot did not play a game (stage c did not pass)" } : raw?.ok ? { ok: true, evidence: { metrics: raw.metrics ?? {}, events: raw.events ?? {} } } : { ok: false, reason: raw?.reason ?? "no Sentry evidence was pulled for this bot" }
  const later = p ? p.expect.map((guard, index) => {
    const sentry = played && raw?.ok && guard.kind === "metric" && raw.metricGuards?.[`g${index}`]
      ? { ok: true as const, evidence: { metrics: { [guard.name]: raw.metricGuards[`g${index}`] }, events: raw.events ?? {} } }
      : src
    return evaluateGuard(guard, { sentry, rolesOn: process.env.E2E_ROLES === "1", blockTimeMs: r.chainBlockMs })
  }) : []
  // a result written before guards existed (or by a boot-only run) has none: start from the later evaluation
  // the Sentry-backed guards (metric, event) are always re-evaluated from the evidence given; page and chain results stay
  const merged: GuardResult[] = !p ? (r.guards ?? []) : r.guards?.length === later.length ? r.guards.map((g, i) => (g.kind === "metric" || g.kind === "event" ? later[i] : mergeGuards([g], [later[i]])[0])) : later
  r.guards = merged
  writeFileSync(f, JSON.stringify(r, null, 2))
  lines.push(`| ${r.slot} | ${r.profile} | ${guardCell(merged)} |`)
  for (const g of merged) if (g.status !== "pending") lines.push(`|  |  | ${g.status}: ${g.description} - ${g.evidence} |`)
  failed += tally(merged).fail
  const telemetryProfile = needsTelemetryOracle(p)
  if (played && telemetryProfile && raw?.telemetryOracle?.ok !== true) {
    failed += 1
    const oracle = raw?.telemetryOracle
    lines.push(`|  |  | fail: telemetry completeness oracle - ${oracle?.reason ?? `${oracle?.missing?.length ?? 0} missing line(s)`} |`)
  } else if (played && telemetryProfile) lines.push("|  |  | pass: telemetry completeness oracle - every captured occurrence arrived |")
  // an inconclusive act (a runner freeze, #341): Sentry's own number for the same bot and game, when it was pulled
  const longTask = raw?.ok ? raw.metrics?.["ui.long_task_ms"] : undefined
  if (r.inconclusive?.length && longTask?.length) lines.push(`|  |  | Sentry ui.long_task_ms max for this game: ${Math.max(...longTask).toFixed(0)} ms (the app's own measurement, beside the bot's inconclusive act) |`)
}
const md = lines.join("\n")
console.log(md)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n")
process.exit(failed ? 1 : 0)
