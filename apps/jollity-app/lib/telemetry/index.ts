// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE TELEMETRY DOORWAY. The rest of the app calls these and never sees
 * Sentry (the lib/host rule, for @sentry/react). Every function:
 *
 *  - starts Sentry first if nobody has (`startTelemetry` is idempotent),
 *    because the root layout's DebugBoot runs its effect AFTER the page's;
 *  - is a no-op without a DSN;
 *  - never throws.
 *
 * Framework-free: lib/journeys and lib/game-source import this on every
 * route, so nothing here pulls in React. The screens' scene hook is
 * lib/telemetry/use-scene.ts, imported from there.
 */
import * as Sentry from "@sentry/react"
import { sendFailure, setFailureDelivery, type FailureDetails, type FailureKind } from "./failures"
import {
  createJourney,
  noopJourney,
  recoverInterruptedJourneys as recoverJourneys,
  type Attrs,
  type Journey,
  type JourneyName,
  type JourneyOptions,
  type OpenJourneyRecord,
} from "./journeys"
import { uploadGameLog, type GameLogRequest } from "./game-log"
import { telemetryLive } from "./boot"
import { beginGameLogOutbox, setGameLogOutboxAccount, setGameLogOutboxStorageFallbackDelivery } from "./game-log-outbox"
import { describeError } from "../host/error-detail"
import { setHostRerunRecord } from "../host/safe-call"
import { devLog } from "../debug/log-store"
import { maskSafe } from "../journeys/mask-text"
import { setDeliveryHealthGame } from "./delivery-health"
import { setScopeTags } from "./scope-tags"
import type { GameStateRecord, PreviousSessionDiagnostic } from "./session-record"
import { logEvent } from "./log-event"
import { flushMetrics, recordCount, recordDistribution } from "./metrics"
import { APP_VERSION } from "../debug/flag"
import { observeWorkerHeartbeat, type WorkerHeartbeatObservation } from "./worker-heartbeat"
import type { HealCohortEvent, LinkFailure } from "../webrtc/heal-cohort"
import { healCohortAttributes } from "./heal-cohort"
import { linkFailedAttributes } from "./link-failed"
import type { DrawCeremonyEvidence } from "../draw/wheel/ceremony"
import type { AwayPeriodEvent } from "../webrtc/away-period"
import { awayPeriodAttributes } from "./away-period"
import type { HealEpisodeEvent } from "../webrtc/heal"
import { healEpisodeAttributes } from "./heal-episode"
import { cameraRestoreAttributes, type CameraRestoreEvent } from "./camera-restore"

setFailureDelivery({ flushMetrics, logEvent, recordCount })
setGameLogOutboxStorageFallbackDelivery({ logEvent, recordCount })
setHostRerunRecord(hostRetryRecord)

export { startTelemetry, telemetryLive } from "./boot"

/** One privacy-safe terminal record for a draw-wheel ceremony. Durations and
 * booleans stay typed; the game/player already on the Sentry scope is enough
 * to join this to a report, so no additional identity is sent. */
export function reportDrawCeremony(evidence: DrawCeremonyEvidence): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    logEvent("draw.ceremony", evidence.fallbackReason === "none" ? "info" : "warn", {
      "draw.ceremony_total_ms": evidence.totalMs,
      "draw.ceremony_load_ms": evidence.loadMs,
      "draw.ceremony_ending_ms": evidence.endingMs,
      "draw.continue_visible_ms": evidence.continueVisibleMs,
      "draw.hidden_ms": evidence.hiddenMs,
      "draw.ended": evidence.ended,
      "draw.continue_tapped": evidence.tapped,
      "draw.idle_advanced": evidence.idleAdvanced,
      "draw.fallback_reason": evidence.fallbackReason,
      // where a stage that never ended stood: the step it never got past
      ...Object.fromEntries(Object.entries(evidence.stall ?? {}).map(([key, value]) => [`draw.stall.${key}`, value ?? "null"])),
    })
  } catch {
    /* diagnostics never break the draw */
  }
}

