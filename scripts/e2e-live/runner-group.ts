// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { GroupChildMessage } from "./group-boundary"
import { addMasks } from "./mask"
import { stripSecrets } from "./players"
import { loadNetemProfiles, loadProfiles, type NetemProfile, type Profile } from "./profile"
import { DEFAULT_PROFILE, profileForName, ROTATION_FIXED_PROFILES } from "./profiles"
import { emptyResult, resultFile, type SlotResult } from "./result"
import type { BotEntry } from "./timing"

type Env = Record<string, string | undefined>
export const MAX_SHARED_BOTS = 3
// GitHub-hosted by default; the workflow passes a bigger label in E2E_SOLO_RUNNER / E2E_SHARED_RUNNER when it has one
export const SOLO_RUNNER = "ubuntu-latest"
export const SHARED_RUNNER = "ubuntu-latest"
export type RunnerGroupMember = BotEntry

export interface RunnerGroup {
  group: string; size: number; runner: string; shared: boolean; measure: boolean; effect: string; effect_profile: string
  bots_label: string; profiles_label: string; entries: RunnerGroupMember[]
  bot1: number; profile1: string; identity1: string; secret1: string
  bot2: number | null; profile2: string; identity2: string; secret2: string
  bot3: number | null; profile3: string; identity3: string; secret3: string
}
export interface RunnerGroupManifestEntry { group: string; bots: number[]; shared: boolean; measure: boolean }
export interface RunnerGroupPlan { include: RunnerGroup[]; manifest: RunnerGroupManifestEntry[] }
interface GroupOptions { profiles?: Profile[]; netem?: Record<string, NetemProfile>; share?: "off" | "measure" | "on"; soloRunner?: string; sharedRunner?: string }
interface Effect { key: string; profile?: string; shareable: boolean; measureCandidate: boolean; measureSignature?: string; device?: string }
interface Planned { entries: BotEntry[]; effect: string; effectProfile?: string; measure: boolean }

const fixedProfile = (name: string): boolean => ROTATION_FIXED_PROFILES.includes(name as (typeof ROTATION_FIXED_PROFILES)[number])

function effectFor(entry: BotEntry, profiles: Profile[], netem: Record<string, NetemProfile>): Effect {
  if (entry.profile === DEFAULT_PROFILE) return { key: "unshaped", shareable: false, measureCandidate: false }
  const profile = profileForName(entry.profile, profiles)
  if (!profile) return { key: "unshaped", shareable: false, measureCandidate: false }
  const network = profile.network
  const shape = netem[network.profile]
  const dynamic = Boolean(network.switchAtTurn || network.blackoutS || network.timeline?.length)
  const shareable = Boolean(shape) && shape.rateMbit === 0 && !network.relayOnly && !dynamic
  const key = shareable ? `static:${network.profile}:${shape.delayMs}:${shape.jitterMs}:${shape.lossPct}:${shape.rateMbit}` : `solo:${entry.bot}`
  const measureCandidate = shareable && profile.role.kind === "baseline" && (profile.camera.mode ?? "ok") === "ok" && !profile.expectedOutcome && profile.clockOffsetS === 0 && !profile.clockJumps?.length && !profile.fixture
  return {
    key, profile: shareable ? network.profile : undefined, shareable, measureCandidate,
    measureSignature: measureCandidate ? `${key}:${profile.cpuThrottle}:${profile.camera.resolution}:${profile.camera.mode ?? "ok"}` : undefined,
    device: measureCandidate ? profile.device : undefined,
  }
}

function row(group: string, plan: Planned, soloRunner: string, sharedRunner: string): RunnerGroup {
  if (plan.entries.length < 1 || plan.entries.length > MAX_SHARED_BOTS) throw new Error(`runner group ${group} needs 1..${MAX_SHARED_BOTS} bots`)
  const [one, two, three] = plan.entries
  const shared = plan.entries.length > 1
  return {
    group, size: plan.entries.length, runner: shared ? sharedRunner : soloRunner, shared, measure: plan.measure,
    effect: plan.effect, effect_profile: plan.effectProfile ?? "", bots_label: plan.entries.map(({ bot }) => bot).join("-"), profiles_label: plan.entries.map(({ profile }) => profile).join(", "), entries: plan.entries,
    bot1: one.bot, profile1: one.profile, identity1: one.identity, secret1: one.secret,
    bot2: two?.bot ?? null, profile2: two?.profile ?? "", identity2: two?.identity ?? "", secret2: two?.secret ?? "",
    bot3: three?.bot ?? null, profile3: three?.profile ?? "", identity3: three?.identity ?? "", secret3: three?.secret ?? "",
  }
}

