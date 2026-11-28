// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Profile } from "../profile"
import { identityFor, loadProfiles } from "../profile"
import { allRoles } from "../profiles"

export type NightlyWaveKind = "game-ready" | "specialist" | "check"

export interface MissingPoolProfile {
  profile: string
  identity: string
  status: "missing (pool)"
}

/** One serial, identity-safe execution unit in a manual or scheduled PreviewNet suite. */
export interface NightlyWave {
  key: string
  kind: NightlyWaveKind
  /** Catalogue scenarios covered exactly once by this wave. */
  coverageProfiles: string[]
  /** Repeated, benign profiles that supply a declared multiplayer topology. */
  supportProfiles: string[]
  /** Every profile actually executed, coverage first and support second. */
  profiles: string[]
  identities: string[]
  botsInput: string
  bootOnly: boolean
  bootProfile: string | null
  app: "local" | "deployed"
  roles: boolean
  share: "on" | "off"
  telemetry: boolean
  missingProfiles: MissingPoolProfile[]
}

export interface NightlyPlan {
  schemaVersion: 1
  suiteId: string
  classification: "manual" | "nightly"
  waves: NightlyWave[]
}

export interface BuildNightlyPlanOptions {
  suiteId: string
  classification?: "manual" | "nightly"
  profiles?: Profile[]
  /** Values are opaque and never copied into the plan. */
  identities?: Record<string, string>
}

/** Stable, low-interference identities available to fill a six-seat scenario
 * after shared-identity colouring splits its primary profiles apart. */
export const NIGHTLY_SUPPORT_PROFILES = [
  "baseline-iphone14-wifi",
  "locale-la-enus",
  "locale-tokyo-jajp",
  "locale-berlin-dede",
  "tap-storm-pixel7",
] as const

