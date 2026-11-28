// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE GATHER JOB'S BRAIN, pure (vitest pins it in gather.test.ts; gather-cli.mts
// does the file I/O). Each matrix runner leaves result-<n>.json (result.ts) in
// its own artifact; this merges them into one verdict and one job summary, and
// decides the ONE thing no runner may decide alone: whether the game counts as
// played (the once-per-game dedupe write). That needs EVERY bot's
// playedAndSettled, all of them about the same game, each paired as the person
// it should be (#288 dropped oracle's --expect-user, so the check lives here).
// A bot whose self-hosted runner was demonstrably lost is evidence we do not
// have, not a failed player: #350 lists it apart and evaluates the bots left.
import { identitySecretName } from "./players"
import { tally, type GuardResult } from "./guards"
import { artifactName, attemptArtifactName, parseResultArtifactIdentity, validateExecutionKey, normalizeSlotResult, playedAndSettled, type AdaptiveUploadResult, type SlotResult } from "./result"
import { buildRefreshNote } from "./build-refresh"
import { profileForName, videoRoleProofPlan, type PersonaSchedule } from "./profiles"
import { UPLINK_LIFT_PROFILE } from "./profile"
import { verifyVideoRoleProof } from "./role-proof"
import type { RunnerGroupManifestEntry } from "./runner-group"
import { FULL_VIDEO_RUNG, SEND_ADAPTATION_OBSERVE_MS, VIDEO_RUNGS } from "../../apps/jollity-app/lib/webrtc/send-adaptation-classifier"
import { CLOCK_GROUP_MEASUREMENT_ALLOWANCE_MS, clockEvidenceFailures } from "./clock-proof"

export interface GroupVerdict {
  /** unknown: the bot filed no report, so no roster was read */
  kind: "clean" | "mixed" | "unknown"
  /** the table cell */
  label: string
  /** mixed: the profiles (or "real player") the bot shared a group with beyond the core bots */
  with: string[]
}

export const REAL_PLAYER = "real player"

const groupKey = (round: number, members: readonly { account: string }[]): string =>
  `${round}:${members.map(({ account }) => account).sort().join(",")}`

/** Cross-runner clock proof. Historical runs without this evidence remain
 * readable; once any bot in a controlled group supplies it, every evaluated
 * bot in that group must supply comparable readings and the comparison fails
 * closed. */
export function appClockAgreementFailures(rows: readonly BotRow[]): string[] {
  const groups = new Map<string, { round: number; bots: BotRow[] }>()
  for (const row of rows) {
    if (row.preemption || !row.result?.account || !row.result.groups) continue
    for (const group of row.result.groups) {
      const key = groupKey(group.round, group.members)
      const entry = groups.get(key) ?? { round: group.round, bots: [] }
      if (!entry.bots.some(({ bot }) => bot === row.bot)) entry.bots.push(row)
      groups.set(key, entry)
    }
  }

  return [...groups.values()].flatMap(({ round, bots }) => {
    if (bots.length < 2 || !bots.some(({ result }) => result?.appClockEvidence)) return []
    const missing = bots.filter(({ result }) => !result?.appClockEvidence).map(({ bot }) => bot)
    if (missing.length) return [`group app clocks have no persisted turn-entry evidence for bot${missing.length === 1 ? "" : "s"} ${missing.join(", ")} in round ${round + 1}`]
    const tolerances = new Set(bots.map(({ result }) => result!.appClockEvidence!.toleranceMs))
    if (tolerances.size !== 1) return [`group app clocks use different tolerances in round ${round + 1}: ${[...tolerances].join(", ")} ms`]
    const toleranceMs = [...tolerances][0]
    const groupSpreadBoundMs = 2 * toleranceMs + CLOCK_GROUP_MEASUREMENT_ALLOWANCE_MS
    const byTurn = new Map<number, { bot: number; atMs: number }[]>()
    for (const { bot, result } of bots) {
      for (const entry of result!.appClockEvidence!.turnEntries.filter((entry) => entry.round === round)) {
        byTurn.set(entry.turn, [...(byTurn.get(entry.turn) ?? []), { bot, atMs: entry.atMs }])
      }
    }
    const comparable = [...byTurn.entries()].filter(([, entries]) => entries.length >= 2)
    if (!comparable.length) return [`group app clocks have no shared observed turn in round ${round + 1} across bots ${bots.map(({ bot }) => bot).join(", ")}`]
    return comparable.flatMap(([turn, entries]) => {
      const spreadMs = Math.max(...entries.map(({ atMs }) => atMs)) - Math.min(...entries.map(({ atMs }) => atMs))
      return spreadMs > groupSpreadBoundMs
        ? [`group app clocks disagree at turn ${turn}: ${spreadMs} ms spread (limit ${groupSpreadBoundMs} ms = 2 × ${toleranceMs} ms convergence + ${CLOCK_GROUP_MEASUREMENT_ALLOWANCE_MS} ms measured observation allowance), bots ${entries.map(({ bot }) => bot).join(", ")}`]
        : []
    })
  })
}

/** A bot's group is CLEAN when every co-player, in every round, is one of the CORE profiles' bots (`core`: the profile
 *  names with a bot number, profiles.json); otherwise MIXED, naming what else was there: a non-core bot by its
 *  profile, anything we do not run as "real player". `byAccount`: every dispatched bot's account -> its profile. So
 *  a report or guard result can be split into controlled and uncontrolled groups. */
export function classifyGroup(r: SlotResult | null, byAccount: ReadonlyMap<string, string>, core: ReadonlySet<string>): GroupVerdict {
  if (!r?.groups?.length) return { kind: "unknown", label: "unknown (no roster read)", with: [] }
  const others = new Set<string>()
  for (const round of r.groups) {
    for (const m of round.members) {
      if (m.account === r.account) continue
      const profile = byAccount.get(m.account)
      if (!profile) others.add(REAL_PLAYER)
      else if (!core.has(profile)) others.add(profile)
    }
  }
  return others.size ? { kind: "mixed", label: `mixed (with: ${[...others].sort().join(", ")})`, with: [...others].sort() } : { kind: "clean", label: "clean", with: [] }
}

export interface RawResult {
  /** where it came from, for messages (artifact dir / file name) */
  source: string
  /** the file's text */
  text: string
  /** Immutable artifact provenance, when gathered from GitHub Actions. */
  artifact?: { id: number; name: string; bot: number; attempt: number | null }
}

export interface BotRow {
  bot: number
  /** null: no result file arrived for this bot */
  result: SlotResult | null
  /** the heavy artifact (logs, screenshots, video-<bot>.webm) */
  videoLink: string | null
  /** who the bot played with: clean (core bots only) or mixed */
  group: GroupVerdict
  /** the first play attempt was lost with its self-hosted runner before it could leave a usable result */
  preemption: RunnerPreemption | null
}

export type GatherProductVerdict = "passed" | "failed" | "inconclusive" | "missing" | "skipped"
export type GatherVerdictReason =
  | "superseded-attempt"
  | "runner-setup-unavailable"
  | "profile-mismatch"
  | "identity-mismatch"
  | "identity-unconfigured"
  | "stage-failed"
  | "guard-failed"
  | "guard-incomplete"
  | "typed-inconclusive"
  | "journey-incomplete"
  | "run-stage-failed"
  | "run-guard-failed"
  | "run-problem"
  | "run-inconclusive"
  | "no-selected-evidence"

export interface GatherVerdict {
  product: GatherProductVerdict
  reasons: GatherVerdictReason[]
}

/** Every validated result artifact, retained independently of the one selected
 * for the existing gather summary. Public history must never collapse a rerun
 * attempt merely because another attempt reached a deeper stage. */
export interface BotAttemptEvidence {
  bot: number
  attempt: number
  source: string
  result: SlotResult
  artifact: NonNullable<RawResult["artifact"]> | null
  selected: boolean
  /** Product verdict derived once by gather; publishers map it but never
   * re-evaluate raw stages, guards, or free-form result text. */
  verdict: GatherVerdict
}

