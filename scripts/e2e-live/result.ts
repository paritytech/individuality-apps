// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// WHAT ONE SLOT'S RUN HANDS TO THE GATHER JOB: scripts/out/e2e-live/result-<n>.json
// (under E2E_OUT), written by journey.pw.ts for every slot in every mode. Each matrix
// runner holds one player and one artifact; the gather job reads the N files,
// decides whether the game was played by everyone, and owns the once-per-game
// "played" write that a single runner must not make (it cannot see the others).
// Pure and import-free (types only) so the spec and vitest share it.
import type { GuardResult } from "./guards"
import type { NetworkSnapshot } from "./network"
import { NARRATION_SOURCES, NARRATION_STATES, type NarrationTransition } from "./narration"

export interface AdaptiveUploadResult {
  page: {
    gameIndex: number | null
    rung: number
    currentRung: number
    lowPower: boolean
    lowPowerReason: string
    transitions: {
      id: string
      direction: "down" | "up"
      cause: "bandwidth" | "recovery"
      from: number
      to: number
      probe: "none" | "start" | "success" | "failed"
      applied: number
      refused: number
      before: { activeSenders: number; actualKbps?: number; availableKbps?: number; targetBitrateCoverage?: number; targetNearCapShare?: number; bandwidthLowTargetShare?: number; payloadBytes?: number; headerBytes?: number; bandwidthShare?: number; queueMsPerPacket?: number; rttMs?: number; baselineRttMs?: number }
      after?: { activeSenders: number; actualKbps?: number; availableKbps?: number; targetBitrateCoverage?: number; targetNearCapShare?: number; bandwidthLowTargetShare?: number; payloadBytes?: number; headerBytes?: number; bandwidthShare?: number; queueMsPerPacket?: number; rttMs?: number; baselineRttMs?: number }
    }[]
    roundSecondsByRung: Record<string, number>
    roundPayloadBytesByRung: Record<string, number>
    roundHeaderBytesByRung: Record<string, number>
    /** Candidate-pair bytes and the fully observed seconds behind them. Optional
     * on evidence written before the transport/runner split existed. */
    roundTransportBytesByRung?: Record<string, number>
    roundTransportAllowanceBytesByRung?: Record<string, number>
    roundTransportSecondsByRung?: Record<string, number>
    /** Per-link aligned evidence. Unlike the legacy wall-time counter, one
     * selected-pair change excludes only that peer's RTP and sender-seconds. */
    roundTransportCoveredPayloadBytesByRung?: Record<string, number>
    roundTransportCoveredHeaderBytesByRung?: Record<string, number>
    roundTransportCoveredSenderSecondsByRung?: Record<string, number>
    roundTransportExpectedSenderSecondsByRung?: Record<string, number>
    droppedChangeTransactions: number
    /** The latest RTC observation at a qdisc boundary. The acceptance proof
     * uses the sender count to budget a Survival interval whose mesh can grow
     * after the transition that first reached the floor. */
    lastWindow?: { activeSenders: number; validSenders: number }
    peers: { account: string; connected: boolean; away: boolean; firstFramesDecoded?: number; lastFramesDecoded?: number; decodedSamples?: { turn: number; firstElapsedMs: number; lastElapsedMs: number; firstFramesDecoded: number; lastFramesDecoded: number }[] }[]
  } | null
  network?: NetworkSnapshot
}

export type Stage = "a" | "b" | "c" | "d"
export type StageStatus = "pass" | "fail" | "skip" | "not-run"

export interface StageResult {
  status: StageStatus
  /** short facts: the failure's first line, taps made, what was skipped and why */
  notes: string[]
  seconds: number | null
}

/** Page-owned source of truth for the Sentry game-log completeness oracle.
 * The identity deliberately matches #723's contract; payload differences do
 * not turn one captured line into a different line. */
