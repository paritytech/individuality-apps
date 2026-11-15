// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Read-only capture of the decisions made by Mesh, useMesh and the store
 * calibration, for tests and the state-machine explorer (lib/explorer) to
 * replay offline.
 *
 * This is deliberately not telemetry and it has no authority. Production has
 * no registered sink, so observation is one synchronous empty-set iteration.
 * Test captures replace room, peer, connection and monotonic-time identities
 * with stable aliases; SDP, candidates, credentials and media never enter the
 * observation type.
 */

type LegacyDecisionKind =
  | "decision"
  | "effect-milestone"
  | "stamped-browser-fact"
  | "setup"
  | "calibration-release"
  | "roster"
  | "connection-identity"
  | "clock-ping"
  | "await-completion"
  | "isolation-commit"

export const LEGACY_CALIBRATION_RELEASE_REASONS = ["no-calibrator", "settled", "timeout"] as const

/** rtc lines of the debug log that a reader of exported game logs can parse
 * (mesh-log-contract.test.ts pins the recovery ones word for word). Keep them
 * stable; capture is additive and never replaces them. */
export const PARSER_VISIBLE_RTC_LOG_CONTRACT = [
  "[jollity-rtc] pc <peer> <state>",
  "[jollity-rtc] peer away <peer> said",
  "[jollity-rtc] peer back <peer>",
  "[jollity-rtc] round-link stage=<stage> round=<round> peer=<peer>",
  "[jollity-rtc] self-heal: <action> <peer> (attempt <n>)",
  "[jollity-rtc] media-stall: <reason>",
  "[jollity-rtc] media-stall: no-video-rebuild peer=<peer> signalingState=<state> round=<round> connected channel open but no inbound video → rebuild",
  "[jollity-rtc] stats pair <peer> <state> <nominated> <local> <remote>",
  "[jollity-rtc] relay candidate: <peer> and <peer> both send us video, but have no link to each other",
  "[jollity-rtc] standby (camera held back): <peer>",
  "[jollity-rtc] standby over (camera on): <peer>",
  "[jollity-rtc] no round left with: <peer>",
  "[jollity-rtc] view from <peer>: <row>",
] as const

type Scalar = string | number | boolean | null

interface LegacyDecisionFacts {
  signalingState?: RTCSignalingState | "missing"
  connectionState?: RTCPeerConnectionState | "missing"
  channelState?: RTCDataChannelState | "missing"
  localDescription?: RTCSdpType | null
  remoteDescription?: RTCSdpType | null
  pageHidden?: boolean
  online?: boolean
  cameraLive?: boolean
  standby?: boolean
  roomEpoch?: number
  connectionEpoch?: number
  commandEpoch?: number
  attemptEpoch?: number
  descriptionSessionEpoch?: number
  remoteSignallingSessionEpoch?: number
}

export interface LegacyDecisionObservation {
  kind: LegacyDecisionKind
  at: number
  event: string
  scope?: { room?: string; peer?: string; round?: number | null; generation?: number }
  decision?: string
  budget?: Record<string, Scalar>
  landingState?: string
  facts?: LegacyDecisionFacts
  setup?: { phase: string; cause?: string }
  calibrationRelease?: { reason: (typeof LEGACY_CALIBRATION_RELEASE_REASONS)[number] }
  roster?: { active: readonly string[]; standby: readonly string[]; removed?: readonly string[] }
  connection?: object | string | null
  clockPing?: { eligible: boolean; windowOpen?: boolean }
  awaitCompletion?: { command: string; outcome: "resolved" | "rejected" | "stale" }
}

export interface LegacyDecisionRecord extends Omit<LegacyDecisionObservation, "at" | "scope" | "connection" | "roster"> {
  order: number
  at: string
  scope?: { room?: string; peer?: string; round?: number | null; generation?: number }
  roster?: { active: string[]; standby: string[]; removed?: string[] }
  connectionIdentity?: string
}

type Sink = (observation: LegacyDecisionObservation) => void
type CaptureGlobal = typeof globalThis & {
  __jollityLegacyDecisionCaptureRegistry?: { sinks: Set<Sink> }
}

/* Some Mesh tests reload the implementation module between cases, and the
 * explorer (lib/explorer/mesh/room.ts) counts the registered sinks. Keep the
 * observer registry on globalThis so it is stable across that reload, just as
 * it is across development hot reloads; captures still own and remove their
 * individual sinks. */
