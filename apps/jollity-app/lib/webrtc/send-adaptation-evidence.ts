// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { captureMeasurementTransaction } from "../telemetry/measurements"
import { percentile } from "../telemetry/util"
import type { SendTransition } from "./send-adaptation"
import { VIDEO_RUNGS, type SendRungIndex, type SendWindowSummary, type VideoRungApplyResult } from "./send-adaptation-classifier"

export interface SendTransitionEvidence extends SendTransition {
  applied: number
  refused: number
  after?: SendWindowSummary
}

export interface SendAdaptationEvidenceSnapshot {
  round: number | null
  currentRung: SendRungIndex
  transitions: SendTransitionEvidence[]
  roundSecondsByRung: Record<string, number>
  roundPayloadBytesByRung: Record<string, number>
  roundHeaderBytesByRung: Record<string, number>
  roundTransportBytesByRung: Record<string, number>
  roundTransportAllowanceBytesByRung: Record<string, number>
  roundTransportSecondsByRung: Record<string, number>
  roundTransportCoveredPayloadBytesByRung: Record<string, number>
  roundTransportCoveredHeaderBytesByRung: Record<string, number>
  roundTransportCoveredSenderSecondsByRung: Record<string, number>
  roundTransportExpectedSenderSecondsByRung: Record<string, number>
  droppedChangeTransactions: number
}

/** Bounded, game-local evidence. It records CPU/effects observations but never
 * owns policy: only the network state machine (send-adaptation.ts) changes a
 * rung. */
export class SendAdaptationEvidenceRecorder {
  private round: number | null = null
  private currentRung: SendRungIndex
  private transitions: SendTransitionEvidence[] = []
  private pending?: SendTransitionEvidence
  private pendingApplied = false
  private secondsByRung = new Map<SendRungIndex, number>()
  private payloadByRung = new Map<SendRungIndex, number>()
  private headerByRung = new Map<SendRungIndex, number>()
  private gameSecondsByRung = new Map<SendRungIndex, number>()
  private gamePayloadByRung = new Map<SendRungIndex, number>()
  private gameHeaderByRung = new Map<SendRungIndex, number>()
  private gameTransportByRung = new Map<SendRungIndex, number>()
  private gameTransportAllowanceByRung = new Map<SendRungIndex, number>()
  private gameTransportSecondsByRung = new Map<SendRungIndex, number>()
  private gameTransportCoveredPayloadByRung = new Map<SendRungIndex, number>()
  private gameTransportCoveredHeaderByRung = new Map<SendRungIndex, number>()
  private gameTransportCoveredSenderSecondsByRung = new Map<SendRungIndex, number>()
  private gameTransportExpectedSenderSecondsByRung = new Map<SendRungIndex, number>()
  private pressureSeconds = new Map<string, number>()
  private queue: number[] = []
  private encode: number[] = []
  private encodeShares: number[] = []
  private frameP95: number[] = []
  private slowShares: number[] = []
  private loafP95: number[] = []
  private loafMax: number[] = []
  private emittedChanges = 0
  private droppedChanges = 0
  private failedProbes = 0
  private stepUps = 0
  private openingRung: SendRungIndex
  private minRung: SendRungIndex
  private maxRung: SendRungIndex
  private encoders = new Map<string, number>()
  private encoderKinds = new Map<string, number>()

  constructor(openingRung: SendRungIndex) {
    this.currentRung = openingRung
    this.openingRung = openingRung
    this.minRung = openingRung
    this.maxRung = openingRung
  }

  reset(openingRung: SendRungIndex): void {
    this.closeRound()
    this.round = null
    this.currentRung = openingRung
    this.openingRung = openingRung
    this.minRung = openingRung
    this.maxRung = openingRung
    this.transitions = []
    this.pending = undefined
    this.pendingApplied = false
    this.emittedChanges = 0
    this.droppedChanges = 0
    this.clearRound()
    this.gameSecondsByRung.clear()
    this.gamePayloadByRung.clear()
    this.gameHeaderByRung.clear()
    this.gameTransportByRung.clear()
    this.gameTransportAllowanceByRung.clear()
    this.gameTransportSecondsByRung.clear()
    this.gameTransportCoveredPayloadByRung.clear()
    this.gameTransportCoveredHeaderByRung.clear()
    this.gameTransportCoveredSenderSecondsByRung.clear()
    this.gameTransportExpectedSenderSecondsByRung.clear()
  }