export interface RunJobEvidence {
  id: number
  run_attempt: number
  name: string
  status: string
  conclusion: string | null
  runner_name: string | null
  runner_group_name: string | null
  labels: string[]
  steps: { name: string; status: string; conclusion: string | null }[]
}

export interface RunEvidence {
  jobs: RunJobEvidence[]
  /** A missing entry means annotation retrieval was unavailable for that job. */
  annotations: Record<string, { available: boolean; messages: string[] }>
}

export interface RunnerPreemption {
  attempt: number
  profile: string
  detail: string
}

export const runnerUnavailable = (result: SlotResult | null): boolean => Boolean(result?.runnerOutcomes?.some(({ kind }) => kind === "shared-registration-deadline-missed" || kind === "shared-network-setup-failed"))

export interface Merged {
  /** the network the bots played on (their results agree; "mixed" if not), "paseo-next-v2" for results written before the field */
  network: string
  rows: BotRow[]
  /** All validated per-attempt evidence. `rows` remains the selected summary
   * view; publication uses this list so reruns remain separately visible. */
  attempts: BotAttemptEvidence[]
  /** Run-wide product validity after aggregate proofs and cross-bot checks.
   * Selected attempt records consume this in addition to their own verdict. */
  verdict: GatherVerdict
  /** why the run is red: a missing result, a wrong person, a different game */
  problems: string[]
  game: { index: number; gameAt: number } | null
  /** every evaluated bot played and settled, at least one was evaluated, none of the problems: the dedupe write is allowed */
  allPlayed: boolean
  /** a stage that FAILED, per bot, with its last notes: red like a guard failure, and the reason the summary gives */
  stageFailures: string[]
  /** failing guards, "bot N: <guard> - <evidence>". They turn the run red but are NOT in `problems`
   *  or `allPlayed`: a guard failing says the bot misbehaved, not that the game was not played */
  guardFailures: string[]
  /** acts that were INCONCLUSIVE (a runner freeze, #341): counted apart, never red on their own */
  inconclusive: string[]
  /** Present only for the opt-in rotate preset; it makes omitted coverage explicit. */
  personaSchedule: PersonaSchedule | null
  adaptiveUpload: AdaptiveUploadProof | null
}

export interface AdaptiveUploadProof {
  status: "pass" | "fail" | "inconclusive"
  reasons: string[]
  targetBot: number
  eligibleObservers: number[]
  decodedObservers: number[]
  mediaPayloadBytes?: number
  mediaHeaderBytes?: number
  webRtcTransportBytes?: number
  webRtcProtocolAllowanceBytes?: number
  webRtcCoverageChargeBytes?: number
  appWebRtcBytes?: number
  webRtcOverheadBytes?: number
  otherRunnerEgressBytes?: number
  transportCoverageGapSeconds?: number
  transportCoverageRatio?: number
  qdiscBoundaryLagSeconds?: number
  qdiscBoundaryChargeBytes?: number
  qdiscSnapshotLatencySeconds?: number
  qdiscSnapshotChargeBytes?: number
  capacityBudgetBytes?: number
  cappedMediaBytes?: number
  nonMediaBytes?: number
  reserveBudgetBytes?: number
  totalEgressRatio?: number
  closingRung?: number
}

const qdiscBytes = (output: string): number | undefined => {
  const values = [...output.matchAll(/Sent\s+(\d+)\s+bytes/g)].map((match) => Number(match[1])).filter(Number.isFinite)
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined
}

const counterDelta = (end: Record<string, number>, start: Record<string, number>, rung: string): number => Math.max(0, (end[rung] ?? 0) - (start[rung] ?? 0))

type AdaptiveTransition = NonNullable<AdaptiveUploadResult["page"]>["transitions"][number]

/** A probe failure is healthy backoff only when it immediately reverses the
 * attempted recovery step, applies to at least one sender, and has pressure
 * evidence. Anything else remains a proof failure. */
function repairedRecoveryFailure(transitions: readonly AdaptiveTransition[], index: number): boolean {
  const failed = transitions[index]
  const attempted = transitions[index - 1]
  const before = failed?.before
  const rttPressureThreshold = before?.baselineRttMs === undefined ? 250 : Math.max(250, 1.75 * before.baselineRttMs)
  const saturated = before?.actualKbps !== undefined
    && before.availableKbps !== undefined
    && before.availableKbps > 0
    && before.actualKbps >= 0.85 * before.availableKbps
    && ((before.queueMsPerPacket ?? -Infinity) >= 20 || (before.rttMs ?? -Infinity) >= rttPressureThreshold)
  return failed?.probe === "failed"
    && failed.direction === "down"
    && failed.cause === "bandwidth"
    && failed.applied > 0
    && ((failed.before.bandwidthShare ?? 0) > 0 || saturated)
    && attempted?.direction === "up"
    && attempted.cause === "recovery"
    && attempted.applied > 0
    && attempted.after !== undefined
    && attempted.from === failed.to
    && attempted.to === failed.from
}

function retainedRecoveryUps(transitions: readonly AdaptiveTransition[]): AdaptiveTransition[] {
  return transitions.filter((transition, index) =>
    transition.direction === "up"
    && transition.after !== undefined
    && !repairedRecoveryFailure(transitions, index + 1),
  )
}

type DecodedTurnSample = NonNullable<NonNullable<AdaptiveUploadResult["page"]>["peers"][number]["decodedSamples"]>[number]

/** Receiver counters are cumulative and sampled on each observer's own
 * unpatched monotonic clock. Global game turns provide the cross-runner
 * boundary; no wall-clock comparison or cadence tolerance is involved. */
const decodedGrowth = (samples: readonly DecodedTurnSample[], include: (turn: number) => boolean): boolean => {
  const phase = samples.filter((sample) => include(sample.turn)).sort((a, b) => a.turn - b.turn || a.firstElapsedMs - b.firstElapsedMs)
  return phase.length > 0 && phase.at(-1)!.lastFramesDecoded > phase[0]!.firstFramesDecoded
}

/** The shaped game can gain connected senders between adjacent observation
 * windows. Each fit is authoritative for the sender set it saw, so proof of
 * the initial capacity fit is an uninterrupted applied bandwidth-down chain
 * from Full to Survival, not necessarily one literal 0 -> 4 transition. */
export function survivalConvergence(transitions: readonly AdaptiveTransition[]): AdaptiveTransition | undefined {
  const survival = VIDEO_RUNGS.at(-1)!.index
  let rung = FULL_VIDEO_RUNG.index
  for (const transition of transitions) {
    if (transition.applied < 1) continue
    if (transition.from !== rung || transition.direction !== "down" || transition.cause !== "bandwidth" || transition.to <= transition.from) return undefined
    rung = transition.to
    if (rung === survival) return transition
    if (rung > survival) return undefined
  }
  return undefined
}

const DEVICE_PROBE_ECONOMY_REASONS = new Set(["probe-weak", "probe-weak-confirmed", "probe-no-verdict"])
/** Selected-pair churn invalidates one link at a time. The reserve proof
 * requires at least three quarters of sender-time to be directly observed.
 * Its separate fully-covered wall-time counter advances only when every valid
 * link has transport evidence, so the complement is charged at full shaped
 * capacity without averaging a dark link across sender count. */
const MIN_TRANSPORT_COVERAGE_RATIO = 0.75
/** A local tc read can be delayed on the two-core runners. Its complete
 * request interval is charged as uncertainty, and a command longer than five
 * normal observation windows is too stale to prove the boundary. */
const MAX_QDISC_SNAPSHOT_LATENCY_MS = 5 * SEND_ADAPTATION_OBSERVE_MS

const hasInGameNetworkPlan = (profile: ReturnType<typeof profileForName>): boolean => Boolean(
  profile?.network.switchAtTurn !== undefined || profile?.network.timeline?.length,
)

/** Fail-closed proof for the explicit uplink-lift run. Missing account-keyed
 * receiver or chain evidence is inconclusive, never silently accepted. */