export function buildNightlyPlan(options: BuildNightlyPlanOptions): NightlyPlan {
  const profiles = options.profiles ?? loadProfiles()
  const pool = options.identities ?? {}
  const names = new Set<string>()
  // Bot telemetry to Sentry is opt-in per run and the nightly sends none, so the
  // T1-T12 telemetry torture profiles are left out of it (they are manual dispatches).
  for (const profile of profiles) {
    if (names.has(profile.name)) throw new Error(`duplicate catalogue profile ${profile.name}`)
    names.add(profile.name)
    if (profile.manualOnly || profile.telemetryTorture) continue
    if (profile.pending) throw new Error(`profile ${profile.name} is pending: ${profile.pending}`)
    if (profile.name === "check-seat-preparing") {
      if (!profile.freshIdentity || profile.role.kind !== "seat-preparing") throw new Error("check-seat-preparing requires the fresh-person allocator")
    } else if (profile.name === "check-stale-build") {
      if (!profile.fixture) throw new Error("check-stale-build requires a local fixture")
    } else if (!identityFor(profile, "previewnet")) throw new Error(`profile ${profile.name} has no runnable PreviewNet identity`)
  }
  for (const check of ["check-stale-build", "check-seat-preparing"]) if (!names.has(check)) throw new Error(`catalogue is missing ${check}`)

  const makeWave = (key: string, kind: NightlyWaveKind, selected: Profile[], supportPool: Profile[] = []): NightlyWave => {
    const missingProfiles: MissingPoolProfile[] = []
    const available: string[] = []
    const availableProfiles: Profile[] = []
    const identities: string[] = []
    const plannedIdentities = new Set<string>()
    for (const profile of selected) {
      const identity = identityFor(profile, "previewnet")
      if (!identity) throw new Error(`profile ${profile.name} has no runnable PreviewNet identity`)
      if (plannedIdentities.has(identity)) throw new Error(`${key} repeats PreviewNet identity ${identity}`)
      plannedIdentities.add(identity)
      if (Object.hasOwn(pool, identity)) {
        available.push(profile.name)
        availableProfiles.push(profile)
        identities.push(identity)
      } else missingProfiles.push({ profile: profile.name, identity, status: "missing (pool)" })
    }
    const requiredPlayers = availableProfiles.length === 0
      ? 0
      : Math.max(1, ...availableProfiles.map((profile) => profile.minPlayers ?? 1))
    const supportProfiles: Profile[] = []
    for (const profile of supportPool) {
      if (available.length >= requiredPlayers) break
      const identity = identityFor(profile, "previewnet")
      if (!identity || plannedIdentities.has(identity) || !Object.hasOwn(pool, identity)) continue
      plannedIdentities.add(identity)
      supportProfiles.push(profile)
      available.push(profile.name)
      identities.push(identity)
    }
    if (available.length > 0 && available.length < requiredPlayers) {
      throw new Error(`${key} needs ${requiredPlayers} available players for ${selected.filter((profile) => (profile.minPlayers ?? 1) === requiredPlayers).map(({ name }) => name).join(", ")}, found ${available.length}`)
    }
    return {
      key, kind,
      coverageProfiles: selected.map(({ name }) => name),
      supportProfiles: supportProfiles.map(({ name }) => name),
      profiles: [...selected, ...supportProfiles].map(({ name }) => name), identities,
      botsInput: JSON.stringify(available), bootOnly: false, bootProfile: null,
      app: "deployed", roles: true, share: "on", telemetry: false, missingProfiles,
    }
  }

  const byName = new Map(profiles.map((profile) => [profile.name, profile]))
  const gameReady = allRoles(profiles, "previewnet").map(({ profile }) => byName.get(profile)!)
  const supportPool = NIGHTLY_SUPPORT_PROFILES.map((name) => {
    const profile = byName.get(name)
    if (!profile) throw new Error(`nightly support profile ${name} is missing`)
    return profile
  })
  const coloured = (selected: Profile[], prefix: string): NightlyWave[] => {
    const waves: Profile[][] = []
    for (const profile of selected) {
      const identity = identityFor(profile, "previewnet")!
      let wave = waves.find((entries) => entries.every((entry) => identityFor(entry, "previewnet") !== identity))
      if (!wave) { wave = []; waves.push(wave) }
      wave.push(profile)
    }
    return waves.map((entries, index) => makeWave(`${prefix}-${String(index + 1).padStart(2, "0")}`, "specialist", entries, supportPool))
  }
  const ordinary = profiles.filter((profile) => profile.acceptanceOnly && !profile.manualOnly && !profile.telemetryTorture)
  const covered = [...gameReady, ...ordinary].map(({ name }) => name)
  if (new Set(covered).size !== covered.length) throw new Error("nightly catalogue schedules a profile more than once")
  for (const profile of profiles) if (!profile.manualOnly && !profile.telemetryTorture && !covered.includes(profile.name) && !profile.name.startsWith("check-")) throw new Error(`profile ${profile.name} is unrunnable in the nightly catalogue`)

  const seat: NightlyWave = {
    key: "check-seat-preparing", kind: "check", coverageProfiles: ["check-seat-preparing"], supportProfiles: [], profiles: ["check-seat-preparing"], identities: [],
    botsInput: JSON.stringify(["check-seat-preparing"]), bootOnly: false, bootProfile: null,
    app: "deployed", roles: true, share: "on", telemetry: false, missingProfiles: [],
  }
  // This final wave is deliberately not converted into a synthetic result. Its
  // called-workflow outcome and raw boot artifacts are the complete evidence.
  const stale: NightlyWave = {
    key: "check-stale-build", kind: "check", coverageProfiles: ["check-stale-build"], supportProfiles: [], profiles: ["check-stale-build"], identities: [],
    botsInput: "", bootOnly: true, bootProfile: "check-stale-build", app: "local",
    roles: false, share: "off", telemetry: false, missingProfiles: [],
  }
  return {
    schemaVersion: 1, suiteId: options.suiteId, classification: options.classification ?? "manual",
    waves: [makeWave("game-ready", "game-ready", gameReady), ...coloured(ordinary, "specialist"), seat, stale],
  }
}