const captureGlobal = globalThis as CaptureGlobal
const registry = captureGlobal.__jollityLegacyDecisionCaptureRegistry ?? { sinks: new Set<Sink>() }
captureGlobal.__jollityLegacyDecisionCaptureRegistry = registry
const { sinks } = registry

/** Observation is exception-contained so a capture can never alter a command. */
export function observeLegacyDecision(observation: LegacyDecisionObservation): void {
  for (const sink of sinks) {
    try {
      sink(observation)
    } catch {
      /* a read-only observer never breaks the decision it observes */
    }
  }
}

/** Lets hot command paths skip even their snapshot work when capture is off. */
export function legacyDecisionCaptureActive(): boolean {
  return sinks.size > 0
}

function alias(map: Map<string, string>, value: string | undefined, prefix: string): string | undefined {
  if (value === undefined) return undefined
  let found = map.get(value)
  if (!found) {
    found = `${prefix}-${map.size + 1}`
    map.set(value, found)
  }
  return found
}

/** Shared identity/time normalizer for capture and replay. One capture owns
 *  all its aliases, so separate captures cannot leak identity. */
class LegacyDecisionNormalizer {
  private order = 0
  private rooms = new Map<string, string>()
  private peers = new Map<string, string>()
  private times = new Map<number, string>()
  private objects = new WeakMap<object, string>()
  private scalarConnections = new Map<string, string>()
  private connectionCount = 0

  private connection(value: object | string | null | undefined): string | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value === "string") {
      let found = this.scalarConnections.get(value)
      if (!found) {
        found = `connection-${++this.connectionCount}`
        this.scalarConnections.set(value, found)
      }
      return found
    }
    let found = this.objects.get(value)
    if (!found) {
      found = `connection-${++this.connectionCount}`
      this.objects.set(value, found)
    }
    return found
  }

  normalize(observation: LegacyDecisionObservation): LegacyDecisionRecord {
    let at = this.times.get(observation.at)
    if (!at) {
      at = `time-${this.times.size + 1}`
      this.times.set(observation.at, at)
    }
    const room = alias(this.rooms, observation.scope?.room, "room")
    const peer = alias(this.peers, observation.scope?.peer, "peer")
    const scope = observation.scope
      ? {
          ...(room ? { room } : {}),
          ...(peer ? { peer } : {}),
          ...(observation.scope.round !== undefined ? { round: observation.scope.round } : {}),
          ...(observation.scope.generation !== undefined ? { generation: observation.scope.generation } : {}),
        }
      : undefined
    const roster = observation.roster
      ? {
          active: observation.roster.active.map((id) => alias(this.peers, id, "peer")!),
          standby: observation.roster.standby.map((id) => alias(this.peers, id, "peer")!),
          ...(observation.roster.removed
            ? { removed: observation.roster.removed.map((id) => alias(this.peers, id, "peer")!) }
            : {}),
        }
      : undefined
    const connectionIdentity = this.connection(observation.connection)
    return {
      order: ++this.order,
      at,
      kind: observation.kind,
      event: observation.event,
      ...(scope && Object.keys(scope).length > 0 ? { scope } : {}),
      ...(observation.decision !== undefined ? { decision: observation.decision } : {}),
      ...(observation.budget !== undefined ? { budget: { ...observation.budget } } : {}),
      ...(observation.landingState !== undefined ? { landingState: observation.landingState } : {}),
      ...(observation.facts !== undefined ? { facts: { ...observation.facts } } : {}),
      ...(observation.setup !== undefined ? { setup: { ...observation.setup } } : {}),
      ...(observation.calibrationRelease !== undefined ? { calibrationRelease: { ...observation.calibrationRelease } } : {}),
      ...(roster ? { roster } : {}),
      ...(connectionIdentity ? { connectionIdentity } : {}),
      ...(observation.clockPing !== undefined ? { clockPing: { ...observation.clockPing } } : {}),
      ...(observation.awaitCompletion !== undefined ? { awaitCompletion: { ...observation.awaitCompletion } } : {}),
    }
  }
}

export function captureLegacyDecisions(onRecord?: (record: LegacyDecisionRecord) => void): {
  records: LegacyDecisionRecord[]
  stop: () => void
} {
  const records: LegacyDecisionRecord[] = []
  const normalizer = new LegacyDecisionNormalizer()
  const sink: Sink = (observation) => {
    const record = normalizer.normalize(observation)
    records.push(record)
    onRecord?.(record)
  }
  sinks.add(sink)
  let stopped = false
  return {
    records,
    stop: () => {
      if (stopped) return
      stopped = true
      sinks.delete(sink)
    },
  }
}
