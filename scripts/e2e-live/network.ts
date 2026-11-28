// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// A bot's NETWORK, applied to the runner (netem.sh: tc netem + iptables, Linux
// and sudo only). Pure planning here (vitest pins it); the one function that
// shells out is runNetem. boot.mts applies the profile's network just before
// the journey and clears it at the end; the journey calls the switch plan at
// the turn the profile names. "baseline" (no profile) plans nothing, so a
// plain bot never touches tc or iptables.
//
// WHEN. After the boot and its pre-warm, right before the journey: the oracle,
// the host pairing and next dev's compile are not what a phone's connection
// is judged on, and a 2 Mbit/150 ms boot would eat into the registration
// window the matrix timing (timing.ts CI_SETUP_S) was sized for. Everything
// after that point - the app's chain reads, the statement store, WebRTC
// signalling and TURN - sees the shaped link. The journey clears the link as
// soon as play ends, before settlement waits; boot repeats that cleanup in its
// finalizer. Loopback (the bot's own host and next dev) is never shaped: netem
// sits on the egress interface only.
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import type { Check } from "./chain-checks"
import { scheduledTriggerWaitMs } from "./decide"
import { isHostChainOperation } from "./host-chain-cut"
import type { NetemLifecycleEvent } from "./netem-lifecycle"
import { makeNetemRunner, NETEM_INCONCLUSIVE_EXIT, NetemError } from "./netem-runner"
import type { NarrationState } from "./narration"
import { UPLINK_LIFT_PROFILE, loadNetemProfiles, type NetemProfile, type Profile, type RoundChannelGate, type TimelineStep } from "./profile"
import type { AdaptiveUploadResult } from "./result"

export { NETEM_INCONCLUSIVE_EXIT, NetemError } from "./netem-runner"

/** The networks a run can be on (host-slot.mjs NETWORKS keys); a plain string here because this module must not import it. */
export type RunNetwork = "previewnet" | "paseo-next-v2"

/** Named endpoints a targeted outage can take down, per network. */
export const OUTAGE_TARGETS: Record<RunNetwork, Record<string, string>> = {
  // literals, NOT read from scripts/lib/host-slot.mjs: this module also loads in Playwright's CommonJS loader
  // (the journey), which cannot import that ES module. network.test.ts checks them against NETWORKS.
  previewnet: {
    "people-rpc": "previewnet.substrate.dev",
    // the statement store is served by the People chain's RPC node
    "statement-store": "previewnet.substrate.dev",
    // no "turn-issuer": previewnet serves it at previewnet.substrate.dev/dub/, on the host of the chains, and netem cuts by
    // host, so an outage of it would cut the chains too (see ISOLATION_GAPS)
    "turn-relay": "turn.cloudflare.com",
  },
  "paseo-next-v2": {
    "people-rpc": "paseo-people-next-system-rpc.polkadot.io",
    "statement-store": "paseo-people-next-system-rpc.polkadot.io",
    // dev-host.mjs builds NEXT_PUBLIC_NETWORK_NAME=paseo for paseo-next-v2 (packages/jollity-protocol NETWORK_CONFIG.paseo)
    "turn-issuer": "identity.parity-prod.parity.io",
    "turn-relay": "turn.cloudflare.com",
  },
}

/** Outage targets a network serves from a host it shares with other things: netem cuts by host, so the target can not be isolated there. */
export const ISOLATION_GAPS: Record<RunNetwork, Record<string, string>> = {
  previewnet: {
    "turn-issuer":
      "previewnet serves the TURN issuer at previewnet.substrate.dev/dub/, on the same host as its chains, and netem cuts a whole host, so the outage would cut the chains too and test something else; run it on paseo-next-v2",
  },
  "paseo-next-v2": {},
}

export const outageHost = (target: string, network: RunNetwork): string => {
  const gap = ISOLATION_GAPS[network][target]
  if (gap !== undefined) throw new Error(`outage "${target}" can not run on ${network}: ${gap}`)
  return OUTAGE_TARGETS[network][target] ?? target
}

/** Why `profile` can not run on `network`: its timeline cuts an outage target the network can not isolate (ISOLATION_GAPS), as
 *  that gap's own text, or undefined when it can run. The one place "runnable on a network" asks this: allRoles (so the nightly
 *  planner and the all/rotate presets) and botMatrix (an explicit dispatch) both use it. */
export const profileIsolationGap = (profile: Pick<Profile, "network">, network: RunNetwork | string): string | undefined => {
  const gaps = ISOLATION_GAPS[network as RunNetwork] ?? {}
  for (const step of profile.network.timeline ?? []) if (step.outage !== undefined && gaps[step.outage] !== undefined) return `outage "${step.outage}" can not run on ${network}: ${gaps[step.outage]}`
  return undefined
}

export type NetemCall = [verb: "apply" | "swap" | "custom" | "spike" | "outage" | "host-chain-cut" | "host-chain-hang" | "udp-cut" | "video-stall" | "blackout" | "block-udp" | "allow-udp" | "clear" | "show" | "stats", ...args: string[]]

/** A game moment a step can wait for instead of a turn: the journey's Register tap, or the confirm stage (the last turn's end
 *  on the chain clock). */
export type GameMoment = "sign-up" | "confirm"
/** One due change: at the game's turn `atTurn`, `atS` seconds after it starts,
 * after a bounded round-channel gate, or at the game moment `at`. */
export interface PlannedStep {
  atTurn?: number
  atS?: number
  atBeforeGameS?: number
  atRoundChannelsOpen?: RoundChannelGate
  at?: GameMoment
  calls: NetemCall[]
  /** An explicit apply/hook/hold/finally-restore sequence. Unlike netem's
   * opaque spike command, this proves the custom qdisc was active before the
   * browser hook runs. */
  boundedBurst?: { holdMs: number; restoreProfile: string }
  concurrent?: true
}
export interface NetworkPlan {
  /** run before the journey, in order */
  start: NetemCall[]
  /** the changes during the game, in the order the profile lists them */
  timeline: PlannedStep[]
  /** steps that fire once when the journey opens the app (`atOpen`), off the play loop: boot.mts starts them, unawaited,
   *  just before the journey. They are not in `timeline`, so a game's "network steps applied" count never waits for them. */
  atOpen: PlannedStep[]
}

export interface NetworkStepEvidence {
  turn: number
  applied: boolean
  calls: NetemCall[]
}