export interface TelemetryGroundTruth {
  source: "page-export"
  lines: { ts: number; sessionId: string; tag: string; message: string }[]
  /** True when this document entered the cold-clock state, even if it never released. */
  coldStart: boolean
  /** Latest line timestamp covered by a checkpoint/send the page recorded.
   * This is page-owned evidence, never inferred from Sentry receipts. */
  truthCutoffAt?: number
  /** Distinct current-game chunk objects or delivery receipts observed in
   * browser-local durable storage. T10 requires at least two identities and
   * more than one 48 KiB chunk budget of observed payload. */
  durableChunkIds?: string[]
  /** Encoded bytes of chunk objects the recorder actually observed. A
   * receipt-only chunk contributes zero because its payload was already sent. */
  durableChunkBytes?: number
  /** End of an induced transport fault or the first healthy reopen. */
  recoveredAt?: string
  /** Start of the bounded Sentry/network outage used by the recovery SLA. */
  faultStartedAt?: string
  /** Non-zero page-clock offset: acceptance latency uses independent clocks
   * and is therefore exempt unless normalized by future evidence. */
  clockOffsetMs?: number
  /** Any unreadable/failed document or empty game-window truth fails closed. */
  unavailable?: string
  /** Failed document exports make partial truth fail closed. */
  failedDocuments?: string[]
  /** Known captured occurrences not present in either durable store at kill. */
  unpersistedAtKill: number
  /** Explicit source limits retained with every verdict. */
  limitations?: string[]
}