export function adaptiveUploadProof(results: readonly SlotResult[]): AdaptiveUploadProof {
  const target = results.find((result) => result.profile === UPLINK_LIFT_PROFILE)
  const targetBot = target?.slot ?? 0
  const reasons: string[] = []
  const incomplete: string[] = []
  if (!target) return { status: "inconclusive", reasons: [`${UPLINK_LIFT_PROFILE} result missing`], targetBot, eligibleObservers: [], decodedObservers: [] }
  const evidence = target.adaptiveUpload
  const page = evidence?.page
  if (!page) incomplete.push("target page adaptation evidence missing")
  const snapshots = evidence?.network?.qdiscSnapshots ?? []
  for (const label of ["shaped-start", "survival-start", "step-1-before", "step-1-after", "end"])
    if (!snapshots.some((snapshot) => snapshot.label === label && qdiscBytes(snapshot.output) !== undefined)) incomplete.push(`qdisc ${label} counter snapshot missing`)
  if (evidence?.network?.live !== true || evidence.network.runs.some((run) => !run.ok) || !evidence.network.runs.some((run) => run.call[0] === "swap" && run.call[1] === "lte-good"))
    reasons.push("the live turn-4 lift was not proven")

  const transitions = page?.transitions ?? []
  const down = survivalConvergence(transitions)
  if (!down) reasons.push("no initial Full-to-Survival bandwidth convergence")
  if (down && down.before.activeSenders < 1) reasons.push("downshift had no active video sender")
  const upward = retainedRecoveryUps(transitions)
  if (upward.length < 2) reasons.push(`only ${upward.length} completed post-lift upward probes; need 2`)
  const unrepairedProbe = transitions.findIndex((transition, index) => transition.probe === "failed" && !repairedRecoveryFailure(transitions, index))
  if (unrepairedProbe >= 0) reasons.push("a recovery probe failed without an applied return to its prior rung")
  if (page && (page.lowPower || page.lowPowerReason === "encode-cpu") && !DEVICE_PROBE_ECONOMY_REASONS.has(page.lowPowerReason))
    reasons.push(`unexpected economy reason during upload proof (${page.lowPowerReason})`)
  if ((page?.roundSecondsByRung.survival ?? 0) <= 0) reasons.push("no measured Survival interval")
  if (page && page.rung >= VIDEO_RUNGS.at(-1)!.index) reasons.push("closing rung did not recover above Survival")

  const start = snapshots.find((snapshot) => snapshot.label === "survival-start")
  const beforeLift = snapshots.find((snapshot) => snapshot.label === "step-1-before")
  const liftTurn = profileForName(UPLINK_LIFT_PROFILE)?.network.timeline?.find((step) => step.profile)?.atTurn
  if (liftTurn === undefined) incomplete.push("uplink lift turn missing from profile")

  const targetGroupAccounts = new Set(target.groups?.flatMap((round) => round.members.map((member) => member.account)) ?? [])
  if (!target.groups?.length) incomplete.push("target group roster missing")
  const eligible = results.filter(
    (result) => result.slot !== target.slot
      && result.game?.index === target.game?.index
      && typeof result.account === "string"
      && targetGroupAccounts.has(result.account)
      && !hasInGameNetworkPlan(profileForName(result.profile)),
  )
  const eligibleObservers = eligible.map((result) => result.slot)
  const networkPersonaAccounts = new Set(results.filter(
    (result) => result.slot !== target.slot
      && typeof result.account === "string"
      && targetGroupAccounts.has(result.account)
      && hasInGameNetworkPlan(profileForName(result.profile)),
  ).map((result) => result.account!))
  // Reviewed formula: target group minus target minus known network personas,
  // capped at three and floored at two. Missing result evidence therefore
  // cannot silently lower an ordinary game's observer quorum.
  const requiredObserverCount = Math.max(2, Math.min(3, targetGroupAccounts.size - 1 - networkPersonaAccounts.size))
  const decodedObservers: number[] = []
  for (const observer of eligible) {
    const account = target.account
    if (!account) {
      incomplete.push("target account missing")
      break
    }
    const peer = observer.adaptiveUpload?.page?.peers.find((candidate) => candidate.account === account)
    const samples = peer?.decodedSamples ?? []
    const shapedDecoded = liftTurn !== undefined && decodedGrowth(samples, (turn) => turn < liftTurn)
    const postLiftDecoded = liftTurn !== undefined && decodedGrowth(samples, (turn) => turn >= liftTurn)
    const decoded = shapedDecoded && postLiftDecoded
    const seen = observer.videoRoleProof?.turns.some((turn) => turn.roles[account] !== undefined && turn.roles[account] !== "unseen") ?? false
    const safeVote = observer.videoRoleProof?.turns.some((turn) => {
      const verdict = turn.verdicts[account]
      return verdict !== undefined && !/not.?person|reject/i.test(verdict)
    }) ?? false
    if (decoded) decodedObservers.push(observer.slot)
    if (!peer) incomplete.push(`observer ${observer.slot} target peer is missing`)
    else {
      if (!shapedDecoded) incomplete.push(`observer ${observer.slot} has no shaped-interval decoded-video growth`)
      if (!postLiftDecoded) incomplete.push(`observer ${observer.slot} has no post-lift decoded-video growth`)
    }
    if (!seen) incomplete.push(`observer ${observer.slot} has no target-account seen proof`)
    if (!safeVote || observer.reportSeen !== true) incomplete.push(`observer ${observer.slot} has no safe filed chain-vote proof`)
  }
  if (eligible.length < requiredObserverCount)
    incomplete.push(`only ${eligible.length} eligible observer${eligible.length === 1 ? "" : "s"}; need ${requiredObserverCount}`)
  if (decodedObservers.length < requiredObserverCount)
    incomplete.push(`only ${decodedObservers.length} decoded observer${decodedObservers.length === 1 ? "" : "s"}; need ${requiredObserverCount}`)
  if (target.reportSeen !== true || target.settled !== true || !target.game || target.lastAttendedGame !== target.game.index)
    incomplete.push("target attendance/report/settlement proof missing")

  let nonMediaBytes: number | undefined
  let reserveBudgetBytes: number | undefined
  let totalEgressRatio: number | undefined
  let mediaPayloadBytes: number | undefined
  let mediaHeaderBytes: number | undefined
  let webRtcTransportBytes: number | undefined
  let webRtcProtocolAllowanceBytes: number | undefined
  let webRtcCoverageChargeBytes: number | undefined
  let appWebRtcBytes: number | undefined
  let webRtcOverheadBytes: number | undefined
  let otherRunnerEgressBytes: number | undefined
  let transportCoverageGapSeconds: number | undefined
  let transportCoverageRatio: number | undefined
  let qdiscBoundaryLagSeconds: number | undefined
  let qdiscBoundaryChargeBytes: number | undefined
  let qdiscSnapshotLatencySeconds: number | undefined
  let qdiscSnapshotChargeBytes: number | undefined
  let capacityBudgetBytes: number | undefined
  let cappedMediaBytes: number | undefined
  let totalMediaPayloadBytes: number | undefined
  const startBytes = start && qdiscBytes(start.output)
  const endBytes = beforeLift && qdiscBytes(beforeLift.output)
  const startAdaptation = start?.adaptation
  const endAdaptation = beforeLift?.adaptation
  const seconds = startAdaptation && endAdaptation ? counterDelta(endAdaptation.roundSecondsByRung, startAdaptation.roundSecondsByRung, "survival") : undefined
  const transportSeconds = startAdaptation?.roundTransportSecondsByRung && endAdaptation?.roundTransportSecondsByRung
    ? counterDelta(endAdaptation.roundTransportSecondsByRung, startAdaptation.roundTransportSecondsByRung, "survival")
    : undefined
  const startBoundaryMs = start?.requestStartedAtMs ?? start?.atMs
  const endBoundaryMs = beforeLift?.requestStartedAtMs ?? beforeLift?.atMs
  const intervalSeconds = startBoundaryMs !== undefined && endBoundaryMs !== undefined && endBoundaryMs > startBoundaryMs
    ? (endBoundaryMs - startBoundaryMs) / 1_000
    : undefined
  const otherRungSeconds =
    startAdaptation && endAdaptation
      ? VIDEO_RUNGS.filter((rung) => rung.name !== "survival").reduce(
          (sum, rung) => sum + counterDelta(endAdaptation.roundSecondsByRung, startAdaptation.roundSecondsByRung, rung.name),
          0,
        )
      : undefined
  const survivalSenders = Math.max(
    down?.before.activeSenders ?? 0,
    startAdaptation?.lastWindow?.activeSenders ?? 0,
    endAdaptation?.lastWindow?.activeSenders ?? 0,
  )
  if (startBytes !== undefined && endBytes !== undefined && seconds && intervalSeconds && otherRungSeconds === 0 && down && startAdaptation?.currentRung === VIDEO_RUNGS.at(-1)!.index) {
    const endAligned = endAdaptation!
    const egress = Math.max(0, endBytes - startBytes)
    totalMediaPayloadBytes = counterDelta(endAligned.roundPayloadBytesByRung, startAdaptation.roundPayloadBytesByRung, "survival")
    mediaPayloadBytes = totalMediaPayloadBytes
    mediaHeaderBytes = counterDelta(endAligned.roundHeaderBytesByRung, startAdaptation.roundHeaderBytesByRung, "survival")
    nonMediaBytes = Math.max(0, egress - totalMediaPayloadBytes)
    if (startAdaptation.roundTransportBytesByRung && endAligned.roundTransportBytesByRung && startAdaptation.roundTransportAllowanceBytesByRung && endAligned.roundTransportAllowanceBytesByRung && transportSeconds !== undefined) {
      webRtcTransportBytes = counterDelta(endAligned.roundTransportBytesByRung, startAdaptation.roundTransportBytesByRung, "survival")
      webRtcProtocolAllowanceBytes = counterDelta(endAligned.roundTransportAllowanceBytesByRung, startAdaptation.roundTransportAllowanceBytesByRung, "survival")
      const perLinkCoverage = startAdaptation.roundTransportCoveredPayloadBytesByRung
        && endAligned.roundTransportCoveredPayloadBytesByRung
        && startAdaptation.roundTransportCoveredHeaderBytesByRung
        && endAligned.roundTransportCoveredHeaderBytesByRung
        && startAdaptation.roundTransportCoveredSenderSecondsByRung
        && endAligned.roundTransportCoveredSenderSecondsByRung
        && startAdaptation.roundTransportExpectedSenderSecondsByRung
        && endAligned.roundTransportExpectedSenderSecondsByRung
      if (perLinkCoverage) {
        mediaPayloadBytes = counterDelta(endAligned.roundTransportCoveredPayloadBytesByRung!, startAdaptation.roundTransportCoveredPayloadBytesByRung!, "survival")
        mediaHeaderBytes = counterDelta(endAligned.roundTransportCoveredHeaderBytesByRung!, startAdaptation.roundTransportCoveredHeaderBytesByRung!, "survival")
        const coveredSenderSeconds = counterDelta(endAligned.roundTransportCoveredSenderSecondsByRung!, startAdaptation.roundTransportCoveredSenderSecondsByRung!, "survival")
        const expectedSenderSeconds = counterDelta(endAligned.roundTransportExpectedSenderSecondsByRung!, startAdaptation.roundTransportExpectedSenderSecondsByRung!, "survival")
        transportCoverageRatio = expectedSenderSeconds > 0 ? Math.min(1, coveredSenderSeconds / expectedSenderSeconds) : undefined
      } else {
        transportCoverageRatio = seconds > 0 ? Math.min(1, transportSeconds / seconds) : undefined
      }
      // roundTransportSeconds advances only for windows in which every valid
      // link is covered. Charge every wall second with any uncovered link at
      // the full shaped rate; never divide this uncertainty by sender count.
      transportCoverageGapSeconds = Math.max(0, seconds - transportSeconds)
      qdiscBoundaryLagSeconds = Math.max(0, intervalSeconds - seconds)
      const snapshotTimingComplete = [start, beforeLift].every((snapshot) =>
        snapshot?.requestStartedAtMs !== undefined
        && snapshot.requestEndedAtMs !== undefined
        && snapshot.requestEndedAtMs >= snapshot.requestStartedAtMs,
      )
      const snapshotLatenciesMs = [start, beforeLift].map((snapshot) =>
        snapshot?.requestStartedAtMs !== undefined && snapshot.requestEndedAtMs !== undefined
          ? Math.max(0, snapshot.requestEndedAtMs - snapshot.requestStartedAtMs)
          : 0,
      )
      qdiscSnapshotLatencySeconds = snapshotLatenciesMs.reduce((sum, value) => sum + value, 0) / 1_000
      if (webRtcTransportBytes < mediaPayloadBytes) incomplete.push("WebRTC transport bytes are below covered RTP payload bytes")
      if (transportCoverageGapSeconds === undefined) incomplete.push("per-link WebRTC transport coverage denominator missing")
      if (transportCoverageRatio !== undefined && transportCoverageRatio < MIN_TRANSPORT_COVERAGE_RATIO)
        incomplete.push(`WebRTC transport coverage ${(100 * transportCoverageRatio).toFixed(1)}% is below 75%`)
      if (qdiscBoundaryLagSeconds > (2 * SEND_ADAPTATION_OBSERVE_MS) / 1_000 + 0.05)
        incomplete.push(`qdisc boundary lag ${qdiscBoundaryLagSeconds.toFixed(3)} s exceeds two observe windows`)
      if (!snapshotTimingComplete) incomplete.push("qdisc snapshot request timing evidence missing or invalid")
      for (const latencyMs of snapshotLatenciesMs)
        if (latencyMs > MAX_QDISC_SNAPSHOT_LATENCY_MS)
          incomplete.push(`qdisc snapshot request latency ${(latencyMs / 1_000).toFixed(3)} s exceeds five observe windows`)
      webRtcCoverageChargeBytes = (FULL_VIDEO_RUNG.maxBitrate * (transportCoverageGapSeconds ?? 0)) / 8
      qdiscBoundaryChargeBytes = (FULL_VIDEO_RUNG.maxBitrate * Math.min(qdiscBoundaryLagSeconds, (2 * SEND_ADAPTATION_OBSERVE_MS) / 1_000)) / 8
      qdiscSnapshotChargeBytes = (FULL_VIDEO_RUNG.maxBitrate * qdiscSnapshotLatencySeconds) / 8
      appWebRtcBytes = webRtcTransportBytes + webRtcProtocolAllowanceBytes + webRtcCoverageChargeBytes + qdiscBoundaryChargeBytes + qdiscSnapshotChargeBytes
      webRtcOverheadBytes = Math.max(0, webRtcTransportBytes - mediaPayloadBytes) + webRtcProtocolAllowanceBytes + webRtcCoverageChargeBytes + qdiscBoundaryChargeBytes + qdiscSnapshotChargeBytes
      otherRunnerEgressBytes = Math.max(0, egress - webRtcTransportBytes - webRtcProtocolAllowanceBytes)
    } else {
      incomplete.push("aligned WebRTC transport-byte/allowance evidence missing")
    }
    capacityBudgetBytes = (FULL_VIDEO_RUNG.maxBitrate * intervalSeconds) / 8
    cappedMediaBytes = (survivalSenders * VIDEO_RUNGS.at(-1)!.maxBitrate * intervalSeconds) / 8
    reserveBudgetBytes = capacityBudgetBytes - cappedMediaBytes
    totalEgressRatio = capacityBudgetBytes > 0 ? egress / capacityBudgetBytes : undefined
    const cappedMediaBitrate = survivalSenders * VIDEO_RUNGS.at(-1)!.maxBitrate
    if (cappedMediaBitrate * 4 > FULL_VIDEO_RUNG.maxBitrate * 3)
      reasons.push(`capped Survival media ${cappedMediaBitrate} bit/s exceeds 75% capacity ${(FULL_VIDEO_RUNG.maxBitrate * 3) / 4} bit/s`)
    if (appWebRtcBytes !== undefined && appWebRtcBytes > capacityBudgetBytes)
      reasons.push(`app WebRTC ${Math.round(appWebRtcBytes)} B exceeds shaped capacity ${Math.round(capacityBudgetBytes)} B`)
  } else if (otherRungSeconds !== undefined && otherRungSeconds > 0) incomplete.push("survival reserve interval includes another video rung")
  else incomplete.push("aligned survival reserve/headroom inputs missing")

  return {
    status: incomplete.length ? "inconclusive" : reasons.length ? "fail" : "pass",
    reasons: [...incomplete, ...reasons],
    targetBot,
    eligibleObservers,
    decodedObservers,
    ...(mediaPayloadBytes === undefined ? {} : { mediaPayloadBytes }),
    ...(mediaHeaderBytes === undefined ? {} : { mediaHeaderBytes }),
    ...(webRtcTransportBytes === undefined ? {} : { webRtcTransportBytes }),
    ...(webRtcProtocolAllowanceBytes === undefined ? {} : { webRtcProtocolAllowanceBytes }),
    ...(webRtcCoverageChargeBytes === undefined ? {} : { webRtcCoverageChargeBytes }),
    ...(appWebRtcBytes === undefined ? {} : { appWebRtcBytes }),
    ...(webRtcOverheadBytes === undefined ? {} : { webRtcOverheadBytes }),
    ...(otherRunnerEgressBytes === undefined ? {} : { otherRunnerEgressBytes }),
    ...(transportCoverageGapSeconds === undefined ? {} : { transportCoverageGapSeconds }),
    ...(transportCoverageRatio === undefined ? {} : { transportCoverageRatio }),
    ...(qdiscBoundaryLagSeconds === undefined ? {} : { qdiscBoundaryLagSeconds }),
    ...(qdiscBoundaryChargeBytes === undefined ? {} : { qdiscBoundaryChargeBytes }),
    ...(qdiscSnapshotLatencySeconds === undefined ? {} : { qdiscSnapshotLatencySeconds }),
    ...(qdiscSnapshotChargeBytes === undefined ? {} : { qdiscSnapshotChargeBytes }),
    ...(capacityBudgetBytes === undefined ? {} : { capacityBudgetBytes }),
    ...(cappedMediaBytes === undefined ? {} : { cappedMediaBytes }),
    ...(nonMediaBytes === undefined ? {} : { nonMediaBytes }),
    ...(reserveBudgetBytes === undefined ? {} : { reserveBudgetBytes }),
    ...(totalEgressRatio === undefined ? {} : { totalEgressRatio }),
    ...(page ? { closingRung: page.rung } : {}),
  }
}