/** The adaptive sender gets this full allowance only after the target game's
 * controller exists. Starting it while the bot is still waiting for a
 * scheduled game can exhaust the proof before there is anything to observe. */
export const SURVIVAL_TRANSITION_TIMEOUT_MS = 120_000

/** Arm an absolute wall-clock action now, so work awaited by the caller in the
 * meantime cannot postpone when the action starts. */
export function scheduleAtWallMs<T>(
  targetWallMs: number,
  action: () => Promise<T>,
  options: { nowMs?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const nowMs = options.nowMs ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  return (async () => {
    const waitMs = Math.max(0, targetWallMs - nowMs())
    if (waitMs > 0) await sleep(waitMs)
    return action()
  })()
}

export type BeforeGameSchedule = Map<number, Promise<NetworkStepEvidence[]>> & {
  /** Cancel one pending trigger, or every pending trigger when omitted. */
  cancel(secondsBeforeGame?: number): void
}

function cancellableAtWallMs<T>(
  targetWallMs: number,
  action: () => Promise<T>,
  options: { nowMs: () => number; sleep?: (ms: number) => Promise<void> },
): { promise: Promise<T | undefined>; cancel: () => void } {
  let cancelled = false
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolve!: (value: T | undefined) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T | undefined>((done, fail) => {
    resolve = done
    reject = fail
  })
  const finish = async () => {
    if (cancelled || settled) return
    settled = true
    try {
      resolve(await action())
    } catch (error) {
      reject(error)
    }
  }
  const waitMs = Math.max(0, targetWallMs - options.nowMs())
  if (options.sleep) void options.sleep(waitMs).then(finish, reject)
  else timer = setTimeout(() => void finish(), waitMs)
  return {
    promise,
    cancel: () => {
      if (settled || cancelled) return
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(undefined)
    },
  }
}

/** Arm every absolute pre-game step in a profile as soon as the journey knows
 * the game's chain clock. Unlike the old profile-name branches, this is driven
 * only by timeline data, so adding an atBeforeGameS step makes it real. Turn
 * and elapsed-game steps remain owned by the play loop. */
export function scheduleBeforeGameSteps(
  plan: NetworkPlan,
  gameAtS: number,
  wallMsForChainS: (chainS: number) => number,
  fire: (secondsBeforeGame: number) => NetworkStepEvidence[],
  options: {
    nowMs?: () => number
    sleep?: (ms: number) => Promise<void>
    onRows?: (rows: NetworkStepEvidence[], secondsBeforeGame: number) => void
    onMissed?: (secondsBeforeGame: number, lateByMs: number) => void
    onScheduled?: (secondsBeforeGame: number, waitMs: number) => void
    excludeSeconds?: readonly number[]
  } = {},
): BeforeGameSchedule {
  const nowMs = options.nowMs ?? Date.now
  const excluded = new Set(options.excludeSeconds ?? [])
  const before = [...new Set(plan.timeline.flatMap((step) => step.atBeforeGameS === undefined ? [] : [step.atBeforeGameS]))]
    .filter((seconds) => !excluded.has(seconds))
    .sort((a, b) => b - a)
  const scheduled = new Map<number, Promise<NetworkStepEvidence[]>>() as BeforeGameSchedule
  const cancels = new Map<number, () => void>()
  scheduled.cancel = (secondsBeforeGame) => {
    if (secondsBeforeGame === undefined) {
      for (const cancel of cancels.values()) cancel()
      return
    }
    cancels.get(secondsBeforeGame)?.()
  }
  for (const seconds of before) {
    const targetWallMs = wallMsForChainS(gameAtS - seconds)
    const armedAtMs = nowMs()
    const waitMs = scheduledTriggerWaitMs(targetWallMs, armedAtMs)
    if (waitMs === null) {
      options.onMissed?.(seconds, armedAtMs - targetWallMs)
      scheduled.set(seconds, Promise.resolve([]))
      continue
    }
    options.onScheduled?.(seconds, waitMs)
    const pending = cancellableAtWallMs(targetWallMs, async () => {
      const rows = fire(seconds)
      options.onRows?.(rows, seconds)
      return rows
    }, { nowMs, ...(options.sleep ? { sleep: options.sleep } : {}) })
    cancels.set(seconds, pending.cancel)
    scheduled.set(seconds, pending.promise.then((rows) => rows ?? []))
  }
  return scheduled
}

type DevLogLine = { tag: string; message: string; ts: number }

/** The first open timestamp for every distinct peer in a round. Repeated
 * snapshots and duplicate channel-open lines must not satisfy a count gate. */
export function roundChannelOpenPeers(lines: readonly DevLogLine[], round: number, expectedPeers?: readonly string[]): Map<string, number> {
  const allowed = expectedPeers ? new Set(expectedPeers) : null
  const peers = new Map<string, number>()
  for (const line of lines) {
    if (line.tag !== "rtc" || !line.message.includes("[jollity-rtc] round-link")) continue
    const fields = Object.fromEntries([...line.message.matchAll(/(?:^|\s)([a-zA-Z][\w-]*)=([^\s]+)/g)].map((match) => [match[1], match[2]]))
    if (fields.stage !== "channel-open" || fields.round !== String(round) || !fields.peer || (allowed && !allowed.has(fields.peer))) continue
    peers.set(fields.peer, Math.min(line.ts, peers.get(fields.peer) ?? Number.POSITIVE_INFINITY))
  }
  return new Map([...peers].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])))
}

export interface RoundChannelGateResult {
  status: "fired" | "not-proven" | "cancelled"
  peers: number
  detail: string
  rows: NetworkStepEvidence[]
}

/** Poll page-owned devLog truth until a bounded distinct-channel gate opens.
 * A missed deadline is an explicit NOT PROVEN result; it never fires the
 * shaping step late and silently changes the scenario. */