/** One record for a near-simultaneous established-link failure wave. Arrays
 * are expanded because Logs attributes are typed scalars; every duration and
 * count stays numeric, while link identities and TURN credentials are absent. */
export function reportHealCohort(event: HealCohortEvent): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    logEvent("rtc.heal.cohort", "warn", healCohortAttributes(event))
  } catch {
    /* diagnostics never break self-healing */
  }
}

/** One typed Logs row for each established link that failed, and how (issue
 * #944): with the link's attributes, as rtc.away_period, so it joins its game
 * and round. A single failed link never forms a cohort, so this is the only
 * record of a one-link TURN reset. */
export function reportLinkFailed(event: LinkFailure, link: Record<string, string>): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    logEvent("rtc.link.failed", "warn", { ...linkFailedAttributes(event), ...link })
  } catch {
    /* diagnostics never break the mesh */
  }
}

/** One typed Logs row for a peer's completed away period. */
export function reportAwayPeriod(event: AwayPeriodEvent, link: Record<string, string>): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    logEvent("rtc.away_period", "info", { ...awayPeriodAttributes(event), ...link })
  } catch {
    /* diagnostics never break the mesh */
  }
}

/** One typed Logs row when an offered camera-restore episode ends. */
export function reportCameraRestore(event: CameraRestoreEvent): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    logEvent("rtc.camera_restore", "info", cameraRestoreAttributes(event))
  } catch {
    /* diagnostics never break camera recovery */
  }
}

/** One typed Logs row for all attempts in a terminal self-heal episode. */
export function reportHealEpisode(event: HealEpisodeEvent, link: Record<string, string>): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    logEvent("rtc.heal_episode", "info", { ...healEpisodeAttributes(event), ...link })
  } catch {
    /* diagnostics never break self-healing */
  }
}

/** One privacy-safe Logs row per shared-turn No-video choice. The matching
 * numeric count is emitted by game-trace; no account or tile id leaves the
 * device here. */
export function reportNoVideoChoice(
  choice: "default-notperson" | "flipped-person",
  everFlipped: boolean,
): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    logEvent("report.no_video_choice", "info", {
      "report.choice": choice,
      "report.ever_flipped": everFlipped,
    })
  } catch {
    /* telemetry never breaks report submission */
  }
}

/** A pre-game or network-change TURN attempt can finish before a join journey
 * exists. It gets a standalone, source-labelled span instead of being lost. */
export function turnReceiptSpan(outcome: {
  received: "true" | "cached" | "false"
  source?: string
  stage?: string
}): void {
  try {
    if (!outcome.source || !telemetryLive()) return
    applyScope()
    const span = Sentry.startInactiveSpan({
      name: "network.turn-receipt",
      op: "network.turn-receipt",
      attributes: {
        "turn.received": outcome.received,
        "turn.source": outcome.source,
        "turn.stage": outcome.stage ?? "none",
      },
    })
    span.end()
  } catch {
    /* diagnostics never break relay acquisition */
  }
}

/** The early peerless gather's result and the time it gives a player to move
 * networks before kickoff. Numeric values remain numeric at the call site. */
export function waitingNetworkCheckSpan(evidence: {
  result: string
  reason: string
  trigger: string
  leadTimeS?: number
  gatherMs: number
  attempts: number
  counts: { host: number; srflx: number; relay: number; other: number }
  relayUnreachable: boolean
}): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    const span = Sentry.startInactiveSpan({
      name: "network.waiting-check",
      op: "network.waiting-check",
      attributes: {
        "waiting_check.result": evidence.result,
        "waiting_check.reason": evidence.reason,
        "waiting_check.trigger": evidence.trigger,
        "waiting_check.gather_ms": evidence.gatherMs,
        "waiting_check.attempts": evidence.attempts,
        "waiting_check.host_candidates": evidence.counts.host,
        "waiting_check.srflx_candidates": evidence.counts.srflx,
        "waiting_check.relay_candidates": evidence.counts.relay,
        "waiting_check.other_candidates": evidence.counts.other,
        "waiting_check.relay_unreachable": evidence.relayUnreachable,
        ...(evidence.leadTimeS === undefined ? {} : { "waiting_check.lead_time_s": evidence.leadTimeS }),
      },
    })
    span.end()
  } catch {
    /* diagnostics never break the waiting room */
  }
}

