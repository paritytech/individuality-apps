// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE MATRIX'S CLOCK RULES, pure (vitest pins them in timing.test.ts). Every
// wait and timeout of a distributed run derives from the game's CHAIN times
// (all in chain seconds); no flat "90 minutes" exists anywhere. probe.mts feeds
// the inputs and publishes the outputs for the workflow:
//   lead_s       → the probe's sleep until the runners are due (late: the first
//                  tap is aimed SIGNUP_SLACK_S before registration closes, #338)
//   job_minutes  → play's `timeout-minutes`   (runner start → reportEnds + settle)
//   matrix       → runner-group.ts turns this logical bot list into the play job's physical runner matrix
// The runners' own sleep until registration opens is boot.mts (decide.ts
// sleepMsFor); the play spec's timeout is sized from report_ends (journey.pw.ts).

import { freshPoolVariable } from "./fresh-pool"
import { identityFor, loadProfiles, type Profile } from "./profile"
import { parseIdentities, poolVariable, secretSuffix } from "./players"
import { profileIsolationGap } from "./network"
import { DEFAULT_PROFILE, allRoles, knownProfiles, personaSchedule, resolveProfile, sixRoles, videoRoleProofPlan } from "./profiles"

/** From dispatch to the first Register tap on a fresh runner, ONE estimate
 *  (it covers probe lag and the boot too, so nothing else adds to it). Measured
 *  on ubuntu-latest: ~1.5 min of installs (npm ci, Playwright + Chromium,
 *  truapi-host), then a CI boot of 88-100 s (oracle, host, next dev, pre-warm),
 *  plus the probe job and runner queueing: ~6 min (#284). */
export const CI_SETUP_S = 360
/** A window must stay open this long after the first possible tap to be joinable. */
export const MIN_WINDOW_S = 30
/** Slack after reportEnds: the settlement block, the chain reads (watch
 *  --margin 300 s), the artifact upload. Kept generous on purpose: a job killed
 *  by its timeout loses the whole run's evidence. */
export const SETTLE_MARGIN_S = 600
/** The first Register tap is aimed this long before registration CLOSES (or at
 *  its opening, if that is later): 4 min of sign-up slack, so a bot idles in
 *  the waiting room for minutes, not the ~17 min the whole window used to cost.
 *  The user's "dispatch late" choice, kept open to measure in #338. */
export const SIGNUP_SLACK_S = 240
/** The probe job sleeps (one runner) until the play runners are due, so this
 *  caps how long it may idle: it must fit the probe's `timeout-minutes` (120 in
 *  the workflow) and GitHub's 6 h job ceiling. decide.ts's LEAD_S (1 h) already
 *  keeps real games well inside it. */
export const MAX_LEAD_S = 6600
/** One turn of the game (intro + play + ending), the pallet's HOST_FULL_CYCLE. */
const TURN_S = 12

/** Minimum registration time a cold suite must still have when it probes.
 * CI first needs its ordinary setup/window allowance. A profile whose first
 * fault is due before kickoff also needs enough of that allowance to reach
 * the deadline before shuffle and the post-shuffle margin begin. */
export function coldSuiteCandidateMinLeftS(
  profiles: readonly (Profile | null)[],
  phases: { shuffle: number; postShuffleMargin: number },
): number {
  const earliestBeforeGameS = Math.max(0, ...profiles.flatMap((profile) =>
    profile?.network.timeline?.flatMap((step) => step.atBeforeGameS === undefined ? [] : [step.atBeforeGameS]) ?? []))
  const preGameAllowanceS = Math.max(0, earliestBeforeGameS - phases.shuffle - phases.postShuffleMargin)
  return CI_SETUP_S + MIN_WINDOW_S + preGameAllowanceS
}

export interface GameTimes {
  gameAt: number
  /** the pallet's own report_ends, when the game is the current one */
  reportEnds?: number
  rounds?: number
  maxGroupSize?: number
}

/** When a game's reporting ends, ONE definition for the probe and the play
 *  spec: the latest of the pallet's report_ends, play time + the stored
 *  reporting phase, and the floor no game can end before: rounds x
 *  max_group_size turns of 12 s, plus a minute. */
export function reportEndsFor(game: GameTimes, phases: { reporting: number }): number {
  const floor = game.rounds !== undefined && game.maxGroupSize !== undefined ? game.gameAt + game.rounds * game.maxGroupSize * TURN_S + 60 : 0
  return Math.max(game.reportEnds ?? 0, game.gameAt + phases.reporting, floor)
}

export interface TimingInput {
  /** chain seconds now */
  chainNow: number
  /** chain seconds: when the sign-up window opens (may be in the past) */
  registrationStart: number
  registrationEnds: number
  reportEnds: number
}

export type TimingPlan =
  | { ok: true; jobMinutes: number; leadS: number; firstTapAt: number; windowLeftS: number }
  | { ok: false; reason: string }