export interface SlotResult {
  /** bump on a breaking change, so the gather job can refuse what it does not know */
  version: 1 | 2
  /** Version 2's action-driven recording timeline. Version 1 artifacts are
   * normalized to an empty timeline at the reader boundary. */
  narration: NarrationTransition[]
  slot: number
  /** the behaviour the bot was given (E2E_PROFILE), carried unchanged to the summary */
  profile: string
  /** the network the bot played on (E2E_NETWORK, canonical: previewnet | paseo-next-v2). Absent in results written
   *  before previewnet; those ran on paseo-next-v2. */
  network?: string
  /** the app the bot loaded (deployed-app.ts LoadedApp, merged in by boot.mts after the journey): the dotNS name
   *  (or "local" = next dev of the checkout), its product id, the bundle's CID and build stamp (APP_VERSION). Absent in
   *  results written before #284. */
  app?: { app: string; product: string | null; cid: string | null; version: string | null; commit?: string | null; pinSource?: "input" | "resolved" }
  /** A stale pre-handover page restarted onto the name's newer bundle. The
   *  final `app` above is authoritative; this is the transition evidence. */
  buildReloads?: { from: { cid: string | null; version: string | null }; to: { cid: string | null; version: string | null }; seconds: number }[]
  /** the playing account the oracle derived (SS58), null if the oracle failed */
  account: string | null
  /** the username the host paired as, read back, never configured */
  username: string | null
  /** the game this run signed up for; null when none was in Registration */
  game: { index: number; gameAt: number; registrationEnds: number; reportEnds: number } | null
  /** Duration between the latest two best-chain timestamps observed by the
   * runner. Metric guards express live latency in these blocks, not flat ms. */
  chainBlockMs?: number
  /** The GitHub attempt and, when a late restart found that its probe-selected
   *  game had ended, the exact refusal evidence. Optional for older results. */
  run?: {
    /** Exact Actions workflow run. Annotation refuses to combine timelines
     * without this boundary; older results remain readable but unannotated. */
    id?: string
    attempt: number
    /** This restarted job arrived after the probe-selected game had ended.
     * Its artifact explains the rerun but must not replace evidence from an
     * earlier attempt that reached farther into the journey. */
    superseded?: true
    skipped?: {
      kind: "restarted-after-probed-game"
      expected: { index: number | null; gameAt?: number; registrationEnds: number }
      current: { index: number; gameAt?: number; registrationEnds: number } | null
    }
  }
  /** Exact browser-video clock domains. Every page/relaunch is a separate
   * segment because Playwright starts a new recording for each page. */
  recordings?: RecordingSegment[]
  /** Which physical runner carried this logical bot. Added by gather from the
   * probe manifest; absent on older results without that manifest. */
  runner?: { group: string; size: number; shared: boolean; measure: boolean }
  /** Typed infrastructure outcomes written by the shared-runner supervisor. */
  runnerOutcomes?: {
    kind: "shared-registration-deadline-missed" | "shared-network-setup-failed" | "shared-network-cleanup-failed"
    detail: string
  }[]
  stages: Record<Stage, StageResult>
  /** (b): Game.Players[account].registered at finalized */
  signedUp: boolean
  /** A persona whose correct result is intentionally not entering /game. */
  expectedOutcome?:
    | { kind: "camera-unavailable"; reason: "denied" | "no-camera"; helpShown: boolean; handedOver: boolean }
    | {
        kind: "network-isolation"
        isolated: boolean
        /** Harness-side proof that netem restored the link and every live
         * document accepted the synthetic online edge; not app recovery. */
        faultRecovered: boolean
        isolationAt?: string
        blackout?: { startedAt: string; recoveredAt: string }
      }
  /** (c) */
  /** App-clock turn boundaries inferred by this bot and persisted so gather
   * can compare players that ran in separate CI jobs but shared a group. */
  appClockEvidence?: {
    toleranceMs: number
    turnEntries: { round: number; turn: number; atMs: number }[]
    /** Read-only snapshots of #1060's shown offset and method. */
    samples: { label: string; readAtMs: number; nowMs: number; offsetMs: number; method: string; peers: number }[]
    /** Full clock devLog payloads, including chain and peer verdict evidence. */
    timeline: { ts: number; sessionId?: string; message: string; data?: Record<string, unknown> }[]
  }
  taps: number
  clickErrors: number
  confirmed: boolean
  /** who filed the report, from the app's own "report built" line (filedBy:
   *  tap | auto-confirm), falling back to the bot's own Confirm tap; null = unknown */
  confirmedBy: "tap" | "auto" | null
  /** what the profile's role did: its kind, and one note per thing it did or could not do */
  role: { kind: string; notes: string[]; /** every action the role performed, with its time (role-proof.ts) */ actions: { id: string; at: string; detail: string }[] }
  /** Bounded cross-job evidence for the video-role-proof gather gate. */
  videoRoleProof?: {
    turns: { turn: number; at: string; roles: Record<string, string | undefined>; verdicts: Record<string, string> }[]
    markers: { at: string; id: string; role: string }[]
    recap: { at: string; id: string; role?: string; text: string; verdict?: string; votable?: boolean }[]
    report?: Record<string, { verdict?: string; source?: string; unseenChoice?: "default-notperson" | "flipped-person"; unseenEverFlipped?: boolean }>
  }
  /** Sender controller, netem and qdisc proof retained by the explicit
   * uplink acceptance persona. Optional for ordinary and older results. */
  adaptiveUpload?: AdaptiveUploadResult
  /** the commit the run used (github.sha) and when it started: a fix merged after the dispatch is visible at a glance */
  provenance: { commit: string | null; runStartedAt: string | null; /** `truapi-host --version` of the runner (E2E_HOST_VERSION), so a run says which host it ran on */ hostVersion?: string | null }
  /** Optional lower bound for Sentry-backed guards when a persona must prove
   * evidence produced only after a lifecycle boundary such as a relaunch. */
  sentryGuardStartedAt?: string
  /** Evaluated after the run, against full logs plus durable chunks pulled
   * from Sentry. Present on every current live persona, not only torture ones. */
  telemetryGroundTruth?: TelemetryGroundTruth
  reachedPrizeDraw: boolean
  /** acts the bot could not do for a reason that is not its fault (a runner freeze, #341): not a pass, not a fail.
   *  Optional: results written before it carry none. */
  inconclusive?: { name: string; detail: string }[]
  /** the profile's guards (profile.ts `expect`) with the evidence for each; the journey fills the page and chain
   *  ones, guards-cli.mts the Sentry ones afterwards. A "fail" turns the bot red in the gather summary, but never
   *  changes whether the game counts as played (playedAndSettled is separate). */
  guards: GuardResult[]
  /** (d): a Game.ReportSubmitted for THIS account in this game; null = not read */
  reportSeen: boolean | null
  /** (d): no report, because the chain ended Reporting before report_ends with this player already voted out, so no
   *  report could count (early-close.ts): the check's detail. Absent when the report landed or the close is unproven. */
  reportClosedEarly?: string
  /** (d): Game.GameEnded for the game, or the chain's slot moved on; null = not read */
  settled: boolean | null
  /** Score.Participants.last_attended_game after settlement. The adaptive
   * acceptance gate requires this game, not only an event observed in-flight. */
  lastAttendedGame?: number | null
  /** the group(s) the bot played in, per round, read from the chain roster at its report (chain-read.mts `votes`:
   *  Game.IndexToPlayer over groupSeats): the members' ACCOUNTS only. Which of them are our bots, and which profile, is
   *  resolved by the gather job (gather.ts classifyGroup), the only one that sees every result. null/absent = not read
   *  (the bot filed no report). Added after version 1 shipped: optional, readers tolerate its absence. */
  groups?: GroupRound[] | null
  /** (d), informational: other accounts that reported in this game; null = not read */
  othersReported: number | null
  timings: { bootS: number | null; oracleS: number | null; hostReadyS: number | null; appUpS: number | null }
  startedAt: string
  finishedAt: string | null
}