/** one cell: "3 pass, 1 fail, 2 not evaluated, 1 pending" (none: "-") */
export function guardCell(gs: readonly GuardResult[] | undefined): string {
  if (!gs || gs.length === 0) return "-"
  const t = tally(gs)
  return [t.pass && `${t.pass} pass`, t.fail && `**${t.fail} FAIL**`, t["not-evaluated"] && `${t["not-evaluated"]} not evaluated`, t.pending && `${t.pending} pending`].filter(Boolean).join(", ")
}

export interface VideoLinks {
  /** https://github.com/<repo>/actions/runs/<id> */
  runUrl: string
  runId: string
  executionKey: string
  /** Every immutable artifact id/name pair, preserving duplicate names. */
  artifacts?: readonly { id: number; name: string }[]
}

/** A link to the bot's heavy artifact, which holds its video (the ID form when
 *  the run's artifact listing has it; null when the listing exists and does
 *  not, i.e. the runner never uploaded; else the run page, whose Artifacts
 *  section lists it by name). Gather itself downloads only the small results. */
export function videoLink(v: VideoLinks, bot: number, attempt?: number): string | null {
  validateExecutionKey(v.executionKey)
  if (!v.artifacts) return `${v.runUrl}#artifacts`
  const exactName = attempt === undefined
    ? artifactName(v.runId, bot, v.executionKey)
    : attemptArtifactName(v.runId, bot, attempt, v.executionKey)
  const exact = v.artifacts.filter((artifact) => artifact.name === exactName)
  if (exact.length === 1) return `${v.runUrl}/artifacts/${exact[0].id}`

  return null
}