export async function waitForRoundChannelGate(options: {
  gate: RoundChannelGate
  /** Finalized co-player accounts for this round. Earlier standby links can
   * emit the same round marker immediately before roster removal. */
  peerIds?: readonly string[]
  /** Earlier-round-only peers which must be visibly removed before the hook
   * can inspect the final group's connection count. */
  removedPeerIds?: readonly string[]
  deadlineMs: number
  readLines: () => Promise<readonly DevLogLine[]>
  fire: (round: number, count: number) => NetworkStepEvidence[]
  nowMs?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  cancelled?: () => boolean
}): Promise<RoundChannelGateResult> {
  const nowMs = options.nowMs ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollMs = options.pollMs ?? 1_000
  let peers = 0
  while (true) {
    if (options.cancelled?.()) return { status: "cancelled", peers, detail: `round-${options.gate.round} channel gate cancelled`, rows: [] }
    const lines = await options.readLines()
    // The page read may still be in flight when play fails and the journey
    // enters cleanup. Never let evidence returned by that stale read start a
    // new fault after cancellation.
    if (options.cancelled?.()) return { status: "cancelled", peers, detail: `round-${options.gate.round} channel gate cancelled`, rows: [] }
    const opened = roundChannelOpenPeers(lines, options.gate.round, options.peerIds)
    peers = opened.size
    const removed = new Set(lines.flatMap((line) => {
      if (line.tag !== "rtc") return []
      const match = line.message.match(/^\[jollity-rtc\] no round left with: (\S+)$/)
      return match ? [match[1]] : []
    }))
    const rosterSettled = (options.removedPeerIds ?? []).every((peerId) => removed.has(peerId))
    // Event timestamps alone are insufficient: the export may have started
    // before the bound and completed after it. A fault must never begin after
    // the wall-clock deadline, even when all exported events were on time.
    const readCompletedAtMs = nowMs()
    if (readCompletedAtMs > options.deadlineMs) {
      return {
        status: "not-proven",
        peers,
        detail: `round-${options.gate.round} channel gate NOT PROVEN: ${peers}/${options.gate.count} distinct channels open by game T+${options.gate.byGameS} s`,
        rows: [],
      }
    }
    const gateAtMs = peers >= options.gate.count ? Math.max(...[...opened.values()].slice(0, options.gate.count)) : null
    if (gateAtMs !== null && gateAtMs <= options.deadlineMs && rosterSettled) {
      const rows = options.fire(options.gate.round, peers)
      return { status: "fired", peers, detail: `round-${options.gate.round} channel gate opened at ${peers}/${options.gate.count}`, rows }
    }
    const remainingMs = options.deadlineMs - readCompletedAtMs
    if (remainingMs <= 0) {
      return {
        status: "not-proven",
        peers,
        detail: `round-${options.gate.round} channel gate NOT PROVEN: ${peers}/${options.gate.count} distinct channels open${rosterSettled ? "" : ", final roster not settled"} by game T+${options.gate.byGameS} s`,
        rows: [],
      }
    }
    await sleep(Math.min(pollMs, remainingMs))
  }
}

/** Acceptance evidence for the recalibrated game259 path: all expected
 * channels opened before the burst, every lane renegotiated under it, and the
 * explicit finally path restored the named base profile. */
export function postOpenBurstChecks(
  slot: number,
  lines: readonly DevLogLine[],
  runs: readonly NetworkCallRun[],
  expected: { round: number; count: number; peerIds?: readonly string[]; baseProfile: string; burstS: number; requestId?: string },
): Check[] {
  const peers = roundChannelOpenPeers(lines, expected.round, expected.peerIds)
  const gateAtMs = peers.size >= expected.count ? Math.max(...[...peers.values()].slice(0, expected.count)) : null
  const burst = runs.find((run) => run.call[0] === "custom" && run.call.slice(1).join(" ") === "100 40 65 2")
  const swaps = burst ? runs.filter((run) => run.step === burst.step && run.call[0] === "swap" && run.call[1] === expected.baseProfile) : []
  const before = swaps.find((run) => run.endMs <= burst!.startMs)
  const restored = swaps.find((run) => run.startMs >= burst!.endMs)
  const orderName = `player ${slot} burst followed ${expected.count}/${expected.count} round-${expected.round} channel opens`
  const restoreName = `player ${slot} burst restored ${expected.baseProfile} after ${expected.burstS} s`
  const proofName = `player ${slot} forced lane renegotiation reached fresh video on ${expected.count}/${expected.count} peers`
  const order = gateAtMs === null
    ? { name: orderName, status: "fail" as const, detail: `only ${peers.size}/${expected.count} distinct channels opened` }
    : !burst
      ? { name: orderName, status: "fail" as const, detail: `all ${expected.count} channels opened by ${new Date(gateAtMs).toISOString()}, but no 65% burst was recorded` }
      : {
          name: orderName,
          status: burst.startMs >= gateAtMs ? "pass" as const : "fail" as const,
          detail: `burst started ${burst.startMs - gateAtMs} ms after the ${expected.count}th distinct channel opened`,
        }
  if (!burst || !before || !restored) return [
    order,
    { name: restoreName, status: "fail", detail: `missing the ${expected.baseProfile} base, 65% burst, or finally restore in one network step` },
    ...(expected.requestId ? [{ name: proofName, status: "fail" as const, detail: "NOT PROVEN: the bounded burst did not produce a complete proof window" }] : []),
  ]
  const elapsedMs = restored.startMs - burst.endMs
  const expectedMs = expected.burstS * 1000
  if (!expected.requestId) return [order, {
    name: restoreName,
    status: before.ok && !before.inconclusive && burst.ok && !burst.inconclusive && restored.ok && !restored.inconclusive && elapsedMs >= expectedMs && elapsedMs <= expectedMs + 1_000 ? "pass" : "fail",
    detail: `${expected.baseProfile} was in force before the burst and restored after ${Math.round(elapsedMs / 10) / 100} s`,
  }]
  const requestId = expected.requestId
  const proofLines = lines.filter((line) => line.tag === "rtc" && line.message.includes("[jollity-rtc] e2e-renegotiation") && line.message.includes(`request=${requestId}`))
  const proofByPeer = new Map<string, Map<string, number[]>>()
  for (const line of proofLines) {
    const fields = Object.fromEntries([...line.message.matchAll(/(?:^|\s)([a-zA-Z][\w-]*)=([^\s]+)/g)].map((match) => [match[1], match[2]]))
    if (!fields.peer || !fields.stage || fields.round !== String(expected.round)) continue
    const stages = proofByPeer.get(fields.peer) ?? new Map<string, number[]>()
    const family = fields.stage === "requested" ? "requested" : fields.stage.startsWith("offer-") ? "offer" : fields.stage.startsWith("answer-") ? "answer" : fields.stage
    stages.set(family, [...(stages.get(family) ?? []), line.ts])
    proofByPeer.set(fields.peer, stages)
  }
  const expectedPeers = [...peers.keys()].slice(0, expected.count)
  const recoveryDeadline = restored.endMs + 20_000
  const offerDeadline = restored.endMs + 5_000
  const bad = expectedPeers.flatMap((peerId) => {
    const stages = proofByPeer.get(peerId)
    const requested = stages?.get("requested") ?? []
    const offer = stages?.get("offer") ?? []
    const answer = stages?.get("answer") ?? []
    const fresh = stages?.get("fresh-video") ?? []
    const dropped = stages?.get("request-dropped") ?? []
    const exact = [requested, offer, answer, fresh].every((values) => values.length === 1) && dropped.length === 0
    const ordered = exact && requested[0] >= burst.endMs && offer[0] >= requested[0] && offer[0] <= offerDeadline && answer[0] >= offer[0] && fresh[0] > answer[0] && fresh[0] <= recoveryDeadline
    return exact && ordered ? [] : [peerId]
  })
  return [order, {
    name: restoreName,
    status: before.ok && !before.inconclusive && burst.ok && !burst.inconclusive && restored.ok && !restored.inconclusive && elapsedMs >= expectedMs && elapsedMs <= expectedMs + 1_000 ? "pass" : "fail",
    detail: `${expected.baseProfile} was in force before the burst and restored after ${Math.round(elapsedMs / 10) / 100} s`,
  }, {
    name: proofName,
    status: bad.length === 0 && proofByPeer.size === expected.count ? "pass" : "fail",
    detail: bad.length === 0 && proofByPeer.size === expected.count
      ? `exactly one request, offer, answer, and post-answer fresh-video proof for peers ${expectedPeers.join(", ")}`
      : `NOT PROVEN: missing, duplicate, or late forced renegotiation evidence for ${bad.join(", ") || "unexpected peers"}`,
  }]
}