export interface RecordingSegment {
  /** Basename within this slot's immutable heavy artifact. */
  file: string
  /** Zero-based page/relaunch order for deterministic stitching and display. */
  pageOrdinal: number
  /** Node wall-clock bounds captured by the runner that recorded the page. */
  startedAt: string
  finishedAt: string
}

/** One round's group as the chain had it: the occupied seats of the bot's group, its own included. */
export interface GroupRound {
  round: number
  ownIndex: number
  members: { index: number; account: string }[]
}

/** A decoded report's rounds (chain-checks FiledReport) as the result's `groups`; null when there is no report. */
export function groupsOfReport(report: { rounds: { ownIndex: number; members: { index: number; player: string }[] }[] } | undefined): GroupRound[] | null {
  return report ? report.rounds.map((r, round) => ({ round, ownIndex: r.ownIndex, members: r.members.map((m) => ({ index: m.index, account: m.player })) })) : null
}

export const resultFile = (n: number): string => `result-${n}.json`

/** THE ARTIFACT NAMES, defined once (the workflow's upload steps spell the same
 *  pattern, `e2e-live-<run_id>-attempt-<a>-<execution_key>-bot<n>[-result]`, a = github.run_attempt): every runner uploads two.
 *  The small one holds result-<n>.json plus compact screenshot provenance;
 *  the gather job reads only the result. The full one holds those diagnostics
 *  again with the logs, screenshots and video-<n>.webm. */
export function validateExecutionKey(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
    throw new Error("execution key must be a lowercase kebab identifier of 1 to 64 characters")
  return value
}

/** Convenience names always mean attempt 1; unscoped/attemptless artifacts are not evidence. */
export const artifactName = (runId: string, bot: number, executionKey: string): string =>
  attemptArtifactName(runId, bot, 1, executionKey)
export const resultArtifactName = (runId: string, bot: number, executionKey: string): string => `${artifactName(runId, bot, executionKey)}-result`
export const attemptArtifactName = (runId: string, bot: number, attempt: number, executionKey: string): string =>
  `e2e-live-${runId}-attempt-${attempt}-${validateExecutionKey(executionKey)}-bot${bot}`
export const attemptResultArtifactName = (runId: string, bot: number, attempt: number, executionKey: string): string =>
  `${attemptArtifactName(runId, bot, attempt, executionKey)}-result`

/** Parse the full identity before deciding whether it belongs to this execution.
 * Only valid other-execution names may be ignored; malformed evidence fails closed. */
export function parseResultArtifactIdentity(runId: string, name: string): { executionKey: string; bot: number; attempt: number } | null {
  const prefix = `e2e-live-${runId}-`
  if (!name.startsWith(prefix)) return null
  const rest = name.slice(prefix.length)
  const qualified = /^attempt-([1-9]\d*)-([a-z0-9][a-z0-9-]{0,63})-bot([1-9]\d*)-result$/.exec(rest)
  if (qualified) {
    const bot = Number(qualified[3])
    const attempt = Number(qualified[1])
    return Number.isSafeInteger(bot) && bot > 0 && Number.isSafeInteger(attempt) && attempt > 0
      ? { executionKey: qualified[2], bot, attempt }
      : null
  }
  return null
}

