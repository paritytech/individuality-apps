// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PeerReport } from "./mesh"
import { rtcRates, type RtcSample } from "./rtc-stats"
import { sendRungPin } from "./send-rung-override"
import { SendAdaptationController, type SendTransition } from "./send-adaptation"
import { SendAdaptationEvidenceRecorder, type SendAdaptationEvidenceSnapshot } from "./send-adaptation-evidence"
import type { EffectsHealthSnapshot } from "../telemetry/smoothness"
import {
  FULL_VIDEO_RUNG,
  VIDEO_RUNGS,
  medianValue,
  summarizeSendWindow,
  type SendLinkWindow,
  type SendRoute,
  type SendRungIndex,
  type SendWindowSummary,
  type VideoRung,
  type VideoRungApplyResult,
} from "./send-adaptation-classifier"

export interface SendAdaptationMesh {
  applyVideoRung(rung: VideoRung): Promise<VideoRungApplyResult>
  videoRung(): SendRungIndex
}

export interface SendAdaptationPorts {
  nowMs(): number
  effectsHealth(nowMs: number): EffectsHealthSnapshot
  hidden(): boolean
  networkType?(): string | undefined
  /** Test-only rung ceiling; defaults to the ?sendRung URL pin (send-rung-override.ts). */
  pinnedRung?(): SendRungIndex | undefined
}

export interface SendAdaptationSnapshot extends SendAdaptationEvidenceSnapshot {
  gameIndex: number | null
  rung: SendRungIndex
  /** Name of the test-only ?sendRung pin, or "none": marks test runs so they never read as real starvation. */
  pinned: string
  state: ReturnType<SendAdaptationController["state"]>
  lastWindow?: SendWindowSummary
  /** Per-peer receiver evidence, keyed by the peer's id (its account in the
   * game mesh); cumulative decoder counters show that an observer actually
   * rendered this sender, not merely that the signalling connection existed.
   * The snapshot stays in memory (tests read it); nothing sends it. */
  peers: {
    account: string
    connected: boolean
    away: boolean
    firstFramesDecoded?: number
    lastFramesDecoded?: number
    /** One retained bucket per game turn. The monotonic elapsed values are
     * observer-local diagnostics; gather uses the turn boundary, never a
     * cross-runner clock. */
    decodedSamples?: DecodedTurnSample[]
  }[]
}

export interface DecodedTurnSample {
  turn: number
  firstElapsedMs: number
  lastElapsedMs: number
  firstFramesDecoded: number
  lastFramesDecoded: number
}

let latestSnapshot: SendAdaptationSnapshot = {
  gameIndex: null,
  rung: FULL_VIDEO_RUNG.index,
  pinned: pinName(sendRungPin()),
  state: new SendAdaptationController().state(),
  transitions: [],
  round: null,
  currentRung: FULL_VIDEO_RUNG.index,
  roundSecondsByRung: {},
  roundPayloadBytesByRung: {},
  roundHeaderBytesByRung: {},
  roundTransportBytesByRung: {},
  roundTransportAllowanceBytesByRung: {},
  roundTransportSecondsByRung: {},
  roundTransportCoveredPayloadBytesByRung: {},
  roundTransportCoveredHeaderBytesByRung: {},
  roundTransportCoveredSenderSecondsByRung: {},
  roundTransportExpectedSenderSecondsByRung: {},
  droppedChangeTransactions: 0,
  peers: [],
}

export function sendAdaptationSnapshot(): SendAdaptationSnapshot {
  return structuredClone(latestSnapshot)
}

function pinName(index: SendRungIndex | undefined): string {
  return VIDEO_RUNGS.find((rung) => rung.index === index)?.name ?? "none"
}

function routeOf(sample: RtcSample): SendRoute {
  const local = sample.localType
  const remote = sample.remoteType
  if (!local && !remote) return "unknown"
  return local === "relay" || remote === "relay" ? "relay" : "direct"
}

/** Framework-free owner of one game controller. Meshes may come and go as
 * groups change; the desired rung remains until startGame receives a new game. */