const mins = (s: number): string => `${(s / 60).toFixed(1)} min`

/** Can a run dispatched now sign up before registration closes, and when
 *  must the runners start? They start at CI_SETUP_S before the tap
 *  target, max(window opens, window closes - SIGNUP_SLACK_S), or now if that
 *  is past (the probe sleeps `leadS`), so each lives only from that
 *  start to reportEnds + settle: derived, not guessed, and never an idle hour. */
export function planTiming(i: TimingInput): TimingPlan {
  const setupS = CI_SETUP_S
  const minWindowS = MIN_WINDOW_S
  for (const [k, v] of Object.entries({ chainNow: i.chainNow, registrationStart: i.registrationStart, registrationEnds: i.registrationEnds, reportEnds: i.reportEnds })) {
    if (!Number.isFinite(v)) return { ok: false, reason: `${k} is not a number (${String(v)}): the probe could not read the game's times` }
  }
  if (i.reportEnds <= i.registrationEnds) return { ok: false, reason: `report ends (${i.reportEnds}) is not after registration ends (${i.registrationEnds}): the game's times are inconsistent` }
  const tapTarget = Math.max(i.registrationStart, i.registrationEnds - SIGNUP_SLACK_S)
  const firstTapAt = Math.max(tapTarget, i.chainNow + setupS)
  const windowLeftS = i.registrationEnds - firstTapAt
  if (windowLeftS < minWindowS) {
    return {
      ok: false,
      reason: `CI cannot sign up in time: it needs ${mins(setupS)} from dispatch to the first Register tap, so the earliest tap is chain ${firstTapAt}, but registration closes at ${i.registrationEnds} (${Math.round(windowLeftS)} s left, need ${minWindowS} s). Dispatch earlier, or wait for the next game.`,
    }
  }
  const leadS = Math.max(0, tapTarget - setupS - i.chainNow)
  if (leadS > MAX_LEAD_S) return { ok: false, reason: `the tap is due ${mins(tapTarget - i.chainNow)} from now; the probe would idle ${mins(leadS)}, over its ${mins(MAX_LEAD_S)} cap. Dispatch closer to the game.` }
  const jobMinutes = Math.ceil((i.reportEnds - (i.chainNow + leadS) + SETTLE_MARGIN_S) / 60)
  return { ok: true, jobMinutes, leadS, firstTapAt, windowLeftS }
}

export interface BotEntry {
  /** the slot index (ports, out dir, artifact name): its position in the run, never an identity */
  bot: number
  /** the behaviour (E2E_PROFILE) */
  profile: string
  /** WHO plays: the lite username (a key of the network's pool) */
  identity: string
  /** the identity's secret name minus E2E_ID_: the workflow reads secrets[format('E2E_ID_{0}', matrix.secret)] */
  secret: string
}

/** The dispatch's `bots` input, the ONE place the bot list is set, ONE parse
 *  path. The forms, all producing the strategy.matrix `include` list:
 *    ""            three baseline bots
 *    "6"           = bots 1..6, all baseline (bot n plays as the identity of
 *                  the profile whose `bot` field is n: the slot's owner)
 *    "core"        bots 1..6 with the profile whose `bot` field is that number
 *                  (profiles.json); a preset is data, not code. "six-roles" is its old name.
 *    "all"         the core six, then EVERY other profile that has an identity, is not
 *                  pending and is not a single-bot check-*: the default for a game
 *                  dispatch (every profile plays every game); "core" is the control game
 *    "rotate"      the four fixed regression personas, plus alternating halves
 *                  of every other runnable profile, keyed by `rotationRun`
 *    '["late-join-galaxya55-lte-good","kill-background-iphone13"]'
 *                  a list of PROFILE names: the slot index is the position and
 *                  the identity is the profile's own (`identity` in
 *                  profiles.json). THE way to run a test: a test is a profile.
 *    '[{"bot":1,"profile":"baseline"},{"bot":2,"profile":"slow-pixel7-lte-poor"}]'
 *                  the same with an explicit slot index (both fields optional)
 *  Validated HERE, once (boot.mts and gather trust what the matrix hands them):
 *  a bot number repeats nowhere, every profile is known and runnable, every
 *  profile has an identity that is in the pool (`identities`, the repo
 *  variable E2E_IDENTITIES, or E2E_IDENTITIES_PREVIEWNET on previewnet; the workflow hands the chosen one over as E2E_IDENTITIES) and no identity plays twice in one run: two
 *  sessions of one account make every peer's link rotate (#324). */
