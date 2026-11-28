// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { USERNAME_RE } from "../players"
import { buildNightlyPlan, type NightlyWave } from "./nightly-plan"
import { invocationFor } from "./nightly-schedule"

type Env = Record<string, string | undefined>

function usernames(raw: string | undefined, label: string, fallback: "{}" | "[]"): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw || fallback) } catch { throw new Error(`${label} must be JSON`) }
  const values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.keys(parsed) : null
  if (!values || values.some((value) => typeof value !== "string" || !USERNAME_RE.test(value))) throw new Error(`${label} contains an invalid username`)
  return values as string[]
}

export function waveMatrix(waves: NightlyWave[]): string {
  return JSON.stringify({ include: waves.map((wave) => ({
    key: wave.key, bots: wave.botsInput, boot_only: wave.bootOnly, boot_profile: wave.bootProfile ?? "",
    app: wave.app === "local" ? "local" : "", roles: wave.roles, share: wave.share, telemetry: wave.telemetry,
  })) })
}

export function runNightlyPlanCli(env: Env, outputPath = "nightly-plan.json", now = new Date()): { suiteId: string; profiles: number } {
  const runId = Number(env.GITHUB_RUN_ID)
  const { suiteId, classification } = invocationFor(env.GITHUB_EVENT_NAME, runId, now)
  const identities = Object.fromEntries(usernames(env.E2E_IDENTITIES_PREVIEWNET, "E2E_IDENTITIES_PREVIEWNET", "{}").map((name) => [name, "available"]))
  const plan = buildNightlyPlan({ suiteId, classification, identities })
  const reserve = Number(env.E2E_FRESH_RESERVE ?? "1")
  if (!Number.isSafeInteger(reserve) || reserve < 1) throw new Error("E2E_FRESH_RESERVE must be a positive whole number")
  const freshDepth = new Set(usernames(env.E2E_UNBOUND_FRESH_USERS, "E2E_UNBOUND_FRESH_USERS", "[]")).size
  const seat = plan.waves.find((wave) => wave.key === "check-seat-preparing")!
  const seatRunnable = freshDepth > reserve
  if (!seatRunnable) seat.missingProfiles.push({ profile: "check-seat-preparing", identity: "", status: "missing (pool)" })
  const document = { ...plan, freshPool: { unboundDepth: freshDepth, reserve, seatRunnable } }
  const target = resolve(outputPath)
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`)

  const runnable = (wave: NightlyWave): boolean => wave.bootOnly || (wave.key === "check-seat-preparing" ? seatRunnable : JSON.parse(wave.botsInput).length > 0)
  const groups = {
    game_ready: plan.waves.filter((wave) => wave.kind === "game-ready" && runnable(wave)),
    specialists: plan.waves.filter((wave) => wave.kind === "specialist" && runnable(wave)),
    checks: plan.waves.filter((wave) => wave.kind === "check" && !wave.bootOnly && runnable(wave)),
    stale: plan.waves.filter((wave) => wave.kind === "check" && wave.bootOnly && runnable(wave)),
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, [
    `suite_id=${suiteId}`, `classification=${classification}`, `game_ready_matrix=${waveMatrix(groups.game_ready)}`,
    `specialist_matrix=${waveMatrix(groups.specialists)}`,
    `check_matrix=${waveMatrix(groups.checks)}`, `stale_check_matrix=${waveMatrix(groups.stale)}`,
    `game_ready=${groups.game_ready.length > 0}`,
    `has_specialists=${groups.specialists.length > 0}`,
    `has_checks=${groups.checks.length > 0}`, `has_stale_check=${groups.stale.length > 0}`, "",
  ].join("\n"))
  return { suiteId, profiles: plan.waves.flatMap((wave) => wave.coverageProfiles).length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 2 || (args.length && args[0] !== "--out") || (args[0] === "--out" && !args[1])) throw new Error("usage: nightly-plan-cli.mts [--out nightly-plan.json]")
    const result = runNightlyPlanCli(process.env, args[1])
    console.log(`planned ${result.suiteId}: ${result.profiles} profiles`)
  } catch (error) {
    console.error(`nightly plan failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
