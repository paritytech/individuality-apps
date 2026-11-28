// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// WHICH BEHAVIOUR A BOT PLAYS: one generic bot program takes exactly two
// inputs, its IDENTITY (E2E_PLAYER_MNEMONIC) and its BEHAVIOUR (E2E_PROFILE, a
// profile name). The names come from ONE place, profiles.json (profile.ts
// loads and validates it WITHOUT Playwright), plus the reserved name
// "baseline": plain behaviour, nothing applied (the journey's own default
// device, no throttling, no netem, no role) - what ran games 177-181. A new
// profile is therefore a data change in profiles.json and nothing here.
//
// Preset names for the dispatch's `bots` input are data too: PRESETS maps
// a preset to a list of profile names, and "six-roles" is derived from the
// `bot` field in profiles.json (bots 1-6), as "core" (six-roles is its old name); "all" is every runnable
// profile with an identity on the run's network (allRoles). "rotate" keeps
// the four regression sentinels and alternates every other runnable profile
// by dispatched live-E2E run, so PR boot checks do not flip the half and
// on-demand runs do not starve one half merely
// because they happen to select games with the same index parity (#402).
import { profileIsolationGap } from "./network"
import { identityFor, loadProfiles, type Profile } from "./profile"

export const DEFAULT_PROFILE = "baseline"

/** Personas whose regressions have already justified running them every game. */
export const ROTATION_FIXED_PROFILES = ["baseline-iphone14-wifi", "kill-background-iphone13", "late-join-galaxya55-lte-good", "reload-mid-game"] as const

/** One bounded game proving reload restoration, a delayed first frame and a
 * peer that never produces video. Remaining slots keep ordinary behaviour. */
export function videoRoleProofPlan(slots = 6): { bot: number; profile: string }[] {
  if (!Number.isInteger(slots) || slots < 3) throw new Error("video-role-proof needs at least 3 slots")
  const special = ["reload-mid-game", "video-role-late-flip", "video-role-late-never"]
  return Array.from({ length: slots }, (_, index) => ({
    bot: index + 1,
    profile: special[index] ?? DEFAULT_PROFILE,
  }))
}

export interface PersonaSchedule {
  runNumber: number
  half: "A" | "B"
  scheduled: string[]
  rotatedOut: string[]
}

/** Every name E2E_PROFILE may carry: the reserved default, then profiles.json. */
export const knownProfiles = (profiles: Profile[] = loadProfiles()): string[] => [DEFAULT_PROFILE, ...profiles.map((p) => p.name)]

/** E2E_PROFILE → a known profile name; empty means the default. */
export function resolveProfile(raw: string | undefined, known: readonly string[] = knownProfiles()): string {
  const name = (raw ?? "").trim() || DEFAULT_PROFILE
  if (!known.includes(name)) throw new Error(`E2E_PROFILE="${name}" is not a known profile (known: ${known.join(", ")})`)
  return name
}

/** "six-roles": every profile that carries a `bot` number, as bot -> name. */
export function sixRoles(profiles: Profile[] = loadProfiles()): { bot: number; profile: string }[] {
  return profiles
    .filter((p): p is Profile & { bot: number } => p.bot !== null)
    .map((p) => ({ bot: p.bot, profile: p.name }))
    .sort((a, b) => a.bot - b.bot)
}

/** "all": every profile that can play a game bot: it has an identity on `network`, is not pending, can isolate every outage it cuts there (ISOLATION_GAPS) and is not a single-bot check
 *  (`check-*`, which has no bot number). The core six come first, in bot order, then the rest in file order. */
export function allRoles(profiles: Profile[] = loadProfiles(), network = "previewnet"): { profile: string }[] {
  const core = sixRoles(profiles).map((e) => e.profile)
  const rest = profiles.filter((p) => p.bot === null && !p.name.startsWith("check-") && !p.acceptanceOnly).map((p) => p.name)
  const runnable = new Set(profiles.filter((p) => identityFor(p, network) && !p.pending && !profileIsolationGap(p, network)).map((p) => p.name))
  return [...core, ...rest].filter((n) => runnable.has(n)).map((profile) => ({ profile }))
}

/** The opt-in `rotate` preset for one dispatched run. Fixed personas always
 *  lead the matrix; the remaining runnable profiles keep profiles.json order
 *  and alternate between complementary halves on consecutive GitHub runs. */
export function personaSchedule(network = "previewnet", runNumber?: number, profiles: Profile[] = loadProfiles(), selectedHalf?: "A" | "B"): PersonaSchedule {
  if (!Number.isInteger(runNumber) || (runNumber as number) < 1) throw new Error(`rotate needs a positive whole dispatched-run sequence number (got ${String(runNumber)})`)
  const all = allRoles(profiles, network).map((entry) => entry.profile)
  const missing = ROTATION_FIXED_PROFILES.filter((profile) => !all.includes(profile))
  if (missing.length) throw new Error(`rotate can not schedule its fixed persona${missing.length === 1 ? "" : "s"} on ${network}: ${missing.join(", ")}`)
  const fixed = new Set<string>(ROTATION_FIXED_PROFILES)
  const rotating = all.filter((profile) => !fixed.has(profile))
  const half: PersonaSchedule["half"] = selectedHalf ?? ((runNumber as number) % 2 === 1 ? "A" : "B")
  const parity = half === "A" ? 0 : 1
  return {
    runNumber: runNumber as number,
    half,
    scheduled: [...ROTATION_FIXED_PROFILES, ...rotating.filter((_, index) => index % 2 === parity)],
    rotatedOut: rotating.filter((_, index) => index % 2 !== parity),
  }
}

/** E2E_PROFILE's name -> its Profile, or null for the reserved "baseline" (nothing to apply). */
export function profileForName(name: string | undefined, profiles: Profile[] = loadProfiles()): Profile | null {
  const n = resolveProfile(name, knownProfiles(profiles))
  return n === DEFAULT_PROFILE ? null : (profiles.find((p) => p.name === n) as Profile)
}