  startRound(round: number | null): void {
    if (this.round === round) return
    this.closeRound()
    this.round = round
    this.clearRound()
  }

  observe(summary: SendWindowSummary): void {
    if (this.pending && this.pendingApplied && !this.pending.after && !summary.hidden && !summary.baselineOnly && summary.validSenders > 0) {
      this.pending.after = summary
      this.emitChange(this.pending)
      this.pending = undefined
      this.pendingApplied = false
    }
    if (summary.hidden || summary.baselineOnly) return
    const seconds = summary.durationMs / 1_000
    this.secondsByRung.set(this.currentRung, (this.secondsByRung.get(this.currentRung) ?? 0) + seconds)
    this.payloadByRung.set(this.currentRung, (this.payloadByRung.get(this.currentRung) ?? 0) + (summary.payloadBytes ?? 0))
    this.headerByRung.set(this.currentRung, (this.headerByRung.get(this.currentRung) ?? 0) + (summary.headerBytes ?? 0))
    this.gameSecondsByRung.set(this.currentRung, (this.gameSecondsByRung.get(this.currentRung) ?? 0) + seconds)
    this.gamePayloadByRung.set(this.currentRung, (this.gamePayloadByRung.get(this.currentRung) ?? 0) + (summary.payloadBytes ?? 0))
    this.gameHeaderByRung.set(this.currentRung, (this.gameHeaderByRung.get(this.currentRung) ?? 0) + (summary.headerBytes ?? 0))
    // Selected-pair churn invalidates only the affected link. Keep transport
    // and RTP from the same covered links, plus sender-seconds for the missing
    // links, rather than blanking every peer in that observe window.
    if (
      summary.validSenders > 0
      && summary.transportBytes !== undefined
      && summary.transportAllowanceBytes !== undefined
      && summary.transportCoveredPayloadBytes !== undefined
      && summary.transportCoveredHeaderBytes !== undefined
      && summary.transportCoveredSenderSeconds !== undefined
    ) {
      this.gameTransportByRung.set(this.currentRung, (this.gameTransportByRung.get(this.currentRung) ?? 0) + summary.transportBytes)
      this.gameTransportAllowanceByRung.set(this.currentRung, (this.gameTransportAllowanceByRung.get(this.currentRung) ?? 0) + summary.transportAllowanceBytes)
      this.gameTransportCoveredPayloadByRung.set(this.currentRung, (this.gameTransportCoveredPayloadByRung.get(this.currentRung) ?? 0) + summary.transportCoveredPayloadBytes)
      this.gameTransportCoveredHeaderByRung.set(this.currentRung, (this.gameTransportCoveredHeaderByRung.get(this.currentRung) ?? 0) + summary.transportCoveredHeaderBytes)
      this.gameTransportCoveredSenderSecondsByRung.set(
        this.currentRung,
        (this.gameTransportCoveredSenderSecondsByRung.get(this.currentRung) ?? 0) + summary.transportCoveredSenderSeconds,
      )
      if (summary.transportCoveredSenderSeconds === summary.transportExpectedSenderSeconds)
        this.gameTransportSecondsByRung.set(this.currentRung, (this.gameTransportSecondsByRung.get(this.currentRung) ?? 0) + seconds)
    }
    if (summary.transportExpectedSenderSeconds !== undefined)
      this.gameTransportExpectedSenderSecondsByRung.set(
        this.currentRung,
        (this.gameTransportExpectedSenderSecondsByRung.get(this.currentRung) ?? 0) + summary.transportExpectedSenderSeconds,
      )
    this.pressureSeconds.set(summary.pressure, (this.pressureSeconds.get(summary.pressure) ?? 0) + seconds)
    if (summary.queueMsPerPacket !== undefined) this.queue.push(summary.queueMsPerPacket)
    if (summary.encodeMsPerFrame !== undefined) this.encode.push(summary.encodeMsPerFrame)
    if (summary.encodeShare !== undefined) this.encodeShares.push(summary.encodeShare)
    if (summary.effects.frameP95Ms !== undefined) this.frameP95.push(summary.effects.frameP95Ms)
    if (summary.effects.slowFrameShare !== undefined) this.slowShares.push(summary.effects.slowFrameShare)
    if (summary.effects.loafP95Ms !== undefined) this.loafP95.push(summary.effects.loafP95Ms)
    if (summary.effects.loafMaxMs !== undefined) this.loafMax.push(summary.effects.loafMaxMs)
    for (const encoder of summary.encoderImplementations) this.encoders.set(encoder, (this.encoders.get(encoder) ?? 0) + 1)
    const kind = summary.powerEfficientEncoder === true ? "hardware" : summary.powerEfficientEncoder === false ? "software" : "unsupported"
    this.encoderKinds.set(kind, (this.encoderKinds.get(kind) ?? 0) + 1)
  }