export async function waitForSurvivalWindow(options: {
  playDeadlineMs: number
  nowMs?: () => number
  waitForGame: (timeoutMs: number) => Promise<unknown>
  waitForTransition: (timeoutMs: number) => Promise<unknown>
}): Promise<void> {
  const nowMs = options.nowMs ?? Date.now
  await options.waitForGame(Math.max(1, options.playDeadlineMs - nowMs()))
  const transitionTimeoutMs = Math.min(SURVIVAL_TRANSITION_TIMEOUT_MS, options.playDeadlineMs - nowMs())
  if (transitionTimeoutMs <= 0) throw new Error("play deadline elapsed before Survival transition wait")
  await options.waitForTransition(transitionTimeoutMs)
}

/** One netem call as it RAN: the wall ms it started and ended (a blackout call sleeps, so its length is the cut's), after it
 *  finished. `ok` is false when it failed; `inconclusive` when netem.sh acted but could not show every side of it. */
export interface NetworkCallRun {
  /** 1-based index of the step in the plan's timeline */
  step: number
  call: NetemCall
  startMs: number
  endMs: number
  ok: boolean
  inconclusive: boolean
}

export interface NetworkSnapshot {
  live: boolean
  planned: number
  fired: number
  problems: string[]
  /** every game-step call that ran, in order, with its wall times (switch-proof.ts judges them) */
  runs: NetworkCallRun[]
  /** Raw labelled tc -s output. Counters are never reset during the run. */
  qdiscSnapshots: {
    label: string
    /** Controller-clock bounds around the complete stats + app snapshot. The
     * qdisc and app counters are read inside this interval; gather charges the
     * whole uncertainty instead of pretending a busy runner completed it
     * instantaneously. */
    requestStartedAtMs?: number
    requestEndedAtMs?: number
    /** Counter boundary on the controller clock. New evidence uses request
     * start; older evidence used command completion and has no request bounds. */
    atMs: number
    output: string
    /** App counters read beside this qdisc counter. Their deltas define the
     * exact interval used by the acceptance reserve calculation. */
    adaptation?: Pick<NonNullable<AdaptiveUploadResult["page"]>, "currentRung" | "roundSecondsByRung" | "roundPayloadBytesByRung" | "roundHeaderBytesByRung" | "roundTransportBytesByRung" | "roundTransportAllowanceBytesByRung" | "roundTransportSecondsByRung" | "roundTransportCoveredPayloadBytesByRung" | "roundTransportCoveredHeaderBytesByRung" | "roundTransportCoveredSenderSecondsByRung" | "roundTransportExpectedSenderSecondsByRung" | "lastWindow">
  }[]
}

/** Actual controller-clock bounds of a successfully completed whole-link
 * blackout. Telemetry T9 uses these, rather than the planned turn, as its
 * acceptance-latency window. */
export const blackoutFaultWindow = (runs: readonly NetworkCallRun[]): { startedAtMs: number; recoveredAtMs: number } | null => {
  const run = runs.find((candidate) => candidate.call[0] === "blackout" && candidate.ok && !candidate.inconclusive)
  return run ? { startedAtMs: run.startMs, recoveredAtMs: run.endMs } : null
}

export const blackoutAcceptanceDeadline = (recoveredAtMs: number): number => recoveredAtMs + 60_000

/** Recovery is evidence, not merely elapsed time: netem must have completed a
 * conclusive blackout/restore run and every live document must have accepted
 * the browser recovery edge. */
export const blackoutRecoveryObserved = (
  window: { startedAtMs: number; recoveredAtMs: number } | null,
  recoveryEdges: readonly boolean[],
): boolean => window !== null && recoveryEdges.length > 0 && recoveryEdges.every(Boolean)

export const BLACKOUT_ISOLATION_MIN_MS = 30_000

/** T9 proves the app isolated neither before its grace elapsed nor after the
 * controller restored the link. Missing timestamps fail closed. */
export const isolationWithinBlackout = (
  isolationAtMs: number | null,
  window: { startedAtMs: number; recoveredAtMs: number } | null,
): boolean => isolationAtMs !== null && window !== null && isolationAtMs >= window.startedAtMs + BLACKOUT_ISOLATION_MIN_MS && isolationAtMs <= window.recoveredAtMs