let player: { id: string | null; name: string | null } = { id: null, name: null }
let gameIndex: number | null = null
let lowPower = false
let lowPowerReason = "none"
let probe: "done" | "none" = "none"
/** the SPS tap's session decision (lib/webrtc/sps-tap.ts, #629); unset until a mesh opens */
let spsTap: string | undefined
/** What the scope holds now, for this client, so an unchanged player, game or
 *  low power tag is not set again. */
let applied: {
  client: unknown
  player: typeof player
  gameIndex: number | null
  lowPower: boolean
  lowPowerReason: string
  probe: "done" | "none"
  spsTap: string | undefined
} | null = null

/** Put the remembered player, game and low power tags on the scope. Every
 *  public function calls it after its live check, so a player named before
 *  Sentry started is not lost; it only touches Sentry when one of them changed. */
function applyScope(): void {
  const client = Sentry.getClient()
  const fresh = applied?.client !== client
  if (
    !fresh &&
    applied?.player === player &&
    applied.gameIndex === gameIndex &&
    applied.lowPower === lowPower &&
    applied.lowPowerReason === lowPowerReason &&
    applied.probe === probe &&
    applied.spsTap === spsTap
  )
    return
  if (fresh || applied?.player !== player)
    Sentry.setUser(player.id ? { id: player.id, ...(player.name ? { username: player.name } : {}) } : null)
  if (fresh || applied?.gameIndex !== gameIndex) setScopeTags({ "game.index": gameIndex === null ? undefined : String(gameIndex) })
  if (fresh || applied?.lowPower !== lowPower || applied?.lowPowerReason !== lowPowerReason || applied?.probe !== probe)
    setScopeTags({ lowpower: lowPower ? "on" : "off", "lowpower.reason": lowPower ? lowPowerReason : "none", probe })
  if (fresh || applied?.spsTap !== spsTap) setScopeTags({ "rtc.sps_tap": spsTap })
  applied = { client, player, gameIndex, lowPower, lowPowerReason, probe, spsTap }
}

/** The Sentry user: `address` as the id (undefined keeps the current one),
 *  the host's permissioned name as the username when it gives one. */
export function setPlayer(address: string | null | undefined, name?: string | null): void {
  try {
    if (address !== undefined) {
      player = { ...player, id: address }
      setGameLogOutboxAccount(address)
    }
    if (name !== undefined) player = { ...player, name }
    if (!telemetryLive()) return
    applyScope()
  } catch {
    /* never throws */
  }
}

/**
 * One per-app-open verdict for the separately deployed chat worker.
 *
 * The count supplies a per-player denominator. Healthy workers stay
 * metric-only; every state but `fresh` and `not-applicable` also emits one
 * warning Log that can be found directly for the affected account without
 * manufacturing an Error.
 */
export function reportWorkerHeartbeat(observation: WorkerHeartbeatObservation): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    const expectedRelease = Sentry.getClient()?.getOptions().release ?? `jollity@${APP_VERSION}`
    const attrs = {
      "worker.status": observation.status,
      "worker.release": "release" in observation ? observation.release : "unknown",
      "worker.expected_release": expectedRelease,
    }
    recordCount("chat.worker.heartbeat", 1, attrs)
    if ("ageMs" in observation)
      recordDistribution("chat.worker.heartbeat_age_ms", observation.ageMs, "millisecond", attrs)
    if (observation.status !== "fresh" && observation.status !== "not-applicable")
      logEvent("chat-worker-heartbeat", "warn", {
        ...attrs,
        ...("ageMs" in observation ? { "worker.heartbeat_age_ms": observation.ageMs } : {}),
      })
  } catch {
    /* telemetry never breaks app startup */
  }
}