function measurementSelection(entries: BotEntry[], effects: Map<number, Effect>): { cohort: Set<number>; control: number } {
  const signatures = new Map<string, BotEntry[]>()
  for (const candidate of entries.filter((entry) => effects.get(entry.bot)?.measureCandidate)) {
    const signature = effects.get(candidate.bot)?.measureSignature as string
    signatures.set(signature, [...(signatures.get(signature) ?? []), candidate])
  }
  for (const bucket of signatures.values()) for (const control of bucket) {
    const remaining = bucket.filter(({ bot }) => bot !== control.bot)
    for (const device of new Set(remaining.map((candidate) => effects.get(candidate.bot)?.device))) {
      const sameDevice = remaining.filter((candidate) => effects.get(candidate.bot)?.device === device)
      const cohort = [...sameDevice.filter(({ profile }) => fixedProfile(profile)).slice(0, 1), ...sameDevice.filter(({ profile }) => !fixedProfile(profile))].slice(0, MAX_SHARED_BOTS)
      if (cohort.length >= 2) return { cohort: new Set(cohort.map(({ bot }) => bot)), control: control.bot }
    }
  }
  throw new Error(`share=measure needs 2 same-device baseline-like static wifi bots plus a CPU/resolution-matched solo control (found ${entries.filter((entry) => effects.get(entry.bot)?.measureCandidate).length} eligible)`)
}

/** One planner emits singleton, measurement and enabled layouts. Only identical
 * static unbounded effects share; fixed sentinels never co-locate. */
export function runnerGroups(entries: BotEntry[], options: GroupOptions = {}): RunnerGroupPlan {
  const profiles = options.profiles ?? loadProfiles()
  const netem = options.netem ?? loadNetemProfiles()
  const effects = new Map(entries.map((entry) => [entry.bot, effectFor(entry, profiles, netem)]))
  const mode = options.share ?? "off"
  const measurement = mode === "measure" ? measurementSelection(entries, effects) : null
  const selected = measurement?.cohort ?? new Set<number>()
  const pending = new Map<string, BotEntry[]>()
  const planned: Planned[] = []
  const flush = (key: string, measure = false): void => {
    const bucket = pending.get(key)
    if (!bucket?.length) return
    const effectProfile = effects.get(bucket[0].bot)?.profile
    planned.push({ entries: bucket.splice(0), effect: key, effectProfile, measure })
  }
  let measurementEmitted = false
  for (const entry of entries) {
    const effect = effects.get(entry.bot) as Effect
    if (measurement && selected.has(entry.bot)) {
      if (!measurementEmitted) {
        const members = entries.filter(({ bot }) => selected.has(bot))
        planned.push({ entries: members, effect: effect.key, effectProfile: effect.profile, measure: true })
        measurementEmitted = true
      }
      continue
    }
    if (mode !== "on" || !effect.shareable || measurement) {
      planned.push({ entries: [entry], effect: effect.key, effectProfile: effect.profile, measure: entry.bot === measurement?.control })
      continue
    }
    const bucket = pending.get(effect.key) ?? []
    if (fixedProfile(entry.profile) && bucket.some(({ profile }) => fixedProfile(profile))) flush(effect.key)
    const current = pending.get(effect.key) ?? []
    current.push(entry)
    pending.set(effect.key, current)
    if (current.length === MAX_SHARED_BOTS) flush(effect.key)
  }
  for (const key of pending.keys()) flush(key)
  const seen = planned.flatMap(({ entries: members }) => members.map(({ bot }) => bot))
  if (seen.length !== entries.length || new Set(seen).size !== entries.length) throw new Error("runner grouping must schedule every logical bot exactly once")
  const order = new Map(entries.map((entry, index) => [entry.bot, index]))
  planned.sort((a, b) => (order.get(a.entries[0].bot) as number) - (order.get(b.entries[0].bot) as number))
  const include = planned.map((plan, index) => row(`g${String(index + 1).padStart(2, "0")}`, plan, plan.measure && plan.entries.length === 1 ? (options.sharedRunner ?? SHARED_RUNNER) : (options.soloRunner ?? SOLO_RUNNER), options.sharedRunner ?? SHARED_RUNNER))
  return { include, manifest: include.map(({ group, entries: members, shared, measure }) => ({ group, bots: members.map(({ bot }) => bot), shared, measure })) }
}