  transition(value: SendTransition): void {
    const evidence: SendTransitionEvidence = { ...value, applied: 0, refused: 0 }
    this.transitions.push(evidence)
    if (this.transitions.length > 64) this.transitions.shift()
    this.pending = evidence
    this.pendingApplied = false
    this.currentRung = value.to
    if (rungPosition(value.to) < rungPosition(this.minRung)) this.minRung = value.to
    if (rungPosition(value.to) > rungPosition(this.maxRung)) this.maxRung = value.to
    if (value.probe === "failed") this.failedProbes++
    if (value.direction === "up") this.stepUps++
  }

  apply(result: VideoRungApplyResult): void {
    const transition = [...this.transitions].reverse().find((value) => value.to === result.requested && value.after === undefined)
    if (!transition) return
    transition.applied = result.senders.filter((sender) => sender.status === "applied" || sender.status === "partial").length
    transition.refused = result.senders.filter((sender) => sender.status === "refused").length
    if (transition.applied > 0) this.pendingApplied = true
    if (transition.applied === 0 && (result.senders.length === 0 || result.senders.some((sender) => sender.status === "refused"))) {
      this.currentRung = transition.from
      if (this.pending === transition) this.pending = undefined
      this.pendingApplied = false
    }
  }

  /** A regroup or rejected apply returns ownership to the controller's
   * authoritative rung without treating the interruption as a failed probe. */
  reconcile(rung: SendRungIndex): void {
    this.currentRung = rung
    this.pending = undefined
    this.pendingApplied = false
  }

  snapshot(): SendAdaptationEvidenceSnapshot {
    return {
      round: this.round,
      currentRung: this.currentRung,
      transitions: structuredClone(this.transitions),
      roundSecondsByRung: Object.fromEntries(VIDEO_RUNGS.map((rung) => [rung.name, this.gameSecondsByRung.get(rung.index) ?? 0])),
      roundPayloadBytesByRung: Object.fromEntries(VIDEO_RUNGS.map((rung) => [rung.name, this.gamePayloadByRung.get(rung.index) ?? 0])),
      roundHeaderBytesByRung: Object.fromEntries(VIDEO_RUNGS.map((rung) => [rung.name, this.gameHeaderByRung.get(rung.index) ?? 0])),
      roundTransportBytesByRung: Object.fromEntries(VIDEO_RUNGS.map((rung) => [rung.name, this.gameTransportByRung.get(rung.index) ?? 0])),
      roundTransportAllowanceBytesByRung: Object.fromEntries(VIDEO_RUNGS.map((rung) => [rung.name, this.gameTransportAllowanceByRung.get(rung.index) ?? 0])),
      roundTransportSecondsByRung: Object.fromEntries(VIDEO_RUNGS.map((rung) => [rung.name, this.gameTransportSecondsByRung.get(rung.index) ?? 0])),
      roundTransportCoveredPayloadBytesByRung: Object.fromEntries(VIDEO_RUNGS.map((rung) => [rung.name, this.gameTransportCoveredPayloadByRung.get(rung.index) ?? 0])),
      roundTransportCoveredHeaderBytesByRung: Object.fromEntries(VIDEO_RUNGS.map((rung) => [rung.name, this.gameTransportCoveredHeaderByRung.get(rung.index) ?? 0])),
      roundTransportCoveredSenderSecondsByRung: Object.fromEntries(VIDEO_RUNGS.map((rung) => [rung.name, this.gameTransportCoveredSenderSecondsByRung.get(rung.index) ?? 0])),
      roundTransportExpectedSenderSecondsByRung: Object.fromEntries(VIDEO_RUNGS.map((rung) => [rung.name, this.gameTransportExpectedSenderSecondsByRung.get(rung.index) ?? 0])),
      droppedChangeTransactions: this.droppedChanges,
    }
  }

  close(): void {
    this.closeRound()
  }