/** Read and report after DebugBoot's startup grace. Never rejects. */
export async function checkWorkerHeartbeat(): Promise<void> {
  try {
    const expectedRelease = Sentry.getClient()?.getOptions().release ?? `jollity@${APP_VERSION}`
    reportWorkerHeartbeat(await observeWorkerHeartbeat(expectedRelease))
  } catch {
    reportWorkerHeartbeat({ status: "unavailable" })
  }
}

/** The `game.index` tag, once the game is known. */
export function setGameIndex(next: number | null): void {
  try {
    if (!setDeliveryHealthGame(next)) return
    gameIndex = next
    // The sign-up/waiting room learns the game before handover. Start capture
    // there so the handover checkpoint includes the evidence leading to it.
    if (next !== null) beginGameLogOutbox(next)
    if (!telemetryLive()) return
    applyScope()
  } catch {
    /* never throws */
  }
}

/** A standalone log at the one point a sign-up is on the wire. Unlike the
 * game-signup journey it can be delivered before that journey ends, so a page
 * replacement cannot erase the fact of the broadcast. */
export function signupBroadcast(account: string, attempt: number, route: string, signupGameIndex: number | null): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    const release = Sentry.getClient()?.getOptions().release ?? "unknown"
    logEvent("signup-broadcast", "info", {
      account,
      "game.index": signupGameIndex === null ? "unknown" : String(signupGameIndex),
      "signup.attempt": String(attempt),
      "signup.route": route,
      release,
    })
  } catch {
    /* telemetry never breaks sign-up */
  }
}

/** The cap the chat worker puts on the text of a detail, so a reason reads the same from the app and the worker. */
const MAX_REASON_LENGTH = 300

/**
 * The answer of the host to a reminder ask of the app, as the chat worker
 * sends chat.reminder.ask.
 *
 * The reason the host gave for any answer but held goes in a log beside the
 * count, in the shape of the detail of the worker.
 */
export function reminderAskRecord(outcome: string, error?: string): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    const attrs = { outcome, surface: "app" }
    recordCount("reminder.ask", 1, attrs)
    if (error) logEvent("reminder.ask", "info", attrs, JSON.stringify({ error: error.slice(0, MAX_REASON_LENGTH) }))
  } catch {
    /* telemetry never breaks sign-up */
  }
}

/** Exactly one previous-session verdict per app open. This is diagnostic,
 * never a failure: the categories are evidence for deciding a later fix. */