export interface GroupChild {
  member: RunnerGroupMember
  out: string
  env: Record<string, string>
}

export interface GroupChildOutcome {
  bot: number
  code: number
  result: boolean
  annotationError?: string
}

export interface GroupBoundaryDecision {
  ready: GroupChild[]
  pending: GroupChild[]
  expired: GroupChild[]
}

export interface GroupBoundaryActions {
  release: GroupChild[]
  expire: GroupChild[]
}

export type ReadyDeadlines = ReadonlyMap<number, number | null>
export const SHAPE_RESERVE_MS = 20_000

export function noteGroupChildMessage(raw: unknown, bot: number, ready: Map<number, number | null>, deadlineMissed: Map<number, string>): boolean {
  const message = raw as Partial<GroupChildMessage> | null
  if (!message || message.slot !== bot) return false
  if (message.type === "e2e-group-ready") ready.set(bot, typeof message.releaseByMs === "number" ? message.releaseByMs : null)
  else if (message.type === "e2e-group-expired") deadlineMissed.set(bot, message.reason ?? "registration budget expired")
  else return false
  return true
}

export function boundaryDecision(children: readonly GroupChild[], ready: ReadyDeadlines, terminal: ReadonlySet<number>, now = Date.now()): GroupBoundaryDecision {
  const live = children.filter(({ member }) => !terminal.has(member.bot))
  // Keep expired readiness visible after child exit: a timeout during the
  // async shared apply must retain deadline provenance instead of degrading
  // into generic missing-result evidence.
  const expired = children.filter(({ member }) => {
    const deadline = ready.get(member.bot)
    return deadline !== undefined && deadline !== null && now >= deadline
  })
  const expiredBots = new Set(expired.map(({ member }) => member.bot))
  const accepted = live.filter(({ member }) => ready.has(member.bot) && !expiredBots.has(member.bot))
  const acceptedBots = new Set(accepted.map(({ member }) => member.bot))
  return { ready: accepted, pending: live.filter(({ member }) => !acceptedBots.has(member.bot) && !expiredBots.has(member.bot)), expired }
}

export function boundaryActions(decision: GroupBoundaryDecision, released: ReadonlySet<number>, deadlineMissed: ReadonlySet<number>): GroupBoundaryActions {
  return {
    release: decision.ready.filter(({ member }) => !released.has(member.bot)),
    expire: decision.expired.filter(({ member }) => !released.has(member.bot) && !deadlineMissed.has(member.bot)),
  }
}

export function shapeDeadline(readyChildren: readonly GroupChild[], ready: ReadyDeadlines, watchdog: number): number {
  const deadlines = readyChildren
    .map(({ member }) => ready.get(member.bot))
    .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value))
  return Math.min(watchdog, deadlines.length ? Math.min(...deadlines) - SHAPE_RESERVE_MS : Infinity)
}

export function parseRunnerGroup(raw: string | undefined): RunnerGroup {
  const group = parseMatrixGroup(raw)
  if (!group.shared || group.entries.length < 2) throw new Error(`runner group ${String(group.group)} must describe 2..${MAX_SHARED_BOTS} shared bots`)
  if (!group.effect_profile) throw new Error(`runner group ${group.group} needs a planned static-network effect profile`)
  return group
}

export function parseMatrixGroup(raw: string | undefined): RunnerGroup {
  if (!raw) throw new Error("E2E_RUNNER_GROUP is empty")
  const group = JSON.parse(raw) as RunnerGroup
  if (!group || typeof group !== "object" || !Array.isArray(group.entries)) throw new Error("E2E_RUNNER_GROUP is not a runner-group matrix row")
  if (group.entries.length < 1 || group.entries.length > MAX_SHARED_BOTS || group.size !== group.entries.length) throw new Error(`runner group ${String(group.group)} must describe 1..${MAX_SHARED_BOTS} bots`)
  if (new Set(group.entries.map(({ bot }) => bot)).size !== group.entries.length) throw new Error(`runner group ${group.group} repeats a bot`)
  return group
}

/** Construct each child from a scrubbed environment. A child receives exactly
 * one mnemonic, one port range, one state directory and one artifact root. */