export function parseResult(raw: RawResult): { result: SlotResult } | { error: string } {
  let json: unknown
  try {
    json = JSON.parse(raw.text)
  } catch (e) {
    return { error: `${raw.source}: not valid JSON (${e instanceof Error ? e.message : String(e)})` }
  }
  try {
    return { result: normalizeSlotResult(json) }
  } catch (error) {
    return { error: `${raw.source}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const STAGES = ["a", "b", "c", "d"] as const

/** Evidence depth, independent of whether that stage passed or failed. A
 * failure in (d) is farther—and more useful—than a clean restart skip in (b). */
function reachedStage(result: SlotResult): number {
  let reached = -1
  for (let index = 0; index < STAGES.length; index++)
    if (result.stages[STAGES[index]].status !== "not-run") reached = index
  return reached
}

export const attemptOf = (result: SlotResult): number => result.run?.attempt ?? 1

/** A restarted job that refused to replay the probed game (#397). Its result
 * explains the rerun; it is never better evidence than an earlier attempt. */
const superseded = (result: SlotResult): boolean =>
  result.run?.superseded === true || result.run?.skipped?.kind === "restarted-after-probed-game"

export function attemptVerdict(result: SlotResult, plannedProfile?: string, plannedIdentity?: string): GatherVerdict {
  if (superseded(result)) return { product: "skipped", reasons: ["superseded-attempt"] }
  if (runnerUnavailable(result)) return { product: "missing", reasons: ["runner-setup-unavailable"] }
  const failures: GatherVerdictReason[] = []
  if (plannedProfile && result.profile !== plannedProfile) failures.push("profile-mismatch")
  if (!plannedIdentity) failures.push("identity-unconfigured")
  else if (result.username !== plannedIdentity) failures.push("identity-mismatch")
  if (Object.values(result.stages).some(({ status }) => status === "fail")) failures.push("stage-failed")
  if (result.guards.some(({ status }) => status === "fail")) failures.push("guard-failed")
  if (failures.some((reason) => reason !== "identity-unconfigured")) return { product: "failed", reasons: [...new Set(failures)] }
  const inconclusive = [...failures]
  if (result.guards.some(({ status }) => status === "pending" || status === "not-evaluated")) inconclusive.push("guard-incomplete")
  if ((result.inconclusive?.length ?? 0) > 0) inconclusive.push("typed-inconclusive")
  if (inconclusive.length > 0) return { product: "inconclusive", reasons: [...new Set(inconclusive)] }
  return playedAndSettled(result)
    ? { product: "passed", reasons: [] }
    : { product: "inconclusive", reasons: ["journey-incomplete"] }
}

/** The game this run's probe chose (its `game_at` output). */
export interface ProbedGame {
  gameAt: number
}

/** Pick evidence by the furthest journey stage. On an equal stage the earlier
 * attempt wins: a scheduler rerun must not hide the first attempt's failure.
 * A superseded attempt ranks below every earlier attempt that left a result,
 * whatever stage either reached: its restart skip counts as reaching (b), and
 * letting that beat an attempt that failed in (a), or a supervisor's synthetic
 * row, would bring back #498's misleading "saw no game in Registration". */
export function bestResult<T extends { result: SlotResult; source: string }>(
  all: readonly T[],
  probedGame?: ProbedGame,
): T {
  // After "Re-run all jobs" the probe may pick a new game Y; an attempt that
  // played the old game X must not outrank (or be merged with) attempt 2's Y.
  // A candidate with no game (it failed before reading one) stays eligible. If
  // every candidate played another game, keep them all rather than lose evidence.
  const sameGame = probedGame
    ? all.filter((c) => !c.result.game || c.result.game.gameAt === probedGame.gameAt)
    : all
  const candidates = sameGame.length ? sameGame : all
  const outranked = (c: T): boolean =>
    superseded(c.result) && candidates.some((o) => attemptOf(o.result) < attemptOf(c.result))
  const pool = candidates.filter((c) => !outranked(c))
  return [...(pool.length ? pool : candidates)].sort(
    (a, b) =>
      reachedStage(b.result) - reachedStage(a.result) ||
      attemptOf(a.result) - attemptOf(b.result) ||
      a.source.localeCompare(b.source),
  )[0]
}

/** `bots`: the bot numbers that were dispatched. `identities`: bot -> the username its profile plays as
 *  (timing.ts botMatrix, from profiles.json): the only check that each secret is the person it should be. */
export function mergeResults(opts: {
  bots: readonly number[]
  raws: readonly RawResult[]
  identities: Readonly<Record<number, string>>
  /** account -> profile for every bot WE run, from the pool (E2E_IDENTITIES) and the profiles, so a bot with no result
   *  (its runner died) does not make its group partners read as real players. Results override it. */
  knownAccounts?: ReadonlyMap<string, string>
  /** the core profile names (profiles.json profiles with a bot number): a group of only these is clean */
  coreProfiles?: ReadonlySet<string>
  links: VideoLinks
  /** the dispatched network, for a run where no bot wrote a result */
  network?: string
  /** bot -> dispatched profile, so a runner that wrote no result still has a role in the summary */
  profiles?: Readonly<Record<number, string>>
  /** read-only GitHub Actions job and check-annotation evidence for every run attempt */
  runEvidence?: RunEvidence
  /** Exact probe-produced physical-runner grouping. Needed to map one lost
   * grouped job to each logical bot whose result is missing. */
  runnerGroups?: readonly RunnerGroupManifestEntry[]
  /** The probe/gather schedule recomputed from the same GitHub run number. */
  personaSchedule?: PersonaSchedule
  /** Fail-closed errors from listing/downloading immutable result artifacts. */
  acquisitionProblems?: readonly string[]
  /** The probe's game: results of an attempt that played a different game are not evidence for this run. */
  probedGame?: ProbedGame
  /** The bots that drew a person from the fresh pool. A re-run of a failed job reuses that person, whom the earlier
   *  attempt may already have bound, so a result of attempt 2 or later did not exercise the unbound path (#614). */
  freshBots?: readonly number[]
  /** Probe-resolved named proof intent and the exact checkout it requested. */
  proofs?: readonly string[]
  proofHead?: string
}): Merged {
  const executionKey = validateExecutionKey(opts.links.executionKey)
  const problems: string[] = [...(opts.acquisitionProblems ?? [])]
  type Candidate = { result: SlotResult; source: string; artifact: NonNullable<RawResult["artifact"]> | null }
  const candidatesBySlot = new Map<number, Candidate[]>()
  for (const raw of opts.raws) {
    if (raw.artifact) {
      const identity = parseResultArtifactIdentity(opts.links.runId, raw.artifact.name)
      if (!identity) {
        problems.push(`${raw.source}: invalid result artifact name`)
        continue
      }
      if (identity.executionKey !== executionKey) continue
      if (identity.bot !== raw.artifact.bot || identity.attempt !== raw.artifact.attempt) {
        problems.push(`${raw.source}: artifact metadata disagrees with its name`)
        continue
      }
    }
    const p = parseResult(raw)
    if ("error" in p) {
      problems.push(p.error)
      continue
    }
    if (raw.artifact && p.result.slot !== raw.artifact.bot) {
      problems.push(`${raw.source}: result says bot ${p.result.slot}, but artifact ${raw.artifact.name} belongs to bot ${raw.artifact.bot}`)
      continue
    }
    const resultAttempt = p.result.run?.attempt
    if (raw.artifact?.attempt !== null && raw.artifact?.attempt !== undefined && resultAttempt !== raw.artifact.attempt) {
      problems.push(`${raw.source}: result says attempt ${resultAttempt ?? "missing"}, but artifact ${raw.artifact.name} belongs to attempt ${raw.artifact.attempt}`)
      continue
    }
    const candidates = candidatesBySlot.get(p.result.slot) ?? []
    candidates.push({ result: p.result, source: raw.source, artifact: raw.artifact ?? null })
    candidatesBySlot.set(p.result.slot, candidates)
  }
  const bySlot = new Map<number, SlotResult>()
  const selectedBySlot = new Map<number, Candidate>()
  for (const [slot, candidates] of candidatesBySlot) {
    const byAttempt = new Map<number, string[]>()
    for (const candidate of candidates) {
      const attempt = attemptOf(candidate.result)
      byAttempt.set(attempt, [...(byAttempt.get(attempt) ?? []), candidate.source])
    }
    for (const [attempt, sources] of byAttempt)
      if (sources.length > 1)
        problems.push(
          `bot ${slot}: two result files for attempt ${attempt} (${sources.join(" and ")})`,
        )
    const selected = bestResult(candidates, opts.probedGame)
    selectedBySlot.set(slot, selected)
    bySlot.set(slot, selected.result)
  }
  for (const n of bySlot.keys()) if (!opts.bots.includes(n)) problems.push(`result for bot ${n}, which was not dispatched (bots: ${opts.bots.join(", ")})`)
  for (const result of bySlot.values()) {
    const group = opts.runnerGroups?.find(({ bots }) => bots.includes(result.slot))
    if (group) result.runner = { group: group.group, size: group.bots.length, shared: group.shared, measure: group.measure }
  }
  const attempts: BotAttemptEvidence[] = [...candidatesBySlot.entries()]
    .flatMap(([bot, candidates]) => candidates.map((candidate) => ({
      bot,
      attempt: attemptOf(candidate.result),
      source: candidate.source,
      result: candidate.result,
      artifact: candidate.artifact,
      selected: selectedBySlot.get(bot) === candidate,
      verdict: attemptVerdict(candidate.result, opts.profiles?.[bot], opts.identities[bot]),
    })))
    .sort((one, two) => one.bot - two.bot || one.attempt - two.attempt || one.source.localeCompare(two.source))

  for (const bot of opts.bots) if (!opts.identities[bot]) problems.push(`bot ${bot}: no identity to check its username against (the profile names none): add "identity" to the profile`)

  const byAccount = new Map<string, string>(opts.knownAccounts ?? [])
  for (const r of bySlot.values()) if (r.account) byAccount.set(r.account, r.profile)
  const rows: BotRow[] = opts.bots.map((bot) => {
    const result = bySlot.get(bot) ?? null
    const profile = opts.profiles?.[bot] ?? result?.profile ?? "unknown"
    const preemption = runnerPreemption(bot, profile, result, opts.runEvidence, executionKey)
    const unavailable = runnerUnavailable(result)
    if (!result && !preemption) problems.push(`bot ${bot}: no result-${bot}.json arrived (the runner died before writing it, or its artifact is missing)`)
    const expected = opts.identities[bot]
    if (result && !preemption && !unavailable && expected && result.username !== expected) {
      problems.push(`bot ${bot}: paired as "${result.username ?? "nobody"}", expected "${expected}" (the identity of profile ${result.profile ?? "?"}): its E2E_POOL entry or legacy secret ${identitySecretName(expected)} is a different person`)
    }
    for (const outcome of result?.runnerOutcomes ?? []) problems.push(`bot ${bot} (${profile}): ${outcome.kind} - ${outcome.detail}`)
    return { bot, result, preemption, videoLink: videoLink(opts.links, bot, result?.run?.attempt), group: classifyGroup(preemption || unavailable ? null : result, byAccount, opts.coreProfiles ?? new Set()) }
  })

  if (opts.proofs?.length && rows.some((row) => /^dim2-pr\d+-sandbox00\./.test(row.result?.app?.app ?? ""))) {
    const requested = opts.proofHead?.trim().toLowerCase() ?? ""
    for (const row of rows) {
      const actual = row.result?.app?.commit?.trim().toLowerCase() ?? ""
      if (!/^[0-9a-f]{40}$/.test(requested) || actual !== requested) {
        problems.push(`bot ${row.bot} (${opts.profiles?.[row.bot] ?? row.result?.profile ?? "unknown"}) ran on old build ${actual ? actual.slice(0, 12) : "unknown"}; named proof requires requested head ${requested || "unknown"}`)
      }
    }
  }

  const games = new Set(rows.flatMap((r) => (!r.preemption && !runnerUnavailable(r.result) && r.result?.game ? [`${r.result.game.index}@${r.result.game.gameAt}`] : [])))
  if (games.size > 1) problems.push(`the bots played different games: ${[...games].join(", ")}`)
  const first = rows.find((r) => !r.preemption && r.result?.game)?.result?.game ?? null
  for (const r of rows) if (r.result && !r.preemption && !runnerUnavailable(r.result) && !r.result.game && r.result.expectedOutcome?.kind !== "camera-unavailable") problems.push(`bot ${r.bot}: saw no game in Registration (it joined nothing)`)

  const stageFailures = rows.flatMap((r) =>
    (["a", "b", "c", "d"] as const)
      .filter((s) => !r.preemption && r.result?.stages[s].status === "fail")
      .map((s) => `bot ${r.bot} (${r.result?.profile}): stage (${s}) failed: ${r.result?.stages[s].notes.slice(-2).join("; ") || "no notes"}`),
  )
  const guardFailures = rows.flatMap((r) => (r.preemption ? [] : (r.result?.guards ?? []).filter((g) => g.status === "fail").map((g) => `bot ${r.bot} (${r.result?.profile}, group ${r.group.label}): ${g.description} - ${g.evidence}`)))
  guardFailures.push(...appClockAgreementFailures(rows))
  guardFailures.push(...rows.flatMap((row) => row.preemption || !row.result ? [] : clockEvidenceFailures(row.result).map((failure) => `bot ${row.bot} (${row.result!.profile}): ${failure}`)))
  const requestedProof = videoRoleProofPlan()
  const videoRoleProofRequested = opts.bots.length === requestedProof.length
    && requestedProof.every(({ bot, profile }) => opts.bots.includes(bot) && opts.profiles?.[bot] === profile)
  if (videoRoleProofRequested) {
    for (const row of rows) {
      const requested = opts.profiles?.[row.bot]
      if (!row.result || row.preemption) {
        problems.push(`video-role-proof requested persona bot ${row.bot} (${requested}) has no original result${row.preemption ? " (runner preempted)" : ""}`)
      } else if (row.result.profile !== requested) {
        problems.push(`video-role-proof bot ${row.bot} requested ${requested} but received result profile ${row.result.profile}`)
      }
    }
    const proof = verifyVideoRoleProof(rows.flatMap((row) => !row.preemption && row.result ? [row.result] : []))
    if (proof.status !== "pass") guardFailures.push(`${proof.name}: ${proof.detail}`)
  }
  const inconclusive = rows.flatMap((r) => [
    ...(r.preemption ? [`bot ${r.bot} (${r.preemption.profile}): runner preempted - ${r.preemption.detail}`] : []),
    ...(r.preemption ? [] : (r.result?.inconclusive ?? []).map((c) => `bot ${r.bot} (${r.result?.profile}): ${c.name} - ${c.detail}`)),
    ...(!r.preemption && opts.freshBots?.includes(r.bot) && (r.result?.run?.attempt ?? 1) > 1
      ? [`bot ${r.bot} (${r.result?.profile}): attempt ${r.result?.run?.attempt} reused the drawn fresh person, whom an earlier attempt may have bound; the unbound path (preparing your seat) was not proven`]
      : []),
  ])
  const networks = [...new Set(rows.flatMap((r) => (!r.preemption && r.result ? [r.result.network ?? "paseo-next-v2"] : [])))]
  if (networks.length > 1) problems.push(`the bots played on different networks: ${networks.join(", ")}`)
  const evaluated = rows.filter((r) => !r.preemption && !runnerUnavailable(r.result))
  const adaptiveUploadRequested = rows.some((row) => row.result?.profile === UPLINK_LIFT_PROFILE)
    || Object.values(opts.profiles ?? {}).includes(UPLINK_LIFT_PROFILE)
  const adaptiveUpload = adaptiveUploadRequested
    ? adaptiveUploadProof(rows.flatMap((row) => row.result ? [row.result] : []))
    : null
  if (adaptiveUpload && adaptiveUpload.status !== "pass") guardFailures.push(`adaptive upload proof: ${adaptiveUpload.reasons.join("; ")}`)
  if (adaptiveUpload?.status === "inconclusive") inconclusive.push(`adaptive upload proof: ${adaptiveUpload.reasons.join("; ")}`)
  const selectedVerdicts = attempts.filter(({ selected }) => selected).map(({ verdict }) => verdict)
  const verdictReasons: GatherVerdictReason[] = [
    ...(stageFailures.length > 0 ? ["run-stage-failed" as const] : []),
    ...(guardFailures.length > 0 ? ["run-guard-failed" as const] : []),
    ...(problems.length > 0 ? ["run-problem" as const] : []),
    ...(inconclusive.length > 0 || selectedVerdicts.some(({ product }) => product === "inconclusive" || product === "missing")
      ? ["run-inconclusive" as const]
      : []),
    ...(selectedVerdicts.length === 0 ? ["no-selected-evidence" as const] : []),
  ]
  const verdict: GatherVerdict = stageFailures.length > 0
    || guardFailures.length > 0
    || selectedVerdicts.some(({ product }) => product === "failed")
    ? { product: "failed", reasons: [...new Set(verdictReasons)] }
    : problems.length > 0
      || inconclusive.length > 0
      || selectedVerdicts.some(({ product }) => product !== "passed")
      ? { product: selectedVerdicts.length === 0 ? "missing" : "inconclusive", reasons: [...new Set(verdictReasons)] }
      : { product: "passed", reasons: [] }
  return {
    network: networks.length === 1 ? networks[0] : networks.length ? "mixed" : (opts.network ?? "unknown"),
    rows,
    attempts,
    verdict,
    problems,
    inconclusive,
    stageFailures,
    guardFailures,
    personaSchedule: opts.personaSchedule ?? null,
    adaptiveUpload,
    game: first ? { index: first.index, gameAt: first.gameAt } : null,
    allPlayed: evaluated.length > 0 && evaluated.every((r) => r.result !== null && playedAndSettled(r.result)) && problems.length === 0,
  }
}

const RUNNER_LOST_MESSAGE = /self-hosted runner lost communication with the server/i
export const PLAY_JOB = /^play \[([a-z0-9][a-z0-9-]{0,63})\] \(bot (\d+), .+\)$/
export const GROUP_JOB = /^play \[([a-z0-9][a-z0-9-]{0,63})\] \(group ([^,]+), bots ([0-9-]+)\)$/

export function botsOfJobName(name: string, executionKey: string): number[] {
  validateExecutionKey(executionKey)
  const leaf = name.split(" / ").at(-1) ?? name
  const singleton = PLAY_JOB.exec(leaf)
  const grouped = GROUP_JOB.exec(leaf)
  const bots = singleton?.[1] === executionKey ? [Number(singleton[2])] : grouped?.[1] === executionKey ? grouped[3].split("-").map(Number) : []
  return bots.filter((bot) => Number.isSafeInteger(bot) && bot > 0)
}

function restartedAfterProbedGame(result: SlotResult | null): { attempt: number; current: number | null } | null {
  const run = result?.run
  if (!run || run.attempt <= 1 || run.skipped?.kind !== "restarted-after-probed-game") return null
  return { attempt: run.attempt, current: typeof run.skipped.current?.index === "number" ? run.skipped.current.index : null }
}

function selfHosted(job: RunJobEvidence): boolean {
  return job.runner_group_name === "internal" || job.labels.some((label) => label.startsWith("parity-int-"))
}

/** A real result always wins. The sole exception is #397's explicit restart skip: it exists to explain why a later
 * attempt did not replay the first attempt's already-lost game, not to replace that first attempt's evidence. */
function runnerPreemption(bot: number, profile: string, result: SlotResult | null, evidence: RunEvidence | undefined, executionKey: string): RunnerPreemption | null {
  const restart = restartedAfterProbedGame(result)
  if ((result && !restart) || !evidence) return null
  const jobs = evidence.jobs
    .filter((job) => botsOfJobName(job.name, executionKey).includes(bot))
    .sort((a, b) => a.run_attempt - b.run_attempt || a.id - b.id)
  for (const job of jobs) {
    if (job.status !== "completed" || job.conclusion !== "failure" || !selfHosted(job)) continue
    const annotations = evidence.annotations[String(job.id)]
    const annotatedLost = annotations?.available === true && annotations.messages.some((message) => RUNNER_LOST_MESSAGE.test(message))
    const unavailableZeroStep = (!annotations || !annotations.available) && job.steps.length === 0
    if (!annotatedLost && !unavailableZeroStep) continue
    const source = annotatedLost ? "runner-lost annotation" : "zero-step self-hosted failure; annotation unavailable"
    const restarted = restart ? `; restart attempt ${restart.attempt} refused game ${restart.current ?? "none"} after its probed game ended` : ""
    return { attempt: job.run_attempt, profile, detail: `attempt ${job.run_attempt}, ${source}${restarted}; role ${profile} was not proven` }
  }
  return null
}

const yn = (b: boolean): string => (b ? "yes" : "no")

/** "dim2next.paseo (product dim2.paseo), build 8bd8ae98e98e, CID bafy…": what the bots actually loaded. Bots that
 *  loaded different bundles (a deploy landed mid-run) are each named. */
export function appLines(rows: readonly BotRow[]): string[] {
  const seen = new Map<string, number[]>()
  for (const r of rows) {
    const a = r.result?.app
    if (!a) continue
    const text = a.cid
      ? `${a.app} (product ${a.product ?? "?"}), build ${a.version ? a.version.slice(0, 12) : "unknown"}, CID ${a.cid}${a.pinSource === "input" ? ", pinned by input" : ""}`
      : `${a.app} (next dev of the checkout, build ${a.version ?? "dev"})`
    seen.set(text, [...(seen.get(text) ?? []), r.bot])
  }
  if (seen.size === 0) return []
  const reloads = rows.flatMap((r) => (r.result?.buildReloads ?? []).map((x) => `- ${buildRefreshNote(r.bot, x, "bot")}`))
  if (seen.size === 1) return [`**App:** ${[...seen.keys()][0]}`, ...reloads, ""]
  return ["**App: the bots loaded DIFFERENT builds**", ...[...seen].map(([text, bots]) => `- bot ${bots.join(", ")}: ${text}`), ...reloads, ""]
}

/** Which truapi-host the bots ran on (the workflow installs the current stable unless host_version pins one): a host that moved is
 *  the first suspect when every bot fails to pair. */
export function hostLine(rows: Merged["rows"]): string {
  const hosts = [...new Set(rows.map((r) => r.result?.provenance?.hostVersion).filter((h): h is string => !!h))]
  return hosts.length ? `Host ${hosts.join(", ")}${hosts.length > 1 ? " (the bots ran DIFFERENT hosts)" : ""}.` : "Host version not recorded."
}

export function renderSummary(m: Merged, runUrl: string, commit: string | null = null): string {
  const head = m.game ? `game ${m.game.index} (play time ${m.game.gameAt})` : "no game"
  // the commit the runners used: a fix merged after the dispatch is visible at a glance
  const commits = [...new Set(m.rows.map((r) => r.result?.provenance?.commit).filter((c): c is string => !!c))]
  const started = m.rows.map((r) => r.result?.provenance?.runStartedAt).find(Boolean)
  const redBots = new Set(m.rows.filter((r) => Object.values(r.result?.stages ?? {}).some((st) => st.status === "fail")).map((r) => r.bot)).size
  const preemptedBots = m.rows.filter((r) => r.preemption).length
  const played = m.allPlayed ? (preemptedBots ? `every evaluated bot played and settled, ${preemptedBots} bot${preemptedBots === 1 ? "" : "s"} inconclusive` : "every bot played and settled") : "NOT every bot played and settled"
  const sha = commits.length ? commits.map((c) => c.slice(0, 7)).join(", ") : commit ? commit.slice(0, 7) : "unknown"
  const lines = [
    `## E2E live (${m.network}): ${head}, ${played}${m.allPlayed && redBots ? `, but ${redBots} bot${redBots === 1 ? "" : "s"} failed a stage` : ""}`,
    "",
    `Commit ${sha}${commits.length > 1 ? " (the bots ran DIFFERENT commits)" : ""}${started ? `, run started ${started}` : ""}.`,
    hostLine(m.rows),
    "",
    ...appLines(m.rows),
    ...(m.personaSchedule
      ? [
          `**Scheduled personas (${m.personaSchedule.scheduled.length}; rotation half ${m.personaSchedule.half}, dispatch ${m.personaSchedule.runNumber}):** ${m.personaSchedule.scheduled.join(", ")}`,
          "",
          `**Rotated out (${m.personaSchedule.rotatedOut.length}; expected in half ${m.personaSchedule.half === "A" ? "B" : "A"}):** ${m.personaSchedule.rotatedOut.join(", ")}`,
          "",
        ]
      : []),
    "| bot | profile | user | signed up | played | reported | settled | votes (taps) | confirmed (by) | guards | group | video |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...m.rows.map((r) => {
      const x = r.result
      const video = r.videoLink ? `[video-${r.bot}.webm](${r.videoLink})` : "none"
      if (r.preemption) return `| ${r.bot} | ${r.preemption.profile} | runner preempted | INCONCLUSIVE | | | | | | | role not proven | ${video} |`
      if (runnerUnavailable(x)) return `| ${r.bot} | ${x?.profile ?? "?"} | shared runner unavailable | FAILED | | | | | | | role not proven | ${video} |`
      if (x?.expectedOutcome?.kind === "camera-unavailable") {
        const reason = x.expectedOutcome.reason === "no-camera" ? "no-camera" : "denied"
        return `| ${r.bot} | ${x.profile} | ${x.username ?? "?"} | ${yn(x.signedUp)} | expected: camera ${reason}, ${x.expectedOutcome.helpShown ? "help shown" : "help missing"}, ${x.expectedOutcome.handedOver ? "handed over" : "not handed over"} | n/a | n/a | ${x.taps} | n/a | ${guardCell(x.guards)} | ${r.group.label} | ${video} |`
      }
      if (x?.expectedOutcome?.kind === "network-isolation") {
        return `| ${r.bot} | ${x.profile} | ${x.username ?? "?"} | ${yn(x.signedUp)} | expected: network isolation, ${x.expectedOutcome.isolated ? "help shown" : "help missing"}, fault ${x.expectedOutcome.faultRecovered ? "recovered" : "not recovered"} | n/a | n/a | ${x.taps} | n/a | ${guardCell(x.guards)} | ${r.group.label} | ${video} |`
      }
      return x
        ? `| ${r.bot} | ${x.profile} | ${x.username ?? "?"} | ${yn(x.signedUp)} | ${yn(x.stages.c.status === "pass")} | ${x.reportClosedEarly !== undefined ? "closed early (inconclusive)" : yn(x.reportSeen === true)} | ${yn(x.settled === true)} | ${x.taps} | ${yn(x.confirmed)}${x.confirmedBy ? ` (${x.confirmedBy})` : ""} | ${guardCell(x.guards)} | ${r.group.label} | ${video} |`
        : `| ${r.bot} | ? | ? | no result | | | | | | | | ${video} |`
    }),
    "",
  ]
  if (m.problems.length) lines.push("**Problems**", "", ...m.problems.map((p) => `- ${p}`), "")
  if (m.stageFailures.length) lines.push("**Stages that FAILED** (the bot is red; the game still counts as played if every bot reported and settled)", "", ...m.stageFailures.map((p) => `- ${p}`), "")
  if (m.guardFailures.length) lines.push("**Guards that FAILED** (the bot is red; the game still counts as played if every bot settled)", "", ...m.guardFailures.map((p) => `- ${p}`), "")
  if (m.inconclusive.length) lines.push(`**Inconclusive acts: ${m.inconclusive.length}** (not passed, not failed; they do not turn the run red on their own)`, "", ...m.inconclusive.map((p) => `- ${p}`), "")
  const withGuards = m.rows.filter((r) => r.result?.guards?.length)
  if (withGuards.length) {
    lines.push("**Guards**", "")
    for (const r of withGuards) lines.push(`- bot ${r.bot} (${r.result?.profile}):`, ...(r.result?.guards ?? []).map((g) => `  - ${g.status}: ${g.description} - ${g.evidence}`))
    lines.push("")
  }
  lines.push(`Run: ${runUrl}. ${m.allPlayed ? "The game is marked played." : "The game is NOT marked played, so a re-dispatch plays it again."}`)
  return lines.join("\n")
}