export function previousSessionEnd(data: PreviousSessionDiagnostic): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    const midRound = data.turn !== undefined || data.openJourneys.includes("game")
    const uncleanInGame = data.inGame && (
      data.classification === "killed-background" ||
      data.classification === "crash-or-kill-foreground" ||
      (data.classification === "host-reload" && midRound)
    )
    const killedGameState = data.classification === "killed-background" || data.classification === "crash-or-kill-foreground"
      ? data.gameState
      : undefined
    const uncleanReason = data.classification === "host-reload" ? "host-reload" : "in-game"
    const attrs = {
      "previous.end": data.classification,
      "previous.visibility": data.lastVisibility,
      "previous.in_game": data.inGame,
      "previous.pagehide": data.pagehideSeen,
      "previous.pagehide_persisted": data.pagehidePersisted ?? "unknown",
      "previous.freeze": data.freezeSeen,
      "previous.visibility_changed": data.visibilityChanges > 0,
      "previous.screen": data.screen ?? "unknown",
      "previous.game": data.gameIndex === undefined ? "unknown" : String(data.gameIndex),
      "previous.turn": data.turn === undefined ? "unknown" : String(data.turn),
      ...(uncleanInGame
        ? {
            "failure.kind": "unclean-exit",
            "failure.reason": uncleanReason,
            "journey.expected": String(false),
          }
        : {}),
      ...(data.previousSessionId ? { "previous.session.session_id": data.previousSessionId } : {}),
      ...(data.gapMs !== undefined ? { "previous.session.gap_ms": data.gapMs } : {}),
      ...(data.gameIndex !== undefined ? { "previous.session.game_index": String(data.gameIndex) } : {}),
      ...(data.turn !== undefined ? { "previous.session.turn": String(data.turn) } : {}),
      ...(data.liveVideo !== undefined ? { "previous.session.live_video": data.liveVideo } : {}),
      ...(data.heapMb !== undefined ? { "previous.session.heap_mb": data.heapMb } : {}),
      ...(data.openJourneys.length > 0 ? { "previous.session.open_journeys": data.openJourneys.join(",") } : {}),
      ...(data.openJourneySteps.length > 0 ? { "previous.session.open_journey_steps": data.openJourneySteps.join(",") } : {}),
      "previous.session.visibility_changes": data.visibilityChanges,
      ...(killedGameState
        ? {
            "previous.game_state.unclean": true,
            "previous.game_state.ambiguous_end": "kill-or-force-quit",
            "previous.game_state.phase": killedGameState.phase,
            "previous.game_state.visibility": killedGameState.visibility,
            "previous.game_state.sampled_at_ms": killedGameState.sampledAtMs,
            ...(killedGameState.hiddenSinceMs === undefined ? {} : { "previous.game_state.hidden_since_ms": killedGameState.hiddenSinceMs }),
            ...(killedGameState.gameIndex === undefined ? {} : { "previous.game_state.game_index": String(killedGameState.gameIndex) }),
            ...(killedGameState.chainTimeMs === undefined ? {} : { "previous.game_state.chain_time_ms": killedGameState.chainTimeMs }),
            ...resourceAttrs("previous.game_state", killedGameState),
          }
        : {}),
      ...(uncleanInGame && data.openJourneys.length > 0
        ? {
            "failure.open_journeys": data.openJourneys.join(","),
            "failure.open_journey_steps": data.openJourneySteps.join(","),
          }
        : {}),
    }
    logEvent("previous-session-end", "info", attrs)
    recordCount("app.previous_end", 1, {
      "previous.end": data.classification,
      "previous.in_game": String(data.inGame),
    })
    if (uncleanInGame) {
      recordCount("failure", 1, {
        "failure.kind": "unclean-exit",
        "failure.reason": uncleanReason,
        "journey.expected": String(false),
      })
    }
  } catch {
    /* diagnostics never break app open */
  }
}

function resourceAttrs(prefix: string, state: GameStateRecord): Record<string, string | number | boolean> {
  const counters = state.counters
  return {
    [`${prefix}.counters_installed`]: counters.installed,
    [`${prefix}.peer_connections`]: counters.peerConnections,
    [`${prefix}.webgl_contexts`]: counters.glContexts,
    [`${prefix}.webgl_live`]: counters.glLive,
    [`${prefix}.webgl_lost`]: counters.glLost,
    [`${prefix}.videos`]: counters.videos,
    [`${prefix}.videos_live`]: counters.videosWithStream,
    [`${prefix}.video_max_width`]: counters.videoMaxWidth,
    [`${prefix}.video_max_height`]: counters.videoMaxHeight,
    [`${prefix}.video_pixels`]: counters.videoPixels,
    [`${prefix}.video_resolutions`]: counters.videoResolutions,
    [`${prefix}.canvases`]: counters.canvases,
    ...(counters.domNodes === undefined ? {} : { [`${prefix}.dom_nodes`]: counters.domNodes }),
  }
}

/** Existing 20 s page heartbeat, now with bounded load evidence. */
export function pageResourceSample(state: GameStateRecord): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    logEvent("page-resource-sample", "info", {
      "page.phase": state.phase,
      "page.visibility": state.visibility,
      "page.sampled_at_ms": state.sampledAtMs,
      ...(state.gameIndex === undefined ? {} : { "page.game_index": String(state.gameIndex) }),
      ...(state.chainTimeMs === undefined ? {} : { "page.chain_time_ms": state.chainTimeMs }),
      ...resourceAttrs("page.resource", state),
    })
  } catch {
    /* diagnostics never break the game */
  }
}

const CAMERA_SENTRY_TRANSITIONS = new Set([
  "open.requested",
  "open.resolved",
  "open.failed",
  "stream.reused",
  "track.muted",
  "track.unmuted",
  "track.ended",
  "self.no_frames",
  "self.play_rejected",
  "recover.started",
  "recover.done",
])