export function groupChildren(group: RunnerGroup, env: Env, tempDir: string, outRoot = "/tmp/e2e-live-out"): GroupChild[] {
  const common = stripSecrets(env)
  return group.entries.map((member, index) => {
    const mnemonic = env[`E2E_GROUP_MNEMONIC_${index + 1}`]?.trim()
    if (!mnemonic) throw new Error(`runner group ${group.group} bot ${member.bot}: E2E_GROUP_MNEMONIC_${index + 1} is empty`)
    addMasks([mnemonic], env)
    const out = join(outRoot, `bot-${member.bot}`)
    return {
      member,
      out,
      env: {
        ...common,
        E2E_SLOT: String(member.bot),
        E2E_PROFILE: member.profile,
        E2E_EXPECTED_USER: member.identity,
        E2E_PLAYER_MNEMONIC: mnemonic,
        E2E_BASE_PORT: String(10_000 + index * 1_000),
        E2E_STATE_DIR: join(tempDir, "e2e-live-groups", group.group, `bot-${member.bot}`),
        E2E_OUT: out,
        E2E_RUNNER_GROUP_ID: group.group,
        E2E_RUNNER_GROUP_SIZE: String(group.size),
        E2E_RUNNER_GROUP_MEASURE: group.measure ? "1" : "",
        E2E_SHARED_NETWORK: "1",
      },
    }
  })
}

type SupervisorOutcome = NonNullable<SlotResult["runnerOutcomes"]>[number]

export function writeSupervisorOutcome(child: GroupChild, outcome: SupervisorOutcome, options: { create?: boolean; now?: Date } = {}): boolean {
  const path = join(child.out, resultFile(child.member.bot))
  const now = options.now ?? new Date()
  let result: SlotResult
  if (existsSync(path)) {
    try {
      result = JSON.parse(readFileSync(path, "utf8")) as SlotResult
    } catch {
      return false
    }
  } else {
    if (options.create === false) return false
    result = emptyResult(child.member.bot, null, null, now, child.member.profile, child.env)
    result.finishedAt = now.toISOString()
  }
  if (!(result.runnerOutcomes ?? []).some(({ kind, detail }) => kind === outcome.kind && detail === outcome.detail)) result.runnerOutcomes = [...(result.runnerOutcomes ?? []), outcome]
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`)
  return true
}

export function applySupervisorOutcome(children: readonly GroupChild[], outcomes: GroupChildOutcome[], outcome: SupervisorOutcome, options: { create?: boolean; now?: Date } = {}): void {
  const byBot = new Map(outcomes.map((value) => [value.bot, value]))
  for (const child of children) {
    const saved = byBot.get(child.member.bot)
    if (saved) saved.result = writeSupervisorOutcome(child, outcome, options)
  }
}

export function recordSharedNetem(children: readonly GroupChild[], call: readonly string[], text: string, at = new Date().toISOString(), skipFirst = false): void {
  for (const child of skipFirst ? children.slice(1) : children) {
    appendFileSync(join(child.out, "netem.log"), `${at} shared netem ${call.join(" ")}\n${text}\n`)
  }
}

/** Turn every launch/exit/annotation path into one terminal outcome. This
 * never rejects, so one malformed result cannot make the supervisor abandon
 * siblings that are still producing evidence. */
export async function finalizeGroupChild(child: GroupChild, exit: Promise<number>, say: (line: string) => void = console.error): Promise<GroupChildOutcome> {
  let code = 1
  try {
    code = await exit
  } catch (error) {
    say(`[bot ${child.member.bot}] child failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const path = join(child.out, resultFile(child.member.bot))
  try {
    if (!existsSync(path)) return { bot: child.member.bot, code, result: false }
    JSON.parse(readFileSync(path, "utf8"))
    return { bot: child.member.bot, code, result: true }
  } catch (error) {
    const annotationError = error instanceof Error ? error.message : String(error)
    say(`[bot ${child.member.bot}] result annotation failed; original evidence retained: ${annotationError}`)
    return { bot: child.member.bot, code: 1, result: false, annotationError }
  }
}

export function ensureGroupDirectories(children: readonly GroupChild[]): void {
  for (const child of children) {
    mkdirSync(child.out, { recursive: true })
    mkdirSync(child.env.E2E_STATE_DIR, { recursive: true })
  }
}