  private emitChange(value: SendTransitionEvidence): void {
    if (!value.after) return
    if (this.emittedChanges >= 5) {
      this.droppedChanges++
      return
    }
    this.emittedChanges++
    const tags = {
      transition_id: value.id,
      direction: value.direction,
      cause: value.cause,
      probe: value.probe,
      from_rung: String(value.from),
      to_rung: String(value.to),
      route: value.before.route,
      network_type: value.before.networkType ?? "unknown",
      encoder: value.before.encoderImplementations.join(",") || "unknown",
      encoder_kind: value.before.powerEfficientEncoder === true ? "hardware" : value.before.powerEfficientEncoder === false ? "software" : "unknown",
    }
    const before = value.before
    const after = value.after
    const endMs = Date.now()
    captureMeasurementTransaction("rtc.send_adaptation.change", { ...tags, phase: "before", measurement_set: "network" }, networkMeasurements("before", before, value.from, value), {
      startMs: endMs - before.durationMs - after.durationMs,
      endMs: endMs - after.durationMs,
    })
    captureMeasurementTransaction("rtc.send_adaptation.change", { ...tags, phase: "after", measurement_set: "network" }, networkMeasurements("after", after, value.to, value), {
      startMs: endMs - after.durationMs,
      endMs,
    })
    captureMeasurementTransaction("rtc.send_adaptation.change", { ...tags, phase: "before", measurement_set: "cpu-effects" }, cpuMeasurements("before", before), {
      startMs: endMs - before.durationMs - after.durationMs,
      endMs: endMs - after.durationMs,
    })
    captureMeasurementTransaction("rtc.send_adaptation.change", { ...tags, phase: "after", measurement_set: "cpu-effects" }, cpuMeasurements("after", after), {
      startMs: endMs - after.durationMs,
      endMs,
    })
  }

  private closeRound(): void {
    if (this.round === null || !this.secondsByRung.size) return
    const endMs = Date.now()
    const totalSeconds = [...this.secondsByRung.values()].reduce((sum, value) => sum + value, 0)
    const rungMeasurements = Object.fromEntries(VIDEO_RUNGS.map((rung) => [`rung_${rung.name}_s`, { value: this.secondsByRung.get(rung.index) ?? 0, unit: "second" as const }]))
    captureMeasurementTransaction(
      "rtc.send_adaptation.round",
      { measurement_set: "rungs-network", round: String(this.round + 1), opening_rung: String(this.openingRung), min_rung: String(this.minRung), max_rung: String(this.maxRung), closing_rung: String(this.currentRung) },
      {
        ...Object.fromEntries(Object.entries(rungMeasurements).map(([key, value]) => [`rtc.send.${key}`, value])),
        "rtc.send.bandwidth_limited_s": { value: this.pressureSeconds.get("bandwidth") ?? 0, unit: "second" },
        "rtc.send.healthy_s": { value: this.pressureSeconds.get("healthy") ?? 0, unit: "second" },
        "rtc.send.step_up_count": { value: this.stepUps, unit: "none" },
        "rtc.send.failed_probe_count": { value: this.failedProbes, unit: "none" },
        "rtc.send.dropped_change_transitions": { value: this.droppedChanges, unit: "none" },
      },
      { startMs: endMs - totalSeconds * 1_000, endMs },
    )
    captureMeasurementTransaction(
      "rtc.send_adaptation.round",
      {
        measurement_set: "cpu-effects",
        round: String(this.round + 1),
        opening_rung: String(this.openingRung),
        min_rung: String(this.minRung),
        max_rung: String(this.maxRung),
        closing_rung: String(this.currentRung),
        encoder: dominant(this.encoders) ?? "unknown",
        encoder_kind: dominant(this.encoderKinds) ?? "unsupported",
      },
      {
        "rtc.send.cpu_limited_s": { value: this.pressureSeconds.get("cpu") ?? 0, unit: "second" },
        "rtc.send.encode_share_p50": ratio(percentile(this.encodeShares, 0.5) ?? 0),
        "rtc.send.encode_share_p95": ratio(percentile(this.encodeShares, 0.95) ?? 0),
        "rtc.send.encode_ms_p95": measure(percentile(this.encode, 0.95) ?? 0, "millisecond"),
        "rtc.send.effects_frame_p95_ms": measure(percentile(this.frameP95, 0.95) ?? 0, "millisecond"),
        "rtc.send.effects_slow_share": ratio(percentile(this.slowShares, 0.95) ?? 0),
        "rtc.send.effects_loaf_p95_ms": measure(percentile(this.loafP95, 0.95) ?? 0, "millisecond"),
        "rtc.send.effects_loaf_max_ms": measure(percentile(this.loafMax, 1) ?? 0, "millisecond"),
      },
      { startMs: endMs - totalSeconds * 1_000, endMs },
    )
  }