/** A notable camera diagnostic transition. The complete bounded trail stays
 * in devLog and the handover summary; periodic frame/outbound samples use
 * metrics only so a healthy game cannot emit hundreds of Sentry records. */
export function cameraTrail(event: string, data: Record<string, string | number | boolean | undefined>): void {
  try {
    if (!CAMERA_SENTRY_TRANSITIONS.has(event) && !(event === "self.attach" && data.stale === true)) return
    if (!telemetryLive()) return
    applyScope()
    logEvent("camera-trail", "info", { "camera.event": event, ...prefixed("camera", data) })
  } catch {
    /* diagnostics never break capture */
  }
}

export function cameraNoFrames(data: Record<string, string | number | boolean | undefined>): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    logEvent("camera.no_frames", "warn", {
      "camera.checkpoint": String(data.camera_checkpoint ?? "unknown"),
      ...prefixed("camera", data),
    })
  } catch {
    /* diagnostics never break capture */
  }
}

/** A host storage call still pending at 10 s (#776). Sent from lib/host/storage
 * at most once per session, because app-open may never end to carry its numbers. */
export function storageSlowRecord(data: { op: string; key: string; ms: number }): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    logEvent("storage-slow", "warn", {
      "storage.op": data.op,
      "storage.key": data.key,
      "storage.ms": data.ms,
    })
    recordCount("storage.slow", 1, { "storage.op": data.op })
  } catch {
    /* diagnostics never break app open */
  }
}

export type PageLifecycleEvent = "visibilitychange" | "pagehide" | "pageshow" | "freeze" | "resume"

/** One page lifecycle edge, sent as it happens so it lines up with the host retries it causes. */
export function pageLifecycleRecord(data: {
  event: PageLifecycleEvent
  state: "hidden" | "visible"
  monoMs: number
  persisted?: boolean
}): void {
  try {
    const monoMs = Math.round(data.monoMs)
    devLog("lifecycle", `${data.event}: ${data.state}`, { monoMs, persisted: data.persisted })
    if (!telemetryLive()) return
    applyScope()
    logEvent("page-lifecycle", "info", {
      "lifecycle.event": data.event,
      "lifecycle.state": data.state,
      "lifecycle.mono_ms": monoMs,
      ...(data.persisted === undefined ? {} : { "lifecycle.persisted": data.persisted }),
    })
  } catch {}
}

export type HostRetryReason = "host-interrupted" | "block-not-pinned" | "read-timeout" | "read-failed" | "turn"

export type HostRetry = {
  operation: string
  attempt: number
  reason: HostRetryReason
  waitedMs: number
  error: unknown
}

/** One rerun of a host request after a failure, logged before the rerun starts. */
export function hostRetryRecord(data: HostRetry): void {
  try {
    const waitedMs = Math.round(data.waitedMs)
    const detail = describeError(data.error).slice(0, 300)
    devLog("host", `retrying ${data.operation} (attempt ${data.attempt}) after ${data.reason}`, { waitedMs, detail }, "warn")
    if (!telemetryLive()) return
    applyScope()
    logEvent(
      "host.retry",
      "warn",
      {
        "host.retry.operation": data.operation,
        "host.retry.attempt": data.attempt,
        "host.retry.reason": data.reason,
        "host.retry.waited_ms": waitedMs,
      },
      detail,
    )
  } catch {}
}

/** One host chain-health probe. Unlike a provider read, the probe asks the
 * product-account signer to build a transaction, which exercises the host's
 * cached Subxt client. */