export interface NetworkControllerOptions {
  plan: NetworkPlan
  /** Whether this process is attached to shaping that boot.mts successfully started. */
  active: boolean
  /** Initial shaping is owned by the parent group supervisor; this process
   * may use the active link but must not apply or clear runner-wide state. */
  shared?: boolean
  /** Executes exactly one netem call. Kept injectable so lifecycle tests never need tc, sudo or a shell. */
  run: (call: NetemCall, onLifecycle?: (event: NetemLifecycleEvent) => void) => Promise<string>
  /** Writes one complete evidence line; the caller owns its artifact destination. */
  write?: (line: string) => void
  say?: (line: string) => void
  now?: () => string
  /** wall ms, for the call runs' times; injectable so tests need no clock */
  nowMs?: () => number
  profileName?: string
  inactiveReason?: string
  /** Shared with journey role failures so their existing output order is unchanged. */
  problems?: string[]
  captureAdaptation?: () => Promise<AdaptiveUploadResult["page"]>
  sleep?: (ms: number) => Promise<void>
  /** Emits truthful, one-based timeline state for the recording narrator. */
  onNarration?: (event: NetworkNarrationEvent) => void
}

export type NetworkNarrationState = Extract<NarrationState, "preparing" | "active" | "failed" | "not-applied"> | "restored" | "inconclusive"
export type NetworkNarrationRole = "step" | "setup" | "action" | "restore"

export interface NetworkNarrationEvent {
  step: number
  state: NetworkNarrationState
  role: NetworkNarrationRole
  detail?: string
}

/**
 * The network-shaping lifecycle shared by boot and the Playwright journey.
 *
 * boot owns start/atOpen/final clear; the journey owns due timeline steps and
 * their proof snapshot. They construct the same controller on their side of
 * the process boundary, without importing an ESM-only module or adding IPC.
 */
export class NetworkController {
  private readonly plan: NetworkPlan
  private readonly active: boolean
  private readonly shared: boolean
  private readonly run: (call: NetemCall, onLifecycle?: (event: NetemLifecycleEvent) => void) => Promise<string>
  private readonly write: (line: string) => void
  private readonly say: (line: string) => void
  private readonly now: () => string
  private readonly nowMs: () => number
  private readonly profileName?: string
  private readonly inactiveReason?: string
  private readonly problems: string[]
  private readonly captureAdaptation?: () => Promise<AdaptiveUploadResult["page"]>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onNarration: (event: NetworkNarrationEvent) => void
  private readonly fired = new Set<number>()
  private readonly applied = new Set<number>()
  private readonly runs: NetworkCallRun[] = []
  private readonly inconclusiveSteps: string[] = []
  private readonly qdiscSnapshots: NetworkSnapshot["qdiscSnapshots"] = []
  private queue: Promise<void> = Promise.resolve()
  private readonly background = new Set<Promise<void>>()
  private cleared = false

  constructor(options: NetworkControllerOptions) {
    this.plan = options.plan
    this.active = options.active
    this.shared = options.shared ?? false
    this.run = options.run
    this.write = options.write ?? (() => undefined)
    this.say = options.say ?? console.log
    this.now = options.now ?? (() => new Date().toISOString())
    this.nowMs = options.nowMs ?? Date.now
    this.profileName = options.profileName
    this.inactiveReason = options.inactiveReason
    this.problems = options.problems ?? []
    this.captureAdaptation = options.captureAdaptation
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    this.onNarration = options.onNarration ?? (() => undefined)
  }

  /** Apply the initial link. A game queues atOpen work without waiting; a boot-only run exercises every planned call. */
  async start({ bootOnly }: { bootOnly: boolean }): Promise<void> {
    if (this.plan.start.length) {
      if (!this.active) this.say(`network profile ${this.profileName} NOT applied: ${this.inactiveReason}`)
      else if (this.shared) this.say(`network profile ${this.profileName} supplied by shared runner supervisor`)
      else {
        for (const call of this.plan.start) await this.run(call)
        await this.captureInitialQdisc()
      }
    }
    if (!this.active) return
    if (bootOnly) {
      // a host-chain cut needs the page open to prove the app's side: the journey's stage (a) runs its self-test instead
      for (const step of [...this.plan.timeline, ...this.plan.atOpen]) {
        const calls = step.calls.filter((call) => !isHostChainOperation(call))
        if (!calls.length) continue
        if (step.boundedBurst) {
          const [base, burst, restore] = calls
          await this.run(base)
          try {
            await this.run(burst)
            await this.sleep(step.boundedBurst.holdMs)
          } finally {
            await this.run(restore)
          }
          await this.run(["show"])
        } else for (const call of [...calls, ["show"] as NetemCall]) await this.run(call)
      }
      return
    }
    for (const step of this.plan.atOpen) {
      this.queue = this.queue.then(async () => {
        for (const call of step.calls) {
          await this.run(call).catch((error: Error) => this.write(`${this.now()} ERROR ${error.message}`))
        }
      })
    }
  }

  /** Record and queue every newly due game step. The play loop itself never waits for netem. */
  onTurn({ turn, sinceStartS }: { turn: number; sinceStartS: number | null }): NetworkStepEvidence[] {
    return this.fire(dueSteps(this.plan.timeline, this.fired, { turn, sinceStartS }), turn, `game turn ${turn}`)
  }

  /** Fire waiting-room steps after registration, when the journey reaches their offset before game_date. */
  onBeforeGame(secondsBeforeGame: number): NetworkStepEvidence[] {
    const due = this.plan.timeline.flatMap((step, i) => (!this.fired.has(i) && step.atBeforeGameS === secondsBeforeGame ? [i] : []))
    return this.fire(due, 0, `${secondsBeforeGame} s before the game`)
  }

  /** Fire a bounded devLog-gated step only after its distinct round channel
   * requirement is met. Counts below the threshold leave the link untouched.
   * A finalized roster may narrow the effective gate; its original identity
   * must still match the planned step before the narrower count can fire it. */
  onRoundChannelsOpen(
    round: number,
    count: number,
    duringBurst?: () => Promise<void>,
    gateOverride?: { planned: RoundChannelGate; effective: RoundChannelGate },
  ): NetworkStepEvidence[] {
    const due = this.plan.timeline.flatMap((step, i) => {
      const gate = step.atRoundChannelsOpen
      const planned = gateOverride?.planned
      const effective = gateOverride?.effective
      const plannedMatches = planned
        ? gate?.round === planned.round && gate?.count === planned.count && gate?.byGameS === planned.byGameS
        : gate?.round === round
      const effectiveMatches = effective
        ? effective.round === round && count >= effective.count
        : gate !== undefined && count >= gate.count
      return !this.fired.has(i) && plannedMatches && effectiveMatches ? [i] : []
    })
    return this.fire(due, 0, `${count} round-${round} channels open`, duringBurst)
  }