export class SendAdaptationDriver {
  private controller = new SendAdaptationController()
  private gameIndex: number | null = null
  private mesh: SendAdaptationMesh | null = null
  private previous = new Map<string, RtcSample>()
  private rttSamples = new Map<string, number[]>()
  private evidence = new SendAdaptationEvidenceRecorder(FULL_VIDEO_RUNG.index)
  private lastWindow?: SendWindowSummary
  private baselineOnlyWindows = 0
  private gameTurn: number | null = null
  private peerEvidence = new Map<string, { connected: boolean; away: boolean; firstFramesDecoded?: number; lastFramesDecoded?: number; decodedSamples?: DecodedTurnSample[] }>()
  private closed = false

  constructor(private readonly ports: SendAdaptationPorts) {
    this.publish()
  }

  startGame(gameIndex: number): void {
    if (this.gameIndex === gameIndex && !this.closed) return
    this.closed = false
    this.gameIndex = gameIndex
    this.controller = new SendAdaptationController({ nowMs: this.ports.nowMs(), ceiling: this.pin() })
    this.previous.clear()
    this.rttSamples.clear()
    this.evidence.reset(this.videoRung())
    this.lastWindow = undefined
    this.baselineOnlyWindows = 0
    this.peerEvidence.clear()
    this.publish()
    if (this.mesh && this.mesh.videoRung() !== this.videoRung()) void this.mesh.applyVideoRung(this.rung())
  }

  startRound(round: number | null): void {
    this.evidence.startRound(round)
    this.publish()
  }

  /** Global game turn used only to retain cross-runner receiver proof. */
  setGameTurn(turn: number | null): void {
    this.gameTurn = turn
  }

  /** A new sender changes the page-wide cap before the next three-second
   * report. Re-fit only from already measured capacity; no capacity means no
   * synthetic pressure. */
  async activeSendersChanged(count: number): Promise<void> {
    const prior = this.lastWindow
    if (!prior || prior.baselineOnly || prior.availableKbps === undefined || count <= prior.activeSenders || this.closed) return
    const state = this.controller.state()
    if (state.mode === "probing-up" || state.transition?.direction === "up") {
      this.neutralRegroup()
      this.publish()
      return
    }
    const current = this.rung()
    // availableKbps is already the lowest per-PC share. Sender count changes
    // must not divide that share a second time.
    if (current.maxBitrate <= prior.availableKbps * 1_000 * 0.75) return
    const summary: SendWindowSummary = {
      ...prior,
      atMs: this.ports.nowMs(),
      activeSenders: count,
      validSenders: Math.max(prior.validSenders, count),
      pressure: "bandwidth",
      severe: true,
      baselineOnly: false,
    }
    this.lastWindow = summary
    const transition = this.controller.observe(summary)
    if (transition) await this.applyTransition(transition)
    this.publish()
  }

  attachMesh(mesh: SendAdaptationMesh): void {
    this.mesh = mesh
    this.previous.clear()
    this.rttSamples.clear()
    this.lastWindow = undefined
    this.baselineOnlyWindows = 0
    this.publish()
    this.reapplyCurrentRung()
  }

  detachMesh(mesh: SendAdaptationMesh): void {
    if (this.mesh === mesh) this.mesh = null
    this.previous.clear()
    this.rttSamples.clear()
    this.lastWindow = undefined
    this.baselineOnlyWindows = 0
    this.neutralRegroup()
    this.publish()
  }

  visibilityChanged(hidden: boolean): void {
    if (!hidden) {
      this.previous.clear()
      this.rttSamples.clear()
      this.baselineOnlyWindows = 0
      this.neutralRegroup()
    }
    this.publish()
  }

  videoRung(): SendRungIndex {
    return this.controller.state().rung
  }

  rung(): VideoRung {
    return VIDEO_RUNGS.find((rung) => rung.index === this.videoRung()) ?? FULL_VIDEO_RUNG
  }

  /** The rung a fresh mesh should be built at: the pending target of an
   * unanswered down request, otherwise the settled rung. */
  targetRung(): VideoRung {
    return VIDEO_RUNGS.find((rung) => rung.index === this.controller.targetRung()) ?? FULL_VIDEO_RUNG
  }