export function parseResultArtifactName(runId: string, name: string, executionKey: string): { bot: number; attempt: number | null } | null {
  validateExecutionKey(executionKey)
  const parsed = parseResultArtifactIdentity(runId, name)
  return parsed?.executionKey === executionKey ? { bot: parsed.bot, attempt: parsed.attempt } : null
}

export function supersededRun(
  run: SlotResult["run"],
  skipped: NonNullable<NonNullable<SlotResult["run"]>["skipped"]>,
): NonNullable<SlotResult["run"]> {
  return { ...run, attempt: run?.attempt ?? 1, superseded: true, skipped }
}

export function emptyResult(slot: number, account: string | null, username: string | null, now: Date = new Date(), profile = "baseline", env: Record<string, string | undefined> = process.env): SlotResult {
  const stage = (): StageResult => ({ status: "not-run", notes: [], seconds: null })
  const attempt = Number(env.GITHUB_RUN_ATTEMPT)
  return {
    version: 2,
    narration: [],
    slot,
    profile,
    network: env.E2E_NETWORK || "previewnet",
    account,
    username,
    game: null,
    run: {
      ...(env.GITHUB_RUN_ID ? { id: env.GITHUB_RUN_ID } : {}),
      attempt: Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1,
    },
    stages: { a: stage(), b: stage(), c: stage(), d: stage() },
    signedUp: false,
    taps: 0,
    clickErrors: 0,
    confirmed: false,
    confirmedBy: null,
    role: { kind: "baseline", notes: [], actions: [] },
    provenance: { commit: env.GITHUB_SHA ?? null, runStartedAt: env.E2E_RUN_STARTED_AT ?? null, hostVersion: env.E2E_HOST_VERSION || null },
    reachedPrizeDraw: false,
    guards: [],
    reportSeen: null,
    settled: null,
    othersReported: null,
    timings: { bootS: null, oracleS: null, hostReadyS: null, appUpS: null },
    startedAt: now.toISOString(),
    finishedAt: null,
  }
}

/** Validate the result envelope and normalize pre-narration schema-v1
 * artifacts without pretending they contained a timeline. */
export function normalizeSlotResult(raw: unknown): SlotResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected a result object")
  const result = raw as Partial<SlotResult> & { version?: unknown; narration?: unknown }
  if (result.version !== 1 && result.version !== 2) throw new Error("expected result version 1 or 2")
  if (typeof result.slot !== "number" || !result.stages || typeof result.stages !== "object") throw new Error(`version ${result.version} result needs slot and stages`)
  if (result.version === 2 && !Array.isArray(result.narration)) throw new Error("version 2 result needs a narration array")
  if (result.version === 1) return { ...(result as SlotResult), narration: [] }
  const states = new Set<string>(NARRATION_STATES)
  const sources = new Set<string>(NARRATION_SOURCES)
  for (const [index, rawTransition] of result.narration!.entries()) {
    if (!rawTransition || typeof rawTransition !== "object" || Array.isArray(rawTransition)) throw new Error(`narration[${index}] must be an object`)
    const transition = rawTransition as Partial<NarrationTransition>
    if (typeof transition.at !== "string" || Number.isNaN(Date.parse(transition.at)) || new Date(transition.at).toISOString() !== transition.at) throw new Error(`narration[${index}].at must be a canonical ISO timestamp`)
    if (typeof transition.state !== "string" || !states.has(transition.state)) throw new Error(`narration[${index}].state is invalid`)
    if (typeof transition.source !== "string" || !sources.has(transition.source)) throw new Error(`narration[${index}].source is invalid`)
    if (transition.action !== null && typeof transition.action !== "string") throw new Error(`narration[${index}].action must be a string or null`)
    if (typeof transition.title !== "string" || !transition.title.trim()) throw new Error(`narration[${index}].title must be non-empty`)
    if (typeof transition.text !== "string" || !transition.text.trim()) throw new Error(`narration[${index}].text must be non-empty`)
    if (transition.detail !== undefined && typeof transition.detail !== "string") throw new Error(`narration[${index}].detail must be a string`)
  }
  return result as SlotResult
}

/** Validate annotation-only provenance without making optional video metadata
 * part of the live game verdict. Gather deliberately does not call this. */