  pendingRoundChannelGates(): RoundChannelGate[] {
    return this.plan.timeline.flatMap((step, i) => (!this.fired.has(i) && step.atRoundChannelsOpen ? [step.atRoundChannelsOpen] : []))
  }

  /** Fire and await a serial pre-game step without waiting for older concurrent
   * work. A recovery deadline must not slip because a bounded fault command is
   * still doing its cleanup/proof probes; stop() joins that background work. */
  async runBeforeGame(secondsBeforeGame: number): Promise<NetworkStepEvidence[]> {
    const rows = this.onBeforeGame(secondsBeforeGame)
    await this.drain()
    return rows
  }

  /** Wait for queued shaping without ending the controller; used before a host restart that must follow a bounded hang. */
  async drain(): Promise<void> {
    await this.queue
  }

  /** Wait for deliberately concurrent timed work, such as a bounded waiting-room outage. */
  async drainBackground(): Promise<void> {
    await Promise.all([...this.background])
  }

  /** Record and queue the steps waiting for a game moment (the sign-up, the confirm stage), each once. `turn` is the evidence's
   *  turn number (0 before the game). */
  onMoment(moment: GameMoment, turn = 0): NetworkStepEvidence[] {
    return this.fire(momentSteps(this.plan.timeline, this.fired, moment), turn, `the ${moment}`)
  }

  /** The steps of a moment that have not fired: what the journey must wait for or explain. */
  pendingAt(moment: GameMoment): PlannedStep[] {
    return momentSteps(this.plan.timeline, this.fired, moment).map((i) => this.plan.timeline[i])
  }

  get isActive(): boolean {
    return this.active
  }

  private fire(due: number[], turn: number, when: string, duringBurst?: () => Promise<void>): NetworkStepEvidence[] {
    const rows: NetworkStepEvidence[] = []
    for (const i of due) {
      this.fired.add(i)
      const step = this.plan.timeline[i]
      const line = `${this.now()} network step ${i + 1} at ${when}: ${step.calls.map((call) => call.join(" ")).join(" then ")}${this.active ? "" : " (NOT applied: boot.mts did not shape this runner)"}`
      this.say(`  ${line}`)
      this.write(line)
      rows.push({ turn, applied: this.active, calls: step.calls })
      this.onNarration({ step: i + 1, state: "preparing", role: "step" })
      if (!this.active) this.onNarration({ step: i + 1, state: "not-applied", role: "step" })
      if (this.active) {
        const work = async () => {
          let ok = true
          if (this.profileName === UPLINK_LIFT_PROFILE) await this.captureQdisc(`step-${i + 1}-before`)
          const runCall = async (call: NetemCall, role: Exclude<NetworkNarrationRole, "step"> = "action"): Promise<NetworkCallRun> => {
            const startMs = this.nowMs()
            let result!: NetworkCallRun
            let terminal: NetemLifecycleEvent | null = null
            const ran = (good: boolean, inconclusive: boolean) => {
              result = { step: i + 1, call, startMs, endMs: this.nowMs(), ok: good, inconclusive }
              this.runs.push(result)
            }
            const observe = (event: NetemLifecycleEvent) => {
              if (role === "action" && event.state === "active") {
                this.onNarration({ step: i + 1, state: "active", role, detail: event.detail })
              } else terminal = event
            }
            await this.run(call, observe).then(() => {
              ran(true, false)
              if (terminal) this.onNarration({ step: i + 1, state: terminal.state, role, detail: terminal.detail })
            }, (error: Error) => {
              // acted, but could not show every side of it: recorded apart, never a pass and never a failed step
              if (netemOutcome(error) === "inconclusive") {
                ran(true, true)
                this.write(`INCONCLUSIVE ${error.message}`)
                this.inconclusiveSteps.push(`network step ${i + 1} (${call[0]}) INCONCLUSIVE: ${error.message.split("\n").filter((l) => /INCONCLUSIVE/.test(l)).slice(-1)[0]?.slice(0, 300) ?? "see netem.log"}`)
                this.onNarration({ step: i + 1, state: "inconclusive", role })
                return
              }
              ok = false
              ran(false, false)
              this.write(`ERROR ${error.message}`)
              this.problems.push(`network step ${i + 1} (${call.join(" ")}) failed: ${error.message.split("\n").slice(-2).join(" ").slice(0, 300)}`)
              this.onNarration({ step: i + 1, state: "failed", role })
            })
            return result
          }
          if (step.boundedBurst) {
            const [base, burst, restore] = step.calls
            const baseRun = await runCall(base, "setup")
            if (!baseRun.ok || baseRun.inconclusive) {
              await runCall(restore, "setup")
              return
            }
            let recover = false
            try {
              const burstRun = await runCall(burst)
              if (!burstRun.ok || burstRun.inconclusive) return
              recover = true
              const holdUntil = this.nowMs() + step.boundedBurst.holdMs
              try {
                await duringBurst?.()
              } catch (error) {
                ok = false
                recover = false
                this.problems.push(`network step ${i + 1} renegotiation hook failed: ${error instanceof Error ? error.message : String(error)}`)
                this.onNarration({ step: i + 1, state: "failed", role: "action" })
                return
              }
              await this.sleep(Math.max(0, holdUntil - this.nowMs()))
            } finally {
              await runCall(restore, recover ? "restore" : "setup")
            }
          } else for (const call of step.calls) {
            await runCall(call, ok ? "action" : "setup")
          }
          if (this.profileName === UPLINK_LIFT_PROFILE) await this.captureQdisc(`step-${i + 1}-after`)
          if (ok) this.applied.add(i)
        }
        if (step.concurrent) {
          const background = work().finally(() => this.background.delete(background))
          this.background.add(background)
        } else this.queue = this.queue.then(work)
      }
    }
    return rows
  }

  /** Drain owned work, clear shaping once when this process owns cleanup, and return role-proof inputs.
   * A journey controller inherits shaping applied by boot, so clearing must
   * not depend on this controller having called start(). */
  async stop({ clear = false }: { clear?: boolean } = {}): Promise<NetworkSnapshot> {
    await this.queue
    await this.drainBackground()
    if (this.active && this.profileName === UPLINK_LIFT_PROFILE) await this.captureQdisc("end")
    if (clear && this.active && !this.shared && !this.cleared) {
      await this.run(["clear"])
      this.cleared = true
    }
    return this.snapshot()
  }

  /** the steps that acted but came back INCONCLUSIVE (netemOutcome): stage (c) records each as an inconclusive check */
  inconclusive(): readonly string[] {
    return this.inconclusiveSteps
  }