  /** Results carry the mesh they came from: a detached mesh's late answer
   * never settles the request (a regroup swapped the mesh before it landed). */
  videoRungResult(result: VideoRungApplyResult, from?: SendAdaptationMesh): void {
    if (from !== undefined && from !== this.mesh) return
    if (!this.controller.acceptsResult(result)) {
      if (result.requested !== this.videoRung()) this.reapplyCurrentRung()
      return
    }
    this.evidence.apply(result)
    if (result.senders.length === 0) {
      // An empty apply on an outstanding down request counts as a refusal, so
      // the controller rolls back and the driver rewrites its rung instead of
      // treating the regroup as neutral. An empty apply on an up request
      // (probe) stays a neutral regroup: a refused probe would double the
      // recovery hold.
      if (this.controller.state().transition?.direction === "down") this.refuse(result)
      else this.neutralRegroup()
      this.publish()
      return
    }
    const held = result.senders.some((sender) => sender.appliedFields.includes("maxBitrate"))
    const allPending = result.senders.length > 0 && result.senders.every((sender) => sender.status === "pending" || sender.status === "missing")
    if (held || allPending) this.controller.accepted(result, this.ports.nowMs())
    else this.refuse(result)
    this.publish()
  }

  async observeReports(reports: readonly PeerReport[]): Promise<void> {
    if (this.closed || this.gameIndex === null) return
    const now = this.ports.nowMs()
    const gameTurn = this.gameTurn
    const links: SendLinkWindow[] = []
    for (const report of reports) {
      const sample = report.quality
      if (!sample) continue
      const decoded = sample.inbound?.framesDecoded
      const peer = this.peerEvidence.get(report.id) ?? { connected: false, away: false }
      peer.connected = report.conn === "connected"
      peer.away = report.away
      if (decoded !== undefined) {
        peer.firstFramesDecoded ??= decoded
        peer.lastFramesDecoded = decoded
        if (gameTurn !== null) {
          const samples = [...(peer.decodedSamples ?? [])]
          const current = samples.find((sample) => sample.turn === gameTurn)
          if (current) {
            current.lastElapsedMs = now
            current.lastFramesDecoded = decoded
          } else {
            samples.push({ turn: gameTurn, firstElapsedMs: now, lastElapsedMs: now, firstFramesDecoded: decoded, lastFramesDecoded: decoded })
          }
          peer.decodedSamples = samples
        }
      }
      this.peerEvidence.set(report.id, peer)
      const prior = this.previous.get(report.id)
      const rates = rtcRates(prior?.link === sample.link ? prior : undefined, sample)
      this.previous.set(report.id, sample)
      const valid = rates.windowMs !== undefined
      const active = report.conn === "connected" && Boolean(sample.outbound)
      links.push({
        id: report.id,
        active,
        valid,
        durationMs: rates.windowMs,
        reason: normalizeReason(sample.outbound?.qualityLimitationReason),
        reasonDurations: rates.reasonDurations,
        outKbps: rates.outKbps,
        targetKbps: rates.targetKbps,
        availableKbps: rates.availKbps,
        queueMsPerPacket: rates.queueMsPerPacket,
        rttMs: rates.rttMs,
        encodeMsPerFrame: rates.encodeMs,
        encodeSeconds: rates.encodeSeconds,
        framesEncoded: rates.framesEncoded,
        framesSent: rates.framesSent,
        payloadBytes: rates.bytesSent,
        headerBytes: rates.headerBytesSent,
        transportBytes: rates.transportBytesSent,
        transportAllowanceBytes: rates.transportAllowanceBytesSent,
        encoderImplementation: sample.outbound?.encoderImplementation,
        powerEfficientEncoder: sample.outbound?.powerEfficientEncoder,
        width: sample.outbound?.width,
        height: sample.outbound?.height,
        fps: sample.outbound?.fps,
        route: routeOf(sample),
      })
    }
    const validDurations = links.flatMap((link) => (link.active && link.valid && link.durationMs !== undefined ? [link.durationMs] : []))
    const durationMs = medianValue(validDurations)
    if (durationMs === undefined) {
      this.publish()
      return
    }
    const baselines = new Map(
      [...this.rttSamples].flatMap(([id, values]) => {
        const value = values.length ? Math.min(...values) : undefined
        return value === undefined ? [] : [[id, value] as const]
      }),
    )
    const summary = summarizeSendWindow(
      {
        atMs: now,
        durationMs,
        hidden: this.ports.hidden(),
        networkType: this.ports.networkType?.(),
        links,
        rungMaxBitrate: this.rung().maxBitrate,
        effects: this.ports.effectsHealth(now),
      },
      baselines,
    )
    this.baselineOnlyWindows = summary.baselineOnly ? this.baselineOnlyWindows + 1 : 0
    const actionable = summary.baselineOnly && this.baselineOnlyWindows > 2 ? { ...summary, baselineOnly: false } : summary
    // Preserve the raw completeness bit for sender-growth decisions even when
    // the controller's bounded hold has expired for ordinary adaptation.
    this.lastWindow = summary
    this.evidence.observe(actionable)
    // Never teach the baseline from a sample already proven pressured. A
    // congested first window otherwise normalises multi-second RTT inflation.
    for (const link of summary.pressure === "healthy" ? links : []) {
      if (!link.active || !link.valid || link.rttMs === undefined) continue
      const samples = [...(this.rttSamples.get(link.id) ?? []), link.rttMs].slice(-10)
      this.rttSamples.set(link.id, samples)
    }
    const transition = this.controller.observe(actionable)
    if (transition) await this.applyTransition(transition)
    else this.reapplyCurrentRung()
    this.publish()
  }