export function botMatrix(
  raw: string | undefined,
  known: readonly string[] = knownProfiles(),
  profiles: Profile[] = loadProfiles(),
  identities: Record<string, string> = parseIdentities(process.env.E2E_IDENTITIES),
  network = "previewnet",
  rotationRun?: number,
  rotationHalf?: "A" | "B",
  /** the UNBOUND persons of the fresh pool, in order (fresh-pool.ts unboundFresh): what a `freshIdentity` profile draws from */
  fresh: readonly string[] = [],
): BotEntry[] {
  const text = (raw ?? "").trim() || "3"
  let wanted: { bot?: number; profile?: string }[]
  if (text === "rotate") wanted = personaSchedule(network, rotationRun, profiles, rotationHalf).scheduled.map((profile) => ({ profile }))
  else if (text === "video-role-proof") wanted = videoRoleProofPlan()
  else if (text === "core" || text === "six-roles") wanted = sixRoles(profiles)
  else if (text === "all") wanted = allRoles(profiles, network)
  else {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`bots=${JSON.stringify(text)} is not a count, the preset core / all / rotate / video-role-proof or a JSON list of profile names / {bot, profile}`)
    }
    // a count is sugar for the default list
    if (Number.isInteger(json) && (json as number) >= 1) json = Array.from({ length: json as number }, (_, k) => ({ bot: k + 1 }))
    if (!Array.isArray(json) || json.length < 1) throw new Error(`bots must be a count or a non-empty list of profile names / {bot, profile} entries`)
    wanted = json.map((e: unknown) => {
      if (typeof e === "string") return { profile: e }
      const o = e as { bot?: unknown; profile?: unknown } | null
      if (!o || typeof o !== "object") throw new Error(`bots entry ${JSON.stringify(e)} is neither a profile name nor {bot, profile}`)
      if (o.bot !== undefined && (!Number.isInteger(o.bot) || (o.bot as number) < 1)) throw new Error(`bots entry ${JSON.stringify(e)} needs a whole "bot" number from 1`)
      return { bot: o.bot as number | undefined, profile: typeof o.profile === "string" ? o.profile : undefined }
    })
  }
  const takenFresh = new Set<string>()
  const entries = wanted.map((w, i): BotEntry => {
    const bot = w.bot ?? i + 1
    const profile = resolveProfile(w.profile, known)
    // a profile that can not run yet is refused here, with its reason, never scheduled to fail later
    const pending = profiles.find((p) => p.name === profile)?.pending
    if (pending) throw new Error(`profile ${profile} is pending and can not be scheduled: ${pending}`)
    // a profile whose outage the network can not isolate would die in "Boot and run the journey": refused here with the gap's text
    const gapProfile = profiles.find((p) => p.name === profile)
    const gap = gapProfile && profileIsolationGap(gapProfile, network)
    if (gap) throw new Error(`profile ${profile} can not be scheduled on ${network}: ${gap}`)
    // a profile with a fixture points the app at a local version server, which only a `next dev` app can be told: the matrix plays a
    // deployed app, so it is run alone, as a boot_only dispatch with app=local and boot_profile=<name> (the boot identity, unregistered)
    const fixtured = profiles.find((p) => p.name === profile)?.fixture
    if (fixtured) throw new Error(`profile ${profile} serves a local fixture and needs next dev: dispatch it with boot_only, app=local and boot_profile=${profile}, not in the bots list`)
    // the plain baseline has no profile to name a person: it is played by the owner of its slot number
    const owner = profile === DEFAULT_PROFILE ? profiles.find((p) => p.bot === bot) : profiles.find((p) => p.name === profile)
    if (owner?.freshIdentity) {
      const person = fresh.find((u) => !takenFresh.has(u))
      if (!person) throw new Error(`profile ${profile} needs a fresh lite person and the ${freshPoolVariable(network)} pool has no unbound one left: mint more on the desk with new-identity.mts --network ${network} --fresh --count <n>`)
      takenFresh.add(person)
      return { bot, profile, identity: person, secret: secretSuffix(person) }
    }
    const identity = owner && identityFor(owner, network)
    if (!identity) {
      throw new Error(
        profile === DEFAULT_PROFILE
          ? `bot ${bot} (baseline) has no identity on ${network}: no profile owns slot ${bot} there, name a profile instead`
          : `profile ${profile} has no identity on ${network}: add "identity": {"${network}": "<username>"} to it in profiles.json (new-identity.mts --network ${network} makes one)`,
      )
    }
    if (!(identity in identities)) throw new Error(`profile ${profile} plays as ${identity}, which is not in ${poolVariable(network)} (the ${network} pool, E2E_IDENTITIES in the job): create it with new-identity.mts --network ${network}`)
    return { bot, profile, identity, secret: secretSuffix(identity) }
  })
  const dup = entries.find((e, i) => entries.findIndex((o) => o.bot === e.bot) !== i)
  if (dup) throw new Error(`bot ${dup.bot} appears twice in bots`)
  const twice = entries.find((e, i) => entries.findIndex((o) => o.identity === e.identity) !== i)
  if (twice) throw new Error(`identity ${twice.identity} appears twice in one run (bots ${entries.filter((o) => o.identity === twice.identity).map((o) => o.bot).join(" and ")}): two sessions of one account break every peer's link`)
  return entries
}
