// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// FAIL-CLOSED PROOF PREFLIGHT. A live game's intent is named separately from
// its bot matrix so the dispatcher can prove the matrix and flags actually
// exercise that intent before consuming a game slot. Profiles remain the
// extension point: `profile:<name>` validates the requirements already
// declared by profiles.json; the two cross-profile proofs keep their small,
// explicit composition contracts here.
import { needsTelemetryOracle } from "./profile"
import { profileForName, videoRoleProofPlan } from "./profiles"
import type { BotEntry } from "./timing"

export type NamedProof = "video-role-proof" | "flip-verdict" | "clock-watch-fault" | `profile:${string}`

export interface ProofPreflightInput {
  proofs: NamedProof[]
  bots: BotEntry[]
  roles: boolean
  telemetry: boolean
  telemetryProfile: boolean
  flipVerdict: boolean
  clockWatchFault?: boolean
  /** telemetry=true as dispatched (telemetry above also counts clock_watch_fault, which gather does not read) */
  explicitTelemetry?: boolean
  /** game_log_to_sentry=true as dispatched: a T1-T12 profile's completeness check needs the game log in Sentry */
  gameLogToSentry?: boolean
}

const knownProof = (name: string): name is NamedProof => {
  if (name === "video-role-proof" || name === "flip-verdict" || name === "clock-watch-fault") return true
  if (!name.startsWith("profile:")) return false
  try {
    profileForName(name.slice("profile:".length))
    return true
  } catch {
    return false
  }
}

/** Empty means no named acceptance proof. A single name is convenient for the
 * common case; a JSON list lets compatible proofs share one game. */
export function parseNamedProofs(raw: string | undefined): NamedProof[] {
  const text = raw?.trim() ?? ""
  if (!text) return []
  let values: unknown[]
  if (text.startsWith("[")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`proofs=${JSON.stringify(text)} is not a proof name or JSON list of proof names`)
    }
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("proofs must be a proof name or a non-empty JSON list")
    values = parsed
  } else values = [text]
  const proofs = values.map((value) => {
    if (typeof value !== "string" || !knownProof(value)) {
      const detail = typeof value === "string" && value.startsWith("profile:") ? `known profile after profile:` : "known proof (video-role-proof, flip-verdict, clock-watch-fault or profile:<name>)"
      throw new Error(`proof ${JSON.stringify(value)} is not a ${detail}`)
    }
    return value
  })
  const duplicate = proofs.find((proof, index) => proofs.indexOf(proof) !== index)
  if (duplicate) throw new Error(`proof ${duplicate} is listed twice`)
  return proofs
}

/** Existing purpose-built inputs imply their proof even when the caller also
 * names other compatible proofs. An explicit list must not suppress the
 * safety contract already carried by bots=video-role-proof or flip_verdict. */
export function resolveNamedProofs(raw: string | undefined, rawBots: string, flipVerdict: boolean, clockWatchFault: boolean): NamedProof[] {
  const inferred: NamedProof[] = [
    ...(rawBots === "video-role-proof" ? ["video-role-proof" as const] : []),
    ...(flipVerdict ? ["flip-verdict" as const] : []),
    ...(clockWatchFault ? ["clock-watch-fault" as const] : []),
  ]
  return [...new Set([...parseNamedProofs(raw), ...inferred])]
}

const sameProfiles = (bots: readonly BotEntry[], expected: readonly { bot: number; profile: string }[]): boolean =>
  bots.length === expected.length && bots.every((bot, index) => bot.bot === expected[index]?.bot && bot.profile === expected[index]?.profile)

/** Validate only declared proof intent. Generic rotate/all runs keep their
 * established behavior; declaring a proof opts into the stricter contract. */