  close(): void {
    this.evidence.close()
    this.closed = true
    this.mesh = null
    this.previous.clear()
    this.rttSamples.clear()
    this.publish()
  }

  private pin(): SendRungIndex | undefined {
    return (this.ports.pinnedRung ?? sendRungPin)()
  }

  private publish(): void {
    const evidence = this.evidence.snapshot()
    latestSnapshot = {
      ...evidence,
      gameIndex: this.gameIndex,
      rung: this.videoRung(),
      pinned: pinName(this.pin()),
      state: this.controller.state(),
      ...(this.lastWindow ? { lastWindow: this.lastWindow } : {}),
      peers: [...this.peerEvidence.entries()].map(([account, evidence]) => ({ account, ...evidence })),
    }
  }

  private async applyTransition(transition: SendTransition): Promise<void> {
    this.evidence.transition(transition)
    const mesh = this.mesh
    if (!mesh) {
      this.videoRungResult({ requested: transition.to, senders: [], uniform: false })
      return
    }
    try {
      const result = await mesh.applyVideoRung(VIDEO_RUNGS.find((rung) => rung.index === transition.to) ?? FULL_VIDEO_RUNG)
      if (this.controller.state().mode === "awaiting-apply" && mesh === this.mesh) this.videoRungResult(result, mesh)
    } catch {
      this.videoRungResult({ requested: transition.to, senders: [], uniform: false })
    }
  }

  /** Writes the target rung (pending down request or settled rung) to the
   * attached mesh when it differs — a fresh mesh is built at the target, so
   * attach itself usually makes no write. */
  private reapplyCurrentRung(): void {
    const mesh = this.mesh
    const rung = this.targetRung()
    if (!mesh || mesh.videoRung() === rung.index) return
    void mesh.applyVideoRung(rung).catch(() => undefined)
  }

  private neutralRegroup(): void {
    this.controller.regroup()
    this.evidence.reconcile(this.videoRung())
    this.reapplyCurrentRung()
  }

  private refuse(result: VideoRungApplyResult): void {
    this.controller.rejected(result, this.ports.nowMs())
    this.evidence.reconcile(this.videoRung())
    this.reapplyCurrentRung()
  }
}

function normalizeReason(reason: string | undefined): SendLinkWindow["reason"] {
  return reason === "none" || reason === "bandwidth" || reason === "cpu" || reason === "other" ? reason : undefined
}