export function chainHealthRecord(data: {
  where: string
  outcome: string
  latencyMs: number
  errorClass?: string
  error?: string
  /** app opens in a row that found the chain lost (lib/chain-lost-streak) */
  consecutiveLost?: number
  /** the player holds a seat in the upcoming game */
  registered?: boolean
}): void {
  try {
    // Healthy probes are represented by the latency distribution. An event
    // every waiting-room interval adds volume without new diagnostic evidence.
    if (!telemetryLive() || data.outcome === "healthy") return
    applyScope()
    logEvent("chain.health", data.outcome === "host-chain-lost" ? "warn" : "info", {
      "chain.health.where": data.where,
      "chain.health.outcome": data.outcome,
      "chain.health.error_class": data.errorClass ?? "none",
      "chain.health.latency_ms": data.latencyMs,
      ...(data.consecutiveLost !== undefined ? { "chain.health.consecutive_lost": data.consecutiveLost } : {}),
      ...(data.registered !== undefined ? { "chain.health.registered": data.registered } : {}),
      ...(data.error ? { "chain.health.error": maskSafe(data.error) } : {}),
    })
    recordCount("chain.health", 1, {
      "chain.health.where": data.where,
      "chain.health.outcome": data.outcome,
    })
  } catch {
    /* diagnostics never break the game */
  }
}

function prefixed(
  context: string,
  values: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean | undefined> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [`${context}.${key}`, value]))
}

/** The `lowpower`, `lowpower.reason` and `probe` tags. Unset fields keep their value. */
export function setLowPowerTags(next: { lowpower?: boolean; reason?: string; probe?: "done" | "none" }): void {
  try {
    if (next.lowpower !== undefined) lowPower = next.lowpower
    if (next.reason !== undefined) lowPowerReason = next.reason
    if (next.probe !== undefined) probe = next.probe
    if (!telemetryLive()) return
    applyScope()
  } catch {
    /* never throws */
  }
}

/** The `rtc.sps_tap` tag: this session tapped at least one link's H.264 SPS
 *  (on), was drawn but has tapped none yet (pending), was drawn and failed
 *  before tapping any (failed), was not drawn (off), or cannot (unsupported). Decode times of
 *  tapped and untapped sessions are compared by it (#629). */
export function setSpsTapTag(state: "on" | "off" | "unsupported" | "pending" | "failed"): void {
  try {
    spsTap = state
    if (!telemetryLive()) return
    applyScope()
  } catch {
    /* never throws */
  }
}

/** Send one deliberate failure event of a fixed kind. With a journey, its
 *  `journey.expected` follows the failure. */
export function reportFailure(kind: FailureKind, details: FailureDetails, journey?: Journey): void {
  try {
    if (!telemetryLive()) return
    applyScope()
    sendFailure(kind, details, journey)
  } catch {
    /* never throws */
  }
}
export type { FailureDetails, FailureKind } from "./failures"

/** Start a journey. A no-op handle when telemetry is off; never throws. */
export function startJourney<N extends JourneyName>(name: N, attrs?: Attrs, options?: JourneyOptions): Journey<N> {
  try {
    if (!telemetryLive()) return noopJourney(name)
    applyScope()
    return createJourney(name, attrs, options)
  } catch {
    return noopJourney(name)
  }
}

/** Rebuild the roots a killed page could not send. The next same-name journey
 *  is linked to each rebuilt root by the journey module. */
export function recoverInterruptedJourneys(records: readonly OpenJourneyRecord[], previousSessionId: string, lastSeenAt: number): number {
  try {
    if (!telemetryLive()) return 0
    applyScope()
    return recoverJourneys(records, previousSessionId, lastSeenAt)
  } catch {
    return 0
  }
}

export type { Attrs, EndOptions, Journey, JourneyName, JourneyOptions, OpenJourneyRecord, OpenJourneyStepRecord, OutcomeOf, Step, StepOf, StepOptions } from "./journeys"
export { renderCrashDetails } from "./failures"
export type { GameLogRequest } from "./game-log"
export { connectionAttrs } from "./device"
export type { SceneName } from "./smoothness"
export { flushMetrics, recordCount, recordDistribution, recordGauge, type MetricAttrs, type MetricUnit } from "./metrics"

/** Send this device's log of one game. True once Sentry has it. */
export async function sendGameLog(request: GameLogRequest): Promise<boolean> {
  try {
    if (!telemetryLive()) return false
    applyScope()
    return await uploadGameLog(request)
  } catch {
    return false
  }
}