export function validateRecordingProvenance(result: SlotResult): SlotResult {
  if (result.run?.id !== undefined && (typeof result.run.id !== "string" || !/^\d+$/.test(result.run.id))) throw new Error("run.id must be a numeric workflow run id")
  if (result.recordings !== undefined) {
    if (!Array.isArray(result.recordings)) throw new Error("recordings must be an array")
    const files = new Set<string>()
    const ordinals = new Set<number>()
    for (const [index, rawRecording] of result.recordings.entries()) {
      if (!rawRecording || typeof rawRecording !== "object" || Array.isArray(rawRecording)) throw new Error(`recordings[${index}] must be an object`)
      const recording = rawRecording as Partial<RecordingSegment>
      if (typeof recording.file !== "string" || !/^video-\d+(?:-part\d+)?\.webm$/.test(recording.file)) throw new Error(`recordings[${index}].file is invalid`)
      if (!Number.isSafeInteger(recording.pageOrdinal) || (recording.pageOrdinal ?? -1) < 0) throw new Error(`recordings[${index}].pageOrdinal is invalid`)
      if (typeof recording.startedAt !== "string" || Number.isNaN(Date.parse(recording.startedAt)) || new Date(recording.startedAt).toISOString() !== recording.startedAt) throw new Error(`recordings[${index}].startedAt must be a canonical ISO timestamp`)
      if (typeof recording.finishedAt !== "string" || Number.isNaN(Date.parse(recording.finishedAt)) || new Date(recording.finishedAt).toISOString() !== recording.finishedAt || Date.parse(recording.finishedAt) < Date.parse(recording.startedAt)) throw new Error(`recordings[${index}].finishedAt must be a canonical ISO timestamp at or after startedAt`)
      if (files.has(recording.file)) throw new Error(`recordings[${index}].file is duplicated`)
      if (ordinals.has(recording.pageOrdinal!)) throw new Error(`recordings[${index}].pageOrdinal is duplicated`)
      files.add(recording.file)
      ordinals.add(recording.pageOrdinal!)
    }
  }
  return result
}

/** The stage a Playwright test title names: "(a) hosted boot…" → "a". "(c0)" is
 *  the opt-in demo, not a stage. */
export function stageOfTitle(title: string): Stage | null {
  const m = /^\(([abcd])\)/.exec(title)
  return m ? (m[1] as Stage) : null
}

/** Playwright's test status onto a stage's. */
export function stageStatus(playwright: string): StageStatus {
  if (playwright === "passed") return "pass"
  if (playwright === "skipped") return "skip"
  return "fail"
}

/** Other accounts with a ReportSubmitted in this game (Account or Person: the
 *  event's `who` value), the account itself excluded, each counted once. */
export function othersReported(events: readonly { who: { value: string }; game_index: number }[], gameIndex: number, own: string): number {
  return new Set(events.filter((e) => e.game_index === gameIndex && e.who.value !== own).map((e) => e.who.value)).size
}

/** A player played the whole game when it signed up (b), played (c), and (d) saw its report and the settlement on
 *  chain. What the gather job asks of each file. (d)'s own status is NOT part of it: (d) also holds the bot's checks
 *  (its role's acts, the filed verdicts), and one of those failing says the bot misbehaved, not that the game went
 *  unplayed (game 190: bot 5's background act never fired, and the summary called a settled game unplayed with no
 *  reason). gather.ts lists a failed stage on its own and keeps the run red. */
export function playedAndSettled(r: SlotResult): boolean {
  if (r.expectedOutcome?.kind === "camera-unavailable") {
    return r.stages.a.status === "pass" && r.stages.b.status === "skip" && r.stages.c.status === "skip" && r.stages.d.status === "skip" && r.expectedOutcome.helpShown && !r.expectedOutcome.handedOver
  }
  if (r.expectedOutcome?.kind === "network-isolation") {
    return r.stages.a.status === "pass" && r.stages.b.status === "pass" && r.stages.c.status === "pass" && r.stages.d.status === "skip" && r.expectedOutcome.isolated && r.expectedOutcome.faultRecovered
  }
  return r.stages.b.status === "pass" && r.stages.c.status === "pass" && (r.reportSeen === true || r.reportClosedEarly !== undefined) && r.settled === true
}