  private clearRound(): void {
    this.secondsByRung.clear()
    this.payloadByRung.clear()
    this.headerByRung.clear()
    this.pressureSeconds.clear()
    this.queue = []
    this.encode = []
    this.encodeShares = []
    this.frameP95 = []
    this.slowShares = []
    this.loafP95 = []
    this.loafMax = []
    this.failedProbes = 0
    this.stepUps = 0
    this.openingRung = this.currentRung
    this.minRung = this.currentRung
    this.maxRung = this.currentRung
    this.encoders.clear()
    this.encoderKinds.clear()
  }
}

const rungPosition = (index: SendRungIndex): number => {
  const position = VIDEO_RUNGS.findIndex((rung) => rung.index === index)
  return position < 0 ? VIDEO_RUNGS.length : position
}

const dominant = (counts: ReadonlyMap<string, number>): string | undefined =>
  [...counts].sort(([left, a], [right, b]) => b - a || left.localeCompare(right))[0]?.[0]

const measure = (value: number | undefined, unit: "millisecond") => (value === undefined ? undefined : { value, unit })
const ratio = (value: number | undefined) => (value === undefined ? undefined : { value, unit: "ratio" as const })

const networkMeasurements = (prefix: "before" | "after", summary: SendWindowSummary, rungIndex: SendRungIndex, transition: SendTransitionEvidence) => ({
  [`rtc.send.${prefix}.actual_kbps`]: summary.actualKbps === undefined ? undefined : { value: summary.actualKbps, unit: "none" as const },
  [`rtc.send.${prefix}.available_kbps`]: summary.availableKbps === undefined ? undefined : { value: summary.availableKbps, unit: "none" as const },
  [`rtc.send.${prefix}.target_bitrate_coverage`]: { value: summary.targetBitrateCoverage, unit: "ratio" as const },
  [`rtc.send.${prefix}.target_near_cap_share`]: { value: summary.targetNearCapShare, unit: "ratio" as const },
  [`rtc.send.${prefix}.bandwidth_low_target_share`]: { value: summary.bandwidthLowTargetShare, unit: "ratio" as const },
  [`rtc.send.${prefix}.queue_ms`]: measure(summary.queueMsPerPacket, "millisecond"),
  [`rtc.send.${prefix}.rtt_ms`]: measure(summary.rttMs, "millisecond"),
  [`rtc.send.${prefix}.active_senders`]: { value: summary.activeSenders, unit: "none" as const },
  [`rtc.send.${prefix}.total_cap_kbps`]: { value: ((VIDEO_RUNGS.find((rung) => rung.index === rungIndex)?.maxBitrate ?? 0) * summary.activeSenders) / 1_000, unit: "none" as const },
  [`rtc.send.${prefix}.applied_senders`]: { value: transition.applied, unit: "none" as const },
  [`rtc.send.${prefix}.refused_senders`]: { value: transition.refused, unit: "none" as const },
})

const cpuMeasurements = (prefix: "before" | "after", summary: SendWindowSummary) => ({
  [`rtc.send.${prefix}.encode_ms`]: measure(summary.encodeMsPerFrame, "millisecond"),
  [`rtc.send.${prefix}.encode_share`]: ratio(summary.encodeShare),
  [`rtc.send.${prefix}.cpu_limited_share`]: { value: summary.cpuShare, unit: "ratio" as const },
  [`rtc.send.${prefix}.bandwidth_limited_share`]: { value: summary.bandwidthShare, unit: "ratio" as const },
  [`rtc.send.${prefix}.effects_frame_p95_ms`]: measure(summary.effects.frameP95Ms, "millisecond"),
  [`rtc.send.${prefix}.effects_slow_share`]: ratio(summary.effects.slowFrameShare),
  [`rtc.send.${prefix}.effects_loaf_p95_ms`]: measure(summary.effects.loafP95Ms, "millisecond"),
  [`rtc.send.${prefix}.effects_loaf_max_ms`]: measure(summary.effects.loafMaxMs, "millisecond"),
})