  snapshot(): NetworkSnapshot {
    return { live: this.active, planned: this.plan.timeline.length, fired: this.applied.size, problems: this.problems, runs: [...this.runs], qdiscSnapshots: [...this.qdiscSnapshots] }
  }

  /** The boot process owns initial shaping, while the Playwright process owns
   * the game proof. Both may call this; each controller records at most one
   * start counter and never resets the qdisc. */
  async captureInitialQdisc(): Promise<void> {
    if (!this.active || this.profileName !== UPLINK_LIFT_PROFILE || this.qdiscSnapshots.some((snapshot) => snapshot.label === "shaped-start")) return
    await this.captureQdisc("shaped-start")
  }

  async captureQdisc(label: string): Promise<void> {
    if (!this.active || this.profileName !== UPLINK_LIFT_PROFILE || this.qdiscSnapshots.some((snapshot) => snapshot.label === label)) return
    try {
      const requestStartedAtMs = this.nowMs()
      const output = await this.run(["stats", label])
      const page = await this.captureAdaptation?.().catch((error) => {
        this.problems.push(`qdisc ${label} adaptation snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      const adaptation = page
        ? {
            currentRung: page.currentRung,
            roundSecondsByRung: page.roundSecondsByRung,
            roundPayloadBytesByRung: page.roundPayloadBytesByRung,
            roundHeaderBytesByRung: page.roundHeaderBytesByRung,
            roundTransportBytesByRung: page.roundTransportBytesByRung,
            roundTransportAllowanceBytesByRung: page.roundTransportAllowanceBytesByRung,
            roundTransportSecondsByRung: page.roundTransportSecondsByRung,
            roundTransportCoveredPayloadBytesByRung: page.roundTransportCoveredPayloadBytesByRung,
            roundTransportCoveredHeaderBytesByRung: page.roundTransportCoveredHeaderBytesByRung,
            roundTransportCoveredSenderSecondsByRung: page.roundTransportCoveredSenderSecondsByRung,
            roundTransportExpectedSenderSecondsByRung: page.roundTransportExpectedSenderSecondsByRung,
            ...(page.lastWindow ? { lastWindow: { activeSenders: page.lastWindow.activeSenders, validSenders: page.lastWindow.validSenders } } : {}),
          }
        : undefined
      const requestEndedAtMs = this.nowMs()
      this.qdiscSnapshots.push({
        label,
        requestStartedAtMs,
        requestEndedAtMs,
        atMs: requestStartedAtMs,
        output,
        ...(adaptation ? { adaptation } : {}),
      })
    } catch (error) {
      this.problems.push(`qdisc ${label} snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Release a bot's runner-wide shaping at the play/settlement boundary.
 * Cleanup is retried once because leaving packet loss in force can consume the
 * whole settlement budget. Neither failure is thrown: this helper runs from a
 * play-stage finally block and must preserve the primary game verdict. */
export async function clearNetworkAfterPlay(controller: NetworkController, report: (message: string) => void): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await controller.stop({ clear: true })
      return { ok: true, failures }
    } catch (error) {
      const message = `post-play network cleanup attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`
      failures.push(message)
      report(message)
    }
  }
  return { ok: false, failures }
}

const noNetwork: NetworkPlan = { start: [], timeline: [], atOpen: [] }

/** A timeline step as netem.sh calls. A named profile is a swap. A bounded named
 * profile plus restoreProfile explicitly applies the restore base, applies the
 * named profile's values, then restores the base after the controller-owned hold.
 * Ad-hoc numbers fill in what they leave
 * out from the step's base link; `forS` restores the previous link. A blackout
 * comes last, so the link that comes back is the step's. */
export function stepCalls(step: TimelineStep, base: NetemProfile, network: RunNetwork): NetemCall[] {
  const calls: NetemCall[] = []
  if (step.restoreProfile && step.forS !== undefined) {
    return [["swap", step.restoreProfile], ["custom", ...[base.delayMs, base.jitterMs, base.lossPct, base.rateMbit].map(String)], ["swap", step.restoreProfile]]
  }
  if (step.outage) calls.push(["outage", outageHost(step.outage, network), String(step.forS)])
  // the WebRTC path cut while signalling stays up: the relay's host is cut too, the People RPC must stay reachable
  if (step.udpCutS) calls.push(["udp-cut", String(step.udpCutS), outageHost("turn-relay", network), outageHost("people-rpc", network)])
  if (step.videoStallS) calls.push(["video-stall", String(step.videoStallS)])
  // the signing host's chain alone (host-chain-cut.ts): window, hold, the People RPC; boot's pid file etc. are added at run time
  if (step.hostChainCutS) {
    calls.push(["host-chain-cut", String(step.hostChainCutS), String(step.hostChainHoldS ?? step.hostChainCutS), outageHost("people-rpc", network)])
    if (step.profile === undefined && step.delayMs === undefined && step.jitterMs === undefined && step.lossPct === undefined && step.rateMbit === undefined && !step.blackoutS && !step.outage && !step.udpCutS && !step.videoStallS) return calls
  }
  if (step.hostChainHangS) {
    calls.push(["host-chain-hang", String(step.hostChainHangS), outageHost("people-rpc", network)])
    if (step.profile === undefined && step.delayMs === undefined && step.jitterMs === undefined && step.lossPct === undefined && step.rateMbit === undefined && !step.blackoutS && !step.outage && !step.udpCutS && !step.videoStallS) return calls
  }
  if (step.allowUdp) calls.push(["allow-udp"])
  if ((step.udpCutS || step.videoStallS) && !step.outage && step.profile === undefined && step.delayMs === undefined && step.jitterMs === undefined && step.lossPct === undefined && step.rateMbit === undefined && !step.blackoutS) return calls
  if (step.outage && step.profile === undefined && step.delayMs === undefined && step.jitterMs === undefined && step.lossPct === undefined && step.rateMbit === undefined) return calls
  const adhoc = step.delayMs !== undefined || step.jitterMs !== undefined || step.lossPct !== undefined || step.rateMbit !== undefined
  if (step.profile && !adhoc) calls.push(["swap", step.profile])
  if (adhoc) {
    const n = [step.delayMs ?? base.delayMs, step.jitterMs ?? base.jitterMs, step.lossPct ?? base.lossPct, step.rateMbit ?? base.rateMbit].map(String)
    calls.push(step.forS !== undefined && step.forS > 0 ? ["spike", String(step.forS), ...n] : ["custom", ...n])
  }
  if (step.blackoutS && step.blackoutS > 0) calls.push(["blackout", String(step.blackoutS)])
  return calls
}

export function networkPlan(profile: Profile | null, netem: Record<string, NetemProfile> = loadNetemProfiles(), network: RunNetwork = "previewnet"): NetworkPlan {
  if (!profile) return noNetwork
  const n = profile.network
  const start: NetemCall[] = [["apply", n.profile]]
  if (n.relayOnly) start.push(["block-udp"])
  start.push(["show"])
  const timeline: PlannedStep[] = []
  const atOpen: PlannedStep[] = []
  // switchAtTurn / switchTo / blackoutS is sugar for one timeline step
  if (n.switchAtTurn !== undefined && n.switchTo !== undefined) timeline.push({ atTurn: n.switchAtTurn, calls: stepCalls({ profile: n.switchTo, blackoutS: n.blackoutS }, netem[n.switchTo], network) })
  for (const step of n.timeline ?? []) {
    const base = netem[step.profile ?? n.profile]
    if (step.atOpen) atOpen.push({ calls: stepCalls(step, base, network) })
    else timeline.push({ ...(step.atTurn !== undefined && { atTurn: step.atTurn }), ...(step.atS !== undefined && { atS: step.atS }), ...(step.atBeforeGameS !== undefined && { atBeforeGameS: step.atBeforeGameS }), ...(step.atRoundChannelsOpen && { atRoundChannelsOpen: step.atRoundChannelsOpen }), ...(step.atSignUp && { at: "sign-up" as const }), ...(step.atConfirm && { at: "confirm" as const }), ...(step.concurrent && { concurrent: true as const }), ...(step.restoreProfile && step.forS !== undefined && { boundedBurst: { holdMs: step.forS * 1000, restoreProfile: step.restoreProfile } }), calls: stepCalls(step, base, network) })
  }
  return { start, timeline, atOpen }
}

/** The steps due now, not yet fired: by the game's turn count or by seconds since it started. */
export function dueSteps(plan: readonly PlannedStep[], fired: ReadonlySet<number>, at: { turn: number | null; sinceStartS: number | null }): number[] {
  return plan.flatMap((s, i) => (!fired.has(i) && ((s.atTurn !== undefined && at.turn !== null && at.turn >= s.atTurn) || (s.atS !== undefined && at.sinceStartS !== null && at.sinceStartS >= s.atS)) ? [i] : []))
}

/** The not-yet-fired steps waiting for `moment`. */
export function momentSteps(plan: readonly PlannedStep[], fired: ReadonlySet<number>, moment: GameMoment): number[] {
  return plan.flatMap((s, i) => (!fired.has(i) && s.at === moment ? [i] : []))
}

/** Only a Linux CI runner shapes its network; E2E_NETEM=0 turns it off anywhere. */
export function netemEnabled(env: Record<string, string | undefined>, platform: string = process.platform): { on: boolean; why: string } {
  if (env.E2E_NETEM === "0") return { on: false, why: "E2E_NETEM=0" }
  if (platform !== "linux") return { on: false, why: `${platform} is not Linux (netem is tc/iptables)` }
  if (!env.CI) return { on: false, why: "not a CI runner (CI unset): a desk's own network is never shaped" }
  return { on: true, why: "Linux CI runner" }
}

export const netemScript = (repoRoot: string): string => join(repoRoot, "scripts/e2e-live/netem.sh")

const netemRunners = new Map<string, ReturnType<typeof makeNetemRunner>>()
const netemRunnerFor = (repoRoot: string): ReturnType<typeof makeNetemRunner> => {
  const script = netemScript(repoRoot)
  const existing = netemRunners.get(script)
  if (existing) return existing
  const runner = makeNetemRunner(script, { timeoutFor: (args) => netemCallTimeoutMs(args as NetemCall) })
  netemRunners.set(script, runner)
  return runner
}

/** What one netem.sh call came to: proven (exit 0), inconclusive (NETEM_INCONCLUSIVE_EXIT: never a pass, never a fail) or failed. */
export function netemOutcome(error: unknown): "proven" | "inconclusive" | "failed" {
  if (error === null || error === undefined) return "proven"
  return error instanceof NetemError && error.exitCode === NETEM_INCONCLUSIVE_EXIT ? "inconclusive" : "failed"
}

/** A netem outcome as a check status: inconclusive is its own status, never a pass and never a fail. */
export const netemCheckStatus = (outcome: ReturnType<typeof netemOutcome>): "pass" | "inconclusive" | "fail" => (outcome === "proven" ? "pass" : outcome === "inconclusive" ? "inconclusive" : "fail")

/** One netem.sh call, async (a blackout sleeps for its duration); it sudo -n's itself. */
export const NETEM_TIMEOUT_MARGIN_MS = 60_000
export function netemCallTimeoutMs(call: NetemCall): number {
  const seconds = call[0] === "outage" ? Number(call[2]) : ["spike", "blackout", "host-chain-cut", "host-chain-hang", "udp-cut", "video-stall"].includes(call[0]) ? Number(call[1]) : 0
  return Math.max(120_000, (Number.isFinite(seconds) ? seconds : 0) * 1000 + NETEM_TIMEOUT_MARGIN_MS)
}

/** THE one way to run a netem call: run it, say what it printed, append both to <out>/netem.log. Throws with the output on failure. */
export async function netemStep(
  repoRoot: string,
  out: string,
  call: NetemCall,
  say: (line: string) => void = console.log,
  onLifecycle?: (event: NetemLifecycleEvent) => void,
): Promise<string> {
  const run = netemRunnerFor(repoRoot)
  let output: string
  try {
    output = await run(call, onLifecycle)
  } catch (error) {
    if (!(error instanceof NetemError)) throw error
    const text = [error.stdout, error.stderr].map((value) => value.trim()).filter(Boolean).join("\n") || error.message
    error.message = `netem.sh ${call.join(" ")} ${error.exitCode === NETEM_INCONCLUSIVE_EXIT ? "INCONCLUSIVE" : "failed"}: ${text}`
    throw error
  }
  const text = output.trim()
  say(`netem ${call.join(" ")}\n${text}`)
  appendFileSync(join(out, "netem.log"), `${new Date().toISOString()} netem ${call.join(" ")}\n${text}\n`)
  return text
}