export function validateProofPreflight(input: ProofPreflightInput): { proofs: NamedProof[] } {
  const failures: string[] = []
  const hasTelemetry = input.telemetry
  // Bot telemetry is opt-in per run: a T1-T12 telemetry profile never supplies it.
  if (input.telemetryProfile && !(input.explicitTelemetry ?? input.telemetry)) failures.push("telemetry profiles (T1-T12) need telemetry=true: bot telemetry is opt-in per run")
  if (input.telemetryProfile && input.gameLogToSentry === false) failures.push("telemetry profiles (T1-T12) need game_log_to_sentry=true: their completeness check reads the game log from Sentry")
  const hasCoplayer = input.bots.length >= 2
  // Every selected persona's own floor, not only the named ones'. `minPlayers` is the
  // profile's statement of how many players its evidence needs — game259-lossy-video's
  // channel gate wants five distinct channels, which needs six players — and an
  // ordinary `bot=`/`profile=` dispatch never consulted it: a live run sent that
  // persona with four bots, its step could never fire, and the run failed with
  // "all 4 channels opened ... but no 65% burst was recorded" instead of saying why.
  for (const name of [...new Set(input.bots.map((b) => b.profile))]) {
    const profile = profileForName(name)
    if (profile?.minPlayers && input.bots.length < profile.minPlayers)
      failures.push(`${name} requires ${profile.minPlayers} players; resolved ${input.bots.length}`)
  }
  for (const proof of input.proofs) {
    if (proof === "video-role-proof") {
      if (!sameProfiles(input.bots, videoRoleProofPlan())) failures.push("video-role-proof requires the exact six-bot video-role-proof preset (bots=video-role-proof)")
      if (!hasCoplayer) failures.push("video-role-proof needs at least one co-player")
      if (!input.roles) failures.push("video-role-proof requires roles=true")
      if (!hasTelemetry) failures.push("video-role-proof requires telemetry=true")
      continue
    }
    if (proof === "flip-verdict") {
      if (!hasCoplayer) failures.push("flip-verdict needs at least one co-player")
      if (input.bots.find((bot) => bot.bot === 1)?.profile !== "baseline-iphone14-wifi") failures.push("flip-verdict requires baseline-iphone14-wifi as bot 1, the only bot receiving E2E_FLIP_VERDICT")
      if (!input.roles) failures.push("flip-verdict requires roles=true")
      if (!input.flipVerdict) failures.push("flip-verdict requires flip_verdict=true")
      if (!hasTelemetry) failures.push("flip-verdict requires telemetry=true")
      continue
    }
    if (proof === "clock-watch-fault") {
      if (!hasCoplayer) failures.push("clock-watch-fault needs at least one co-player")
      if (input.bots.find((bot) => bot.bot === 1)?.profile !== "baseline-iphone14-wifi") failures.push("clock-watch-fault requires baseline-iphone14-wifi as bot 1, the only bot receiving E2E_CLOCK_WATCH_FAULT")
      if (!input.roles) failures.push("clock-watch-fault requires roles=true")
      if (!input.clockWatchFault) failures.push("clock-watch-fault requires clock_watch_fault=true")
      if (!hasTelemetry && !input.clockWatchFault) failures.push("clock-watch-fault requires telemetry=true (clock_watch_fault supplies it)")
      continue
    }

    const name = proof.slice("profile:".length)
    const profile = profileForName(name)
    if (!input.bots.some((bot) => bot.profile === name)) failures.push(`${proof} requires ${name} in the resolved bots list`)
    if (!profile) continue
    const rolesOnly = profile.expect.some((guard) => guard.rolesOnly)
    if ((profile.role.kind !== "baseline" || rolesOnly) && !input.roles) failures.push(`${proof} requires roles=true`)
    if (profile.minPlayers && input.bots.length < profile.minPlayers) failures.push(`${name} requires ${profile.minPlayers} players; resolved ${input.bots.length}`)
    else if (profile.expect.some((guard) => guard.kind === "chain-report") && !hasCoplayer) failures.push(`${proof} needs at least one co-player for its chain-report guard`)
    if ((needsTelemetryOracle(profile) || profile.expect.some((guard) => guard.kind === "metric" || guard.kind === "event" || guard.kind === "synchronized-pc-failure")) && !hasTelemetry) {
      failures.push(`${proof} requires telemetry=true for its telemetry guards`)
    }
  }
  const selectedProfiles = new Set([
    ...input.bots.map((bot) => bot.profile),
    ...input.proofs.filter((proof): proof is `profile:${string}` => proof.startsWith("profile:")).map((proof) => proof.slice("profile:".length)),
  ])
  for (const [left, right] of PROOF_CONFLICTS) if (selectedProfiles.has(left) && selectedProfiles.has(right)) failures.push(`incompatible shared proofs: ${left} cannot share a game with ${right}`)
  if (failures.length) throw new Error(`named proof preflight failed:\n- ${[...new Set(failures)].join("\n- ")}`)
  return { proofs: input.proofs }
}
export function videoProofViewer(proofs: readonly NamedProof[], bots: readonly BotEntry[]): BotEntry | undefined {
  return proofs.includes("video-role-proof") ? bots.find((bot) => bot.profile === "reload-mid-game") : undefined
}

const PROOF_CONFLICTS: readonly [string, string][] = [
  ["game259-lossy-video", "video-role-late-never"],
  ["game259-dropped-lane-rebuild", "video-role-late-never"],
]
